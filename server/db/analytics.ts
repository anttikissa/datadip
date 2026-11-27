// Dialect-safe (SQLite + PostgreSQL) read-only product analytics engine: detection, trends, funnels, retention, and actor journeys.
import {
	type ActorJourneyRequest,
	type ActorJourneyResponse,
	type ActorsRequest,
	type ActorsResponse,
	type ActorSummary,
	type AnalyticsBaseConfig,
	type AnalyticsDetection,
	type AnalyticsFilter,
	type AnalyticsInterval,
	type AnalyticsTopEvent,
	type AnalyticsUserDirectory,
	type AnalyticsUserMeta,
	buildIdentityResolver,
	computeFunnel,
	computeRetention,
	detectBestAnalyticsTable,
	detectTableColumns,
	detectUserTableMeta,
	floorBucketMs,
	type FunnelRequest,
	type FunnelResponse,
	generateBuckets,
	inferTimeFormat,
	looksLikeHttpEventList,
	looksLikeTestLabel,
	normalizeEventName,
	parseTimestampToMs,
	rangeToDurationMs,
	type RetentionActivityPoint,
	type RetentionRequest,
	type RetentionResponse,
	STITCHED_ACTOR_SENTINEL,
	type TimeColumnFormat,
	type TrendsRequest,
	type TrendsResponse,
	type TrendsSeries,
} from '../../src/shared/analytics.ts'
import type { DatabaseSchema, DriverKind, TableSchema } from '../../src/shared/types.ts'
import type { DbAdapter } from './types.ts'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONDAY_OFFSET_MS = 4 * DAY_MS

function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

function quoteTable(table: string, driver: DriverKind): string {
	if (driver === 'postgres' && table.includes('.')) {
		return table
			.split('.')
			.map((p) => quoteIdent(p))
			.join('.')
	}
	return quoteIdent(table)
}

function sqlLiteral(val: string): string {
	return `'${val.replaceAll("'", "''")}'`
}

function assertValidTable(schema: DatabaseSchema, table: string): TableSchema {
	const ts = schema.schemas[table]
	if (!ts) throw new Error(`Unknown table: ${table}`)
	return ts
}

function assertValidColumn(ts: TableSchema, col: string): string {
	if (!ts.columns.some((c) => c.name === col)) {
		throw new Error(`Unknown column "${col}" on table "${ts.name}"`)
	}
	return col
}

function optionalColumn(ts: TableSchema, col: string | null | undefined): string | null {
	if (!col) return null
	return ts.columns.some((c) => c.name === col) ? col : null
}

const COCOA_EPOCH_OFFSET_SEC = 978_307_200

function timeToMsExpr(timeCol: string, format: TimeColumnFormat, driver: DriverKind): string {
	const q = quoteIdent(timeCol)
	const intType = driver === 'postgres' ? 'BIGINT' : 'INTEGER'
	if (format === 'epoch_ms') {
		return `CAST(${q} AS ${intType})`
	}
	if (format === 'epoch_us') {
		return `(CAST(${q} AS ${intType}) / 1000)`
	}
	if (format === 'epoch_s') {
		return `(CAST(${q} AS ${intType}) * 1000)`
	}
	if (format === 'cocoa_s') {
		const numType = driver === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'
		return `CAST((CAST(${q} AS ${numType}) + ${COCOA_EPOCH_OFFSET_SEC}) * 1000 AS ${intType})`
	}
	if (driver === 'postgres') {
		return `CAST(EXTRACT(EPOCH FROM ${q}::timestamptz) * 1000 AS BIGINT)`
	}
	return `(CAST(strftime('%s', ${q}) AS INTEGER) * 1000)`
}

function bucketMsExpr(
	timeCol: string,
	format: TimeColumnFormat,
	interval: AnalyticsInterval,
	driver: DriverKind,
): string {
	const ms = timeToMsExpr(timeCol, format, driver)
	if (interval === 'hour') return `((${ms} / ${HOUR_MS}) * ${HOUR_MS})`
	if (interval === 'day') return `((${ms} / ${DAY_MS}) * ${DAY_MS})`
	if (interval === 'week') return `((((${ms} - ${MONDAY_OFFSET_MS}) / ${WEEK_MS}) * ${WEEK_MS}) + ${MONDAY_OFFSET_MS})`
	if (driver === 'postgres') {
		return `CAST(EXTRACT(EPOCH FROM date_trunc('month', to_timestamp((${ms})::double precision / 1000.0) AT TIME ZONE 'UTC')) * 1000 AS BIGINT)`
	}
	return `(CAST(strftime('%s', strftime('%Y-%m-01', (${ms}) / 1000, 'unixepoch')) AS INTEGER) * 1000)`
}

function buildTimeRangeWhere(
	timeCol: string,
	format: TimeColumnFormat,
	startMs: number | null,
	endMs: number | null,
	driver: DriverKind,
): string[] {
	const q = quoteIdent(timeCol)
	const clauses: string[] = [`${q} IS NOT NULL`]
	if (startMs !== null) {
		if (format === 'epoch_ms') clauses.push(`${q} >= ${Math.floor(startMs)}`)
		else if (format === 'epoch_us') clauses.push(`${q} >= ${Math.floor(startMs) * 1000}`)
		else if (format === 'epoch_s') clauses.push(`${q} >= ${Math.floor(startMs / 1000)}`)
		else if (format === 'cocoa_s') clauses.push(`${q} >= ${(startMs / 1000 - COCOA_EPOCH_OFFSET_SEC).toFixed(3)}`)
		else if (driver === 'postgres') clauses.push(`${q} >= ${sqlLiteral(new Date(startMs).toISOString())}::timestamptz`)
		else clauses.push(`${q} >= ${sqlLiteral(new Date(startMs).toISOString().slice(0, 19).replace('T', ' '))}`)
	}
	if (endMs !== null) {
		if (format === 'epoch_ms') clauses.push(`${q} <= ${Math.ceil(endMs)}`)
		else if (format === 'epoch_us') clauses.push(`${q} <= ${Math.ceil(endMs) * 1000 + 999}`)
		else if (format === 'epoch_s') clauses.push(`${q} <= ${Math.ceil(endMs / 1000)}`)
		else if (format === 'cocoa_s') clauses.push(`${q} <= ${((endMs + 1) / 1000 - COCOA_EPOCH_OFFSET_SEC).toFixed(3)}`)
		else if (driver === 'postgres') {
			// Postgres timestamptz has microsecond precision while JS Date ms truncates sub-ms digits;
			// using `< (endMs + 1ms)` ensures rows within the final millisecond are never dropped.
			clauses.push(`${q} < ${sqlLiteral(new Date(Math.floor(endMs) + 1).toISOString())}::timestamptz`)
		} else {
			clauses.push(`${q} < ${sqlLiteral(new Date(Math.floor(endMs) + 1).toISOString())}`)
		}
	}
	return clauses
}

function buildFilterWhere(ts: TableSchema, filters: AnalyticsFilter[] | undefined, driver: DriverKind): string[] {
	if (!filters || filters.length === 0) return []
	const out: string[] = []
	for (const f of filters) {
		const col = optionalColumn(ts, f.column)
		if (!col) continue
		const q = quoteIdent(col)
		if (f.op === 'isnull') {
			out.push(`${q} IS NULL`)
			continue
		}
		if (f.op === 'notnull') {
			out.push(`${q} IS NOT NULL`)
			continue
		}
		const colMeta = ts.columns.find((c) => c.name === col)
		const isNumCol = /\b(int|integer|bigint|real|float|double|numeric|decimal)\b/i.test(colMeta?.type ?? '')
		const rawVal = f.value ?? ''
		const numVal = Number(rawVal)
		const literal = isNumCol && rawVal.trim() !== '' && Number.isFinite(numVal) ? String(numVal) : sqlLiteral(rawVal)

		if (f.op === 'eq') out.push(`${q} = ${literal}`)
		else if (f.op === 'neq') out.push(`(${q} IS NULL OR ${q} <> ${literal})`)
		else if (f.op === 'gte') out.push(`${q} >= ${literal}`)
		else if (f.op === 'lte') out.push(`${q} <= ${literal}`)
		else if (f.op === 'like') {
			const pat = rawVal.includes('%') ? rawVal : `%${rawVal}%`
			out.push(
				driver === 'postgres'
					? `CAST(${q} AS TEXT) ILIKE ${sqlLiteral(pat)}`
					: `CAST(${q} AS TEXT) LIKE ${sqlLiteral(pat)}`,
			)
		} else if (f.op === 'not_like') {
			const pat = rawVal.includes('%') ? rawVal : `%${rawVal}%`
			out.push(
				driver === 'postgres'
					? `(${q} IS NULL OR CAST(${q} AS TEXT) NOT ILIKE ${sqlLiteral(pat)})`
					: `(${q} IS NULL OR CAST(${q} AS TEXT) NOT LIKE ${sqlLiteral(pat)})`,
			)
		}
	}
	return out
}

function isTruthyColExpr(col: string): string {
	return `LOWER(COALESCE(CAST(${quoteIdent(col)} AS TEXT), '0')) IN ('1', 'true', 't')`
}

// Guard CAST(... AS INTEGER) so text status values (e.g. 'failed', 'succeeded') never abort a Postgres transaction.
function safeStatusIntExpr(col: string, driver: DriverKind): string {
	const q = quoteIdent(col)
	if (driver === 'postgres') {
		return `CASE WHEN CAST(${q} AS TEXT) ~ '^[0-9]{1,9}$' THEN CAST(CAST(${q} AS TEXT) AS INTEGER) ELSE NULL END`
	}
	return `CASE WHEN CAST(${q} AS TEXT) GLOB '[0-9]*' AND CAST(${q} AS TEXT) NOT GLOB '*[^0-9]*' AND LENGTH(CAST(${q} AS TEXT)) <= 9 THEN CAST(${q} AS INTEGER) ELSE NULL END`
}

function buildActorExclusionWhere(
	ts: TableSchema,
	schema: DatabaseSchema,
	cfg: AnalyticsBaseConfig,
	driver: DriverKind,
): string[] {
	const clauses: string[] = []
	const cols = detectTableColumns(ts)
	const uCol = optionalColumn(ts, cfg.userIdColumn) ?? cols.userIdColumn
	const vCol = optionalColumn(ts, cfg.visitorIdColumn) ?? cols.visitorIdColumn
	const userMeta = detectUserTableMeta(schema, ts, uCol)

	if (cfg.signedInOnly && uCol) {
		clauses.push(`NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '') IS NOT NULL`)
	}

	if (cfg.excludeAdmin) {
		if (cols.adminColumn) {
			clauses.push(`${quoteIdent(cols.adminColumn)} IS NULL`)
		}
		if (uCol && userMeta?.adminColumn) {
			const qUserTbl = quoteTable(userMeta.table, driver)
			const qPk = quoteIdent(userMeta.pkColumn)
			clauses.push(
				`(${quoteIdent(uCol)} IS NULL OR CAST(${quoteIdent(uCol)} AS TEXT) NOT IN (SELECT CAST(${qPk} AS TEXT) FROM ${qUserTbl} WHERE ${isTruthyColExpr(userMeta.adminColumn)}))`,
			)
		}
	}

	if (cfg.excludeTestUsers && uCol && userMeta?.testColumn) {
		const qUserTbl = quoteTable(userMeta.table, driver)
		const qPk = quoteIdent(userMeta.pkColumn)
		clauses.push(
			`(${quoteIdent(uCol)} IS NULL OR CAST(${quoteIdent(uCol)} AS TEXT) NOT IN (SELECT CAST(${qPk} AS TEXT) FROM ${qUserTbl} WHERE ${isTruthyColExpr(userMeta.testColumn)}))`,
		)
	}

	const excluded = (cfg.excludedActors ?? [])
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 200)
	if (excluded.length > 0) {
		const inList = excluded.map(sqlLiteral).join(', ')
		if (uCol) {
			clauses.push(`(${quoteIdent(uCol)} IS NULL OR CAST(${quoteIdent(uCol)} AS TEXT) NOT IN (${inList}))`)
		}
		if (vCol) {
			clauses.push(`(${quoteIdent(vCol)} IS NULL OR CAST(${quoteIdent(vCol)} AS TEXT) NOT IN (${inList}))`)
		}
		const single = optionalColumn(ts, cfg.actorColumn)
		if (single && single !== uCol && single !== vCol) {
			clauses.push(`(${quoteIdent(single)} IS NULL OR CAST(${quoteIdent(single)} AS TEXT) NOT IN (${inList}))`)
		}
	}

	return clauses
}

function buildActorExpr(
	ts: TableSchema,
	actorColumn: string | null | undefined,
	userIdColumn: string | null | undefined,
	visitorIdColumn: string | null | undefined,
): string | null {
	const uCol = optionalColumn(ts, userIdColumn)
	const vCol = optionalColumn(ts, visitorIdColumn)
	if (actorColumn === STITCHED_ACTOR_SENTINEL && uCol && vCol) {
		return `COALESCE(NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), ''), NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), ''))`
	}
	const single = optionalColumn(ts, actorColumn)
	if (single) return `NULLIF(CAST(${quoteIdent(single)} AS TEXT), '')`
	if (uCol && vCol) {
		return `COALESCE(NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), ''), NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), ''))`
	}
	if (uCol) return `NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '')`
	if (vCol) return `NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), '')`
	return null
}

async function execReadOnly(
	adapter: DbAdapter,
	sql: string,
	maxRows: number,
	queryId?: string,
): Promise<Record<string, unknown>[]> {
	const results = await adapter.executeStatements([sql], { writable: false, maxRows, queryId })
	const first = results[0]
	if (!first) return []
	if (first.error) throw new Error(first.error)
	return first.rows
}

// Batch multiple read-only statements into one adapter call (1 SSH/worker round-trip, 1 cancellable queryId).
async function execReadOnlyBatch(
	adapter: DbAdapter,
	sqls: string[],
	maxRows: number,
	queryId?: string,
): Promise<Record<string, unknown>[][]> {
	if (sqls.length === 0) return []
	const results = await adapter.executeStatements(sqls, { writable: false, maxRows, queryId })
	return results.map((r) => {
		if (r.error) throw new Error(r.error)
		return r.rows
	})
}

async function resolveTimeWindow(
	adapter: DbAdapter,
	driver: DriverKind,
	ts: TableSchema,
	cfg: AnalyticsBaseConfig,
): Promise<{ startMs: number; endMs: number; minObservedMs: number | null; maxObservedMs: number | null }> {
	const qTable = quoteTable(ts.name, driver)
	const qTime = quoteIdent(cfg.timeColumn)
	let endMs = cfg.anchorEndMs ?? null
	let minObservedMs: number | null = null
	let maxObservedMs: number | null = null

	if (cfg.range === 'all' || endMs === null) {
		const rows = await execReadOnly(
			adapter,
			`SELECT MIN(${qTime}) AS mn, MAX(${qTime}) AS mx FROM ${qTable} WHERE ${qTime} IS NOT NULL`,
			1,
		)
		minObservedMs = parseTimestampToMs(rows[0]?.mn, cfg.timeFormat)
		maxObservedMs = parseTimestampToMs(rows[0]?.mx, cfg.timeFormat)
		if (endMs === null) endMs = maxObservedMs ?? Date.now()
	}

	const dur = rangeToDurationMs(cfg.range)
	if (dur === null) {
		const startMs = minObservedMs ?? endMs - 30 * DAY_MS
		return { startMs, endMs, minObservedMs, maxObservedMs }
	}
	return { startMs: endMs - dur, endMs, minObservedMs, maxObservedMs }
}

export async function detectAnalyticsTable(
	adapter: DbAdapter,
	driver: DriverKind,
	schema: DatabaseSchema,
	requestedTable?: string | null,
	queryId?: string,
): Promise<AnalyticsDetection> {
	const started = performance.now()
	const tableName = requestedTable && schema.schemas[requestedTable] ? requestedTable : detectBestAnalyticsTable(schema)
	if (!tableName) {
		throw new Error('No tables available for analytics')
	}
	const ts = assertValidTable(schema, tableName)
	const cols = detectTableColumns(ts)
	const qTable = quoteTable(ts.name, driver)
	const summary = schema.tables.find((t) => t.name === ts.name)
	const isLargeTable =
		summary?.rowCount === null || Boolean(summary?.rowCountEstimated) || (summary?.rowCount ?? 0) > 100_000
	let totalRows = summary?.rowCount ?? 0
	let timeFormat: TimeColumnFormat = 'iso'
	let minTimeMs: number | null = null
	let maxTimeMs: number | null = null

	if (cols.timeColumn) {
		const qTime = quoteIdent(cols.timeColumn)
		const colMeta = ts.columns.find((c) => c.name === cols.timeColumn)
		// On large tables, skip COUNT(*) so indexed MIN/MAX resolves via index seek without a full-table scan.
		const minMaxSql = isLargeTable
			? `SELECT MIN(${qTime}) AS mn, MAX(${qTime}) AS mx FROM ${qTable}`
			: `SELECT MIN(${qTime}) AS mn, MAX(${qTime}) AS mx, COUNT(*) AS n FROM ${qTable} WHERE ${qTime} IS NOT NULL`
		const rows = await execReadOnly(adapter, minMaxSql, 1, queryId)
		const r = rows[0]
		if (r) {
			timeFormat = inferTimeFormat(r.mx ?? r.mn, colMeta?.type ?? '', cols.timeColumn)
			minTimeMs = parseTimestampToMs(r.mn, timeFormat)
			maxTimeMs = parseTimestampToMs(r.mx, timeFormat)
			if (r.n !== undefined && r.n !== null) totalRows = Number(r.n) || totalRows
		}
	}

	const userMeta = detectUserTableMeta(schema, ts, cols.userIdColumn)

	let topEvents: AnalyticsTopEvent[] = []
	let looksLikeHttpEvents = false
	if (cols.eventColumn) {
		const qEv = quoteIdent(cols.eventColumn)
		const actorExpr = buildActorExpr(ts, cols.defaultActorColumn, cols.userIdColumn, cols.visitorIdColumn)
		const evFilters = [`${qEv} IS NOT NULL`]
		if (cols.adminColumn) evFilters.push(`${quoteIdent(cols.adminColumn)} IS NULL`)
		if (!isLargeTable && cols.userIdColumn && userMeta?.adminColumn) {
			const qUserTbl = quoteTable(userMeta.table, driver)
			const qPk = quoteIdent(userMeta.pkColumn)
			evFilters.push(
				`(${quoteIdent(cols.userIdColumn)} IS NULL OR CAST(${quoteIdent(cols.userIdColumn)} AS TEXT) NOT IN (SELECT CAST(${qPk} AS TEXT) FROM ${qUserTbl} WHERE ${isTruthyColExpr(userMeta.adminColumn)}))`,
			)
		}

		let evSql: string
		if (isLargeTable) {
			// Bound scan on large tables: sample recent 7d window (or 25k rows) and skip expensive COUNT(DISTINCT).
			if (cols.timeColumn && maxTimeMs !== null) {
				evFilters.push(...buildTimeRangeWhere(cols.timeColumn, timeFormat, maxTimeMs - 7 * DAY_MS, maxTimeMs, driver))
			}
			evSql = `SELECT ev, COUNT(*) AS n, 0 AS actors FROM (SELECT CAST(${qEv} AS TEXT) AS ev FROM ${qTable} WHERE ${evFilters.join(' AND ')} LIMIT 25000) sub GROUP BY ev ORDER BY n DESC LIMIT 40`
		} else {
			const actorSelect = actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'
			evSql = `SELECT CAST(${qEv} AS TEXT) AS ev, COUNT(*) AS n${actorSelect} FROM ${qTable} WHERE ${evFilters.join(' AND ')} GROUP BY ${qEv} ORDER BY n DESC LIMIT 40`
		}
		const evRows = await execReadOnly(adapter, evSql, 40, queryId)
		topEvents = evRows.map((r) => ({
			event: String(r.ev ?? ''),
			count: Number(r.n ?? 0),
			uniqueActors: Number(r.actors ?? 0),
		}))
		looksLikeHttpEvents = looksLikeHttpEventList(topEvents.map((e) => e.event))
	}

	// Resolve linked users table metadata (labels, admin flag, test flag) via declared/inferred/learned FK
	let userDirectory: AnalyticsUserDirectory | null = null
	if (userMeta) {
		try {
			const qUserTbl = quoteTable(userMeta.table, driver)
			const qPk = quoteIdent(userMeta.pkColumn)
			const adminExpr = userMeta.adminColumn ? isTruthyColExpr(userMeta.adminColumn) : '0 = 1'
			const testExpr = userMeta.testColumn ? isTruthyColExpr(userMeta.testColumn) : '0 = 1'
			const countRows = await execReadOnly(
				adapter,
				`SELECT COUNT(*) AS total,
	SUM(CASE WHEN ${adminExpr} THEN 1 ELSE 0 END) AS admins,
	SUM(CASE WHEN ${testExpr} THEN 1 ELSE 0 END) AS tests
FROM ${qUserTbl}`,
				1,
			)
			const totalUsers = Number(countRows[0]?.total ?? 0)
			const adminCount = Number(countRows[0]?.admins ?? 0)
			const testCount = Number(countRows[0]?.tests ?? 0)

			const labelSelect = userMeta.labelColumn
				? `CAST(${quoteIdent(userMeta.labelColumn)} AS TEXT) AS label`
				: 'NULL AS label'
			const isAdminSelect = userMeta.adminColumn
				? `CASE WHEN ${adminExpr} THEN 1 ELSE 0 END AS is_admin`
				: '0 AS is_admin'
			const isTestSelect = userMeta.testColumn ? `CASE WHEN ${testExpr} THEN 1 ELSE 0 END AS is_test` : '0 AS is_test'
			const orderParts = [
				userMeta.labelColumn
					? `CASE WHEN ${quoteIdent(userMeta.labelColumn)} IS NOT NULL AND CAST(${quoteIdent(userMeta.labelColumn)} AS TEXT) <> '' THEN 0 ELSE 1 END`
					: null,
				userMeta.adminColumn ? 'is_admin DESC' : null,
				userMeta.testColumn ? 'is_test ASC' : null,
				`${qPk} ASC`,
			].filter(Boolean)

			const userRows = await execReadOnly(
				adapter,
				`SELECT CAST(${qPk} AS TEXT) AS id, ${labelSelect}, ${isAdminSelect}, ${isTestSelect}
FROM ${qUserTbl}
ORDER BY ${orderParts.join(', ')}
LIMIT 250`,
				250,
			)
			const users: AnalyticsUserMeta[] = userRows.map((r) => {
				const label =
					r.label !== null && r.label !== undefined && String(r.label).trim() !== '' ? String(r.label) : null
				return {
					id: String(r.id ?? ''),
					label,
					isAdmin: Number(r.is_admin ?? 0) === 1,
					isTest: Number(r.is_test ?? 0) === 1,
					looksLikeTest: looksLikeTestLabel(label),
				}
			})
			userDirectory = {
				table: userMeta.table,
				pkColumn: userMeta.pkColumn,
				labelColumn: userMeta.labelColumn,
				adminColumn: userMeta.adminColumn,
				testColumn: userMeta.testColumn,
				totalUsers,
				adminCount,
				testCount,
				users,
			}
		} catch {
			userDirectory = null
		}
	}

	return {
		table: ts.name,
		timeColumn: cols.timeColumn,
		timeFormat,
		eventColumn: cols.eventColumn,
		actorColumns: cols.actorColumns,
		defaultActorColumn: cols.defaultActorColumn,
		userIdColumn: cols.userIdColumn,
		visitorIdColumn: cols.visitorIdColumn,
		statusColumn: cols.statusColumn,
		adminColumn: cols.adminColumn,
		payloadColumn: cols.payloadColumn,
		userDirectory,
		looksLikeHttpEvents,
		minTimeMs,
		maxTimeMs,
		totalRows,
		topEvents,
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runAnalyticsTrends(
	adapter: DbAdapter,
	driver: DriverKind,
	schema: DatabaseSchema,
	req: TrendsRequest,
): Promise<TrendsResponse> {
	const started = performance.now()
	const ts = assertValidTable(schema, req.table)
	assertValidColumn(ts, req.timeColumn)
	const qTable = quoteTable(ts.name, driver)

	const { startMs, endMs } = await resolveTimeWindow(adapter, driver, ts, req)
	const buckets = generateBuckets(startMs, endMs, req.interval, 400)
	const bucketIdx = new Map<number, number>()
	for (let i = 0; i < buckets.length; i++) bucketIdx.set(buckets[i]!, i)

	const baseFilters = [
		...buildFilterWhere(ts, req.filters, driver),
		...buildActorExclusionWhere(ts, schema, req, driver),
	]
	const rangeWhere = [...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs, endMs, driver), ...baseFilters]
	const whereSql = rangeWhere.length > 0 ? `WHERE ${rangeWhere.join(' AND ')}` : ''

	const actorExpr = buildActorExpr(ts, req.actorColumn, req.userIdColumn, req.visitorIdColumn)
	const uCol = optionalColumn(ts, req.userIdColumn)
	const vCol = optionalColumn(ts, req.visitorIdColumn)
	const statusCol = optionalColumn(ts, req.statusColumn)
	const eventCol = optionalColumn(ts, req.eventColumn)
	const breakdownCol = optionalColumn(ts, req.breakdownColumn)
	const normUrls = Boolean(req.normalizeUrls && eventCol && breakdownCol === eventCol)

	const bExpr = bucketMsExpr(req.timeColumn, req.timeFormat, req.interval, driver)

	// 1. KPIs + Previous-period comparison (always report distinct signed-in users vs anonymous visitors honestly)
	const errorExpr = statusCol
		? `SUM(CASE WHEN (${safeStatusIntExpr(statusCol, driver)}) >= 400 THEN 1 ELSE 0 END) AS errors`
		: 'NULL AS errors'
	const usersCountExpr = uCol ? `COUNT(DISTINCT NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), ''))` : 'NULL'
	const anonVisitorsCountExpr =
		vCol && uCol
			? `COUNT(DISTINCT CASE WHEN NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '') IS NULL THEN NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), '') END)`
			: vCol
				? `COUNT(DISTINCT NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), ''))`
				: 'NULL'
	const kpiSql = `SELECT COUNT(*) AS total, ${actorExpr ? `COUNT(DISTINCT ${actorExpr})` : '0'} AS actors, ${usersCountExpr} AS unique_users, ${anonVisitorsCountExpr} AS unique_anon_visitors, ${errorExpr} FROM ${qTable} ${whereSql}`

	const dur = rangeToDurationMs(req.range)
	const prevSql =
		dur !== null
			? `SELECT COUNT(*) AS total FROM ${qTable} WHERE ${[
					...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs - dur, startMs - 1, driver),
					...baseFilters,
				].join(' AND ')}`
			: null

	// 2. Prepare main bucketed series SQL + topEvents queries and execute independent scans in parallel
	const topN = Math.max(1, Math.min(12, req.topN ?? 6))
	const selectedSet = req.selectedEvents && req.selectedEvents.length > 0 ? new Set(req.selectedEvents) : null

	let mainSql = ''
	let breakExpr = ''
	if (!breakdownCol) {
		mainSql = `SELECT ${bExpr} AS bucket, COUNT(*) AS events${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1
ORDER BY 1 ASC`
	} else {
		const qBreak = quoteIdent(breakdownCol)
		breakExpr = `COALESCE(CAST(${qBreak} AS TEXT), '(null)')`
		mainSql = `SELECT ${bExpr} AS bucket, ${breakExpr} AS grp, COUNT(*) AS events${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1, 2
ORDER BY 1 ASC`
	}

	const canReuseMainForTop = Boolean(eventCol && breakdownCol === eventCol)
	const topSql =
		eventCol && !canReuseMainForTop
			? `SELECT ${bExpr} AS bucket, COALESCE(CAST(${quoteIdent(eventCol)} AS TEXT), '(null)') AS ev, COUNT(*) AS n${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1, 2`
			: null
	const overallActorsSql = eventCol
		? `SELECT COALESCE(CAST(${quoteIdent(eventCol)} AS TEXT), '(null)') AS ev, COUNT(*) AS n${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1
ORDER BY n DESC
LIMIT 200`
		: null

	const batchSqls: string[] = [kpiSql]
	const prevIdx = prevSql ? batchSqls.push(prevSql) - 1 : -1
	const mainIdx = batchSqls.push(mainSql) - 1
	const topIdx = topSql ? batchSqls.push(topSql) - 1 : -1
	const overallIdx = overallActorsSql ? batchSqls.push(overallActorsSql) - 1 : -1

	const batchResults = await execReadOnlyBatch(adapter, batchSqls, breakdownCol || topSql ? 25_000 : 1000, req.queryId)
	const kpiRows = batchResults[0] ?? []
	const prevRows = prevIdx >= 0 ? (batchResults[prevIdx] ?? []) : null
	const mainRows = batchResults[mainIdx] ?? []
	const separateTopRows = topIdx >= 0 ? (batchResults[topIdx] ?? []) : null
	const overallRows = overallIdx >= 0 ? (batchResults[overallIdx] ?? []) : null

	const totalEvents = Number(kpiRows[0]?.total ?? 0)
	const uniqueActors = Number(kpiRows[0]?.actors ?? 0)
	const uniqueUsers =
		uCol && kpiRows[0]?.unique_users !== null && kpiRows[0]?.unique_users !== undefined
			? Number(kpiRows[0].unique_users)
			: null
	const uniqueAnonVisitors =
		vCol && kpiRows[0]?.unique_anon_visitors !== null && kpiRows[0]?.unique_anon_visitors !== undefined
			? Number(kpiRows[0].unique_anon_visitors)
			: null
	const errorCount = statusCol ? Number(kpiRows[0]?.errors ?? 0) : null

	let prevPeriodEvents: number | null = null
	let deltaPct: number | null = null
	if (prevRows) {
		prevPeriodEvents = Number(prevRows[0]?.total ?? 0)
		if (prevPeriodEvents > 0) {
			deltaPct = Number((((totalEvents - prevPeriodEvents) / prevPeriodEvents) * 100).toFixed(1))
		}
	}

	const series: TrendsSeries[] = []

	if (!breakdownCol) {
		const rows = mainRows
		const values = new Array<number>(buckets.length).fill(0)
		let total = 0
		for (const r of rows) {
			const bMs = floorBucketMs(Number(r.bucket), req.interval)
			const idx = bucketIdx.get(bMs)
			if (idx === undefined) continue
			const ev = Number(r.events ?? 0)
			const ac = Number(r.actors ?? 0)
			const v =
				req.metric === 'unique_actors'
					? ac
					: req.metric === 'events_per_actor'
						? ac > 0
							? Number((ev / ac).toFixed(2))
							: 0
						: ev
			values[idx] = v
			total += ev
		}
		if (req.metric === 'cumulative') {
			let run = 0
			for (let i = 0; i < values.length; i++) {
				run += values[i]!
				values[i] = run
			}
			total = run
		}
		const label =
			req.metric === 'unique_actors'
				? 'Unique People'
				: req.metric === 'events_per_actor'
					? 'Events / Person'
					: req.metric === 'cumulative'
						? `Cumulative ${ts.name}`
						: `All ${ts.name}`
		const seriesTotal =
			req.metric === 'unique_actors'
				? uniqueActors
				: req.metric === 'events_per_actor'
					? uniqueActors > 0
						? Number((totalEvents / uniqueActors).toFixed(2))
						: 0
					: total
		series.push({ key: '__all__', label, values, total: seriesTotal })
	} else {
		const rows = mainRows

		// Aggregate by group (optionally normalizing URL routes) and track raw keys per normalized group
		const grpEvents = new Map<string, number[]>()
		const grpActors = new Map<string, number[]>()
		const grpTotals = new Map<string, number>()
		const rawKeysByGroup = new Map<string, Set<string>>()

		for (const r of rows) {
			const bMs = floorBucketMs(Number(r.bucket), req.interval)
			const idx = bucketIdx.get(bMs)
			if (idx === undefined) continue
			const rawKey = String(r.grp ?? '(null)')
			const key = normUrls ? normalizeEventName(rawKey) : rawKey
			if (selectedSet && !selectedSet.has(key) && !selectedSet.has(rawKey)) continue

			let rawSet = rawKeysByGroup.get(key)
			if (!rawSet) {
				rawSet = new Set<string>()
				rawKeysByGroup.set(key, rawSet)
			}
			rawSet.add(rawKey)

			const ev = Number(r.events ?? 0)
			const ac = Number(r.actors ?? 0)
			let evArr = grpEvents.get(key)
			if (!evArr) {
				evArr = new Array<number>(buckets.length).fill(0)
				grpEvents.set(key, evArr)
			}
			evArr[idx] = evArr[idx]! + ev

			let acArr = grpActors.get(key)
			if (!acArr) {
				acArr = new Array<number>(buckets.length).fill(0)
				grpActors.set(key, acArr)
			}
			acArr[idx] = acArr[idx]! + ac

			grpTotals.set(key, (grpTotals.get(key) ?? 0) + ev)
		}

		const ranked = [...grpTotals.entries()].sort((a, b) => b[1] - a[1])
		const keep = selectedSet ? ranked : ranked.slice(0, topN)
		const rest = selectedSet ? [] : ranked.slice(topN)

		// Never sum COUNT(DISTINCT actor) across normalized routes or into `Other (N)`:
		// recompute exact distinct actors in SQL via a CASE mapping whenever needed.
		let exactBucketActors: Map<string, number[]> | null = null
		let exactBucketEvents: Map<string, number[]> | null = null
		let exactOverallActors: Map<string, number> | null = null
		const totalKeepRawKeys = keep.reduce((acc, [k]) => acc + (rawKeysByGroup.get(k)?.size ?? 0), 0)
		const needsExactDistinct = Boolean(
			actorExpr &&
			(req.metric === 'unique_actors' || req.metric === 'events_per_actor') &&
			keep.length > 0 &&
			totalKeepRawKeys <= 250 &&
			(req.metric === 'unique_actors' || rest.length > 0 || keep.some(([k]) => (rawKeysByGroup.get(k)?.size ?? 0) > 1)),
		)

		if (needsExactDistinct && actorExpr) {
			const whenClauses: string[] = []
			for (const [key] of keep) {
				const raws = [...(rawKeysByGroup.get(key) ?? [])]
				if (raws.length === 0) continue
				const inList = raws.map(sqlLiteral).join(', ')
				whenClauses.push(`WHEN ${breakExpr} IN (${inList}) THEN ${sqlLiteral(key)}`)
			}
			if (whenClauses.length > 0) {
				const caseExpr = `CASE ${whenClauses.join(' ')} ELSE '__other__' END`
				const exactBucketSql = `SELECT ${bExpr} AS bucket, ${caseExpr} AS norm_grp, COUNT(*) AS events, COUNT(DISTINCT ${actorExpr}) AS actors
FROM ${qTable}
${whereSql}
GROUP BY 1, 2
ORDER BY 1 ASC`
				const exactRows = await execReadOnly(adapter, exactBucketSql, 25_000, req.queryId)
				exactBucketActors = new Map()
				exactBucketEvents = new Map()
				for (const r of exactRows) {
					const bMs = floorBucketMs(Number(r.bucket), req.interval)
					const idx = bucketIdx.get(bMs)
					if (idx === undefined) continue
					const g = String(r.norm_grp ?? '__other__')
					let acArr = exactBucketActors.get(g)
					if (!acArr) {
						acArr = new Array<number>(buckets.length).fill(0)
						exactBucketActors.set(g, acArr)
					}
					acArr[idx] = Number(r.actors ?? 0)
					let evArr = exactBucketEvents.get(g)
					if (!evArr) {
						evArr = new Array<number>(buckets.length).fill(0)
						exactBucketEvents.set(g, evArr)
					}
					evArr[idx] = Number(r.events ?? 0)
				}
				mainSql = exactBucketSql

				if (req.metric === 'unique_actors') {
					const exactTotalSql = `SELECT ${caseExpr} AS norm_grp, COUNT(DISTINCT ${actorExpr}) AS actors
FROM ${qTable}
${whereSql}
GROUP BY 1`
					const exactTotalRows = await execReadOnly(adapter, exactTotalSql, 50, req.queryId)
					exactOverallActors = new Map()
					for (const r of exactTotalRows) {
						exactOverallActors.set(String(r.norm_grp ?? '__other__'), Number(r.actors ?? 0))
					}
				}
			}
		}

		for (const [key, total] of keep) {
			const evArr = exactBucketEvents?.get(key) ?? grpEvents.get(key)!
			const acArr = exactBucketActors?.get(key) ?? grpActors.get(key)!
			const values = evArr.map((ev, i) => {
				if (req.metric === 'unique_actors') return acArr[i]!
				if (req.metric === 'events_per_actor') return acArr[i]! > 0 ? Number((ev / acArr[i]!).toFixed(2)) : 0
				return ev
			})
			if (req.metric === 'cumulative') {
				let run = 0
				for (let i = 0; i < values.length; i++) {
					run += values[i]!
					values[i] = run
				}
			}
			const seriesTotal = req.metric === 'unique_actors' ? (exactOverallActors?.get(key) ?? total) : total
			series.push({ key, label: key, values, total: seriesTotal })
		}

		if (rest.length > 0 && req.metric !== 'events_per_actor') {
			let otherVals: number[]
			let otherTotal = 0
			if (req.metric === 'unique_actors' && exactBucketActors) {
				otherVals = exactBucketActors.get('__other__') ?? new Array<number>(buckets.length).fill(0)
				otherTotal = exactOverallActors?.get('__other__') ?? 0
			} else if (req.metric === 'unique_actors') {
				// Fallback when >250 raw keys: omit approximate Other series rather than double-counting distinct people.
				otherVals = []
			} else {
				otherVals = new Array<number>(buckets.length).fill(0)
				for (const [key, total] of rest) {
					const arr = grpEvents.get(key)!
					otherTotal += total
					for (let i = 0; i < buckets.length; i++) otherVals[i] = otherVals[i]! + arr[i]!
				}
				if (req.metric === 'cumulative') {
					let run = 0
					for (let i = 0; i < otherVals.length; i++) {
						run += otherVals[i]!
						otherVals[i] = run
					}
				}
			}
			if (otherVals.length > 0) {
				series.push({ key: '__other__', label: `Other (${rest.length})`, values: otherVals, total: otherTotal })
			}
		}
	}

	// 3. Top events breakdown with sparklines (reusing mainRows when breakdownCol === eventCol)
	const topEvents: AnalyticsTopEvent[] = []
	if (eventCol && overallRows) {
		const evMap = new Map<string, { count: number; actors: number; spark: number[] }>()
		const norm = Boolean(req.normalizeUrls)
		for (const r of overallRows) {
			const raw = String(r.ev ?? '(null)')
			const key = norm ? normalizeEventName(raw) : raw
			const cur = evMap.get(key) ?? {
				count: 0,
				actors: 0,
				spark: new Array<number>(Math.min(buckets.length, 24)).fill(0),
			}
			cur.count += Number(r.n ?? 0)
			cur.actors = Math.max(cur.actors, Number(r.actors ?? 0))
			evMap.set(key, cur)
		}

		const sparkLen = Math.max(1, Math.min(buckets.length, 24))
		const bucketRows = canReuseMainForTop ? mainRows : (separateTopRows ?? [])
		for (const r of bucketRows) {
			const raw = String((canReuseMainForTop ? r.grp : r.ev) ?? '(null)')
			const key = norm ? normalizeEventName(raw) : raw
			const entry = evMap.get(key)
			if (!entry) continue
			const bMs = floorBucketMs(Number(r.bucket), req.interval)
			const idx = bucketIdx.get(bMs)
			if (idx === undefined) continue
			const sIdx = Math.min(sparkLen - 1, Math.floor((idx / Math.max(1, buckets.length)) * sparkLen))
			entry.spark[sIdx] = (entry.spark[sIdx] ?? 0) + Number((canReuseMainForTop ? r.events : r.n) ?? 0)
		}

		const sortedTop = [...evMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30)
		for (const [ev, info] of sortedTop) {
			topEvents.push({
				event: ev,
				count: info.count,
				uniqueActors: info.actors,
				pct: totalEvents > 0 ? Number(((info.count / totalEvents) * 100).toFixed(1)) : 0,
				sparkline: info.spark,
			})
		}
	}

	return {
		buckets,
		interval: req.interval,
		rangeStartMs: startMs,
		rangeEndMs: endMs,
		series,
		kpis: {
			totalEvents,
			uniqueActors,
			uniqueUsers,
			uniqueAnonVisitors,
			avgPerActor: uniqueActors > 0 ? Number((totalEvents / uniqueActors).toFixed(1)) : 0,
			errorCount,
			errorRatePct:
				errorCount !== null && totalEvents > 0 ? Number(((errorCount / totalEvents) * 100).toFixed(2)) : null,
			prevPeriodEvents,
			deltaPct,
		},
		topEvents,
		sql: mainSql,
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runAnalyticsFunnel(
	adapter: DbAdapter,
	driver: DriverKind,
	schema: DatabaseSchema,
	req: FunnelRequest,
): Promise<FunnelResponse> {
	const started = performance.now()
	const ts = assertValidTable(schema, req.table)
	assertValidColumn(ts, req.timeColumn)
	if (!req.eventColumn) throw new Error('Funnel requires an event column')
	assertValidColumn(ts, req.eventColumn)
	if (!req.steps || req.steps.length === 0) throw new Error('At least one funnel step is required')

	const qTable = quoteTable(ts.name, driver)
	const qEv = quoteIdent(req.eventColumn)
	const uCol = optionalColumn(ts, req.userIdColumn)
	const vCol = optionalColumn(ts, req.visitorIdColumn)
	const actorExpr = buildActorExpr(ts, req.actorColumn, uCol, vCol)
	if (!actorExpr) throw new Error('Funnel requires an actor/user column')

	const { startMs, endMs } = await resolveTimeWindow(adapter, driver, ts, req)
	const whereClauses = [
		...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs, endMs, driver),
		...buildFilterWhere(ts, req.filters, driver),
		...buildActorExclusionWhere(ts, schema, req, driver),
		`${qEv} IS NOT NULL`,
	]

	// When stitching visitor_id -> user_id, we also need co-occurrence links (or fetch events matching steps + stitch links)
	const stitch = Boolean(req.stitchIdentity && uCol && vCol)
	const likeOp = driver === 'postgres' ? 'ILIKE' : 'LIKE'
	const stepPredicates: string[] = []
	let canPushStepPredicates = true
	for (const step of req.steps) {
		const pat = step.pattern.trim()
		if (!pat) continue
		if (!req.normalizeUrls) {
			if (step.match === 'exact') {
				stepPredicates.push(`CAST(${qEv} AS TEXT) = ${sqlLiteral(pat)}`)
			} else if (step.match === 'prefix') {
				stepPredicates.push(`CAST(${qEv} AS TEXT) LIKE ${sqlLiteral(pat + '%')}`)
			} else {
				stepPredicates.push(`CAST(${qEv} AS TEXT) ${likeOp} ${sqlLiteral('%' + pat + '%')}`)
			}
		} else {
			// Push coarse SQL pre-filter even when normalizeUrls is ON: replace `:id` with `%` (or match query strings)
			// so Funnel avoids scanning unrelated events before JS normalization & exact matching.
			const hasPlaceholder = pat.includes(':id')
			if (step.match === 'exact' && !hasPlaceholder) {
				stepPredicates.push(
					`(CAST(${qEv} AS TEXT) = ${sqlLiteral(pat)} OR CAST(${qEv} AS TEXT) LIKE ${sqlLiteral(pat + '?%')})`,
				)
			} else if (step.match === 'exact' || step.match === 'prefix') {
				const coarse = pat.replaceAll(':id', '%')
				if (coarse.replaceAll('%', '').length === 0) {
					canPushStepPredicates = false
				} else {
					stepPredicates.push(`CAST(${qEv} AS TEXT) LIKE ${sqlLiteral(coarse + '%')}`)
				}
			} else {
				const coarse = pat.replaceAll(':id', '%')
				if (coarse.replaceAll('%', '').length === 0) {
					canPushStepPredicates = false
				} else {
					stepPredicates.push(`CAST(${qEv} AS TEXT) ${likeOp} ${sqlLiteral('%' + coarse + '%')}`)
				}
			}
		}
	}

	const selectCols = [
		`${actorExpr} AS actor_key`,
		uCol ? `NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '') AS uid` : 'NULL AS uid',
		vCol ? `NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), '') AS vid` : 'NULL AS vid',
		`CAST(${qEv} AS TEXT) AS ev`,
		`${timeToMsExpr(req.timeColumn, req.timeFormat, driver)} AS ts_ms`,
	]

	const evWhere = [...whereClauses]
	if (canPushStepPredicates && stepPredicates.length > 0) {
		evWhere.push(`(${stepPredicates.join(' OR ')})`)
	}

	const MAX_SCAN = 120_000
	const sql = `SELECT ${selectCols.join(', ')}
FROM ${qTable}
WHERE ${evWhere.join(' AND ')}
ORDER BY ${quoteIdent(req.timeColumn)} ASC
LIMIT ${MAX_SCAN}`

	const rows = await execReadOnly(adapter, sql, MAX_SCAN, req.queryId)
	const truncated = rows.length >= MAX_SCAN

	// If stitching is enabled and we filtered events by step predicates, fetch distinct (visitor_id, user_id) pairs so
	// anonymous visitors who later signed up on a non-funnel event still stitch cleanly.
	const linkRows: { userId: string | null; visitorId: string | null; actorKey?: string }[] = []
	if (stitch && uCol && vCol) {
		const linkSql = `SELECT DISTINCT NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '') AS uid, NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), '') AS vid
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')} AND ${quoteIdent(uCol)} IS NOT NULL AND ${quoteIdent(vCol)} IS NOT NULL
LIMIT 50000`
		const links = await execReadOnly(adapter, linkSql, 50_000, req.queryId)
		for (const l of links) {
			if (l.uid && l.vid) linkRows.push({ userId: String(l.uid), visitorId: String(l.vid) })
		}
	}

	const rawEvents = rows
		.map((r) => {
			const rawEv = String(r.ev ?? '')
			return {
				actorKey: r.actor_key ? String(r.actor_key) : '',
				userId: r.uid ? String(r.uid) : null,
				visitorId: r.vid ? String(r.vid) : null,
				event: req.normalizeUrls ? normalizeEventName(rawEv) : rawEv,
				tsMs: Number(r.ts_ms ?? 0),
			}
		})
		.filter((e) => e.actorKey || e.userId || e.visitorId)

	// Pre-resolve visitor->user links from both the stitch table and the event stream
	const resolver = buildIdentityResolver([...linkRows, ...rawEvents], stitch)
	const resolvedEvents = rawEvents.map((e) => {
		const id = resolver(e)
		return { ...e, actorKey: id ?? e.actorKey, userId: id, visitorId: null }
	})

	const steps = computeFunnel(resolvedEvents, req.steps, req.windowSeconds, false)

	return {
		steps,
		windowSeconds: req.windowSeconds,
		stitchedIdentity: stitch,
		scannedEvents: rows.length,
		truncated,
		sql,
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runAnalyticsRetention(
	adapter: DbAdapter,
	driver: DriverKind,
	schema: DatabaseSchema,
	req: RetentionRequest,
): Promise<RetentionResponse> {
	const started = performance.now()
	const ts = assertValidTable(schema, req.table)
	assertValidColumn(ts, req.timeColumn)

	const qTable = quoteTable(ts.name, driver)
	const uCol = optionalColumn(ts, req.userIdColumn)
	const vCol = optionalColumn(ts, req.visitorIdColumn)
	const evCol = optionalColumn(ts, req.eventColumn)
	const actorExpr = buildActorExpr(ts, req.actorColumn, uCol, vCol)
	if (!actorExpr) throw new Error('Retention requires an actor/user column')

	const { startMs, endMs } = await resolveTimeWindow(adapter, driver, ts, req)
	const whereClauses = [
		...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs, endMs, driver),
		...buildFilterWhere(ts, req.filters, driver),
		...buildActorExclusionWhere(ts, schema, req, driver),
	]
	const bExpr = bucketMsExpr(req.timeColumn, req.timeFormat, req.granularity, driver)
	const stitch = Boolean(req.stitchIdentity && uCol && vCol)
	const cohortFilter = req.cohortEvent?.trim() || null
	const returnFilter = req.returnEvent?.trim() || null
	const needEvent = Boolean((cohortFilter || returnFilter) && evCol)

	const selectCols = [
		`${actorExpr} AS actor_key`,
		uCol ? `NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '') AS uid` : 'NULL AS uid',
		vCol ? `NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), '') AS vid` : 'NULL AS vid',
		`${bExpr} AS bucket`,
		...(needEvent && evCol ? [`CAST(${quoteIdent(evCol)} AS TEXT) AS ev`] : []),
	]

	const RETENTION_MAX_ROWS = 120_000
	const sql = `SELECT DISTINCT ${selectCols.join(', ')}
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')}
ORDER BY 4 ASC
LIMIT ${RETENTION_MAX_ROWS}`

	const rows = await execReadOnly(adapter, sql, RETENTION_MAX_ROWS, req.queryId)
	const truncated = rows.length >= RETENTION_MAX_ROWS

	const parsedRows = rows.map((r) => ({
		actorKey: r.actor_key ? String(r.actor_key) : '',
		userId: r.uid ? String(r.uid) : null,
		visitorId: r.vid ? String(r.vid) : null,
		bucketMs: Number(r.bucket ?? 0),
		ev: r.ev !== undefined && r.ev !== null ? String(r.ev) : null,
	}))

	const resolver = buildIdentityResolver(parsedRows, stitch)
	const points: RetentionActivityPoint[] = []
	let maxObservedMs = endMs
	for (const r of parsedRows) {
		const actorId = resolver(r)
		if (!actorId) continue
		const evNorm = r.ev !== null ? (req.normalizeUrls ? normalizeEventName(r.ev) : r.ev) : null
		const isCohortEvent = !cohortFilter || evNorm === cohortFilter || r.ev === cohortFilter
		const isReturnEvent = !returnFilter || evNorm === returnFilter || r.ev === returnFilter
		if (!isCohortEvent && !isReturnEvent) continue
		if (r.bucketMs > maxObservedMs) maxObservedMs = r.bucketMs
		points.push({ actorId, bucketMs: r.bucketMs, isCohortEvent, isReturnEvent })
	}

	const periods = Math.max(3, Math.min(30, req.periods || (req.granularity === 'week' ? 8 : 14)))
	const { cohorts, averagePcts } = computeRetention(points, req.granularity, periods, maxObservedMs)

	return {
		granularity: req.granularity,
		periods,
		cohorts,
		averagePcts,
		truncated,
		sql,
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runAnalyticsActors(
	adapter: DbAdapter,
	driver: DriverKind,
	schema: DatabaseSchema,
	req: ActorsRequest,
): Promise<ActorsResponse> {
	const started = performance.now()
	const ts = assertValidTable(schema, req.table)
	assertValidColumn(ts, req.timeColumn)

	const qTable = quoteTable(ts.name, driver)
	const uCol = optionalColumn(ts, req.userIdColumn)
	const vCol = optionalColumn(ts, req.visitorIdColumn)
	const statusCol = optionalColumn(ts, req.statusColumn)
	const evCol = optionalColumn(ts, req.eventColumn)
	const actorExpr = buildActorExpr(ts, req.actorColumn, uCol, vCol)
	if (!actorExpr) throw new Error('Actors view requires an actor/user column')

	const { startMs, endMs } = await resolveTimeWindow(adapter, driver, ts, req)
	const whereClauses = [
		...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs, endMs, driver),
		...buildFilterWhere(ts, req.filters, driver),
		...buildActorExclusionWhere(ts, schema, req, driver),
		`${actorExpr} IS NOT NULL`,
	]
	if (req.search?.trim()) {
		const pat = `%${req.search.trim()}%`
		const likeOp = driver === 'postgres' ? 'ILIKE' : 'LIKE'
		const userMeta = detectUserTableMeta(schema, ts, uCol)
		if (uCol && userMeta?.labelColumn) {
			const qUserTbl = quoteTable(userMeta.table, driver)
			const qPk = quoteIdent(userMeta.pkColumn)
			const qLbl = quoteIdent(userMeta.labelColumn)
			whereClauses.push(
				`(${actorExpr} ${likeOp} ${sqlLiteral(pat)} OR CAST(${quoteIdent(uCol)} AS TEXT) IN (SELECT CAST(${qPk} AS TEXT) FROM ${qUserTbl} WHERE CAST(${qLbl} AS TEXT) ${likeOp} ${sqlLiteral(pat)}))`,
			)
		} else {
			whereClauses.push(`${actorExpr} ${likeOp} ${sqlLiteral(pat)}`)
		}
	}

	const msExpr = timeToMsExpr(req.timeColumn, req.timeFormat, driver)
	const dayBucket = bucketMsExpr(req.timeColumn, req.timeFormat, 'day', driver)
	const errSelect = statusCol
		? `SUM(CASE WHEN (${safeStatusIntExpr(statusCol, driver)}) >= 400 THEN 1 ELSE 0 END) AS errors`
		: '0 AS errors'
	const orderSql =
		req.sortBy === 'last_seen'
			? 'last_seen DESC'
			: req.sortBy === 'errors'
				? 'errors DESC, event_count DESC'
				: 'event_count DESC, last_seen DESC'
	const limit = Math.max(10, Math.min(200, req.limit ?? 80))

	const sql = `SELECT ${actorExpr} AS actor_id,
	${uCol ? `MAX(NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), ''))` : 'NULL'} AS user_id,
	${vCol ? `MAX(NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), ''))` : 'NULL'} AS visitor_id,
	COUNT(*) AS event_count,
	COUNT(DISTINCT ${dayBucket}) AS active_days,
	${errSelect},
	MIN(${msExpr}) AS first_seen,
	MAX(${msExpr}) AS last_seen
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')}
GROUP BY 1
ORDER BY ${orderSql}
LIMIT ${limit}`

	const rows = await execReadOnly(adapter, sql, limit, req.queryId)

	// Compute actual most-frequent event per returned actor (not alphabetical MAX(event)).
	const topEventByActor = new Map<string, string>()
	if (evCol && rows.length > 0) {
		const actorIds = rows.map((r) => String(r.actor_id ?? '')).filter(Boolean)
		if (actorIds.length > 0) {
			const inList = actorIds.map(sqlLiteral).join(', ')
			const qEv = quoteIdent(evCol)
			const freqSql = `SELECT ${actorExpr} AS actor_id, CAST(${qEv} AS TEXT) AS ev, COUNT(*) AS n
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')} AND ${actorExpr} IN (${inList}) AND ${qEv} IS NOT NULL
GROUP BY 1, 2`
			const freqRows = await execReadOnly(adapter, freqSql, 10_000, req.queryId)
			const countsByActor = new Map<string, Map<string, number>>()
			for (const fr of freqRows) {
				const aid = String(fr.actor_id ?? '')
				const rawEv = String(fr.ev ?? '')
				if (!aid || !rawEv) continue
				const key = req.normalizeUrls ? normalizeEventName(rawEv) : rawEv
				let m = countsByActor.get(aid)
				if (!m) {
					m = new Map<string, number>()
					countsByActor.set(aid, m)
				}
				m.set(key, (m.get(key) ?? 0) + Number(fr.n ?? 0))
			}
			for (const [aid, m] of countsByActor) {
				let bestEv = ''
				let bestN = -1
				for (const [ev, n] of m) {
					if (n > bestN) {
						bestN = n
						bestEv = ev
					}
				}
				if (bestEv) topEventByActor.set(aid, bestEv)
			}
		}
	}

	const actors: ActorSummary[] = rows.map((r) => {
		const actorId = String(r.actor_id ?? '')
		return {
			actorId,
			userId: r.user_id ? String(r.user_id) : null,
			visitorId: r.visitor_id ? String(r.visitor_id) : null,
			eventCount: Number(r.event_count ?? 0),
			activeDays: Number(r.active_days ?? 0),
			errorCount: Number(r.errors ?? 0),
			firstSeenMs: Number(r.first_seen ?? 0),
			lastSeenMs: Number(r.last_seen ?? 0),
			topEvent: topEventByActor.get(actorId) ?? null,
		}
	})

	return {
		actors,
		sql,
		durationMs: Math.round(performance.now() - started),
	}
}

export async function runAnalyticsActorJourney(
	adapter: DbAdapter,
	driver: DriverKind,
	schema: DatabaseSchema,
	req: ActorJourneyRequest,
): Promise<ActorJourneyResponse> {
	const started = performance.now()
	const ts = assertValidTable(schema, req.table)
	assertValidColumn(ts, req.timeColumn)
	if (!req.actorId?.trim()) throw new Error('actorId is required')

	const qTable = quoteTable(ts.name, driver)
	const uCol = optionalColumn(ts, req.userIdColumn)
	const vCol = optionalColumn(ts, req.visitorIdColumn)
	const evCol = optionalColumn(ts, req.eventColumn)
	const statusCol = optionalColumn(ts, req.statusColumn)
	const payloadCol = optionalColumn(ts, req.payloadColumn)
	const pkCol = ts.primaryKeyColumns[0] ? optionalColumn(ts, ts.primaryKeyColumns[0]) : null

	const lit = sqlLiteral(req.actorId.trim())
	const actorMatch: string[] = []
	if (req.actorColumn === STITCHED_ACTOR_SENTINEL && uCol && vCol) {
		actorMatch.push(`CAST(${quoteIdent(uCol)} AS TEXT) = ${lit}`, `CAST(${quoteIdent(vCol)} AS TEXT) = ${lit}`)
	} else {
		const single = optionalColumn(ts, req.actorColumn) ?? uCol ?? vCol
		if (!single) throw new Error('Actor column is required')
		actorMatch.push(`CAST(${quoteIdent(single)} AS TEXT) = ${lit}`)
		if (uCol && uCol !== single) actorMatch.push(`CAST(${quoteIdent(uCol)} AS TEXT) = ${lit}`)
		if (vCol && vCol !== single) actorMatch.push(`CAST(${quoteIdent(vCol)} AS TEXT) = ${lit}`)
	}

	const { startMs, endMs } = await resolveTimeWindow(adapter, driver, ts, req)
	const whereClauses = [
		...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs, endMs, driver),
		...buildFilterWhere(ts, req.filters, driver),
		`(${actorMatch.join(' OR ')})`,
	]
	const limit = Math.max(20, Math.min(500, req.limit ?? 250))

	const sql = `SELECT ${pkCol ? `CAST(${quoteIdent(pkCol)} AS TEXT)` : 'NULL'} AS id,
	${timeToMsExpr(req.timeColumn, req.timeFormat, driver)} AS ts_ms,
	${evCol ? `CAST(${quoteIdent(evCol)} AS TEXT)` : sqlLiteral(ts.name)} AS ev,
	${statusCol ? safeStatusIntExpr(statusCol, driver) : 'NULL'} AS status,
	${payloadCol ? `CAST(${quoteIdent(payloadCol)} AS TEXT)` : 'NULL'} AS data,
	${uCol ? `NULLIF(CAST(${quoteIdent(uCol)} AS TEXT), '')` : 'NULL'} AS uid,
	${vCol ? `NULLIF(CAST(${quoteIdent(vCol)} AS TEXT), '')` : 'NULL'} AS vid
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')}
ORDER BY ${quoteIdent(req.timeColumn)} DESC
LIMIT ${limit}`

	const rows = await execReadOnly(adapter, sql, limit, req.queryId)
	const events = rows.map((r) => {
		const rawEv = String(r.ev ?? '')
		return {
			id: r.id ? String(r.id) : null,
			tsMs: Number(r.ts_ms ?? 0),
			event: req.normalizeUrls ? normalizeEventName(rawEv) : rawEv,
			rawEvent: rawEv,
			status:
				r.status !== null && r.status !== undefined && Number.isFinite(Number(r.status)) ? Number(r.status) : null,
			data: r.data !== null && r.data !== undefined ? String(r.data) : null,
			userId: r.uid ? String(r.uid) : null,
			visitorId: r.vid ? String(r.vid) : null,
		}
	})

	return {
		actorId: req.actorId.trim(),
		events,
		sql,
		durationMs: Math.round(performance.now() - started),
	}
}

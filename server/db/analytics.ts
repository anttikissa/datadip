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
	buildIdentityResolver,
	computeFunnel,
	computeRetention,
	detectBestAnalyticsTable,
	detectTableColumns,
	floorBucketMs,
	type FunnelRequest,
	type FunnelResponse,
	generateBuckets,
	inferTimeFormat,
	looksLikeHttpEventList,
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

function timeToMsExpr(timeCol: string, format: TimeColumnFormat, driver: DriverKind): string {
	const q = quoteIdent(timeCol)
	if (format === 'epoch_ms') {
		return `CAST(${q} AS ${driver === 'postgres' ? 'BIGINT' : 'INTEGER'})`
	}
	if (format === 'epoch_s') {
		return `(CAST(${q} AS ${driver === 'postgres' ? 'BIGINT' : 'INTEGER'}) * 1000)`
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
		else if (format === 'epoch_s') clauses.push(`${q} >= ${Math.floor(startMs / 1000)}`)
		else if (driver === 'postgres') clauses.push(`${q} >= ${sqlLiteral(new Date(startMs).toISOString())}::timestamptz`)
		else clauses.push(`${q} >= ${sqlLiteral(new Date(startMs).toISOString().slice(0, 19).replace('T', ' '))}`)
	}
	if (endMs !== null) {
		if (format === 'epoch_ms') clauses.push(`${q} <= ${Math.ceil(endMs)}`)
		else if (format === 'epoch_s') clauses.push(`${q} <= ${Math.ceil(endMs / 1000)}`)
		else if (driver === 'postgres') clauses.push(`${q} <= ${sqlLiteral(new Date(endMs).toISOString())}::timestamptz`)
		else clauses.push(`${q} <= ${sqlLiteral(new Date(endMs).toISOString())}`)
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
	let totalRows = summary?.rowCount ?? 0
	let timeFormat: TimeColumnFormat = 'iso'
	let minTimeMs: number | null = null
	let maxTimeMs: number | null = null

	if (cols.timeColumn) {
		const qTime = quoteIdent(cols.timeColumn)
		const colMeta = ts.columns.find((c) => c.name === cols.timeColumn)
		const rows = await execReadOnly(
			adapter,
			`SELECT MIN(${qTime}) AS mn, MAX(${qTime}) AS mx, COUNT(*) AS n FROM ${qTable} WHERE ${qTime} IS NOT NULL`,
			1,
		)
		const r = rows[0]
		if (r) {
			timeFormat = inferTimeFormat(r.mx ?? r.mn, colMeta?.type ?? '')
			minTimeMs = parseTimestampToMs(r.mn, timeFormat)
			maxTimeMs = parseTimestampToMs(r.mx, timeFormat)
			if (r.n !== undefined && r.n !== null) totalRows = Number(r.n) || totalRows
		}
	}

	let topEvents: AnalyticsTopEvent[] = []
	let looksLikeHttpEvents = false
	if (cols.eventColumn) {
		const qEv = quoteIdent(cols.eventColumn)
		const actorExpr = buildActorExpr(ts, cols.defaultActorColumn, cols.userIdColumn, cols.visitorIdColumn)
		const actorSelect = actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'
		const evRows = await execReadOnly(
			adapter,
			`SELECT CAST(${qEv} AS TEXT) AS ev, COUNT(*) AS n${actorSelect} FROM ${qTable} WHERE ${qEv} IS NOT NULL GROUP BY ${qEv} ORDER BY n DESC LIMIT 40`,
			40,
		)
		topEvents = evRows.map((r) => ({
			event: String(r.ev ?? ''),
			count: Number(r.n ?? 0),
			uniqueActors: Number(r.actors ?? 0),
		}))
		looksLikeHttpEvents = looksLikeHttpEventList(topEvents.map((e) => e.event))
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

	const baseFilters = buildFilterWhere(ts, req.filters, driver)
	const rangeWhere = [...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs, endMs, driver), ...baseFilters]
	const whereSql = rangeWhere.length > 0 ? `WHERE ${rangeWhere.join(' AND ')}` : ''

	const actorExpr = buildActorExpr(ts, req.actorColumn, req.userIdColumn, req.visitorIdColumn)
	const statusCol = optionalColumn(ts, req.statusColumn)
	const eventCol = optionalColumn(ts, req.eventColumn)
	const breakdownCol = optionalColumn(ts, req.breakdownColumn)
	const normUrls = Boolean(req.normalizeUrls && eventCol && breakdownCol === eventCol)

	const bExpr = bucketMsExpr(req.timeColumn, req.timeFormat, req.interval, driver)

	// 1. KPIs + Previous-period comparison
	const errorExpr = statusCol
		? `SUM(CASE WHEN CAST(${quoteIdent(statusCol)} AS INTEGER) >= 400 THEN 1 ELSE 0 END) AS errors`
		: 'NULL AS errors'
	const kpiSql = `SELECT COUNT(*) AS total, ${actorExpr ? `COUNT(DISTINCT ${actorExpr})` : '0'} AS actors, ${errorExpr} FROM ${qTable} ${whereSql}`
	const kpiRows = await execReadOnly(adapter, kpiSql, 1, req.queryId)
	const totalEvents = Number(kpiRows[0]?.total ?? 0)
	const uniqueActors = Number(kpiRows[0]?.actors ?? 0)
	const errorCount = statusCol ? Number(kpiRows[0]?.errors ?? 0) : null

	let prevPeriodEvents: number | null = null
	let deltaPct: number | null = null
	const dur = rangeToDurationMs(req.range)
	if (dur !== null) {
		const prevWhere = [
			...buildTimeRangeWhere(req.timeColumn, req.timeFormat, startMs - dur, startMs - 1, driver),
			...baseFilters,
		]
		const prevRows = await execReadOnly(
			adapter,
			`SELECT COUNT(*) AS total FROM ${qTable} WHERE ${prevWhere.join(' AND ')}`,
			1,
			req.queryId,
		)
		prevPeriodEvents = Number(prevRows[0]?.total ?? 0)
		if (prevPeriodEvents > 0) {
			deltaPct = Number((((totalEvents - prevPeriodEvents) / prevPeriodEvents) * 100).toFixed(1))
		}
	}

	// 2. Bucketed series SQL
	const topN = Math.max(1, Math.min(12, req.topN ?? 6))
	const selectedSet = req.selectedEvents && req.selectedEvents.length > 0 ? new Set(req.selectedEvents) : null

	let mainSql = ''
	const series: TrendsSeries[] = []

	if (!breakdownCol) {
		mainSql = `SELECT ${bExpr} AS bucket, COUNT(*) AS events${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1
ORDER BY 1 ASC`
		const rows = await execReadOnly(adapter, mainSql, 1000, req.queryId)
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
		series.push({ key: '__all__', label, values, total })
	} else {
		const qBreak = quoteIdent(breakdownCol)
		mainSql = `SELECT ${bExpr} AS bucket, COALESCE(CAST(${qBreak} AS TEXT), '(null)') AS grp, COUNT(*) AS events${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1, 2
ORDER BY 1 ASC`
		const rows = await execReadOnly(adapter, mainSql, 25_000, req.queryId)

		// Aggregate by group (optionally normalizing URL routes)
		const grpEvents = new Map<string, number[]>()
		const grpActors = new Map<string, number[]>()
		const grpTotals = new Map<string, number>()

		for (const r of rows) {
			const bMs = floorBucketMs(Number(r.bucket), req.interval)
			const idx = bucketIdx.get(bMs)
			if (idx === undefined) continue
			const rawKey = String(r.grp ?? '(null)')
			const key = normUrls ? normalizeEventName(rawKey) : rawKey
			if (selectedSet && !selectedSet.has(key) && !selectedSet.has(rawKey)) continue

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

		for (const [key, total] of keep) {
			const evArr = grpEvents.get(key)!
			const acArr = grpActors.get(key)!
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
			series.push({ key, label: key, values, total })
		}

		if (rest.length > 0 && req.metric !== 'events_per_actor') {
			const otherVals = new Array<number>(buckets.length).fill(0)
			let otherTotal = 0
			for (const [key, total] of rest) {
				const arr = req.metric === 'unique_actors' ? grpActors.get(key)! : grpEvents.get(key)!
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
			series.push({ key: '__other__', label: `Other (${rest.length})`, values: otherVals, total: otherTotal })
		}
	}

	// 3. Top events breakdown with sparklines (when eventColumn is present)
	const topEvents: AnalyticsTopEvent[] = []
	if (eventCol) {
		const qEv = quoteIdent(eventCol)
		const topSql = `SELECT ${bExpr} AS bucket, COALESCE(CAST(${qEv} AS TEXT), '(null)') AS ev, COUNT(*) AS n${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1, 2`
		const evRows = await execReadOnly(adapter, topSql, 25_000, req.queryId)

		const evMap = new Map<string, { count: number; actors: number; spark: number[] }>()
		// Also compute accurate overall distinct actors per event
		const overallActorsSql = `SELECT COALESCE(CAST(${qEv} AS TEXT), '(null)') AS ev, COUNT(*) AS n${actorExpr ? `, COUNT(DISTINCT ${actorExpr}) AS actors` : ', 0 AS actors'}
FROM ${qTable}
${whereSql}
GROUP BY 1
ORDER BY n DESC
LIMIT 200`
		const overallRows = await execReadOnly(adapter, overallActorsSql, 200, req.queryId)
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
		for (const r of evRows) {
			const raw = String(r.ev ?? '(null)')
			const key = norm ? normalizeEventName(raw) : raw
			const entry = evMap.get(key)
			if (!entry) continue
			const bMs = floorBucketMs(Number(r.bucket), req.interval)
			const idx = bucketIdx.get(bMs)
			if (idx === undefined) continue
			const sIdx = Math.min(sparkLen - 1, Math.floor((idx / Math.max(1, buckets.length)) * sparkLen))
			entry.spark[sIdx] = (entry.spark[sIdx] ?? 0) + Number(r.n ?? 0)
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
		`${qEv} IS NOT NULL`,
	]

	// When stitching visitor_id -> user_id, we also need co-occurrence links (or fetch events matching steps + stitch links)
	const stitch = Boolean(req.stitchIdentity && uCol && vCol)
	const stepPredicates: string[] = []
	for (const step of req.steps) {
		const pat = step.pattern.trim()
		if (!pat) continue
		if (step.match === 'exact' && !req.normalizeUrls) {
			stepPredicates.push(`CAST(${qEv} AS TEXT) = ${sqlLiteral(pat)}`)
		} else if (step.match === 'prefix' && !req.normalizeUrls) {
			stepPredicates.push(`CAST(${qEv} AS TEXT) LIKE ${sqlLiteral(pat + '%')}`)
		} else if (!req.normalizeUrls) {
			stepPredicates.push(
				driver === 'postgres'
					? `CAST(${qEv} AS TEXT) ILIKE ${sqlLiteral('%' + pat + '%')}`
					: `CAST(${qEv} AS TEXT) LIKE ${sqlLiteral('%' + pat + '%')}`,
			)
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
	if (stepPredicates.length > 0 && !req.normalizeUrls) {
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

	const sql = `SELECT DISTINCT ${selectCols.join(', ')}
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')}
LIMIT 120000`

	const rows = await execReadOnly(adapter, sql, 120_000, req.queryId)

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
		`${actorExpr} IS NOT NULL`,
	]
	if (req.search?.trim()) {
		const pat = `%${req.search.trim()}%`
		whereClauses.push(
			driver === 'postgres' ? `${actorExpr} ILIKE ${sqlLiteral(pat)}` : `${actorExpr} LIKE ${sqlLiteral(pat)}`,
		)
	}

	const msExpr = timeToMsExpr(req.timeColumn, req.timeFormat, driver)
	const dayBucket = bucketMsExpr(req.timeColumn, req.timeFormat, 'day', driver)
	const errSelect = statusCol
		? `SUM(CASE WHEN CAST(${quoteIdent(statusCol)} AS INTEGER) >= 400 THEN 1 ELSE 0 END) AS errors`
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
	MAX(${msExpr}) AS last_seen,
	${evCol ? `MAX(CAST(${quoteIdent(evCol)} AS TEXT))` : 'NULL'} AS sample_event
FROM ${qTable}
WHERE ${whereClauses.join(' AND ')}
GROUP BY 1
ORDER BY ${orderSql}
LIMIT ${limit}`

	const rows = await execReadOnly(adapter, sql, limit, req.queryId)
	const actors: ActorSummary[] = rows.map((r) => ({
		actorId: String(r.actor_id ?? ''),
		userId: r.user_id ? String(r.user_id) : null,
		visitorId: r.visitor_id ? String(r.visitor_id) : null,
		eventCount: Number(r.event_count ?? 0),
		activeDays: Number(r.active_days ?? 0),
		errorCount: Number(r.errors ?? 0),
		firstSeenMs: Number(r.first_seen ?? 0),
		lastSeenMs: Number(r.last_seen ?? 0),
		topEvent: r.sample_event
			? req.normalizeUrls
				? normalizeEventName(String(r.sample_event))
				: String(r.sample_event)
			: null,
	}))

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
	${statusCol ? `CAST(${quoteIdent(statusCol)} AS INTEGER)` : 'NULL'} AS status,
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

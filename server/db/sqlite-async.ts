// Shared async SQLite DbAdapter engine used by Turso/libSQL, Cloudflare D1, and remote sqlite3 CLI runners.
import { detectSourceTable } from '../../src/shared/sql.ts'
import type {
	BrowseParams,
	BrowseResult,
	ColumnInfo,
	ColumnProfile,
	DatabaseInfo,
	DatabaseSchema,
	FilterSpec,
	ForeignKeyInfo,
	IdMatch,
	IndexInfo,
	MutateRequest,
	MutateResponse,
	OrderSpec,
	QueryStatementResult,
	ReverseFkCount,
	ReverseForeignKeyInfo,
	TableSchema,
	TableSummary,
	TriggerInfo,
} from '../../src/shared/types.ts'
import { coerceParam, normalizeCellValue, quoteIdent } from './sqlite-ops.ts'
import type { DbAdapter } from './types.ts'

export interface SqliteQueryResult {
	columns: string[]
	rows: Record<string, unknown>[]
	changes: number
	lastInsertRowid: string | number | null
}

export interface SqliteStatementSpec {
	sql: string
	params?: unknown[]
}

export interface SqliteQueryRunner {
	readonly runtimeName: string
	query(sql: string, params?: unknown[], opts?: { writable?: boolean; queryId?: string }): Promise<SqliteQueryResult>
	batch?(
		stmts: SqliteStatementSpec[],
		opts?: { writable?: boolean; transactional?: boolean; queryId?: string },
	): Promise<SqliteQueryResult[]>
	cancelQuery?(queryId: string): Promise<boolean>
	getExtraInfo?(): Partial<DatabaseInfo>
	supportsMaintenance?: boolean
	close(): void
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(row)) {
		out[k] = normalizeCellValue(v)
	}
	return out
}

export function sqlLiteral(val: unknown): string {
	if (val === null || val === undefined) return 'NULL'
	if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL'
	if (typeof val === 'bigint') return val.toString()
	if (typeof val === 'boolean') return val ? '1' : '0'
	if (val instanceof Uint8Array) {
		const hex = Array.from(val, (b) => b.toString(16).padStart(2, '0')).join('')
		return `X'${hex}'`
	}
	return `'${String(val).replaceAll("'", "''")}'`
}

// Substitutes positional `?` placeholders outside quotes/comments with safely escaped SQLite literals (for CLI runners).
export function formatSqlWithParams(sql: string, params: unknown[] = []): string {
	if (params.length === 0) return sql
	let out = ''
	let idx = 0
	let i = 0
	while (i < sql.length) {
		const ch = sql[i]!
		if (ch === "'" || ch === '"' || ch === '`') {
			const quote = ch
			out += ch
			i++
			while (i < sql.length) {
				const c = sql[i]!
				out += c
				i++
				if (c === quote) {
					if (sql[i] === quote) {
						out += sql[i]!
						i++
					} else {
						break
					}
				}
			}
			continue
		}
		if (ch === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i)
			if (nl === -1) {
				out += sql.slice(i)
				break
			}
			out += sql.slice(i, nl + 1)
			i = nl + 1
			continue
		}
		if (ch === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2)
			if (end === -1) {
				out += sql.slice(i)
				break
			}
			out += sql.slice(i, end + 2)
			i = end + 2
			continue
		}
		if (ch === '?' && idx < params.length) {
			out += sqlLiteral(params[idx++])
			i++
			continue
		}
		out += ch
		i++
	}
	return out
}

function buildWhereClause(
	filters: FilterSpec[] | undefined,
	search: string | undefined,
	colMap: Map<string, ColumnInfo>,
): { clauses: string[]; bindings: (string | number)[] } {
	const clauses: string[] = []
	const bindings: (string | number)[] = []

	for (const f of filters ?? []) {
		const col = colMap.get(f.column)
		if (!col) throw new Error(`Unknown column in filter: ${f.column}`)
		const qCol = quoteIdent(col.name)
		switch (f.op) {
			case 'eq':
				clauses.push(`${qCol} = ?`)
				bindings.push(coerceParam(f.value, col.type))
				break
			case 'neq':
				clauses.push(`${qCol} != ?`)
				bindings.push(coerceParam(f.value, col.type))
				break
			case 'gt':
				clauses.push(`${qCol} > ?`)
				bindings.push(coerceParam(f.value, col.type))
				break
			case 'gte':
				clauses.push(`${qCol} >= ?`)
				bindings.push(coerceParam(f.value, col.type))
				break
			case 'lt':
				clauses.push(`${qCol} < ?`)
				bindings.push(coerceParam(f.value, col.type))
				break
			case 'lte':
				clauses.push(`${qCol} <= ?`)
				bindings.push(coerceParam(f.value, col.type))
				break
			case 'like':
				clauses.push(`CAST(${qCol} AS TEXT) LIKE ?`)
				bindings.push(f.value.includes('%') || f.value.includes('_') ? f.value : `%${f.value}%`)
				break
			case 'in': {
				const parts = f.value
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
				if (parts.length > 0) {
					clauses.push(`${qCol} IN (${parts.map(() => '?').join(', ')})`)
					for (const p of parts) bindings.push(coerceParam(p, col.type))
				}
				break
			}
			case 'isnull':
				clauses.push(`${qCol} IS NULL`)
				break
			case 'notnull':
				clauses.push(`${qCol} IS NOT NULL`)
				break
		}
	}

	if (search && search.trim()) {
		const pattern = `%${search.trim()}%`
		const colChecks: string[] = []
		for (const col of colMap.values()) {
			colChecks.push(`CAST(${quoteIdent(col.name)} AS TEXT) LIKE ?`)
			bindings.push(pattern)
		}
		if (colChecks.length > 0) clauses.push(`(${colChecks.join(' OR ')})`)
	}

	return { clauses, bindings }
}

const FTS_SUFFIXES = ['_content', '_data', '_docsize', '_idx', '_config', '_segments', '_segdir', '_stat']
const RTREE_SUFFIXES = ['_node', '_rowid', '_parent']

export class AsyncSqliteAdapter implements DbAdapter {
	readonly driver = 'sqlite' as const
	readonly runner: SqliteQueryRunner
	private cachedSchema: DatabaseSchema | null = null

	constructor(runner: SqliteQueryRunner) {
		this.runner = runner
	}

	private async queryRows(sql: string, params?: unknown[], writable = false): Promise<Record<string, unknown>[]> {
		const res = await this.runner.query(sql, params, { writable })
		return res.rows.map(normalizeRow)
	}

	private async getSchemaCached(): Promise<DatabaseSchema> {
		if (this.cachedSchema) return this.cachedSchema
		return this.getSchema()
	}

	async ping() {
		const t0 = performance.now()
		const res = await this.runner.query('SELECT sqlite_version() AS v')
		const version = String(res.rows[0]?.v ?? '')
		return {
			ok: true as const,
			latencyMs: Math.round((performance.now() - t0) * 100) / 100,
			version: version || undefined,
		}
	}

	async getSchema(): Promise<DatabaseSchema> {
		const t0 = performance.now()
		const masterRows = await this.queryRows(
			`SELECT name, type, sql
			 FROM sqlite_master
			 WHERE type IN ('table', 'view')
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE '_cf_%'
			   AND name NOT LIKE 'libsql_%'
			 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE`,
		)

		let skipSlowCounts = false
		try {
			const pcRows = await this.queryRows('PRAGMA page_count')
			const psRows = await this.queryRows('PRAGMA page_size')
			const pc = Number(Object.values(pcRows[0] ?? {})[0] ?? 0)
			const ps = Number(Object.values(psRows[0] ?? {})[0] ?? 4096)
			if (Number.isFinite(pc) && Number.isFinite(ps)) {
				skipSlowCounts = pc * ps > 50 * 1024 * 1024
			}
		} catch {}

		const statCounts = new Map<string, number>()
		try {
			const hasStat = await this.queryRows(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`,
			)
			if (hasStat.length > 0) {
				const statRows = await this.queryRows('SELECT tbl, stat FROM sqlite_stat1')
				for (const r of statRows) {
					const n = Number(String(r.stat ?? '').split(' ')[0])
					if (Number.isFinite(n) && typeof r.tbl === 'string' && !statCounts.has(r.tbl)) {
						statCounts.set(r.tbl, n)
					}
				}
			}
		} catch {}

		const shadowTables = new Set<string>()
		for (const m of masterRows) {
			const name = String(m.name ?? '')
			const ddl = String(m.sql ?? '')
			if (/^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+fts[345]\b/i.test(ddl)) {
				for (const suf of FTS_SUFFIXES) shadowTables.add(`${name}${suf}`)
			} else if (/^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+rtree/i.test(ddl)) {
				for (const suf of RTREE_SUFFIXES) shadowTables.add(`${name}${suf}`)
			}
		}

		const triggerRows = await this.queryRows(
			`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name COLLATE NOCASE, name COLLATE NOCASE`,
		).catch(() => [])
		const triggers: TriggerInfo[] = triggerRows.map((tr) => ({
			name: String(tr.name ?? ''),
			table: String(tr.tbl_name ?? ''),
			sql: String(tr.sql ?? ''),
		}))
		const triggersByTable = new Map<string, TriggerInfo[]>()
		for (const tr of triggers) {
			const list = triggersByTable.get(tr.table) ?? []
			list.push(tr)
			triggersByTable.set(tr.table, list)
		}

		const tables: TableSummary[] = []
		const schemas: Record<string, TableSchema> = {}

		// Batch metadata queries when runner supports pipelined batch() (huge speedup for Turso HTTP!)
		for (const m of masterRows) {
			const name = String(m.name ?? '')
			const type: 'table' | 'view' = m.type === 'view' ? 'view' : 'table'
			const ddl = String(m.sql ?? '')
			const qName = quoteIdent(name)

			let colRows: Record<string, unknown>[] = []
			let fkRows: Record<string, unknown>[] = []
			let idxRows: Record<string, unknown>[] = []
			let rowCount: number | null = null

			if (this.runner.batch && type === 'table') {
				const stmts: SqliteStatementSpec[] = [
					{ sql: `PRAGMA table_info(${qName})` },
					{ sql: `PRAGMA foreign_key_list(${qName})` },
					{ sql: `PRAGMA index_list(${qName})` },
				]
				if (!skipSlowCounts) stmts.push({ sql: `SELECT COUNT(*) AS c FROM ${qName}` })
				try {
					const batchRes = await this.runner.batch(stmts, { writable: false, transactional: false })
					colRows = (batchRes[0]?.rows ?? []).map(normalizeRow)
					fkRows = (batchRes[1]?.rows ?? []).map(normalizeRow)
					idxRows = (batchRes[2]?.rows ?? []).map(normalizeRow)
					if (!skipSlowCounts) {
						const cVal = Number(batchRes[3]?.rows[0]?.c)
						rowCount = Number.isFinite(cVal) ? cVal : null
					} else {
						rowCount = statCounts.get(name) ?? null
					}
				} catch {
					colRows = await this.queryRows(`PRAGMA table_info(${qName})`).catch(() => [])
					fkRows = await this.queryRows(`PRAGMA foreign_key_list(${qName})`).catch(() => [])
					idxRows = await this.queryRows(`PRAGMA index_list(${qName})`).catch(() => [])
				}
			} else {
				colRows = await this.queryRows(`PRAGMA table_info(${qName})`).catch(() => [])
				if (type === 'table') {
					fkRows = await this.queryRows(`PRAGMA foreign_key_list(${qName})`).catch(() => [])
					idxRows = await this.queryRows(`PRAGMA index_list(${qName})`).catch(() => [])
					if (skipSlowCounts) {
						rowCount = statCounts.get(name) ?? null
					} else {
						try {
							const cRows = await this.queryRows(`SELECT COUNT(*) AS c FROM ${qName}`)
							const cVal = Number(cRows[0]?.c)
							rowCount = Number.isFinite(cVal) ? cVal : 0
						} catch {
							rowCount = null
						}
					}
				}
			}

			const columns: ColumnInfo[] = colRows.map((c) => ({
				name: String(c.name ?? ''),
				type: String(c.type || 'ANY'),
				notNull: Boolean(Number(c.notnull ?? 0)),
				defaultValue: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
				primaryKey: Number(c.pk ?? 0),
			}))

			const primaryKeyColumns = columns
				.filter((c) => c.primaryKey > 0)
				.sort((a, b) => a.primaryKey - b.primaryKey)
				.map((c) => c.name)

			const foreignKeys: ForeignKeyInfo[] = fkRows.map((fk) => ({
				id: Number(fk.id ?? 0),
				fromColumn: String(fk.from ?? ''),
				toTable: String(fk.table ?? ''),
				toColumn: String(fk.to || 'id'),
				onUpdate: String(fk.on_update ?? 'NO ACTION'),
				onDelete: String(fk.on_delete ?? 'NO ACTION'),
			}))

			const indexes: IndexInfo[] = []
			if (idxRows.length > 0) {
				if (this.runner.batch) {
					const idxInfoRes = await this.runner
						.batch(
							idxRows.map((idx) => ({ sql: `PRAGMA index_info(${quoteIdent(String(idx.name ?? ''))})` })),
							{ writable: false, transactional: false },
						)
						.catch(() => null)
					for (let i = 0; i < idxRows.length; i++) {
						const idx = idxRows[i]!
						const idxName = String(idx.name ?? '')
						const cols = (idxInfoRes?.[i]?.rows ?? []).map((r) => String(r.name ?? '')).filter(Boolean)
						indexes.push({
							name: idxName,
							unique: Boolean(Number(idx.unique ?? 0)),
							origin: String(idx.origin ?? ''),
							columns: cols,
						})
					}
				} else {
					for (const idx of idxRows) {
						const idxName = String(idx.name ?? '')
						const infoRows = await this.queryRows(`PRAGMA index_info(${quoteIdent(idxName)})`).catch(() => [])
						indexes.push({
							name: idxName,
							unique: Boolean(Number(idx.unique ?? 0)),
							origin: String(idx.origin ?? ''),
							columns: infoRows.map((r) => String(r.name ?? '')).filter(Boolean),
						})
					}
				}
			}

			const isInternal = shadowTables.has(name)
			tables.push({ name, type, rowCount, ...(isInternal ? { isInternal: true } : {}) })
			schemas[name] = {
				name,
				type,
				ddl,
				columns,
				foreignKeys,
				reverseForeignKeys: [],
				indexes,
				primaryKeyColumns,
				triggers: triggersByTable.get(name) ?? [],
			}
		}

		for (const s of Object.values(schemas)) {
			for (const fk of s.foreignKeys) {
				const target = schemas[fk.toTable]
				if (target) {
					target.reverseForeignKeys.push({
						fromTable: s.name,
						fromColumn: fk.fromColumn,
						toColumn: fk.toColumn,
					})
				}
			}
		}

		const result: DatabaseSchema = {
			tables,
			schemas,
			triggers,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
		}
		this.cachedSchema = result
		return result
	}

	async browseTable(params: BrowseParams): Promise<BrowseResult> {
		const t0 = performance.now()
		const schema = await this.getSchemaCached()
		const tableSchema = schema.schemas[params.table]
		if (!tableSchema) throw new Error(`Table or view not found: ${params.table}`)

		const colMap = new Map(tableSchema.columns.map((c) => [c.name, c]))
		const selectedCols =
			params.fields && params.fields.length > 0
				? params.fields.filter((f) => colMap.has(f))
				: tableSchema.columns.map((c) => c.name)
		if (selectedCols.length === 0) throw new Error(`No valid columns selected for ${params.table}`)

		const validOrders: OrderSpec[] = (params.order ?? []).filter((o) => colMap.has(o.column))
		if (validOrders.length === 0 && tableSchema.primaryKeyColumns.length > 0) {
			validOrders.push({ column: tableSchema.primaryKeyColumns[0]!, dir: 'asc' })
		}

		const singleUniqueCols = new Set<string>()
		if (tableSchema.primaryKeyColumns.length === 1) singleUniqueCols.add(tableSchema.primaryKeyColumns[0]!)
		for (const idx of tableSchema.indexes) {
			if (idx.unique && idx.columns.length === 1) singleUniqueCols.add(idx.columns[0]!)
		}
		const keysetCol =
			validOrders.length === 1 && singleUniqueCols.has(validOrders[0]!.column) ? validOrders[0]!.column : null
		const keysetDir = validOrders[0]?.dir ?? 'asc'

		const { clauses, bindings } = buildWhereClause(params.filters, params.search, colMap)
		const qTable = quoteIdent(tableSchema.name)

		let totalCount: number | null = null
		try {
			const countSql =
				`SELECT COUNT(*) AS c FROM ${qTable}` + (clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '')
			const cRows = await this.queryRows(countSql, bindings)
			const cVal = Number(cRows[0]?.c)
			totalCount = Number.isFinite(cVal) ? cVal : 0
		} catch {
			totalCount = null
		}

		const fetchCols = keysetCol && !selectedCols.includes(keysetCol) ? [...selectedCols, keysetCol] : selectedCols
		const selectSql = fetchCols.map(quoteIdent).join(', ')
		const rowClauses = [...clauses]
		const rowBindings = [...bindings]
		const limit = Math.max(1, Math.min(2000, params.limit || 100))
		const isPrev = params.direction === 'prev'

		let orderSql = ''
		let offsetSql = ''
		if (keysetCol && params.start !== undefined && params.start !== null && params.start !== '') {
			const col = colMap.get(keysetCol)!
			const cursorVal = coerceParam(params.start, col.type)
			if (isPrev) {
				rowClauses.push(`${quoteIdent(keysetCol)} ${keysetDir === 'asc' ? '<' : '>'} ?`)
				rowBindings.push(cursorVal)
				orderSql = ` ORDER BY ${quoteIdent(keysetCol)} ${keysetDir === 'asc' ? 'DESC' : 'ASC'}`
			} else {
				rowClauses.push(`${quoteIdent(keysetCol)} ${keysetDir === 'asc' ? '>' : '<'} ?`)
				rowBindings.push(cursorVal)
				orderSql = ` ORDER BY ${quoteIdent(keysetCol)} ${keysetDir.toUpperCase()}`
			}
		} else {
			if (validOrders.length > 0) {
				orderSql = ' ORDER BY ' + validOrders.map((o) => `${quoteIdent(o.column)} ${o.dir.toUpperCase()}`).join(', ')
			}
			if (params.offset && params.offset > 0) offsetSql = ` OFFSET ${Math.floor(params.offset)}`
		}

		const whereSql = rowClauses.length > 0 ? ` WHERE ${rowClauses.join(' AND ')}` : ''
		const sql = `SELECT ${selectSql} FROM ${qTable}${whereSql}${orderSql} LIMIT ${limit + 1}${offsetSql}`
		const rawRows = await this.queryRows(sql, rowBindings)

		const hasMore = rawRows.length > limit
		let rows = hasMore ? rawRows.slice(0, limit) : rawRows
		if (keysetCol && params.start && isPrev) rows = rows.reverse()

		let hasNext = false
		let hasPrev = false
		let nextCursor: string | null = null
		let prevCursor: string | null = null

		if (keysetCol && rows.length > 0) {
			const firstKey = rows[0]![keysetCol]
			const lastKey = rows[rows.length - 1]![keysetCol]
			if (params.start) {
				hasPrev = isPrev ? hasMore : true
				hasNext = isPrev ? true : hasMore
			} else {
				hasPrev = false
				hasNext = hasMore
			}
			nextCursor = hasNext && lastKey !== null && lastKey !== undefined ? String(lastKey) : null
			prevCursor = hasPrev && firstKey !== null && firstKey !== undefined ? String(firstKey) : null
		} else {
			hasPrev = (params.offset ?? 0) > 0
			hasNext = hasMore
		}

		if (fetchCols.length !== selectedCols.length && keysetCol) {
			rows = rows.map((r) => {
				const copy = { ...r }
				delete copy[keysetCol]
				return copy
			})
		}

		const columnTypes: Record<string, string> = {}
		for (const c of selectedCols) columnTypes[c] = colMap.get(c)?.type ?? 'ANY'

		return {
			table: tableSchema.name,
			columns: selectedCols,
			columnTypes,
			rows,
			totalCount,
			hasNext,
			hasPrev,
			nextCursor,
			prevCursor,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
			generatedSql: sql,
			keysetColumn: keysetCol,
		}
	}

	async executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number; queryId?: string },
	): Promise<QueryStatementResult[]> {
		const maxRows = options.maxRows ?? 2000
		const results: QueryStatementResult[] = []

		for (const rawSql of statements) {
			const sql = rawSql.trim()
			if (!sql) continue
			const t0 = performance.now()
			try {
				const res = await this.runner.query(sql, undefined, {
					writable: options.writable,
					queryId: options.queryId,
				})
				if (res.columns.length > 0) {
					const truncated = res.rows.length > maxRows
					const sliced = (truncated ? res.rows.slice(0, maxRows) : res.rows).map(normalizeRow)
					results.push({
						sql,
						columns: res.columns,
						rows: sliced,
						rowCount: sliced.length,
						changes: 0,
						lastInsertRowid: null,
						durationMs: Math.round((performance.now() - t0) * 100) / 100,
						sourceTable: detectSourceTable(sql),
						truncated,
					})
				} else {
					results.push({
						sql,
						columns: [],
						rows: [],
						rowCount: 0,
						changes: res.changes,
						lastInsertRowid: res.lastInsertRowid,
						durationMs: Math.round((performance.now() - t0) * 100) / 100,
						sourceTable: null,
						truncated: false,
					})
				}
			} catch (err) {
				results.push({
					sql,
					columns: [],
					rows: [],
					rowCount: 0,
					changes: 0,
					lastInsertRowid: null,
					durationMs: Math.round((performance.now() - t0) * 100) / 100,
					sourceTable: null,
					truncated: false,
					error: err instanceof Error ? err.message : String(err),
				})
				break
			}
		}

		if (options.writable) this.cachedSchema = null
		return results
	}

	cancelQuery(queryId: string): Promise<boolean> {
		return this.runner.cancelQuery ? this.runner.cancelQuery(queryId) : Promise.resolve(false)
	}

	async mutate(req: MutateRequest): Promise<MutateResponse> {
		const t0 = performance.now()
		const schema = await this.getSchemaCached()
		const tableSchema = schema.schemas[req.table]
		if (!tableSchema) throw new Error(`Table not found: ${req.table}`)
		if (tableSchema.type !== 'table') throw new Error(`Cannot mutate view: ${req.table}`)

		const colMap = new Map(tableSchema.columns.map((c) => [c.name, c]))
		const qTable = quoteIdent(tableSchema.name)
		const sqlPreview: string[] = []
		const stmts: SqliteStatementSpec[] = []

		for (const upd of req.updates ?? []) {
			const setEntries = Object.entries(upd.changes)
			const pkEntries = Object.entries(upd.pk)
			if (setEntries.length === 0) continue
			if (pkEntries.length === 0) throw new Error('Update requires primary key values')
			const setClauses: string[] = []
			const whereClauses: string[] = []
			const bindings: unknown[] = []
			for (const [col, val] of setEntries) {
				if (!colMap.has(col)) throw new Error(`Unknown column: ${col}`)
				setClauses.push(`${quoteIdent(col)} = ?`)
				bindings.push(val === undefined ? null : val)
			}
			for (const [col, val] of pkEntries) {
				if (!colMap.has(col)) throw new Error(`Unknown PK column: ${col}`)
				if (val === null || val === undefined) whereClauses.push(`${quoteIdent(col)} IS NULL`)
				else {
					whereClauses.push(`${quoteIdent(col)} = ?`)
					bindings.push(val)
				}
			}
			stmts.push({
				sql: `UPDATE ${qTable} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
				params: bindings,
			})
			sqlPreview.push(
				`UPDATE ${qTable} SET ${setEntries.map(([c, v]) => `${quoteIdent(c)} = ${sqlLiteral(v)}`).join(', ')} WHERE ${pkEntries.map(([c, v]) => (v === null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${sqlLiteral(v)}`)).join(' AND ')};`,
			)
		}

		for (const ins of req.inserts ?? []) {
			const entries = Object.entries(ins).filter(([c]) => colMap.has(c))
			if (entries.length === 0) {
				stmts.push({ sql: `INSERT INTO ${qTable} DEFAULT VALUES` })
				sqlPreview.push(`INSERT INTO ${qTable} DEFAULT VALUES;`)
			} else {
				const cols = entries.map(([c]) => quoteIdent(c)).join(', ')
				const placeholders = entries.map(() => '?').join(', ')
				const vals = entries.map(([, v]) => (v === undefined ? null : v))
				stmts.push({ sql: `INSERT INTO ${qTable} (${cols}) VALUES (${placeholders})`, params: vals })
				sqlPreview.push(`INSERT INTO ${qTable} (${cols}) VALUES (${vals.map(sqlLiteral).join(', ')});`)
			}
		}

		for (const pk of req.deletes ?? []) {
			const pkEntries = Object.entries(pk)
			if (pkEntries.length === 0) throw new Error('Delete requires primary key values')
			const whereClauses: string[] = []
			const bindings: unknown[] = []
			for (const [col, val] of pkEntries) {
				if (!colMap.has(col)) throw new Error(`Unknown PK column: ${col}`)
				if (val === null || val === undefined) whereClauses.push(`${quoteIdent(col)} IS NULL`)
				else {
					whereClauses.push(`${quoteIdent(col)} = ?`)
					bindings.push(val)
				}
			}
			stmts.push({ sql: `DELETE FROM ${qTable} WHERE ${whereClauses.join(' AND ')}`, params: bindings })
			sqlPreview.push(
				`DELETE FROM ${qTable} WHERE ${pkEntries.map(([c, v]) => (v === null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${sqlLiteral(v)}`)).join(' AND ')};`,
			)
		}

		let applied = 0
		if (stmts.length > 0) {
			if (this.runner.batch) {
				const results = await this.runner.batch(stmts, { writable: true, transactional: true })
				for (const r of results) applied += r.changes
			} else {
				for (const s of stmts) {
					const r = await this.runner.query(s.sql, s.params, { writable: true })
					applied += r.changes
				}
			}
		}

		return {
			applied,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
			sqlPreview,
		}
	}

	async peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null> {
		const schema = await this.getSchemaCached()
		const tableSchema = schema.schemas[table]
		if (!tableSchema) return null
		const col = tableSchema.columns.find((c) => c.name === column)
		if (!col) return null
		const val = typeof value === 'string' ? coerceParam(value, col.type) : value
		const rows = await this.queryRows(
			`SELECT * FROM ${quoteIdent(tableSchema.name)} WHERE ${quoteIdent(col.name)} = ? LIMIT 1`,
			[val],
		)
		return rows[0] ?? null
	}

	async countReverseFks(
		table: string,
		row: Record<string, unknown>,
		extraReverseFks: ReverseForeignKeyInfo[] = [],
	): Promise<ReverseFkCount[]> {
		const schema = await this.getSchemaCached()
		const tableSchema = schema.schemas[table]
		if (!tableSchema) return []
		const seen = new Set<string>()
		const all: ReverseForeignKeyInfo[] = []
		for (const rfk of tableSchema.reverseForeignKeys) {
			seen.add(`${rfk.fromTable}\0${rfk.fromColumn}\0${rfk.toColumn}`)
			all.push(rfk)
		}
		for (const rfk of extraReverseFks) {
			const key = `${rfk.fromTable}\0${rfk.fromColumn}\0${rfk.toColumn}`
			if (seen.has(key)) continue
			const fromSchema = schema.schemas[rfk.fromTable]
			if (!fromSchema?.columns.some((c) => c.name === rfk.fromColumn)) continue
			if (!tableSchema.columns.some((c) => c.name === rfk.toColumn)) continue
			seen.add(key)
			all.push(rfk)
		}

		const counts: ReverseFkCount[] = []
		for (const rfk of all) {
			const val = row[rfk.toColumn]
			if (val === null || val === undefined) {
				counts.push({ ...rfk, count: 0 })
				continue
			}
			try {
				const rows = await this.queryRows(
					`SELECT COUNT(*) AS c FROM ${quoteIdent(rfk.fromTable)} WHERE ${quoteIdent(rfk.fromColumn)} = ?`,
					[val],
				)
				counts.push({ ...rfk, count: Number(rows[0]?.c ?? 0) })
			} catch {
				counts.push({ ...rfk, count: 0 })
			}
		}
		return counts
	}

	async checkKeysExist(
		probes: { table: string; column: string; values: string[] }[],
	): Promise<{ table: string; column: string; matchedValues: string[] }[]> {
		if (probes.length === 0) return []
		const schema = await this.getSchemaCached()
		const results: { table: string; column: string; matchedValues: string[] }[] = []
		for (const probe of probes.slice(0, 48)) {
			const ts = schema.schemas[probe.table]
			const col = ts?.columns.find((c) => c.name === probe.column)
			const vals = Array.from(new Set(probe.values.filter((v) => typeof v === 'string' && v.length > 0))).slice(0, 16)
			if (!ts || !col || vals.length === 0) {
				results.push({ table: probe.table, column: probe.column, matchedValues: [] })
				continue
			}
			try {
				const placeholders = vals.map(() => '?').join(', ')
				const rows = await this.queryRows(
					`SELECT DISTINCT ${quoteIdent(col.name)} AS v FROM ${quoteIdent(ts.name)} WHERE ${quoteIdent(col.name)} IN (${placeholders})`,
					vals,
				)
				results.push({
					table: probe.table,
					column: probe.column,
					matchedValues: rows.map((r) => (r.v === null || r.v === undefined ? '' : String(r.v))).filter(Boolean),
				})
			} catch {
				results.push({ table: probe.table, column: probe.column, matchedValues: [] })
			}
		}
		return results
	}

	async searchId(value: string): Promise<IdMatch[]> {
		const trimmed = value.trim()
		if (!trimmed) return []
		const schema = await this.getSchemaCached()
		const matches: IdMatch[] = []
		for (const ts of Object.values(schema.schemas)) {
			if (ts.type !== 'table') continue
			const candidateCols = new Set<string>(ts.primaryKeyColumns)
			for (const fk of ts.foreignKeys) candidateCols.add(fk.fromColumn)
			for (const col of ts.columns) {
				if (col.name === 'id' || col.name.endsWith('_id') || col.name.endsWith('Id')) candidateCols.add(col.name)
			}
			for (const colName of candidateCols) {
				const col = ts.columns.find((c) => c.name === colName)
				if (!col) continue
				try {
					const rows = await this.queryRows(
						`SELECT * FROM ${quoteIdent(ts.name)} WHERE ${quoteIdent(col.name)} = ? LIMIT 1`,
						[coerceParam(trimmed, col.type)],
					)
					if (rows[0]) {
						matches.push({
							table: ts.name,
							column: col.name,
							isPrimaryKey: col.primaryKey > 0,
							row: rows[0],
						})
						if (matches.length >= 25) return matches
					}
				} catch {}
			}
		}
		return matches
	}

	async profileColumn(table: string, column: string): Promise<ColumnProfile> {
		const t0 = performance.now()
		const schema = await this.getSchemaCached()
		const ts = schema.schemas[table]
		if (!ts) throw new Error(`Table or view not found: ${table}`)
		const col = ts.columns.find((c) => c.name === column)
		if (!col) throw new Error(`Column not found: ${table}.${column}`)

		const qT = quoteIdent(ts.name)
		const qC = quoteIdent(col.name)
		const aggRows = await this.queryRows(
			`SELECT COUNT(*) AS total, COUNT(${qC}) AS non_null, COUNT(DISTINCT ${qC}) AS distinct_cnt, MIN(${qC}) AS min_val, MAX(${qC}) AS max_val FROM ${qT}`,
		)
		const agg = aggRows[0] ?? {}
		const totalRows = Number(agg.total ?? 0)
		const nonNullCount = Number(agg.non_null ?? 0)
		const nullCount = Math.max(0, totalRows - nonNullCount)
		const nullPct = totalRows > 0 ? Math.round((nullCount / totalRows) * 1000) / 10 : 0
		const topRows = await this.queryRows(
			`SELECT ${qC} AS val, COUNT(*) AS cnt FROM ${qT} GROUP BY ${qC} ORDER BY cnt DESC LIMIT 10`,
		)
		const fmt = (v: unknown) => {
			const n = normalizeCellValue(v)
			return n === null || n === undefined ? null : String(n)
		}
		return {
			table: ts.name,
			column: col.name,
			columnType: col.type,
			totalRows,
			nonNullCount,
			nullCount,
			nullPct,
			distinctCount: Number(agg.distinct_cnt ?? 0),
			min: fmt(agg.min_val),
			max: fmt(agg.max_val),
			topValues: topRows.map((r) => ({ value: fmt(r.val), count: Number(r.cnt ?? 0) })),
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
		}
	}

	async getInfo(): Promise<DatabaseInfo> {
		const t0 = performance.now()
		const verRows = await this.queryRows('SELECT sqlite_version() AS v').catch(() => [])
		const pv = async (name: string): Promise<unknown> => {
			try {
				const rows = await this.queryRows(`PRAGMA ${name}`)
				return rows[0] ? Object.values(rows[0])[0] : undefined
			} catch {
				return undefined
			}
		}
		const syncModes = ['OFF', 'NORMAL', 'FULL', 'EXTRA']
		const avModes = ['NONE', 'FULL', 'INCREMENTAL']
		const [jm, syncVal, fkVal, uv, ps, pc, fl, enc, av] = await Promise.all([
			pv('journal_mode'),
			pv('synchronous'),
			pv('foreign_keys'),
			pv('user_version'),
			pv('page_size'),
			pv('page_count'),
			pv('freelist_count'),
			pv('encoding'),
			pv('auto_vacuum'),
		])
		const sNum = Number(syncVal)
		const aNum = Number(av)
		const extra = this.runner.getExtraInfo?.() ?? {}
		return {
			driver: 'sqlite',
			version: String(verRows[0]?.v ?? ''),
			runtime: this.runner.runtimeName,
			journalMode: jm ? String(jm).toUpperCase() : undefined,
			synchronous: Number.isFinite(sNum) ? (syncModes[sNum] ?? String(sNum)) : undefined,
			foreignKeys: fkVal !== undefined ? Boolean(Number(fkVal)) : undefined,
			userVersion: uv !== undefined ? Number(uv) : undefined,
			pageSize: ps !== undefined ? Number(ps) : undefined,
			pageCount: pc !== undefined ? Number(pc) : undefined,
			freelistCount: fl !== undefined ? Number(fl) : undefined,
			encoding: enc ? String(enc) : undefined,
			autoVacuum: Number.isFinite(aNum) ? (avModes[aNum] ?? String(aNum)) : undefined,
			...extra,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
		}
	}

	async runMaintenance(action: 'wal_checkpoint' | 'vacuum') {
		if (!this.runner.supportsMaintenance) {
			throw new Error(`Maintenance (${action}) is not supported by ${this.runner.runtimeName}`)
		}
		const t0 = performance.now()
		if (action === 'wal_checkpoint') {
			const rows = await this.queryRows('PRAGMA wal_checkpoint(TRUNCATE)', undefined, true)
			const r = rows[0]
			const msg = r
				? `WAL checkpoint complete (checkpointed ${r.checkpointed}/${r.log} frames, busy=${r.busy})`
				: 'WAL checkpoint complete'
			return { ok: true as const, message: msg, durationMs: Math.round((performance.now() - t0) * 100) / 100 }
		}
		await this.runner.query('VACUUM', undefined, { writable: true })
		return {
			ok: true as const,
			message: 'VACUUM complete',
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
		}
	}

	close() {
		this.cachedSchema = null
		this.runner.close()
	}
}

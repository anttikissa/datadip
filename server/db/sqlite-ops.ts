// Core SQLite database operations (introspection, keyset browsing, query execution, mutations, FK peeks, reverse FK counts, ID search, profiling, PRAGMA/WAL info).
// Designed to run identically on local bun:sqlite handles and inside the remote SSH Bun worker.
import type { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
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
	KeyExistenceProbe,
	KeyExistenceResult,
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

export function quoteIdent(name: string): string {
	return '"' + name.replaceAll('"', '""') + '"'
}

export function normalizeCellValue(val: unknown): unknown {
	if (val === null || val === undefined) return null
	if (typeof val === 'bigint') return val.toString()
	if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
		const bytes = val instanceof Uint8Array ? val : new Uint8Array(val)
		const preview = Array.from(bytes.slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join('')
		return `<BLOB ${bytes.length}B 0x${preview}${bytes.length > 32 ? '…' : ''}>`
	}
	return val
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(row)) {
		out[k] = normalizeCellValue(v)
	}
	return out
}

export function coerceParam(raw: string, columnType = ''): string | number {
	const t = columnType.toUpperCase()
	if (t.includes('INT') || t.includes('REAL') || t.includes('NUM') || t.includes('FLOA') || t.includes('DOUB')) {
		if (/^-?\d+(\.\d+)?$/.test(raw.trim())) {
			const num = Number(raw.trim())
			if (Number.isSafeInteger(num) || raw.includes('.')) return num
		}
	}
	return raw
}

export function getSqliteSchema(db: Database): DatabaseSchema {
	const t0 = performance.now()
	const masterRows = db
		.query<{ name: string; type: 'table' | 'view'; sql: string | null }, []>(
			`SELECT name, type, sql
			 FROM sqlite_master
			 WHERE type IN ('table', 'view')
			   AND name NOT LIKE 'sqlite_%'
			 ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE`,
		)
		.all()

	// Avoid slow full-table COUNT(*) scans during schema load on very large databases (>50 MB)
	let skipSlowCounts = false
	try {
		const pc = db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? 0
		const ps = db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 4096
		skipSlowCounts = pc * ps > 50 * 1024 * 1024
	} catch {}

	const statCounts = new Map<string, number>()
	try {
		const hasStat = db
			.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`)
			.get()
		if (hasStat) {
			for (const r of db.query<{ tbl: string; stat: string }, []>('SELECT tbl, stat FROM sqlite_stat1').all()) {
				const n = Number(String(r.stat ?? '').split(' ')[0])
				if (Number.isFinite(n) && !statCounts.has(r.tbl)) statCounts.set(r.tbl, n)
			}
		}
	} catch {}

	const tables: TableSummary[] = []
	const schemas: Record<string, TableSchema> = {}

	// Identify shadow tables created by FTS5/FTS4/FTS3/RTree virtual tables so UI can group them cleanly.
	const shadowTables = new Set<string>()
	const FTS_SUFFIXES = ['_content', '_data', '_docsize', '_idx', '_config', '_segments', '_segdir', '_stat']
	const RTREE_SUFFIXES = ['_node', '_rowid', '_parent']
	for (const m of masterRows) {
		const ddl = m.sql ?? ''
		if (/^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+fts[345]\b/i.test(ddl)) {
			for (const suf of FTS_SUFFIXES) shadowTables.add(`${m.name}${suf}`)
		} else if (/^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+rtree/i.test(ddl)) {
			for (const suf of RTREE_SUFFIXES) shadowTables.add(`${m.name}${suf}`)
		}
	}

	const triggers: TriggerInfo[] = db
		.query<{ name: string; tbl_name: string; sql: string | null }, []>(
			`SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name COLLATE NOCASE, name COLLATE NOCASE`,
		)
		.all()
		.map((tr) => ({ name: tr.name, table: tr.tbl_name, sql: tr.sql ?? '' }))
	const triggersByTable = new Map<string, TriggerInfo[]>()
	for (const tr of triggers) {
		const list = triggersByTable.get(tr.table) ?? []
		list.push(tr)
		triggersByTable.set(tr.table, list)
	}

	for (const m of masterRows) {
		const qName = quoteIdent(m.name)
		const colRows = db
			.query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
				`PRAGMA table_info(${qName})`,
			)
			.all()

		const columns: ColumnInfo[] = colRows.map((c) => ({
			name: c.name,
			type: c.type || 'ANY',
			notNull: Boolean(c.notnull),
			defaultValue: c.dflt_value,
			primaryKey: c.pk,
		}))

		const pkCols = columns
			.filter((c) => c.primaryKey > 0)
			.sort((a, b) => a.primaryKey - b.primaryKey)
			.map((c) => c.name)

		const foreignKeys: ForeignKeyInfo[] =
			m.type === 'table'
				? db
						.query<
							{ id: number; table: string; from: string; to: string | null; on_update: string; on_delete: string },
							[]
						>(`PRAGMA foreign_key_list(${qName})`)
						.all()
						.map((fk) => ({
							id: fk.id,
							fromColumn: fk.from,
							toTable: fk.table,
							toColumn: fk.to || 'id',
							onUpdate: fk.on_update,
							onDelete: fk.on_delete,
						}))
				: []

		const indexes: IndexInfo[] = []
		if (m.type === 'table') {
			const idxRows = db
				.query<{ name: string; unique: number; origin: string }, []>(`PRAGMA index_list(${qName})`)
				.all()
			for (const idx of idxRows) {
				const idxCols = db
					.query<{ name: string | null }, []>(`PRAGMA index_info(${quoteIdent(idx.name)})`)
					.all()
					.map((c) => c.name ?? '')
					.filter(Boolean)
				indexes.push({
					name: idx.name,
					unique: Boolean(idx.unique),
					origin: idx.origin,
					columns: idxCols,
				})
			}
		}

		let rowCount: number | null = null
		if (m.type === 'table') {
			if (skipSlowCounts) {
				rowCount = statCounts.get(m.name) ?? null
			} else {
				try {
					const countRow = db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${qName}`).get()
					rowCount = countRow?.c ?? 0
				} catch {
					rowCount = null
				}
			}
		}

		const isInternal = shadowTables.has(m.name)
		tables.push({ name: m.name, type: m.type, rowCount, ...(isInternal ? { isInternal: true } : {}) })
		schemas[m.name] = {
			name: m.name,
			type: m.type,
			ddl: m.sql ?? '',
			columns,
			foreignKeys,
			reverseForeignKeys: [],
			indexes,
			primaryKeyColumns: pkCols,
			triggers: triggersByTable.get(m.name) ?? [],
		}
	}

	// Populate reverse foreign keys
	for (const schema of Object.values(schemas)) {
		for (const fk of schema.foreignKeys) {
			const target = schemas[fk.toTable]
			if (target) {
				target.reverseForeignKeys.push({
					fromTable: schema.name,
					fromColumn: fk.fromColumn,
					toColumn: fk.toColumn,
				})
			}
		}
	}

	return {
		tables,
		schemas,
		triggers,
		durationMs: Math.round((performance.now() - t0) * 100) / 100,
	}
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
		if (colChecks.length > 0) {
			clauses.push(`(${colChecks.join(' OR ')})`)
		}
	}

	return { clauses, bindings }
}

export function browseSqliteTable(db: Database, params: BrowseParams): BrowseResult {
	const t0 = performance.now()
	const schema = getSqliteSchema(db)
	const tableSchema = schema.schemas[params.table]
	if (!tableSchema) throw new Error(`Table or view not found: ${params.table}`)

	const colMap = new Map(tableSchema.columns.map((c) => [c.name, c]))
	const selectedCols =
		params.fields && params.fields.length > 0
			? params.fields.filter((f) => colMap.has(f))
			: tableSchema.columns.map((c) => c.name)
	if (selectedCols.length === 0) {
		throw new Error(`No valid columns selected for ${params.table}`)
	}

	// Determine sort order (default to PK if none specified)
	const validOrders: OrderSpec[] = (params.order ?? []).filter((o) => colMap.has(o.column))
	if (validOrders.length === 0 && tableSchema.primaryKeyColumns.length > 0) {
		validOrders.push({ column: tableSchema.primaryKeyColumns[0]!, dir: 'asc' })
	}

	// Determine whether we can use clean single-column keyset pagination
	const singleUniqueCols = new Set<string>()
	if (tableSchema.primaryKeyColumns.length === 1) {
		singleUniqueCols.add(tableSchema.primaryKeyColumns[0]!)
	}
	for (const idx of tableSchema.indexes) {
		if (idx.unique && idx.columns.length === 1) singleUniqueCols.add(idx.columns[0]!)
	}
	const keysetCol =
		validOrders.length === 1 && singleUniqueCols.has(validOrders[0]!.column) ? validOrders[0]!.column : null
	const keysetDir = validOrders[0]?.dir ?? 'asc'

	const { clauses, bindings } = buildWhereClause(params.filters, params.search, colMap)
	const qTable = quoteIdent(tableSchema.name)
	const tableSummary = schema.tables.find((t) => t.name === tableSchema.name)

	// Avoid slow full-table COUNT(*) scans when browsing large databases (>50 MB).
	let skipSlowCounts = false
	try {
		const pc = db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? 0
		const ps = db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size ?? 4096
		skipSlowCounts = pc * ps > 50 * 1024 * 1024
	} catch {}

	let totalCount: number | null = null
	if (skipSlowCounts) {
		totalCount = clauses.length === 0 ? (tableSummary?.rowCount ?? null) : null
	} else {
		try {
			const countSql =
				`SELECT COUNT(*) AS c FROM ${qTable}` + (clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '')
			const cRow = db.query<{ c: number }, (string | number)[]>(countSql).get(...bindings)
			totalCount = cRow?.c ?? 0
		} catch {
			totalCount = null
		}
	}

	// Ensure keyset column is fetched even if hidden in fields, so cursors stay valid
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
			const op = keysetDir === 'asc' ? '<' : '>'
			rowClauses.push(`${quoteIdent(keysetCol)} ${op} ?`)
			rowBindings.push(cursorVal)
			const revDir = keysetDir === 'asc' ? 'DESC' : 'ASC'
			orderSql = ` ORDER BY ${quoteIdent(keysetCol)} ${revDir}`
		} else {
			const op = keysetDir === 'asc' ? '>' : '<'
			rowClauses.push(`${quoteIdent(keysetCol)} ${op} ?`)
			rowBindings.push(cursorVal)
			orderSql = ` ORDER BY ${quoteIdent(keysetCol)} ${keysetDir.toUpperCase()}`
		}
	} else {
		if (validOrders.length > 0) {
			orderSql = ' ORDER BY ' + validOrders.map((o) => `${quoteIdent(o.column)} ${o.dir.toUpperCase()}`).join(', ')
		}
		if (params.offset && params.offset > 0) {
			offsetSql = ` OFFSET ${Math.floor(params.offset)}`
		}
	}

	const whereSql = rowClauses.length > 0 ? ` WHERE ${rowClauses.join(' AND ')}` : ''
	const sql = `SELECT ${selectSql} FROM ${qTable}${whereSql}${orderSql} LIMIT ${limit + 1}${offsetSql}`
	const rawRows = db
		.query<Record<string, unknown>, (string | number)[]>(sql)
		.all(...rowBindings)
		.map(normalizeRow)

	const hasMore = rawRows.length > limit
	let rows = hasMore ? rawRows.slice(0, limit) : rawRows
	if (keysetCol && params.start && isPrev) {
		rows = rows.reverse()
	}

	let hasNext = false
	let hasPrev = false
	let nextCursor: string | null = null
	let prevCursor: string | null = null

	if (keysetCol && rows.length > 0) {
		const firstKey = rows[0]![keysetCol]
		const lastKey = rows[rows.length - 1]![keysetCol]
		if (params.start) {
			if (isPrev) {
				hasPrev = hasMore
				hasNext = true
			} else {
				hasPrev = true
				hasNext = hasMore
			}
		} else {
			hasPrev = false
			hasNext = hasMore
		}
		nextCursor = hasNext && lastKey !== null && lastKey !== undefined ? String(lastKey) : null
		prevCursor = hasPrev && firstKey !== null && firstKey !== undefined ? String(firstKey) : null
	} else {
		const off = params.offset ?? 0
		hasPrev = off > 0
		hasNext = hasMore
	}

	// Strip internal keyset column if user excluded it from fields
	if (fetchCols.length !== selectedCols.length && keysetCol) {
		rows = rows.map((r) => {
			const copy = { ...r }
			delete copy[keysetCol]
			return copy
		})
	}

	const columnTypes: Record<string, string> = {}
	for (const c of selectedCols) {
		columnTypes[c] = colMap.get(c)?.type ?? 'ANY'
	}

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

export function executeSqliteStatements(
	db: Database,
	statements: string[],
	options: { maxRows?: number } = {},
): QueryStatementResult[] {
	const maxRows = options.maxRows ?? 2000
	const results: QueryStatementResult[] = []

	for (const rawSql of statements) {
		const sql = rawSql.trim()
		if (!sql) continue
		const t0 = performance.now()
		try {
			const stmt = db.query(sql)
			const colNames = stmt.columnNames
			if (colNames.length > 0) {
				const allRows: Record<string, unknown>[] = []
				let truncated = false
				for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
					if (allRows.length >= maxRows) {
						truncated = true
						break
					}
					allRows.push(normalizeRow(row))
				}
				results.push({
					sql,
					columns: colNames,
					rows: allRows,
					rowCount: allRows.length,
					changes: 0,
					lastInsertRowid: null,
					durationMs: Math.round((performance.now() - t0) * 100) / 100,
					sourceTable: detectSourceTable(sql),
					truncated,
				})
			} else {
				const runInfo = stmt.run()
				results.push({
					sql,
					columns: [],
					rows: [],
					rowCount: 0,
					changes: runInfo.changes,
					lastInsertRowid:
						typeof runInfo.lastInsertRowid === 'bigint' ? runInfo.lastInsertRowid.toString() : runInfo.lastInsertRowid,
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

	return results
}

function sqlLiteralPreview(val: unknown): string {
	if (val === null || val === undefined) return 'NULL'
	if (typeof val === 'number') return String(val)
	return `'${String(val).replaceAll("'", "''")}'`
}

export function mutateSqliteTable(db: Database, req: MutateRequest): MutateResponse {
	const t0 = performance.now()
	const schema = getSqliteSchema(db)
	const tableSchema = schema.schemas[req.table]
	if (!tableSchema) throw new Error(`Table not found: ${req.table}`)
	if (tableSchema.type !== 'table') throw new Error(`Cannot mutate view: ${req.table}`)

	const colMap = new Map(tableSchema.columns.map((c) => [c.name, c]))
	const qTable = quoteIdent(tableSchema.name)
	const sqlPreview: string[] = []
	let applied = 0

	const tx = db.transaction(() => {
		for (const upd of req.updates ?? []) {
			const setEntries = Object.entries(upd.changes)
			const pkEntries = Object.entries(upd.pk)
			if (setEntries.length === 0) continue
			if (pkEntries.length === 0) throw new Error('Update requires primary key values')

			const setClauses: string[] = []
			const whereClauses: string[] = []
			const bindings: (string | number | null)[] = []

			for (const [col, val] of setEntries) {
				if (!colMap.has(col)) throw new Error(`Unknown column: ${col}`)
				setClauses.push(`${quoteIdent(col)} = ?`)
				bindings.push(val === null || val === undefined ? null : (val as string | number))
			}
			for (const [col, val] of pkEntries) {
				if (!colMap.has(col)) throw new Error(`Unknown PK column: ${col}`)
				if (val === null || val === undefined) {
					whereClauses.push(`${quoteIdent(col)} IS NULL`)
				} else {
					whereClauses.push(`${quoteIdent(col)} = ?`)
					bindings.push(val as string | number)
				}
			}

			const sql = `UPDATE ${qTable} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`
			const preview = `UPDATE ${qTable} SET ${setEntries.map(([c, v]) => `${quoteIdent(c)} = ${sqlLiteralPreview(v)}`).join(', ')} WHERE ${pkEntries.map(([c, v]) => (v === null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${sqlLiteralPreview(v)}`)).join(' AND ')};`
			sqlPreview.push(preview)
			const res = db.run(sql, bindings)
			applied += res.changes
		}

		for (const ins of req.inserts ?? []) {
			const entries = Object.entries(ins).filter(([c]) => colMap.has(c))
			if (entries.length === 0) {
				const sql = `INSERT INTO ${qTable} DEFAULT VALUES`
				sqlPreview.push(sql + ';')
				applied += db.run(sql).changes
			} else {
				const cols = entries.map(([c]) => quoteIdent(c)).join(', ')
				const placeholders = entries.map(() => '?').join(', ')
				const vals = entries.map(([, v]) => (v === undefined ? null : (v as string | number | null)))
				const sql = `INSERT INTO ${qTable} (${cols}) VALUES (${placeholders})`
				sqlPreview.push(`INSERT INTO ${qTable} (${cols}) VALUES (${vals.map(sqlLiteralPreview).join(', ')});`)
				applied += db.run(sql, vals).changes
			}
		}

		for (const pk of req.deletes ?? []) {
			const pkEntries = Object.entries(pk)
			if (pkEntries.length === 0) throw new Error('Delete requires primary key values')
			const whereClauses: string[] = []
			const bindings: (string | number)[] = []
			for (const [col, val] of pkEntries) {
				if (!colMap.has(col)) throw new Error(`Unknown PK column: ${col}`)
				if (val === null || val === undefined) {
					whereClauses.push(`${quoteIdent(col)} IS NULL`)
				} else {
					whereClauses.push(`${quoteIdent(col)} = ?`)
					bindings.push(val as string | number)
				}
			}
			const sql = `DELETE FROM ${qTable} WHERE ${whereClauses.join(' AND ')}`
			sqlPreview.push(
				`DELETE FROM ${qTable} WHERE ${pkEntries.map(([c, v]) => (v === null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${sqlLiteralPreview(v)}`)).join(' AND ')};`,
			)
			applied += db.run(sql, bindings).changes
		}
	})

	tx()

	return {
		applied,
		durationMs: Math.round((performance.now() - t0) * 100) / 100,
		sqlPreview,
	}
}

export function peekSqliteRow(
	db: Database,
	table: string,
	column: string,
	value: unknown,
): Record<string, unknown> | null {
	const schema = getSqliteSchema(db)
	const tableSchema = schema.schemas[table]
	if (!tableSchema) return null
	const col = tableSchema.columns.find((c) => c.name === column)
	if (!col) return null
	const val = typeof value === 'string' ? coerceParam(value, col.type) : (value as string | number)
	const row = db
		.query<Record<string, unknown>, [string | number]>(
			`SELECT * FROM ${quoteIdent(tableSchema.name)} WHERE ${quoteIdent(col.name)} = ? LIMIT 1`,
		)
		.get(val)
	return row ? normalizeRow(row) : null
}

export function countSqliteReverseFks(
	db: Database,
	table: string,
	row: Record<string, unknown>,
	extraReverseFks: ReverseForeignKeyInfo[] = [],
): ReverseFkCount[] {
	const schema = getSqliteSchema(db)
	const tableSchema = schema.schemas[table]
	if (!tableSchema) return []
	const seen = new Set<string>()
	const allReverseFks: ReverseForeignKeyInfo[] = []
	for (const rfk of tableSchema.reverseForeignKeys) {
		seen.add(`${rfk.fromTable}\0${rfk.fromColumn}\0${rfk.toColumn}`)
		allReverseFks.push(rfk)
	}
	for (const rfk of extraReverseFks) {
		const key = `${rfk.fromTable}\0${rfk.fromColumn}\0${rfk.toColumn}`
		if (seen.has(key)) continue
		const fromSchema = schema.schemas[rfk.fromTable]
		if (!fromSchema?.columns.some((c) => c.name === rfk.fromColumn)) continue
		if (!tableSchema.columns.some((c) => c.name === rfk.toColumn)) continue
		seen.add(key)
		allReverseFks.push(rfk)
	}
	const counts: ReverseFkCount[] = []
	for (const rfk of allReverseFks) {
		const val = row[rfk.toColumn]
		if (val === null || val === undefined) {
			counts.push({ ...rfk, count: 0 })
			continue
		}
		try {
			const res = db
				.query<{ c: number }, [string | number]>(
					`SELECT COUNT(*) AS c FROM ${quoteIdent(rfk.fromTable)} WHERE ${quoteIdent(rfk.fromColumn)} = ?`,
				)
				.get(val as string | number)
			counts.push({ ...rfk, count: res?.c ?? 0 })
		} catch {
			counts.push({ ...rfk, count: 0 })
		}
	}
	return counts
}

// Fast PK-index existence probe for passive FK verification (validates table/column against schema, caps batch size).
export function checkSqliteKeysExist(db: Database, probes: KeyExistenceProbe[]): KeyExistenceResult[] {
	if (probes.length === 0) return []
	const schema = getSqliteSchema(db)
	const results: KeyExistenceResult[] = []
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
			const rows = db
				.query<{ v: unknown }, string[]>(
					`SELECT DISTINCT ${quoteIdent(col.name)} AS v FROM ${quoteIdent(ts.name)} WHERE ${quoteIdent(col.name)} IN (${placeholders})`,
				)
				.all(...vals)
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

export function searchSqliteId(db: Database, value: string): IdMatch[] {
	const trimmed = value.trim()
	if (!trimmed) return []
	const schema = getSqliteSchema(db)
	const matches: IdMatch[] = []

	for (const tableSchema of Object.values(schema.schemas)) {
		if (tableSchema.type !== 'table') continue
		const candidateCols = new Set<string>(tableSchema.primaryKeyColumns)
		for (const fk of tableSchema.foreignKeys) candidateCols.add(fk.fromColumn)
		for (const col of tableSchema.columns) {
			if (col.name === 'id' || col.name.endsWith('_id') || col.name.endsWith('Id')) {
				candidateCols.add(col.name)
			}
		}

		for (const colName of candidateCols) {
			const col = tableSchema.columns.find((c) => c.name === colName)
			if (!col) continue
			try {
				const param = coerceParam(trimmed, col.type)
				const row = db
					.query<Record<string, unknown>, [string | number]>(
						`SELECT * FROM ${quoteIdent(tableSchema.name)} WHERE ${quoteIdent(col.name)} = ? LIMIT 1`,
					)
					.get(param)
				if (row) {
					matches.push({
						table: tableSchema.name,
						column: col.name,
						isPrimaryKey: col.primaryKey > 0,
						row: normalizeRow(row),
					})
					if (matches.length >= 25) return matches
				}
			} catch {}
		}
	}

	return matches
}

export function profileSqliteColumn(db: Database, table: string, column: string): ColumnProfile {
	const t0 = performance.now()
	const schema = getSqliteSchema(db)
	const tableSchema = schema.schemas[table]
	if (!tableSchema) throw new Error(`Table or view not found: ${table}`)
	const col = tableSchema.columns.find((c) => c.name === column)
	if (!col) throw new Error(`Column not found: ${table}.${column}`)

	const qTable = quoteIdent(tableSchema.name)
	const qCol = quoteIdent(col.name)

	const agg = db
		.query<
			{
				total: number
				non_null: number
				distinct_cnt: number
				min_val: unknown
				max_val: unknown
			},
			[]
		>(
			`SELECT
				COUNT(*) AS total,
				COUNT(${qCol}) AS non_null,
				COUNT(DISTINCT ${qCol}) AS distinct_cnt,
				MIN(${qCol}) AS min_val,
				MAX(${qCol}) AS max_val
			 FROM ${qTable}`,
		)
		.get()

	const totalRows = agg?.total ?? 0
	const nonNullCount = agg?.non_null ?? 0
	const nullCount = Math.max(0, totalRows - nonNullCount)
	const nullPct = totalRows > 0 ? Math.round((nullCount / totalRows) * 1000) / 10 : 0
	const distinctCount = agg?.distinct_cnt ?? 0

	const topRows = db
		.query<{ val: unknown; cnt: number }, []>(
			`SELECT ${qCol} AS val, COUNT(*) AS cnt
			 FROM ${qTable}
			 GROUP BY ${qCol}
			 ORDER BY cnt DESC
			 LIMIT 10`,
		)
		.all()

	const fmtVal = (v: unknown): string | null => {
		const norm = normalizeCellValue(v)
		return norm === null || norm === undefined ? null : String(norm)
	}

	return {
		table: tableSchema.name,
		column: col.name,
		columnType: col.type,
		totalRows,
		nonNullCount,
		nullCount,
		nullPct,
		distinctCount,
		min: fmtVal(agg?.min_val),
		max: fmtVal(agg?.max_val),
		topValues: topRows.map((r) => ({ value: fmtVal(r.val), count: r.cnt })),
		durationMs: Math.round((performance.now() - t0) * 100) / 100,
	}
}

const SYNC_MODES = ['OFF', 'NORMAL', 'FULL', 'EXTRA']
const AUTO_VACUUM_MODES = ['NONE', 'FULL', 'INCREMENTAL']

export function getSqliteInfo(db: Database, filePath?: string): DatabaseInfo {
	const t0 = performance.now()
	const ver = db.query<{ v: string }, []>('SELECT sqlite_version() AS v').get()?.v ?? ''
	const pragmaVal = (name: string): unknown => {
		try {
			const row = db.query<Record<string, unknown>, []>(`PRAGMA ${name}`).get()
			if (!row) return undefined
			return Object.values(row)[0]
		} catch {
			return undefined
		}
	}
	const statSize = (p: string): number | null => {
		try {
			return statSync(p).size
		} catch {
			return null
		}
	}

	const syncNum = Number(pragmaVal('synchronous'))
	const avNum = Number(pragmaVal('auto_vacuum'))

	return {
		driver: 'sqlite',
		version: ver,
		fileSizeBytes: filePath ? statSize(filePath) : null,
		walSizeBytes: filePath ? statSize(`${filePath}-wal`) : null,
		shmSizeBytes: filePath ? statSize(`${filePath}-shm`) : null,
		journalMode: String(pragmaVal('journal_mode') ?? '').toUpperCase() || undefined,
		synchronous: Number.isFinite(syncNum) ? (SYNC_MODES[syncNum] ?? String(syncNum)) : undefined,
		foreignKeys: Boolean(pragmaVal('foreign_keys')),
		userVersion: Number(pragmaVal('user_version') ?? 0),
		pageSize: Number(pragmaVal('page_size') ?? 0),
		pageCount: Number(pragmaVal('page_count') ?? 0),
		freelistCount: Number(pragmaVal('freelist_count') ?? 0),
		encoding: String(pragmaVal('encoding') ?? '') || undefined,
		autoVacuum: Number.isFinite(avNum) ? (AUTO_VACUUM_MODES[avNum] ?? String(avNum)) : undefined,
		durationMs: Math.round((performance.now() - t0) * 100) / 100,
	}
}

export function runSqliteMaintenance(
	db: Database,
	action: 'wal_checkpoint' | 'vacuum',
): { ok: true; message: string; durationMs: number } {
	const t0 = performance.now()
	if (action === 'wal_checkpoint') {
		const row = db
			.query<{ busy: number; log: number; checkpointed: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)')
			.get()
		const durationMs = Math.round((performance.now() - t0) * 100) / 100
		const msg = row
			? `WAL checkpoint complete (checkpointed ${row.checkpointed}/${row.log} frames, busy=${row.busy})`
			: 'WAL checkpoint complete'
		return { ok: true, message: msg, durationMs }
	}
	db.exec('VACUUM')
	const durationMs = Math.round((performance.now() - t0) * 100) / 100
	return { ok: true, message: 'VACUUM complete', durationMs }
}

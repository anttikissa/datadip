// PostgreSQL adapter backed by Bun's built-in Bun.SQL client with optional OpenSSH TCP port forwarding.
// Implements the full DbAdapter contract with read-only transactions, server-side cancel, and zero-scan row estimates.
import { SQL } from 'bun'
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
	TableSchema,
	TableSummary,
	TriggerInfo,
} from '../../src/shared/types.ts'
import type { SshAskpassConfig, SshTarget } from './ssh-mux.ts'
import { SshTcpTunnel } from './ssh-tunnel.ts'
import type { DbAdapter } from './types.ts'

export interface ParsedPostgresUrl {
	rawUrl: string
	hostname: string
	port: number
	database: string
	username?: string
	sslMode?: string
}

const PG_FK_ACTION: Record<string, string> = {
	a: 'NO ACTION',
	r: 'RESTRICT',
	c: 'CASCADE',
	n: 'SET NULL',
	d: 'SET DEFAULT',
}

const LARGE_TABLE_ESTIMATE_THRESHOLD = 50_000

export function parsePostgresUrl(input: string): ParsedPostgresUrl {
	const trimmed = input.trim()
	if (!trimmed) throw new Error('PostgreSQL connection URL is required')
	const withScheme = /^postgres(?:ql)?:\/\//i.test(trimmed) ? trimmed : `postgres://${trimmed}`
	let u: URL
	try {
		u = new URL(withScheme)
	} catch {
		throw new Error('Invalid PostgreSQL connection URL')
	}
	const hostname = u.hostname || '127.0.0.1'
	const port = u.port ? Number(u.port) : 5432
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PostgreSQL port: ${u.port}`)
	}
	const database = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'postgres'
	const username = u.username ? decodeURIComponent(u.username) : undefined
	const rawSslMode = u.searchParams.get('sslmode')?.trim().toLowerCase()
	const rawSsl = u.searchParams.get('ssl')?.trim().toLowerCase()
	const sslMode =
		rawSslMode ||
		(rawSsl === 'true' || rawSsl === '1' ? 'require' : rawSsl === 'false' || rawSsl === '0' ? 'disable' : undefined)
	return { rawUrl: withScheme, hostname, port, database, username, sslMode }
}

// Match libpq default (sslmode=prefer) because Bun.SQL otherwise sends plaintext without SSLRequest,
// causing managed Postgres hosts (Supabase, RDS, Render, etc.) to reject bare DATABASE_URLs with "no encryption".
export function buildPostgresConnectConfig(
	parsed: ParsedPostgresUrl,
	tunnelLocalPort?: number,
): { url: string; tls?: SQL.PostgresOrMySQLOptions['tls'] } {
	const u = new URL(parsed.rawUrl)
	if (!u.searchParams.has('sslmode') && !u.searchParams.has('ssl')) {
		u.searchParams.set('sslmode', 'prefer')
	}

	let tls: SQL.PostgresOrMySQLOptions['tls'] = undefined
	if (tunnelLocalPort !== undefined) {
		u.hostname = '127.0.0.1'
		u.port = String(tunnelLocalPort)
		// Preserve real Postgres hostname for TLS SNI & verification when TLS is explicitly required.
		// Only pass `tls` for required modes because passing a `tls` object disables `sslmode=prefer` plaintext fallback in Bun.SQL.
		if (parsed.sslMode === 'require' || parsed.sslMode === 'verify-ca' || parsed.sslMode === 'verify-full') {
			tls =
				parsed.sslMode === 'verify-full' || parsed.sslMode === 'verify-ca'
					? { serverName: parsed.hostname }
					: { serverName: parsed.hostname, rejectUnauthorized: false }
		}
	}

	return tls ? { url: u.toString(), tls } : { url: u.toString() }
}

export function redactPostgresUrl(input: string): string {
	try {
		const parsed = parsePostgresUrl(input)
		const u = new URL(parsed.rawUrl)
		if (u.password) u.password = '••••'
		return u.toString()
	} catch {
		return input
	}
}

export function quotePgIdent(name: string): string {
	return '"' + name.replaceAll('"', '""') + '"'
}

export function splitPgTableName(qualified: string): { schema: string; table: string } {
	const dot = qualified.indexOf('.')
	if (dot === -1) return { schema: 'public', table: qualified }
	return { schema: qualified.slice(0, dot), table: qualified.slice(dot + 1) }
}

export function quotePgTable(qualified: string): string {
	const { schema, table } = splitPgTableName(qualified)
	return `${quotePgIdent(schema)}.${quotePgIdent(table)}`
}

function formatTableKey(schema: string, table: string): string {
	return schema === 'public' ? table : `${schema}.${table}`
}

export function normalizePgCell(val: unknown): unknown {
	if (val === null || val === undefined) return null
	if (typeof val === 'bigint') return val.toString()
	if (val instanceof Date) return val.toISOString()
	if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
		const bytes = val instanceof Uint8Array ? val : new Uint8Array(val)
		const preview = Array.from(bytes.slice(0, 32), (b) => b.toString(16).padStart(2, '0')).join('')
		return `<BLOB ${bytes.length}B 0x${preview}${bytes.length > 32 ? '…' : ''}>`
	}
	if (typeof val === 'object') {
		try {
			return JSON.stringify(val)
		} catch {
			return String(val)
		}
	}
	return val
}

function normalizePgRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(row)) {
		out[k] = normalizePgCell(v)
	}
	return out
}

function coercePgParam(raw: string, columnType = ''): string | number | boolean {
	const t = columnType.toLowerCase()
	const trimmed = raw.trim()
	if (t === 'boolean' || t === 'bool') {
		if (trimmed.toLowerCase() === 'true' || trimmed === '1' || trimmed === 't') return true
		if (trimmed.toLowerCase() === 'false' || trimmed === '0' || trimmed === 'f') return false
	}
	if (
		t.includes('int') ||
		t.includes('serial') ||
		t.includes('numeric') ||
		t.includes('decimal') ||
		t.includes('real') ||
		t.includes('double') ||
		t.includes('float')
	) {
		if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
			const num = Number(trimmed)
			if (Number.isSafeInteger(num) || trimmed.includes('.')) return num
		}
	}
	return raw
}

function canMatchPgType(value: string, columnType: string): boolean {
	const t = columnType.toLowerCase()
	if (t === 'uuid') {
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
	}
	if (t.includes('int') || t.includes('serial')) {
		return /^-?\d+$/.test(value)
	}
	if (t.includes('numeric') || t.includes('decimal') || t.includes('real') || t.includes('double')) {
		return /^-?\d+(\.\d+)?$/.test(value)
	}
	if (t === 'boolean' || t === 'bool') {
		return /^(true|false|t|f|1|0)$/i.test(value)
	}
	if (t.includes('char') || t === 'text' || t === 'citext' || t === 'name') {
		return true
	}
	return false
}

function sqlLiteralPreview(val: unknown): string {
	if (val === null || val === undefined) return 'NULL'
	if (typeof val === 'number' || typeof val === 'boolean') return String(val)
	return `'${String(val).replaceAll("'", "''")}'`
}

function formatPgError(err: unknown): string {
	if (!err || typeof err !== 'object') return String(err)
	const e = err as { message?: string; detail?: string; hint?: string }
	const parts = [e.message || String(err)]
	if (e.detail) parts.push(`Detail: ${e.detail}`)
	if (e.hint) parts.push(`Hint: ${e.hint}`)
	return parts.join(' — ')
}

function buildPgWhereClause(
	filters: FilterSpec[] | undefined,
	search: string | undefined,
	colMap: Map<string, ColumnInfo>,
	startIndex = 1,
): { clauses: string[]; bindings: unknown[]; nextIndex: number } {
	const clauses: string[] = []
	const bindings: unknown[] = []
	let idx = startIndex
	const pushBind = (val: unknown) => {
		bindings.push(val)
		return `$${idx++}`
	}

	for (const f of filters ?? []) {
		const col = colMap.get(f.column)
		if (!col) throw new Error(`Unknown column in filter: ${f.column}`)
		const qCol = quotePgIdent(col.name)
		switch (f.op) {
			case 'eq':
				clauses.push(`${qCol} = ${pushBind(coercePgParam(f.value, col.type))}`)
				break
			case 'neq':
				clauses.push(`${qCol} <> ${pushBind(coercePgParam(f.value, col.type))}`)
				break
			case 'gt':
				clauses.push(`${qCol} > ${pushBind(coercePgParam(f.value, col.type))}`)
				break
			case 'gte':
				clauses.push(`${qCol} >= ${pushBind(coercePgParam(f.value, col.type))}`)
				break
			case 'lt':
				clauses.push(`${qCol} < ${pushBind(coercePgParam(f.value, col.type))}`)
				break
			case 'lte':
				clauses.push(`${qCol} <= ${pushBind(coercePgParam(f.value, col.type))}`)
				break
			case 'like': {
				const pat = f.value.includes('%') || f.value.includes('_') ? f.value : `%${f.value}%`
				clauses.push(`CAST(${qCol} AS TEXT) ILIKE ${pushBind(pat)}`)
				break
			}
			case 'in': {
				const parts = f.value
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
				if (parts.length > 0) {
					const placeholders = parts.map((p) => pushBind(coercePgParam(p, col.type)))
					clauses.push(`${qCol} IN (${placeholders.join(', ')})`)
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
		const pRef = pushBind(pattern)
		const colChecks: string[] = []
		for (const col of colMap.values()) {
			colChecks.push(`CAST(${quotePgIdent(col.name)} AS TEXT) ILIKE ${pRef}`)
		}
		if (colChecks.length > 0) {
			clauses.push(`(${colChecks.join(' OR ')})`)
		}
	}

	return { clauses, bindings, nextIndex: idx }
}

export class PostgresAdapter implements DbAdapter {
	readonly driver = 'postgres' as const
	private readonly parsed: ParsedPostgresUrl
	private readonly tunnel: SshTcpTunnel | null
	private sql: SQL | null = null
	private connectPromise: Promise<SQL> | null = null
	private activeQueries = new Map<string, () => void>()

	constructor(connectionUrl: string, ssh?: { target: SshTarget; getAskpass: () => SshAskpassConfig | null }) {
		this.parsed = parsePostgresUrl(connectionUrl)
		this.tunnel = ssh ? new SshTcpTunnel(ssh.target, this.parsed.hostname, this.parsed.port, ssh.getAskpass) : null
	}

	setHostPromptActive(dest: string, active: boolean) {
		if (this.tunnel && this.tunnel.dest === dest) {
			this.tunnel.setPromptActive(active)
		}
	}

	private async getClient(): Promise<SQL> {
		if (this.sql) return this.sql
		if (this.connectPromise) return this.connectPromise

		this.connectPromise = (async () => {
			const localPort = this.tunnel ? await this.tunnel.ensureOpen() : undefined
			const connCfg = buildPostgresConnectConfig(this.parsed, localPort)

			const client = new SQL({
				url: connCfg.url,
				adapter: 'postgres',
				max: 6,
				idleTimeout: 30,
				connectionTimeout: 15,
				...(connCfg.tls ? { tls: connCfg.tls } : {}),
			})
			try {
				await client.connect()
			} catch (err) {
				await client.close().catch(() => {})
				throw err
			}
			this.sql = client
			return client
		})().catch((err) => {
			this.connectPromise = null
			throw new Error(formatPgError(err))
		})

		return this.connectPromise
	}

	async ping() {
		const t0 = performance.now()
		const sql = await this.getClient()
		const rows = await sql.unsafe<{ version: string }[]>('SELECT version() AS version')
		const rawVersion = rows[0]?.version ?? ''
		const shortVer = /^PostgreSQL\s+([^\s,]+)/i.exec(rawVersion)?.[1] ?? rawVersion
		return {
			ok: true as const,
			latencyMs: Math.round((performance.now() - t0) * 100) / 100,
			version: shortVer,
		}
	}

	async getSchema(): Promise<DatabaseSchema> {
		const t0 = performance.now()
		const sql = await this.getClient()

		const [relRows, colRows, pkRows, fkRows, idxRows, viewDefRows, trigRows] = await Promise.all([
			sql.unsafe<
				{
					oid: number
					schema_name: string
					table_name: string
					relkind: string
					row_estimate: string | number | null
				}[]
			>(`
				SELECT
					c.oid::int AS oid,
					n.nspname AS schema_name,
					c.relname AS table_name,
					c.relkind::text AS relkind,
					CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END AS row_estimate
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('r', 'p', 'v', 'm')
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND n.nspname NOT LIKE 'pg_toast%'
				  AND n.nspname NOT LIKE 'pg_temp_%'
				ORDER BY
					CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END,
					CASE WHEN c.relkind IN ('r', 'p') THEN 0 ELSE 1 END,
					n.nspname,
					c.relname
			`),
			sql.unsafe<
				{
					attrelid: number
					attnum: number
					column_name: string
					data_type: string
					not_null: boolean
					default_value: string | null
				}[]
			>(`
				SELECT
					a.attrelid::int AS attrelid,
					a.attnum::int AS attnum,
					a.attname AS column_name,
					pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
					a.attnotnull AS not_null,
					pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value
				FROM pg_attribute a
				JOIN pg_class c ON c.oid = a.attrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
				WHERE a.attnum > 0
				  AND NOT a.attisdropped
				  AND c.relkind IN ('r', 'p', 'v', 'm')
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND n.nspname NOT LIKE 'pg_toast%'
				  AND n.nspname NOT LIKE 'pg_temp_%'
				ORDER BY a.attrelid, a.attnum
			`),
			sql.unsafe<{ conrelid: number; attnum: number; ord: number }[]>(`
				SELECT
					con.conrelid::int AS conrelid,
					k.attnum::int AS attnum,
					k.ord::int AS ord
				FROM pg_constraint con
				JOIN pg_class c ON c.oid = con.conrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
				WHERE con.contype = 'p'
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND n.nspname NOT LIKE 'pg_toast%'
			`),
			sql.unsafe<
				{
					oid: number
					from_schema: string
					from_table: string
					from_col: string
					to_schema: string
					to_table: string
					to_col: string
					confupdtype: string
					confdeltype: string
				}[]
			>(`
				SELECT
					con.oid::int AS oid,
					ns_from.nspname AS from_schema,
					c_from.relname AS from_table,
					a_from.attname AS from_col,
					ns_to.nspname AS to_schema,
					c_to.relname AS to_table,
					a_to.attname AS to_col,
					con.confupdtype::text AS confupdtype,
					con.confdeltype::text AS confdeltype
				FROM pg_constraint con
				JOIN pg_class c_from ON c_from.oid = con.conrelid
				JOIN pg_namespace ns_from ON ns_from.oid = c_from.relnamespace
				JOIN pg_class c_to ON c_to.oid = con.confrelid
				JOIN pg_namespace ns_to ON ns_to.oid = c_to.relnamespace
				CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(from_attnum, to_attnum, ord)
				JOIN pg_attribute a_from ON a_from.attrelid = con.conrelid AND a_from.attnum = k.from_attnum
				JOIN pg_attribute a_to ON a_to.attrelid = con.confrelid AND a_to.attnum = k.to_attnum
				WHERE con.contype = 'f'
				  AND ns_from.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND ns_from.nspname NOT LIKE 'pg_toast%'
				ORDER BY con.oid, k.ord
			`),
			sql.unsafe<
				{
					indrelid: number
					index_name: string
					is_unique: boolean
					is_primary: boolean
					col_names: string
				}[]
			>(`
				SELECT
					i.indrelid::int AS indrelid,
					ic.relname AS index_name,
					i.indisunique AS is_unique,
					i.indisprimary AS is_primary,
					COALESCE(
						(
							SELECT string_agg(a.attname, ',' ORDER BY k.ord)
							FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
							JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
							WHERE k.attnum > 0
						),
						''
					) AS col_names
				FROM pg_index i
				JOIN pg_class ic ON ic.oid = i.indexrelid
				JOIN pg_class tc ON tc.oid = i.indrelid
				JOIN pg_namespace n ON n.oid = tc.relnamespace
				WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND n.nspname NOT LIKE 'pg_toast%'
				ORDER BY i.indrelid, ic.relname
			`),
			sql.unsafe<{ oid: number; viewdef: string }[]>(`
				SELECT
					c.oid::int AS oid,
					pg_catalog.pg_get_viewdef(c.oid, true) AS viewdef
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('v', 'm')
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND n.nspname NOT LIKE 'pg_toast%'
			`),
			sql.unsafe<{ schema_name: string; table_name: string; trigger_name: string; def: string }[]>(`
				SELECT
					n.nspname AS schema_name,
					c.relname AS table_name,
					t.tgname AS trigger_name,
					pg_catalog.pg_get_triggerdef(t.oid, true) AS def
				FROM pg_trigger t
				JOIN pg_class c ON c.oid = t.tgrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE NOT t.tgisinternal
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND n.nspname NOT LIKE 'pg_toast%'
				ORDER BY n.nspname, c.relname, t.tgname
			`),
		])

		const pkByRel = new Map<number, Map<number, number>>()
		for (const pk of pkRows) {
			let m = pkByRel.get(pk.conrelid)
			if (!m) {
				m = new Map()
				pkByRel.set(pk.conrelid, m)
			}
			m.set(pk.attnum, pk.ord)
		}

		const colsByRel = new Map<number, ColumnInfo[]>()
		for (const c of colRows) {
			let list = colsByRel.get(c.attrelid)
			if (!list) {
				list = []
				colsByRel.set(c.attrelid, list)
			}
			const pkPos = pkByRel.get(c.attrelid)?.get(c.attnum) ?? 0
			list.push({
				name: c.column_name,
				type: c.data_type,
				notNull: Boolean(c.not_null),
				defaultValue: c.default_value,
				primaryKey: pkPos,
			})
		}

		const idxByRel = new Map<number, IndexInfo[]>()
		for (const idx of idxRows) {
			let list = idxByRel.get(idx.indrelid)
			if (!list) {
				list = []
				idxByRel.set(idx.indrelid, list)
			}
			list.push({
				name: idx.index_name,
				unique: Boolean(idx.is_unique),
				origin: idx.is_primary ? 'pk' : idx.is_unique ? 'u' : 'c',
				columns: idx.col_names ? idx.col_names.split(',').filter(Boolean) : [],
			})
		}

		const viewDefByOid = new Map<number, string>()
		for (const v of viewDefRows) viewDefByOid.set(v.oid, v.viewdef)

		const triggers: TriggerInfo[] = trigRows.map((tr) => ({
			name: tr.trigger_name,
			table: formatTableKey(tr.schema_name, tr.table_name),
			sql: tr.def,
		}))
		const triggersByTable = new Map<string, TriggerInfo[]>()
		for (const tr of triggers) {
			const list = triggersByTable.get(tr.table) ?? []
			list.push(tr)
			triggersByTable.set(tr.table, list)
		}

		const tables: TableSummary[] = []
		const schemas: Record<string, TableSchema> = {}

		for (const r of relRows) {
			const key = formatTableKey(r.schema_name, r.table_name)
			const kind: 'table' | 'view' = r.relkind === 'r' || r.relkind === 'p' ? 'table' : 'view'
			const columns = colsByRel.get(r.oid) ?? []
			const pkCols = columns
				.filter((c) => c.primaryKey > 0)
				.sort((a, b) => a.primaryKey - b.primaryKey)
				.map((c) => c.name)
			const indexes = idxByRel.get(r.oid) ?? []
			const rowCount =
				kind === 'table' && r.row_estimate !== null && r.row_estimate !== undefined ? Number(r.row_estimate) : null

			let ddl = ''
			if (kind === 'view') {
				const def = viewDefByOid.get(r.oid) ?? ''
				ddl = `CREATE ${r.relkind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${quotePgTable(key)} AS\n${def}`
			} else {
				const colDefs = columns.map((c) => {
					const parts = [`  ${quotePgIdent(c.name)} ${c.type}`]
					if (c.notNull) parts.push('NOT NULL')
					if (c.defaultValue !== null) parts.push(`DEFAULT ${c.defaultValue}`)
					return parts.join(' ')
				})
				if (pkCols.length > 0) {
					colDefs.push(`  PRIMARY KEY (${pkCols.map(quotePgIdent).join(', ')})`)
				}
				ddl = `CREATE TABLE ${quotePgTable(key)} (\n${colDefs.join(',\n')}\n);`
			}

			tables.push({ name: key, type: kind, rowCount })
			schemas[key] = {
				name: key,
				type: kind,
				ddl,
				columns,
				foreignKeys: [],
				reverseForeignKeys: [],
				indexes,
				primaryKeyColumns: pkCols,
				triggers: triggersByTable.get(key) ?? [],
			}
		}

		let fkCounter = 0
		for (const fk of fkRows) {
			const fromKey = formatTableKey(fk.from_schema, fk.from_table)
			const toKey = formatTableKey(fk.to_schema, fk.to_table)
			const fromSchema = schemas[fromKey]
			const toSchema = schemas[toKey]
			if (fromSchema) {
				const info: ForeignKeyInfo = {
					id: fkCounter++,
					fromColumn: fk.from_col,
					toTable: toKey,
					toColumn: fk.to_col,
					onUpdate: PG_FK_ACTION[fk.confupdtype] ?? 'NO ACTION',
					onDelete: PG_FK_ACTION[fk.confdeltype] ?? 'NO ACTION',
				}
				fromSchema.foreignKeys.push(info)
			}
			if (toSchema) {
				toSchema.reverseForeignKeys.push({
					fromTable: fromKey,
					fromColumn: fk.from_col,
					toColumn: fk.to_col,
				})
			}
		}

		return {
			tables,
			schemas,
			triggers,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
		}
	}

	async browseTable(params: BrowseParams): Promise<BrowseResult> {
		const t0 = performance.now()
		const sql = await this.getClient()
		const schema = await this.getSchema()
		const tableSchema = schema.schemas[params.table]
		const tableSummary = schema.tables.find((t) => t.name === params.table)
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

		const { clauses, bindings, nextIndex } = buildPgWhereClause(params.filters, params.search, colMap, 1)
		const qTable = quotePgTable(tableSchema.name)
		const estRows = tableSummary?.rowCount ?? null
		const isLargeTable = estRows !== null && estRows > LARGE_TABLE_ESTIMATE_THRESHOLD

		// Avoid expensive COUNT(*) scans on large tables (>50k est rows)
		let totalCount: number | null = null
		if (isLargeTable) {
			totalCount = clauses.length === 0 ? estRows : null
		} else {
			try {
				const countSql =
					`SELECT COUNT(*)::bigint AS c FROM ${qTable}` + (clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '')
				const cRows = await sql.unsafe<{ c: string | number }[]>(countSql, bindings)
				totalCount = cRows[0]?.c !== undefined ? Number(cRows[0].c) : 0
			} catch {
				totalCount = estRows
			}
		}

		const fetchCols = keysetCol && !selectedCols.includes(keysetCol) ? [...selectedCols, keysetCol] : selectedCols
		const selectSql = fetchCols.map(quotePgIdent).join(', ')

		const rowClauses = [...clauses]
		const rowBindings = [...bindings]
		const limit = Math.max(1, Math.min(2000, params.limit || 100))
		const isPrev = params.direction === 'prev'

		let orderSql = ''
		let offsetSql = ''

		if (keysetCol && params.start !== undefined && params.start !== null && params.start !== '') {
			const col = colMap.get(keysetCol)!
			const cursorVal = coercePgParam(params.start, col.type)
			const placeholder = `$${nextIndex}`
			if (isPrev) {
				const op = keysetDir === 'asc' ? '<' : '>'
				rowClauses.push(`${quotePgIdent(keysetCol)} ${op} ${placeholder}`)
				rowBindings.push(cursorVal)
				orderSql = ` ORDER BY ${quotePgIdent(keysetCol)} ${keysetDir === 'asc' ? 'DESC' : 'ASC'}`
			} else {
				const op = keysetDir === 'asc' ? '>' : '<'
				rowClauses.push(`${quotePgIdent(keysetCol)} ${op} ${placeholder}`)
				rowBindings.push(cursorVal)
				orderSql = ` ORDER BY ${quotePgIdent(keysetCol)} ${keysetDir.toUpperCase()}`
			}
		} else {
			if (validOrders.length > 0) {
				orderSql = ' ORDER BY ' + validOrders.map((o) => `${quotePgIdent(o.column)} ${o.dir.toUpperCase()}`).join(', ')
			}
			if (params.offset && params.offset > 0) {
				offsetSql = ` OFFSET ${Math.floor(params.offset)}`
			}
		}

		const whereSql = rowClauses.length > 0 ? ` WHERE ${rowClauses.join(' AND ')}` : ''
		const querySql = `SELECT ${selectSql} FROM ${qTable}${whereSql}${orderSql} LIMIT ${limit + 1}${offsetSql}`
		const rawRows = (await sql.unsafe<Record<string, unknown>[]>(querySql, rowBindings)).map(normalizePgRow)

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
		for (const c of selectedCols) {
			columnTypes[c] = colMap.get(c)?.type ?? 'text'
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
			generatedSql: querySql,
			keysetColumn: keysetCol,
		}
	}

	async executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number; queryId?: string },
	): Promise<QueryStatementResult[]> {
		const sql = await this.getClient()
		const maxRows = options.maxRows ?? 2000
		const results: QueryStatementResult[] = []

		const runList = async (runner: SQL) => {
			for (const rawSql of statements) {
				const stmtSql = rawSql.trim()
				if (!stmtSql) continue
				const t0 = performance.now()
				try {
					const q = runner.unsafe<Record<string, unknown>[]>(stmtSql)
					if (options.queryId) {
						this.activeQueries.set(options.queryId, () => {
							try {
								q.cancel()
							} catch {}
						})
					}
					const res = await q
					const allRows = Array.isArray(res) ? res : []
					const truncated = allRows.length > maxRows
					const sliced = truncated ? allRows.slice(0, maxRows) : allRows
					const normalized = sliced.map(normalizePgRow)
					const colMeta = (res as { columns?: { name: string }[] }).columns
					const columns =
						Array.isArray(colMeta) && colMeta.length > 0
							? colMeta.map((c) => c.name)
							: normalized.length > 0
								? Object.keys(normalized[0]!)
								: []
					const count = typeof (res as { count?: number }).count === 'number' ? (res as { count: number }).count : 0

					results.push({
						sql: stmtSql,
						columns,
						rows: normalized,
						rowCount: normalized.length,
						changes: columns.length === 0 ? count : 0,
						lastInsertRowid: null,
						durationMs: Math.round((performance.now() - t0) * 100) / 100,
						sourceTable: columns.length > 0 ? detectSourceTable(stmtSql) : null,
						truncated,
					})
				} catch (err) {
					results.push({
						sql: stmtSql,
						columns: [],
						rows: [],
						rowCount: 0,
						changes: 0,
						lastInsertRowid: null,
						durationMs: Math.round((performance.now() - t0) * 100) / 100,
						sourceTable: null,
						truncated: false,
						error: formatPgError(err),
					})
					break
				}
			}
		}

		try {
			if (!options.writable) {
				// Enforce server-side READ ONLY transaction on PostgreSQL so writes are impossible even via functions/CTEs.
				await sql.begin('READ ONLY', async (tx) => {
					await tx.unsafe("SET LOCAL statement_timeout = '600000'")
					await runList(tx)
				})
			} else {
				await runList(sql)
			}
		} finally {
			if (options.queryId) this.activeQueries.delete(options.queryId)
		}

		return results
	}

	async cancelQuery(queryId: string): Promise<boolean> {
		const cancelFn = this.activeQueries.get(queryId)
		if (!cancelFn) return false
		cancelFn()
		return true
	}

	async mutate(req: MutateRequest): Promise<MutateResponse> {
		const t0 = performance.now()
		const sql = await this.getClient()
		const schema = await this.getSchema()
		const tableSchema = schema.schemas[req.table]
		if (!tableSchema) throw new Error(`Table not found: ${req.table}`)
		if (tableSchema.type !== 'table') throw new Error(`Cannot mutate view: ${req.table}`)

		const colMap = new Map(tableSchema.columns.map((c) => [c.name, c]))
		const qTable = quotePgTable(tableSchema.name)
		const sqlPreview: string[] = []
		let applied = 0

		await sql.begin('READ WRITE', async (tx) => {
			for (const upd of req.updates ?? []) {
				const setEntries = Object.entries(upd.changes)
				const pkEntries = Object.entries(upd.pk)
				if (setEntries.length === 0) continue
				if (pkEntries.length === 0) throw new Error('Update requires primary key values')

				const setClauses: string[] = []
				const whereClauses: string[] = []
				const bindings: unknown[] = []
				let idx = 1

				for (const [col, val] of setEntries) {
					const colInfo = colMap.get(col)
					if (!colInfo) throw new Error(`Unknown column: ${col}`)
					setClauses.push(`${quotePgIdent(col)} = $${idx++}`)
					bindings.push(
						val === null || val === undefined ? null : typeof val === 'string' ? coercePgParam(val, colInfo.type) : val,
					)
				}
				for (const [col, val] of pkEntries) {
					const colInfo = colMap.get(col)
					if (!colInfo) throw new Error(`Unknown PK column: ${col}`)
					if (val === null || val === undefined) {
						whereClauses.push(`${quotePgIdent(col)} IS NULL`)
					} else {
						whereClauses.push(`${quotePgIdent(col)} = $${idx++}`)
						bindings.push(typeof val === 'string' ? coercePgParam(val, colInfo.type) : val)
					}
				}

				const stmt = `UPDATE ${qTable} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`
				sqlPreview.push(
					`UPDATE ${qTable} SET ${setEntries.map(([c, v]) => `${quotePgIdent(c)} = ${sqlLiteralPreview(v)}`).join(', ')} WHERE ${pkEntries.map(([c, v]) => (v === null ? `${quotePgIdent(c)} IS NULL` : `${quotePgIdent(c)} = ${sqlLiteralPreview(v)}`)).join(' AND ')};`,
				)
				const res = await tx.unsafe(stmt, bindings)
				applied += (res as { count?: number }).count ?? 0
			}

			for (const ins of req.inserts ?? []) {
				const entries = Object.entries(ins).filter(([c]) => colMap.has(c))
				if (entries.length === 0) {
					const stmt = `INSERT INTO ${qTable} DEFAULT VALUES`
					sqlPreview.push(`${stmt};`)
					const res = await tx.unsafe(stmt)
					applied += (res as { count?: number }).count ?? 1
				} else {
					const cols = entries.map(([c]) => quotePgIdent(c)).join(', ')
					const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ')
					const vals = entries.map(([c, v]) => {
						if (v === undefined || v === null) return null
						const colInfo = colMap.get(c)!
						return typeof v === 'string' ? coercePgParam(v, colInfo.type) : v
					})
					const stmt = `INSERT INTO ${qTable} (${cols}) VALUES (${placeholders})`
					sqlPreview.push(`INSERT INTO ${qTable} (${cols}) VALUES (${vals.map(sqlLiteralPreview).join(', ')});`)
					const res = await tx.unsafe(stmt, vals)
					applied += (res as { count?: number }).count ?? 1
				}
			}

			for (const pk of req.deletes ?? []) {
				const pkEntries = Object.entries(pk)
				if (pkEntries.length === 0) throw new Error('Delete requires primary key values')
				const whereClauses: string[] = []
				const bindings: unknown[] = []
				let idx = 1
				for (const [col, val] of pkEntries) {
					const colInfo = colMap.get(col)
					if (!colInfo) throw new Error(`Unknown PK column: ${col}`)
					if (val === null || val === undefined) {
						whereClauses.push(`${quotePgIdent(col)} IS NULL`)
					} else {
						whereClauses.push(`${quotePgIdent(col)} = $${idx++}`)
						bindings.push(typeof val === 'string' ? coercePgParam(val, colInfo.type) : val)
					}
				}
				const stmt = `DELETE FROM ${qTable} WHERE ${whereClauses.join(' AND ')}`
				sqlPreview.push(
					`DELETE FROM ${qTable} WHERE ${pkEntries.map(([c, v]) => (v === null ? `${quotePgIdent(c)} IS NULL` : `${quotePgIdent(c)} = ${sqlLiteralPreview(v)}`)).join(' AND ')};`,
				)
				const res = await tx.unsafe(stmt, bindings)
				applied += (res as { count?: number }).count ?? 0
			}
		})

		return {
			applied,
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
			sqlPreview,
		}
	}

	async peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null> {
		const sql = await this.getClient()
		const schema = await this.getSchema()
		const tableSchema = schema.schemas[table]
		if (!tableSchema) return null
		const col = tableSchema.columns.find((c) => c.name === column)
		if (!col) return null
		const param = typeof value === 'string' ? coercePgParam(value, col.type) : value
		const rows = await sql.unsafe<Record<string, unknown>[]>(
			`SELECT * FROM ${quotePgTable(tableSchema.name)} WHERE ${quotePgIdent(col.name)} = $1 LIMIT 1`,
			[param],
		)
		return rows[0] ? normalizePgRow(rows[0]) : null
	}

	async countReverseFks(table: string, row: Record<string, unknown>): Promise<ReverseFkCount[]> {
		const sql = await this.getClient()
		const schema = await this.getSchema()
		const tableSchema = schema.schemas[table]
		if (!tableSchema) return []
		const counts: ReverseFkCount[] = []
		for (const rfk of tableSchema.reverseForeignKeys) {
			const val = row[rfk.toColumn]
			if (val === null || val === undefined) {
				counts.push({ ...rfk, count: 0 })
				continue
			}
			const fromSchema = schema.schemas[rfk.fromTable]
			const fromCol = fromSchema?.columns.find((c) => c.name === rfk.fromColumn)
			const param = typeof val === 'string' && fromCol ? coercePgParam(val, fromCol.type) : val
			try {
				const res = await sql.begin('READ ONLY', async (tx) => {
					await tx.unsafe("SET LOCAL statement_timeout = '3000'")
					return tx.unsafe<{ c: string | number }[]>(
						`SELECT COUNT(*)::bigint AS c FROM ${quotePgTable(rfk.fromTable)} WHERE ${quotePgIdent(rfk.fromColumn)} = $1`,
						[param],
					)
				})
				counts.push({ ...rfk, count: Number(res[0]?.c ?? 0) })
			} catch {
				counts.push({ ...rfk, count: 0 })
			}
		}
		return counts
	}

	async searchId(value: string): Promise<IdMatch[]> {
		const trimmed = value.trim()
		if (!trimmed) return []
		const sql = await this.getClient()
		const schema = await this.getSchema()
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
				if (!col || !canMatchPgType(trimmed, col.type)) continue
				try {
					const param = coercePgParam(trimmed, col.type)
					const rows = await sql.unsafe<Record<string, unknown>[]>(
						`SELECT * FROM ${quotePgTable(tableSchema.name)} WHERE ${quotePgIdent(col.name)} = $1 LIMIT 1`,
						[param],
					)
					if (rows[0]) {
						matches.push({
							table: tableSchema.name,
							column: col.name,
							isPrimaryKey: col.primaryKey > 0,
							row: normalizePgRow(rows[0]),
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
		const sql = await this.getClient()
		const schema = await this.getSchema()
		const tableSchema = schema.schemas[table]
		if (!tableSchema) throw new Error(`Table or view not found: ${table}`)
		const col = tableSchema.columns.find((c) => c.name === column)
		if (!col) throw new Error(`Column not found: ${table}.${column}`)

		const qTable = quotePgTable(tableSchema.name)
		const qCol = quotePgIdent(col.name)

		return sql.begin('READ ONLY', async (tx) => {
			await tx.unsafe("SET LOCAL statement_timeout = '10000'")
			const aggRows = await tx.unsafe<
				{
					total: string | number
					non_null: string | number
					distinct_cnt: string | number
					min_val: unknown
					max_val: unknown
				}[]
			>(
				`SELECT
					COUNT(*)::bigint AS total,
					COUNT(${qCol})::bigint AS non_null,
					COUNT(DISTINCT ${qCol})::bigint AS distinct_cnt,
					MIN(CAST(${qCol} AS TEXT)) AS min_val,
					MAX(CAST(${qCol} AS TEXT)) AS max_val
				 FROM ${qTable}`,
			)
			const agg = aggRows[0]
			const totalRows = Number(agg?.total ?? 0)
			const nonNullCount = Number(agg?.non_null ?? 0)
			const nullCount = Math.max(0, totalRows - nonNullCount)
			const nullPct = totalRows > 0 ? Math.round((nullCount / totalRows) * 1000) / 10 : 0
			const distinctCount = Number(agg?.distinct_cnt ?? 0)

			const topRows = await tx.unsafe<{ val: unknown; cnt: string | number }[]>(
				`SELECT CAST(${qCol} AS TEXT) AS val, COUNT(*)::bigint AS cnt
				 FROM ${qTable}
				 GROUP BY ${qCol}
				 ORDER BY cnt DESC
				 LIMIT 10`,
			)

			const fmtVal = (v: unknown): string | null => {
				const norm = normalizePgCell(v)
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
				topValues: topRows.map((r) => ({ value: fmtVal(r.val), count: Number(r.cnt) })),
				durationMs: Math.round((performance.now() - t0) * 100) / 100,
			}
		})
	}

	async getInfo(): Promise<DatabaseInfo> {
		const t0 = performance.now()
		const sql = await this.getClient()
		const rows = await sql.unsafe<
			{
				version: string
				db: string
				usr: string
				size_bytes: string | number | null
				encoding: string
				ro: string
			}[]
		>(`
			SELECT
				version() AS version,
				current_database() AS db,
				current_user AS usr,
				pg_database_size(current_database())::bigint AS size_bytes,
				pg_encoding_to_char(encoding) AS encoding,
				current_setting('default_transaction_read_only') AS ro
			FROM pg_database
			WHERE datname = current_database()
		`)
		const r = rows[0]
		const shortVer = /^PostgreSQL\s+([^\s,]+)/i.exec(r?.version ?? '')?.[1] ?? r?.version ?? ''
		return {
			driver: 'postgres',
			version: shortVer,
			currentDatabase: r?.db,
			currentUser: r?.usr,
			databaseSizeBytes: r?.size_bytes !== null && r?.size_bytes !== undefined ? Number(r.size_bytes) : null,
			encoding: r?.encoding,
			readOnly: r?.ro === 'on',
			durationMs: Math.round((performance.now() - t0) * 100) / 100,
		}
	}

	close() {
		for (const cancelFn of this.activeQueries.values()) cancelFn()
		this.activeQueries.clear()
		const client = this.sql
		this.sql = null
		this.connectPromise = null
		if (client) {
			void client.close({ timeout: 0 }).catch(() => {})
		}
		this.tunnel?.close()
	}
}

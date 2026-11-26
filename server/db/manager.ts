// Connection lifecycle manager, Read-Only / Read-Write safety gatekeeper, orphaned-connection tracker, and SSH pool coordinator.
import { closeSync, existsSync, openSync, readSync, realpathSync, watch } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { analyzeSqlDanger, splitSqlStatements } from '../../src/shared/sql.ts'
import { getExtraReverseFksForTable, mergeSchemaForeignKeys } from '../../src/shared/virtual-fks.ts'
import type {
	BrowseParams,
	ColumnProfile,
	ConnectionConfig,
	ConnectionsPayload,
	ConnectionWithStatus,
	DatabaseInfo,
	DatabaseSchema,
	DiscoveredDb,
	DiscoverPreset,
	MutateRequest,
	MutateResponse,
	QueryResponse,
	ReverseFkCount,
} from '../../src/shared/types.ts'
import type { ExportFormat } from '../export.ts'
import { formatExportRows, sanitizeExportFilename } from '../export.ts'
import type { DataStore } from '../store.ts'
import { discoverLocalSqliteDbs, suggestDbName } from './discover.ts'
import { PostgresAdapter } from './postgres.ts'
import { expandTilde, LocalSqliteAdapter } from './sqlite-local.ts'
import { SshSqliteAdapter } from './sqlite-ssh.ts'
import { type SshAskpassConfig, SshMuxPool } from './ssh-mux.ts'
import { SshPromptBroker } from './ssh-prompts.ts'
import type { DbAdapter } from './types.ts'

export const PROD_RW_TTL_MS = 10 * 60 * 1000 // 10-minute auto-relock on production databases

interface RwState {
	armed: boolean
	until: number | null // null = armed until manually locked (non-prod)
}

interface AdapterEntry {
	sig: string
	adapter: DbAdapter
	config: ConnectionConfig
	lastLatencyMs: number | null
	lastRawSchema?: DatabaseSchema
	stopWatch?: () => void
}

export class ConnectionManager {
	readonly store: DataStore
	readonly sshPool = new SshMuxPool()
	readonly sshPrompts: SshPromptBroker
	private adapters = new Map<string, AdapterEntry>()
	private rwStates = new Map<string, RwState>()
	private subscribers = new Set<(payload: ConnectionsPayload) => void>()
	private dbChangeListeners = new Set<(ev: { connectionId: string; ts: number }) => void>()
	private unsubStore: () => void
	private askpassConfig: SshAskpassConfig | null = null

	constructor(store: DataStore) {
		this.store = store
		this.sshPrompts = new SshPromptBroker((host, active) => {
			this.sshPool.setHostPromptActive(host, active)
			for (const entry of this.adapters.values()) {
				if (entry.adapter instanceof PostgresAdapter) {
					entry.adapter.setHostPromptActive(host, active)
				}
			}
		})
		this.unsubStore = this.store.onConnectionsChange(() => {
			this.reconcileActiveConnections()
			this.notifySubscribers()
		})
	}

	setServerUrl(url: string) {
		const cfg: SshAskpassConfig = {
			url: `${url}/api/internal/ssh-askpass`,
			token: this.sshPrompts.token,
		}
		this.askpassConfig = cfg
		this.sshPool.setAskpassConfig(cfg)
	}

	hasSubscribers(): boolean {
		return this.subscribers.size > 0
	}

	private signature(c: ConnectionConfig): string {
		return `${c.driver}|${c.location}|${c.sshUser ?? ''}@${c.sshHost ?? ''}:${c.sshPort ?? 22}|${c.path}`
	}

	private reconcileActiveConnections() {
		const savedById = new Map(this.store.listConnections().map((c) => [c.id, c]))
		for (const [id, entry] of this.adapters.entries()) {
			const updated = savedById.get(id)
			if (!updated) {
				// Removed from connections.ason while active: keep alive in memory as orphaned.
				continue
			}
			const nextSig = this.signature(updated)
			if (nextSig !== entry.sig) {
				entry.stopWatch?.()
				entry.adapter.close()
				this.adapters.delete(id)
				this.rwStates.delete(id)
				continue
			}
			// If connection was newly marked as production while RW was unlimited, or locked alwaysReadOnly, lock back to RO.
			if (updated.alwaysReadOnly) {
				this.rwStates.delete(id)
			} else if (updated.isProduction && !entry.config.isProduction) {
				const st = this.rwStates.get(id)
				if (st && st.armed && st.until === null) {
					this.rwStates.delete(id)
				}
			}
			entry.config = updated
		}
	}

	subscribe(listener: (payload: ConnectionsPayload) => void): () => void {
		this.subscribers.add(listener)
		return () => {
			this.subscribers.delete(listener)
		}
	}

	subscribeDbChanges(listener: (ev: { connectionId: string; ts: number }) => void): () => void {
		this.dbChangeListeners.add(listener)
		return () => {
			this.dbChangeListeners.delete(listener)
		}
	}

	private emitDbChange(connectionId: string) {
		if (this.dbChangeListeners.size === 0) return
		const ev = { connectionId, ts: Date.now() }
		for (const cb of this.dbChangeListeners) {
			try {
				cb(ev)
			} catch {}
		}
	}

	private watchLocalSqlite(connectionId: string, rawPath: string): (() => void) | undefined {
		const expanded = resolve(expandTilde(rawPath))
		let targetPath = expanded
		try {
			targetPath = realpathSync(expanded)
		} catch {}
		const dir = dirname(targetPath)
		const base = basename(targetPath)
		if (!existsSync(dir)) return undefined
		let timer: ReturnType<typeof setTimeout> | null = null
		try {
			const watcher = watch(dir, { persistent: false }, (_event, filename) => {
				if (filename && filename !== base && filename !== `${base}-wal` && filename !== `${base}-shm`) return
				if (timer) clearTimeout(timer)
				timer = setTimeout(() => {
					timer = null
					this.emitDbChange(connectionId)
				}, 250)
				timer.unref?.()
			})
			return () => {
				if (timer) clearTimeout(timer)
				try {
					watcher.close()
				} catch {}
			}
		} catch {
			return undefined
		}
	}

	getConnectionsPayload(): ConnectionsPayload {
		return {
			connections: this.listConnectionsWithStatus(),
			configError: this.store.getConnectionsError(),
		}
	}

	notifySubscribers() {
		if (this.subscribers.size === 0) return
		const payload = this.getConnectionsPayload()
		for (const cb of this.subscribers) {
			try {
				cb(payload)
			} catch {}
		}
	}

	getConnection(id: string): ConnectionConfig | null {
		return this.store.getConnection(id) ?? this.adapters.get(id)?.config ?? null
	}

	isOrphaned(id: string): boolean {
		return this.adapters.has(id) && !this.store.getConnection(id)
	}

	getOrphanedConfigs(): ConnectionConfig[] {
		const savedIds = new Set(this.store.listConnections().map((c) => c.id))
		const out: ConnectionConfig[] = []
		for (const [id, entry] of this.adapters.entries()) {
			if (!savedIds.has(id)) out.push(entry.config)
		}
		return out
	}

	getAdapter(conn: ConnectionConfig): DbAdapter {
		const sig = this.signature(conn)
		const cached = this.adapters.get(conn.id)
		if (cached && cached.sig === sig) {
			cached.config = conn
			return cached.adapter
		}
		if (cached) {
			cached.stopWatch?.()
			cached.adapter.close()
		}

		let adapter: DbAdapter
		let stopWatch: (() => void) | undefined
		if (conn.driver === 'postgres') {
			const ssh =
				conn.location === 'ssh'
					? {
							target: { host: conn.sshHost || '', user: conn.sshUser, port: conn.sshPort },
							getAskpass: () => this.askpassConfig,
						}
					: undefined
			if (conn.location === 'ssh' && !conn.sshHost) throw new Error('SSH connection is missing sshHost')
			adapter = new PostgresAdapter(conn.path, ssh)
		} else if (conn.location === 'ssh') {
			if (!conn.sshHost) throw new Error('SSH connection is missing sshHost')
			adapter = new SshSqliteAdapter(
				this.sshPool,
				{ host: conn.sshHost, user: conn.sshUser, port: conn.sshPort },
				conn.path,
			)
		} else {
			adapter = new LocalSqliteAdapter(conn.path)
			stopWatch = this.watchLocalSqlite(conn.id, conn.path)
		}

		this.adapters.set(conn.id, { sig, adapter, config: conn, lastLatencyMs: null, stopWatch })
		this.notifySubscribers()
		return adapter
	}

	getAdapterById(id: string): { conn: ConnectionConfig; adapter: DbAdapter } {
		const conn = this.getConnection(id)
		if (!conn) throw new HttpError(404, `Connection not found: ${id}`)
		return { conn, adapter: this.getAdapter(conn) }
	}

	getRwState(conn: ConnectionConfig): { armed: boolean; until: number | null } {
		if (conn.alwaysReadOnly) return { armed: false, until: null }
		const st = this.rwStates.get(conn.id)
		if (!st || !st.armed) return { armed: false, until: null }
		if (st.until !== null && Date.now() >= st.until) {
			this.rwStates.delete(conn.id)
			return { armed: false, until: null }
		}
		return { armed: true, until: st.until }
	}

	setRwMode(id: string, armed: boolean): { armed: boolean; until: number | null } {
		const conn = this.getConnection(id)
		if (!conn) throw new HttpError(404, `Connection not found: ${id}`)
		if (!armed) {
			this.rwStates.delete(id)
			this.notifySubscribers()
			return { armed: false, until: null }
		}
		if (conn.alwaysReadOnly) {
			throw new HttpError(403, `Connection "${conn.name}" is locked permanently Read-Only.`)
		}
		const until = conn.isProduction ? Date.now() + PROD_RW_TTL_MS : null
		this.rwStates.set(id, { armed: true, until })
		this.notifySubscribers()
		return { armed: true, until }
	}

	private refreshProdRwTimer(conn: ConnectionConfig): number | null {
		if (!conn.isProduction) return null
		const st = this.rwStates.get(conn.id)
		if (!st || !st.armed) return null
		st.until = Date.now() + PROD_RW_TTL_MS
		return st.until
	}

	listConnectionsWithStatus(): ConnectionWithStatus[] {
		const saved = this.store.listConnections()
		const savedIds = new Set(saved.map((c) => c.id))
		const out: ConnectionWithStatus[] = saved.map((c) => {
			const rw = this.getRwState(c)
			const cached = this.adapters.get(c.id)
			return {
				...c,
				rwArmed: rw.armed,
				rwArmedUntil: rw.until,
				connected: Boolean(cached),
				latencyMs: cached?.lastLatencyMs ?? null,
				orphaned: false,
			}
		})

		for (const [id, entry] of this.adapters.entries()) {
			if (savedIds.has(id)) continue
			const rw = this.getRwState(entry.config)
			out.push({
				...entry.config,
				rwArmed: rw.armed,
				rwArmedUntil: rw.until,
				connected: true,
				latencyMs: entry.lastLatencyMs,
				orphaned: true,
			})
		}

		return out
	}

	restoreOrphanedConnection(id: string): ConnectionConfig {
		const entry = this.adapters.get(id)
		if (!entry) throw new HttpError(404, `Orphaned connection not found: ${id}`)
		const restored = this.store.restoreConnection(entry.config)
		entry.config = restored
		this.notifySubscribers()
		return restored
	}

	async pingConnection(id: string) {
		const { conn, adapter } = this.getAdapterById(id)
		const res = await adapter.ping()
		const entry = this.adapters.get(conn.id)
		if (entry) entry.lastLatencyMs = res.latencyMs
		return res
	}

	async testDraftConnection(draft: Omit<ConnectionConfig, 'id' | 'createdAt'>) {
		const temp: ConnectionConfig = { ...draft, id: '__test__', createdAt: '' }
		const adapter =
			temp.driver === 'postgres'
				? new PostgresAdapter(
						temp.path,
						temp.location === 'ssh'
							? {
									target: { host: temp.sshHost || '', user: temp.sshUser, port: temp.sshPort },
									getAskpass: () => this.askpassConfig,
								}
							: undefined,
					)
				: temp.location === 'ssh'
					? new SshSqliteAdapter(
							this.sshPool,
							{ host: temp.sshHost || '', user: temp.sshUser, port: temp.sshPort },
							temp.path,
						)
					: new LocalSqliteAdapter(temp.path)
		try {
			const ping = await adapter.ping()
			const schema = await adapter.getSchema()
			return { ...ping, tableCount: schema.tables.length }
		} finally {
			adapter.close()
		}
	}

	openLocalFile(rawPath: string): ConnectionConfig {
		const expanded = resolve(expandTilde(rawPath.trim()))
		if (!existsSync(expanded)) {
			throw new HttpError(404, `SQLite file not found: ${expanded}`)
		}
		let realPath = expanded
		try {
			realPath = realpathSync(expanded)
		} catch {}

		// Validate SQLite header (allow empty 0-byte files too)
		let fd: number | undefined
		try {
			fd = openSync(realPath, 'r')
			const buf = Buffer.alloc(16)
			const n = readSync(fd, buf, 0, 16, 0)
			if (n > 0 && (n < 16 || buf.toString('utf8') !== 'SQLite format 3\0')) {
				throw new HttpError(400, `Not a valid SQLite database file: ${realPath}`)
			}
		} catch (err) {
			if (err instanceof HttpError) throw err
			throw new HttpError(400, `Cannot read file: ${err instanceof Error ? err.message : String(err)}`)
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd)
				} catch {}
			}
		}

		// Reuse existing saved local SQLite connection pointing to the same file
		for (const conn of this.store.listConnections()) {
			if (conn.driver !== 'sqlite' || conn.location !== 'local') continue
			try {
				const existingReal = realpathSync(resolve(expandTilde(conn.path)))
				if (existingReal === realPath) {
					this.store.touchConnection(conn.id)
					return conn
				}
			} catch {}
		}

		return this.store.addConnection({
			name: suggestDbName(realPath),
			driver: 'sqlite',
			location: 'local',
			path: realPath,
			isProduction: false,
		})
	}

	async exportData(
		id: string,
		opts: {
			mode: 'table' | 'query'
			format: ExportFormat
			browse?: BrowseParams
			sql?: string
			filename?: string
			maxRows?: number
		},
	): Promise<{ body: string; filename: string; rowCount: number; truncated: boolean }> {
		const { conn, adapter } = this.getAdapterById(id)
		const maxRows = Math.max(1, Math.min(100_000, opts.maxRows ?? 100_000))

		if (opts.mode === 'query') {
			const rawSql = opts.sql?.trim() ?? ''
			if (!rawSql) throw new HttpError(400, 'SQL query is required for export')
			const stmts = splitSqlStatements(rawSql).map((s) => s.text)
			if (stmts.length === 0) throw new HttpError(400, 'No SQL statement to export')
			const danger = analyzeSqlDanger(rawSql)
			if (danger.isWrite) {
				throw new HttpError(403, 'Export only supports read-only SELECT queries')
			}
			const results = await adapter.executeStatements([stmts[stmts.length - 1]!], {
				writable: false,
				maxRows,
			})
			const res = results[0]
			if (!res) throw new HttpError(400, 'Query returned no result set')
			if (res.error) throw new HttpError(400, res.error)
			const tableName = res.sourceTable || 'query_result'
			const body = formatExportRows(opts.format, res.columns, res.rows, tableName)
			const ext = opts.format === 'markdown' ? 'md' : opts.format
			return {
				body,
				filename: sanitizeExportFilename(opts.filename || `${conn.name}_${tableName}`, ext),
				rowCount: res.rows.length,
				truncated: res.truncated,
			}
		}

		// Table export: paginate through browseTable until done or maxRows reached
		const browse = opts.browse
		if (!browse?.table) throw new HttpError(400, 'Table name is required for export')
		const allRows: Record<string, unknown>[] = []
		let columns: string[] = []
		let truncated = false
		let cursor: string | undefined = undefined
		let offset = 0
		const pageSize = 2000

		while (allRows.length < maxRows) {
			const batchLimit = Math.min(pageSize, maxRows - allRows.length)
			const page = await adapter.browseTable({
				table: browse.table,
				fields: browse.fields,
				filters: browse.filters,
				order: browse.order,
				search: browse.search,
				limit: batchLimit,
				...(cursor !== undefined ? { start: cursor, direction: 'next' as const } : { offset }),
			})
			if (columns.length === 0) columns = page.columns
			allRows.push(...page.rows)
			if (!page.hasNext || page.rows.length === 0) break
			if (allRows.length >= maxRows) {
				truncated = true
				break
			}
			if (page.keysetColumn && page.nextCursor !== null) {
				cursor = page.nextCursor
			} else {
				offset += page.rows.length
			}
		}

		const body = formatExportRows(opts.format, columns, allRows, browse.table)
		const ext = opts.format === 'markdown' ? 'md' : opts.format
		return {
			body,
			filename: sanitizeExportFilename(opts.filename || `${conn.name}_${browse.table}`, ext),
			rowCount: allRows.length,
			truncated,
		}
	}

	async runQuery(
		id: string,
		sql: string,
		options: { confirmedDestructive?: boolean; maxRows?: number; queryId?: string } = {},
	): Promise<QueryResponse> {
		const { conn, adapter } = this.getAdapterById(id)
		const stmts = splitSqlStatements(sql).map((s) => s.text)
		if (stmts.length === 0) {
			return { results: [], totalDurationMs: 0 }
		}

		const danger = analyzeSqlDanger(sql)
		const rw = this.getRwState(conn)

		if (danger.isWrite && !rw.armed) {
			throw new HttpError(
				403,
				'Connection is in Read-Only mode. Switch to Read-Write mode to execute write statements.',
			)
		}

		if (danger.isDestructive && !options.confirmedDestructive) {
			return {
				results: [],
				totalDurationMs: 0,
				needsConfirmation: true,
				warnings: danger.warnings,
			}
		}

		const t0 = performance.now()
		const results = await adapter.executeStatements(stmts, {
			writable: danger.isWrite && rw.armed,
			maxRows: options.maxRows,
			queryId: options.queryId,
		})
		const totalDurationMs = Math.round((performance.now() - t0) * 100) / 100

		const rwArmedUntil = danger.isWrite ? this.refreshProdRwTimer(conn) : rw.until

		// Record query history
		const lastErr = results.find((r) => r.error)?.error ?? null
		const totalRows = results.reduce((sum, r) => sum + (r.rowCount || r.changes), 0)
		this.store.recordQueryHistory({
			connectionId: conn.id,
			sql: sql.trim(),
			durationMs: totalDurationMs,
			rowCount: totalRows,
			error: lastErr,
		})
		this.store.touchConnection(conn.id)

		return { results, totalDurationMs, rwArmedUntil }
	}

	async cancelQuery(id: string, queryId: string): Promise<boolean> {
		const entry = this.adapters.get(id)
		if (!entry?.adapter.cancelQuery) return false
		return entry.adapter.cancelQuery(queryId)
	}

	async runMutate(id: string, req: MutateRequest): Promise<MutateResponse> {
		const { conn, adapter } = this.getAdapterById(id)
		const rw = this.getRwState(conn)
		if (!rw.armed) {
			throw new HttpError(403, 'Connection is in Read-Only mode. Switch to Read-Write mode to commit changes.')
		}
		if ((req.deletes?.length ?? 0) > 0 && !req.confirmedDestructive) {
			return {
				applied: 0,
				durationMs: 0,
				sqlPreview: [],
				needsConfirmation: true,
				warnings: [`Deletes ${req.deletes!.length} row(s) from ${req.table}`],
			}
		}
		const res = await adapter.mutate(req)
		this.refreshProdRwTimer(conn)
		return res
	}

	async getSchema(id: string): Promise<DatabaseSchema> {
		const { conn, adapter } = this.getAdapterById(id)
		const rawSchema = await adapter.getSchema()
		const entry = this.adapters.get(conn.id)
		if (entry) entry.lastRawSchema = rawSchema
		this.store.touchConnection(id)
		return mergeSchemaForeignKeys(rawSchema, conn.virtualForeignKeys, conn.ignoredForeignKeys)
	}

	async countReverseFks(id: string, table: string, row: Record<string, unknown>): Promise<ReverseFkCount[]> {
		const { conn, adapter } = this.getAdapterById(id)
		const entry = this.adapters.get(conn.id)
		const rawSchema = entry?.lastRawSchema ?? (await adapter.getSchema())
		if (entry && !entry.lastRawSchema) entry.lastRawSchema = rawSchema
		const extraReverseFks = getExtraReverseFksForTable(
			rawSchema,
			table,
			conn.virtualForeignKeys,
			conn.ignoredForeignKeys,
		)
		return adapter.countReverseFks(table, row, extraReverseFks)
	}

	async profileColumn(id: string, table: string, column: string): Promise<ColumnProfile> {
		const { adapter } = this.getAdapterById(id)
		return adapter.profileColumn(table, column)
	}

	async getDbInfo(id: string): Promise<DatabaseInfo> {
		const { adapter } = this.getAdapterById(id)
		return adapter.getInfo()
	}

	async runMaintenance(
		id: string,
		action: 'wal_checkpoint' | 'vacuum',
	): Promise<{ ok: true; message: string; durationMs: number }> {
		const { conn, adapter } = this.getAdapterById(id)
		const rw = this.getRwState(conn)
		if (!rw.armed) {
			throw new HttpError(403, 'Connection is in Read-Only mode. Switch to Read-Write mode to run maintenance.')
		}
		if (!adapter.runMaintenance) {
			throw new HttpError(400, 'Maintenance actions are only supported for SQLite connections')
		}
		const res = await adapter.runMaintenance(action)
		this.refreshProdRwTimer(conn)
		return res
	}

	async discover(params: {
		location: 'local' | 'ssh'
		sshHost?: string
		sshUser?: string
		sshPort?: number
		roots?: string[]
		maxDepth?: number
		preset?: DiscoverPreset
	}): Promise<DiscoveredDb[]> {
		const existing = this.store.listConnections()
		const isSaved = (path: string) =>
			existing.some(
				(c) =>
					c.location === params.location &&
					c.path === path &&
					(params.location === 'local' || c.sshHost === params.sshHost),
			)

		const raw =
			params.location === 'ssh'
				? await this.sshPool
						.getChannel({
							host: params.sshHost || '',
							user: params.sshUser,
							port: params.sshPort,
						})
						.call<{ path: string; sizeBytes: number; modifiedAt: string }[]>(
							{ op: 'discover', params: { roots: params.roots, maxDepth: params.maxDepth } },
							30_000,
						)
				: discoverLocalSqliteDbs(params.roots, params.maxDepth, params.preset)

		return raw.map((item) => ({
			...item,
			suggestedName: suggestDbName(item.path, params.location === 'ssh' ? params.sshHost : undefined),
			alreadySaved: isSaved(item.path),
		}))
	}

	dropConnection(id: string): boolean {
		const cached = this.adapters.get(id)
		const had = Boolean(cached)
		if (cached) {
			cached.stopWatch?.()
			cached.adapter.close()
			this.adapters.delete(id)
		}
		const hadRw = this.rwStates.delete(id)
		if (had || hadRw) this.notifySubscribers()
		return had
	}

	closeAll() {
		this.unsubStore()
		this.subscribers.clear()
		this.dbChangeListeners.clear()
		this.sshPrompts.closeAll()
		for (const entry of this.adapters.values()) {
			entry.stopWatch?.()
			entry.adapter.close()
		}
		this.adapters.clear()
		this.sshPool.closeAll()
	}
}

export class HttpError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

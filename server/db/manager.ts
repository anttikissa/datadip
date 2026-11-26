// Connection lifecycle manager, Read-Only / Read-Write safety gatekeeper, and SSH pool coordinator.
import { analyzeSqlDanger, splitSqlStatements } from '../../src/shared/sql.ts'
import type {
	ConnectionConfig,
	ConnectionWithStatus,
	DiscoveredDb,
	MutateRequest,
	MutateResponse,
	QueryResponse,
} from '../../src/shared/types.ts'
import type { DataStore } from '../store.ts'
import { discoverLocalSqliteDbs, suggestDbName } from './discover.ts'
import { PostgresAdapterStub } from './postgres-stub.ts'
import { LocalSqliteAdapter } from './sqlite-local.ts'
import { SshSqliteAdapter } from './sqlite-ssh.ts'
import { SshMuxPool } from './ssh-mux.ts'
import type { DbAdapter } from './types.ts'

export const PROD_RW_TTL_MS = 10 * 60 * 1000 // 10-minute auto-relock on production databases

interface RwState {
	armed: boolean
	until: number | null // null = armed until manually locked (non-prod)
}

export class ConnectionManager {
	readonly store: DataStore
	readonly sshPool = new SshMuxPool()
	private adapters = new Map<string, { sig: string; adapter: DbAdapter; lastLatencyMs: number | null }>()
	private rwStates = new Map<string, RwState>()

	constructor(store: DataStore) {
		this.store = store
	}

	private signature(c: ConnectionConfig): string {
		return `${c.driver}|${c.location}|${c.sshUser ?? ''}@${c.sshHost ?? ''}:${c.sshPort ?? 22}|${c.path}`
	}

	getAdapter(conn: ConnectionConfig): DbAdapter {
		const sig = this.signature(conn)
		const cached = this.adapters.get(conn.id)
		if (cached && cached.sig === sig) return cached.adapter
		if (cached) cached.adapter.close()

		let adapter: DbAdapter
		if (conn.driver === 'postgres') {
			adapter = new PostgresAdapterStub()
		} else if (conn.location === 'ssh') {
			if (!conn.sshHost) throw new Error('SSH connection is missing sshHost')
			adapter = new SshSqliteAdapter(
				this.sshPool,
				{ host: conn.sshHost, user: conn.sshUser, port: conn.sshPort },
				conn.path,
			)
		} else {
			adapter = new LocalSqliteAdapter(conn.path)
		}

		this.adapters.set(conn.id, { sig, adapter, lastLatencyMs: null })
		return adapter
	}

	getAdapterById(id: string): { conn: ConnectionConfig; adapter: DbAdapter } {
		const conn = this.store.getConnection(id)
		if (!conn) throw new Error(`Connection not found: ${id}`)
		return { conn, adapter: this.getAdapter(conn) }
	}

	getRwState(conn: ConnectionConfig): { armed: boolean; until: number | null } {
		const st = this.rwStates.get(conn.id)
		if (!st || !st.armed) return { armed: false, until: null }
		if (st.until !== null && Date.now() >= st.until) {
			this.rwStates.delete(conn.id)
			return { armed: false, until: null }
		}
		return { armed: true, until: st.until }
	}

	setRwMode(id: string, armed: boolean): { armed: boolean; until: number | null } {
		const conn = this.store.getConnection(id)
		if (!conn) throw new Error(`Connection not found: ${id}`)
		if (!armed) {
			this.rwStates.delete(id)
			return { armed: false, until: null }
		}
		const until = conn.isProduction ? Date.now() + PROD_RW_TTL_MS : null
		this.rwStates.set(id, { armed: true, until })
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
		return this.store.listConnections().map((c) => {
			const rw = this.getRwState(c)
			const cached = this.adapters.get(c.id)
			return {
				...c,
				rwArmed: rw.armed,
				rwArmedUntil: rw.until,
				connected: Boolean(cached),
				latencyMs: cached?.lastLatencyMs ?? null,
			}
		})
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
				? new PostgresAdapterStub()
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

	async runQuery(
		id: string,
		sql: string,
		options: { confirmedDestructive?: boolean; maxRows?: number } = {},
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

	async discover(params: {
		location: 'local' | 'ssh'
		sshHost?: string
		sshUser?: string
		sshPort?: number
		roots?: string[]
		maxDepth?: number
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
				: discoverLocalSqliteDbs(params.roots, params.maxDepth)

		return raw.map((item) => ({
			...item,
			suggestedName: suggestDbName(item.path, params.location === 'ssh' ? params.sshHost : undefined),
			alreadySaved: isSaved(item.path),
		}))
	}

	dropConnection(id: string) {
		const cached = this.adapters.get(id)
		if (cached) {
			cached.adapter.close()
			this.adapters.delete(id)
		}
		this.rwStates.delete(id)
	}

	closeAll() {
		for (const entry of this.adapters.values()) entry.adapter.close()
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

// Local persistence for DataDip: liveFile-backed connections.ason, server.ason, and state.db (scratchpads, history, recents, prefs).
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseAson, stringify as stringifyAson } from '../src/shared/ason.ts'
import { liveFiles } from '../src/shared/live-file.ts'
import { tid } from '../src/shared/tid.ts'
import type { ConnectionConfig, QueryHistoryEntry, RecentTable, Scratchpad } from '../src/shared/types.ts'

export interface ServerInfo {
	pid: number
	host: string
	port: number
	url: string
	startedAt: string
}

export interface ConnectionsChangeEvent {
	external: boolean
	error: Error | null
}

interface RawConnectionsFile {
	connections: Partial<ConnectionConfig>[]
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

// Stable Crockford base32 id when a user hand-edits connections.ason without specifying `id`.
function stableFallbackId(c: Partial<ConnectionConfig>): string {
	const key = `${c.driver ?? 'sqlite'}|${c.location ?? 'local'}|${c.sshUser ?? ''}@${c.sshHost ?? ''}:${c.sshPort ?? 22}|${c.path ?? ''}|${c.name ?? ''}`
	let h1 = 0x811c9dc5
	let h2 = 0x9e3779b9
	for (let i = 0; i < key.length; i++) {
		const ch = key.charCodeAt(i)
		h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0
		h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0
	}
	let n = (BigInt(h1) << 32n) | BigInt(h2)
	let out = ''
	for (let i = 0; i < 8; i++) {
		out = CROCKFORD[Number(n & 31n)] + out
		n >>= 5n
	}
	return `c_${out}`
}

export function resolveDataDir(dataDir?: string): string {
	return dataDir ?? join(homedir(), '.datadip', 'data')
}

// Lightweight read-only probe for CLI commands (url, status, open) that must never open state.db.
export function readServerInfo(dataDir?: string): ServerInfo | null {
	const infoPath = join(resolveDataDir(dataDir), 'server.ason')
	if (!existsSync(infoPath)) return null
	try {
		return parseAson(readFileSync(infoPath, 'utf8')) as unknown as ServerInfo
	} catch {
		return null
	}
}

function serializeConnection(c: ConnectionConfig): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: c.id,
		name: c.name,
		driver: c.driver,
		location: c.location,
		path: c.path,
	}
	if (c.location === 'ssh') {
		if (c.sshHost) out.sshHost = c.sshHost
		if (c.sshUser) out.sshUser = c.sshUser
		if (c.sshPort && c.sshPort !== 22) out.sshPort = c.sshPort
	}
	out.isProduction = c.isProduction
	if (c.pinned) out.pinned = true
	out.createdAt = c.createdAt
	return out
}

export class DataStore {
	readonly dataDir: string
	readonly connectionsPath: string
	readonly serverInfoPath: string
	readonly db: Database
	private readonly connectionsFile: RawConnectionsFile
	private readonly listeners = new Set<(ev: ConnectionsChangeEvent) => void>()

	constructor(dataDir?: string, options?: { watch?: boolean }) {
		this.dataDir = resolveDataDir(dataDir)
		mkdirSync(this.dataDir, { recursive: true })
		this.connectionsPath = join(this.dataDir, 'connections.ason')
		this.serverInfoPath = join(this.dataDir, 'server.ason')

		this.db = new Database(join(this.dataDir, 'state.db'))
		// Set busy_timeout first so concurrent openers wait out WAL recovery instead of failing with SQLITE_BUSY_RECOVERY.
		this.db.exec('PRAGMA busy_timeout=5000;')
		this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')
		this.migrate()

		this.connectionsFile = liveFiles.liveFile<RawConnectionsFile>(
			this.connectionsPath,
			{ connections: [] },
			{
				watch: options?.watch ?? true,
				keepBroken: true,
				onChange: (err) => this.emitConnectionsChange({ external: true, error: err }),
			},
		)
	}

	private migrate() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS scratchpads (
				id TEXT PRIMARY KEY,
				connection_id TEXT NOT NULL,
				title TEXT NOT NULL,
				sql TEXT NOT NULL DEFAULT '',
				pinned INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_scratchpads_conn ON scratchpads(connection_id, updated_at DESC);

			CREATE TABLE IF NOT EXISTS query_history (
				id TEXT PRIMARY KEY,
				connection_id TEXT NOT NULL,
				sql TEXT NOT NULL,
				duration_ms REAL NOT NULL,
				row_count INTEGER NOT NULL,
				error TEXT,
				executed_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_history_conn ON query_history(connection_id, executed_at DESC);

			CREATE TABLE IF NOT EXISTS recent_tables (
				connection_id TEXT NOT NULL,
				table_name TEXT NOT NULL,
				visited_at TEXT NOT NULL,
				PRIMARY KEY (connection_id, table_name)
			);
			CREATE INDEX IF NOT EXISTS idx_recent_tables_time ON recent_tables(visited_at DESC);

			CREATE TABLE IF NOT EXISTS connection_visits (
				connection_id TEXT PRIMARY KEY,
				visited_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_conn_visits_time ON connection_visits(visited_at DESC);

			CREATE TABLE IF NOT EXISTS preferences (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`)
	}

	private emitConnectionsChange(ev: ConnectionsChangeEvent) {
		for (const cb of this.listeners) {
			try {
				cb(ev)
			} catch {}
		}
	}

	onConnectionsChange(listener: (ev: ConnectionsChangeEvent) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	getConnectionsError(): string | null {
		return liveFiles.brokenError(this.connectionsFile)?.message ?? null
	}

	private ensureWritableConfig() {
		const err = liveFiles.brokenError(this.connectionsFile)
		if (err) {
			throw new Error(`Cannot save connections while connections.ason has a syntax error: ${err.message}`)
		}
	}

	private getVisitMap(): Map<string, string> {
		const rows = this.db
			.query<{ connection_id: string; visited_at: string }, []>(
				'SELECT connection_id, visited_at FROM connection_visits',
			)
			.all()
		const map = new Map<string, string>()
		for (const r of rows) map.set(r.connection_id, r.visited_at)
		return map
	}

	private normalizeConnection(raw: Partial<ConnectionConfig>, visits: Map<string, string>): ConnectionConfig {
		const id = raw.id ? String(raw.id) : stableFallbackId(raw)
		const dbVisit = visits.get(id)
		const fileVisit = raw.lastVisitedAt ? String(raw.lastVisitedAt) : undefined
		let lastVisitedAt = dbVisit
		if (fileVisit && (!lastVisitedAt || fileVisit > lastVisitedAt)) {
			lastVisitedAt = fileVisit
		}
		return {
			id,
			name: String(raw.name ?? 'Untitled'),
			driver: raw.driver === 'postgres' ? 'postgres' : 'sqlite',
			location: raw.location === 'ssh' || (!raw.location && Boolean(raw.sshHost)) ? 'ssh' : 'local',
			path: String(raw.path ?? ''),
			sshHost: raw.sshHost ? String(raw.sshHost) : undefined,
			sshUser: raw.sshUser ? String(raw.sshUser) : undefined,
			sshPort: typeof raw.sshPort === 'number' && Number.isFinite(raw.sshPort) ? raw.sshPort : undefined,
			isProduction: Boolean(raw.isProduction),
			pinned: Boolean(raw.pinned),
			createdAt: raw.createdAt ? String(raw.createdAt) : new Date().toISOString(),
			lastVisitedAt,
		}
	}

	// --- Connections (backed by liveFile on connections.ason) ---

	listConnections(): ConnectionConfig[] {
		const rawList = Array.isArray(this.connectionsFile.connections) ? this.connectionsFile.connections : []
		const visits = this.getVisitMap()
		return rawList
			.filter((c): c is Partial<ConnectionConfig> => Boolean(c) && typeof c === 'object')
			.map((c) => this.normalizeConnection(c, visits))
	}

	getConnection(id: string): ConnectionConfig | null {
		return this.listConnections().find((c) => c.id === id) ?? null
	}

	addConnection(input: Omit<ConnectionConfig, 'id' | 'createdAt'>): ConnectionConfig {
		this.ensureWritableConfig()
		const conn: ConnectionConfig = {
			...input,
			id: tid('c'),
			createdAt: new Date().toISOString(),
		}
		if (!Array.isArray(this.connectionsFile.connections)) {
			this.connectionsFile.connections = []
		}
		this.connectionsFile.connections.push(serializeConnection(conn) as Partial<ConnectionConfig>)
		liveFiles.save(this.connectionsFile)
		this.emitConnectionsChange({ external: false, error: null })
		return conn
	}

	restoreConnection(conn: ConnectionConfig): ConnectionConfig {
		this.ensureWritableConfig()
		const existing = this.getConnection(conn.id)
		if (existing) return existing
		if (!Array.isArray(this.connectionsFile.connections)) {
			this.connectionsFile.connections = []
		}
		this.connectionsFile.connections.push(serializeConnection(conn) as Partial<ConnectionConfig>)
		liveFiles.save(this.connectionsFile)
		this.emitConnectionsChange({ external: false, error: null })
		return this.getConnection(conn.id) ?? conn
	}

	updateConnection(id: string, patch: Partial<Omit<ConnectionConfig, 'id' | 'createdAt'>>): ConnectionConfig | null {
		this.ensureWritableConfig()
		if (!Array.isArray(this.connectionsFile.connections)) return null
		const visits = this.getVisitMap()
		const idx = this.connectionsFile.connections.findIndex(
			(raw) => raw && typeof raw === 'object' && this.normalizeConnection(raw, visits).id === id,
		)
		if (idx === -1) return null
		const current = this.normalizeConnection(this.connectionsFile.connections[idx]!, visits)
		const updated: ConnectionConfig = { ...current, ...patch, id }
		this.connectionsFile.connections[idx] = serializeConnection(updated) as Partial<ConnectionConfig>
		liveFiles.save(this.connectionsFile)
		this.emitConnectionsChange({ external: false, error: null })
		return updated
	}

	// Stored in state.db so browsing/querying never dirties hand-edited connections.ason.
	touchConnection(id: string) {
		this.db.run(
			`INSERT INTO connection_visits (connection_id, visited_at)
			 VALUES (?, ?)
			 ON CONFLICT(connection_id) DO UPDATE SET visited_at = excluded.visited_at`,
			[id, new Date().toISOString()],
		)
	}

	deleteConnection(id: string): boolean {
		this.ensureWritableConfig()
		if (!Array.isArray(this.connectionsFile.connections)) return false
		const visits = this.getVisitMap()
		const idx = this.connectionsFile.connections.findIndex(
			(raw) => raw && typeof raw === 'object' && this.normalizeConnection(raw, visits).id === id,
		)
		if (idx === -1) return false
		this.connectionsFile.connections.splice(idx, 1)
		liveFiles.save(this.connectionsFile)
		this.db.run('DELETE FROM recent_tables WHERE connection_id = ?', [id])
		this.db.run('DELETE FROM connection_visits WHERE connection_id = ?', [id])
		this.emitConnectionsChange({ external: false, error: null })
		return true
	}

	// --- Scratchpads ---

	listScratchpads(connectionId: string): Scratchpad[] {
		const rows = this.db
			.query<
				{
					id: string
					connection_id: string
					title: string
					sql: string
					pinned: number
					created_at: string
					updated_at: string
				},
				[string]
			>(
				`SELECT id, connection_id, title, sql, pinned, created_at, updated_at
				 FROM scratchpads
				 WHERE connection_id = ?
				 ORDER BY pinned DESC, updated_at DESC`,
			)
			.all(connectionId)

		return rows.map((r) => ({
			id: r.id,
			connectionId: r.connection_id,
			title: r.title,
			sql: r.sql,
			pinned: Boolean(r.pinned),
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}))
	}

	getScratchpad(id: string): Scratchpad | null {
		const r = this.db
			.query<
				{
					id: string
					connection_id: string
					title: string
					sql: string
					pinned: number
					created_at: string
					updated_at: string
				},
				[string]
			>(
				`SELECT id, connection_id, title, sql, pinned, created_at, updated_at
				 FROM scratchpads WHERE id = ?`,
			)
			.get(id)
		if (!r) return null
		return {
			id: r.id,
			connectionId: r.connection_id,
			title: r.title,
			sql: r.sql,
			pinned: Boolean(r.pinned),
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		}
	}

	createScratchpad(connectionId: string, title = 'Untitled console', sql = ''): Scratchpad {
		const now = new Date().toISOString()
		const pad: Scratchpad = {
			id: tid('s'),
			connectionId,
			title,
			sql,
			pinned: false,
			createdAt: now,
			updatedAt: now,
		}
		this.db.run(
			`INSERT INTO scratchpads (id, connection_id, title, sql, pinned, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 0, ?, ?)`,
			[pad.id, pad.connectionId, pad.title, pad.sql, pad.createdAt, pad.updatedAt],
		)
		return pad
	}

	updateScratchpad(id: string, patch: { title?: string; sql?: string; pinned?: boolean }): Scratchpad | null {
		const existing = this.getScratchpad(id)
		if (!existing) return null
		const next: Scratchpad = {
			...existing,
			title: patch.title !== undefined ? patch.title : existing.title,
			sql: patch.sql !== undefined ? patch.sql : existing.sql,
			pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
			updatedAt: new Date().toISOString(),
		}
		this.db.run(`UPDATE scratchpads SET title = ?, sql = ?, pinned = ?, updated_at = ? WHERE id = ?`, [
			next.title,
			next.sql,
			next.pinned ? 1 : 0,
			next.updatedAt,
			id,
		])
		return next
	}

	deleteScratchpad(id: string): boolean {
		const res = this.db.run('DELETE FROM scratchpads WHERE id = ?', [id])
		return res.changes > 0
	}

	// --- Query History ---

	recordQueryHistory(entry: Omit<QueryHistoryEntry, 'id' | 'executedAt'>): QueryHistoryEntry {
		const full: QueryHistoryEntry = {
			...entry,
			id: tid('q'),
			executedAt: new Date().toISOString(),
		}
		this.db.run(
			`INSERT INTO query_history (id, connection_id, sql, duration_ms, row_count, error, executed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[full.id, full.connectionId, full.sql, full.durationMs, full.rowCount, full.error, full.executedAt],
		)
		// Trim oldest entries beyond 500 per connection
		this.db.run(
			`DELETE FROM query_history
			 WHERE connection_id = ?
			   AND id NOT IN (
					SELECT id FROM query_history WHERE connection_id = ? ORDER BY executed_at DESC LIMIT 500
			   )`,
			[full.connectionId, full.connectionId],
		)
		return full
	}

	listQueryHistory(connectionId: string, limit = 100): QueryHistoryEntry[] {
		const rows = this.db
			.query<
				{
					id: string
					connection_id: string
					sql: string
					duration_ms: number
					row_count: number
					error: string | null
					executed_at: string
				},
				[string, number]
			>(
				`SELECT id, connection_id, sql, duration_ms, row_count, error, executed_at
				 FROM query_history
				 WHERE connection_id = ?
				 ORDER BY executed_at DESC
				 LIMIT ?`,
			)
			.all(connectionId, limit)

		return rows.map((r) => ({
			id: r.id,
			connectionId: r.connection_id,
			sql: r.sql,
			durationMs: r.duration_ms,
			rowCount: r.row_count,
			error: r.error,
			executedAt: r.executed_at,
		}))
	}

	clearQueryHistory(connectionId: string) {
		this.db.run('DELETE FROM query_history WHERE connection_id = ?', [connectionId])
	}

	// --- Recent Tables ---

	recordRecentTable(connectionId: string, tableName: string) {
		this.db.run(
			`INSERT INTO recent_tables (connection_id, table_name, visited_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(connection_id, table_name) DO UPDATE SET visited_at = excluded.visited_at`,
			[connectionId, tableName, new Date().toISOString()],
		)
		this.touchConnection(connectionId)
	}

	listRecentTables(limit = 30, extraConnections: ConnectionConfig[] = []): RecentTable[] {
		const conns = new Map<string, ConnectionConfig>()
		for (const c of extraConnections) conns.set(c.id, c)
		for (const c of this.listConnections()) conns.set(c.id, c)

		const rows = this.db
			.query<{ connection_id: string; table_name: string; visited_at: string }, [number]>(
				`SELECT connection_id, table_name, visited_at
				 FROM recent_tables
				 ORDER BY visited_at DESC
				 LIMIT ?`,
			)
			.all(limit)

		return rows
			.filter((r) => conns.has(r.connection_id))
			.map((r) => {
				const c = conns.get(r.connection_id)!
				return {
					connectionId: r.connection_id,
					connectionName: c.name,
					isProduction: c.isProduction,
					tableName: r.table_name,
					visitedAt: r.visited_at,
				}
			})
	}

	deleteRecentTable(connectionId: string, tableName: string) {
		this.db.run('DELETE FROM recent_tables WHERE connection_id = ? AND table_name = ?', [connectionId, tableName])
	}

	// --- Preferences ---

	getPreferences(): Record<string, string> {
		const rows = this.db.query<{ key: string; value: string }, []>('SELECT key, value FROM preferences').all()
		const out: Record<string, string> = {}
		for (const r of rows) out[r.key] = r.value
		return out
	}

	setPreference(key: string, value: string) {
		this.db.run(
			`INSERT INTO preferences (key, value) VALUES (?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[key, value],
		)
	}

	// --- Server runtime info ---

	writeServerInfo(info: ServerInfo) {
		writeFileSync(this.serverInfoPath, stringifyAson(info, 'long') + '\n', 'utf8')
	}

	readServerInfo(): ServerInfo | null {
		return readServerInfo(this.dataDir)
	}

	clearServerInfo(expectedPid?: number) {
		if (!existsSync(this.serverInfoPath)) return
		if (expectedPid !== undefined) {
			const current = this.readServerInfo()
			if (current && current.pid !== expectedPid) return
		}
		try {
			unlinkSync(this.serverInfoPath)
		} catch {}
	}

	close() {
		try {
			liveFiles.close(this.connectionsFile)
		} catch {}
		this.db.close()
	}
}

// Local persistence for DataDip: connections.ason, server.ason, and state.db (scratchpads, history, recents, prefs).
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseAson, stringify as stringifyAson } from '../src/shared/ason.ts'
import { tid } from '../src/shared/tid.ts'
import type { ConnectionConfig, QueryHistoryEntry, RecentTable, Scratchpad } from '../src/shared/types.ts'

export interface ServerInfo {
	pid: number
	host: string
	port: number
	url: string
	startedAt: string
}

export class DataStore {
	readonly dataDir: string
	readonly connectionsPath: string
	readonly serverInfoPath: string
	readonly db: Database

	constructor(dataDir?: string) {
		this.dataDir = dataDir ?? join(homedir(), '.datadip', 'data')
		mkdirSync(this.dataDir, { recursive: true })
		this.connectionsPath = join(this.dataDir, 'connections.ason')
		this.serverInfoPath = join(this.dataDir, 'server.ason')

		this.db = new Database(join(this.dataDir, 'state.db'))
		this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')
		this.migrate()
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

			CREATE TABLE IF NOT EXISTS preferences (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`)
	}

	// --- Connections (stored in readable connections.ason) ---

	listConnections(): ConnectionConfig[] {
		if (!existsSync(this.connectionsPath)) return []
		try {
			const raw = readFileSync(this.connectionsPath, 'utf8')
			const parsed = parseAson(raw) as { connections?: ConnectionConfig[] } | ConnectionConfig[]
			const list = Array.isArray(parsed) ? parsed : (parsed?.connections ?? [])
			return list.map((c) => ({
				id: c.id || tid('c'),
				name: String(c.name ?? 'Untitled'),
				driver: c.driver === 'postgres' ? 'postgres' : 'sqlite',
				location: c.location === 'ssh' ? 'ssh' : 'local',
				path: String(c.path ?? ''),
				sshHost: c.sshHost ? String(c.sshHost) : undefined,
				sshUser: c.sshUser ? String(c.sshUser) : undefined,
				sshPort: typeof c.sshPort === 'number' && Number.isFinite(c.sshPort) ? c.sshPort : undefined,
				isProduction: Boolean(c.isProduction),
				pinned: Boolean(c.pinned),
				createdAt: c.createdAt || new Date().toISOString(),
				lastVisitedAt: c.lastVisitedAt || undefined,
			}))
		} catch (err) {
			throw new Error(`Failed to parse ${this.connectionsPath}: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	saveConnections(connections: ConnectionConfig[]) {
		const cleaned = connections.map((c) => {
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
			if (c.lastVisitedAt) out.lastVisitedAt = c.lastVisitedAt
			return out
		})
		const body =
			'// DataDip saved database connections (local, gitignored)\n' +
			stringifyAson({ connections: cleaned }, 'long') +
			'\n'
		writeFileSync(this.connectionsPath, body, 'utf8')
	}

	getConnection(id: string): ConnectionConfig | null {
		return this.listConnections().find((c) => c.id === id) ?? null
	}

	addConnection(input: Omit<ConnectionConfig, 'id' | 'createdAt'>): ConnectionConfig {
		const list = this.listConnections()
		const conn: ConnectionConfig = {
			...input,
			id: tid('c'),
			createdAt: new Date().toISOString(),
		}
		list.push(conn)
		this.saveConnections(list)
		return conn
	}

	updateConnection(id: string, patch: Partial<Omit<ConnectionConfig, 'id' | 'createdAt'>>): ConnectionConfig | null {
		const list = this.listConnections()
		const idx = list.findIndex((c) => c.id === id)
		if (idx === -1) return null
		const updated: ConnectionConfig = { ...list[idx]!, ...patch, id }
		list[idx] = updated
		this.saveConnections(list)
		return updated
	}

	touchConnection(id: string) {
		const list = this.listConnections()
		const conn = list.find((c) => c.id === id)
		if (!conn) return
		conn.lastVisitedAt = new Date().toISOString()
		this.saveConnections(list)
	}

	deleteConnection(id: string): boolean {
		const list = this.listConnections()
		const next = list.filter((c) => c.id !== id)
		if (next.length === list.length) return false
		this.saveConnections(next)
		this.db.run('DELETE FROM recent_tables WHERE connection_id = ?', [id])
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

	createScratchpad(connectionId: string, title = 'Untitled scratchpad', sql = ''): Scratchpad {
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

	listRecentTables(limit = 30): RecentTable[] {
		const conns = new Map(this.listConnections().map((c) => [c.id, c]))
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
		if (!existsSync(this.serverInfoPath)) return null
		try {
			return parseAson(readFileSync(this.serverInfoPath, 'utf8')) as unknown as ServerInfo
		} catch {
			return null
		}
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
		this.db.close()
	}
}

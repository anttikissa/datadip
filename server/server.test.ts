// Integration tests for DataStore, LocalSqliteAdapter, Read-Only/Read-Write safety gates, and /api/* ASON contract.
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseAson, stringify as stringifyAson } from '../src/shared/ason.ts'
import type { ConnectionWithStatus } from '../src/shared/types.ts'
import { handleApiRequest } from './api.ts'
import { ConnectionManager } from './db/manager.ts'
import { DataStore, readServerInfo } from './store.ts'

let workDir = ''
let sampleDbPath = ''
let store: DataStore
let manager: ConnectionManager
let connId = ''

async function apiCall(method: string, path: string, body?: unknown) {
	const req = new Request(`http://127.0.0.1:4747${path}`, {
		method,
		body: body !== undefined ? stringifyAson(body, 'short') : undefined,
	})
	const res = await handleApiRequest(req, manager)
	const data = parseAson(await res.text()) as Record<string, unknown>
	return { status: res.status, data }
}

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'datadip-test-'))
	sampleDbPath = join(workDir, 'sample.sqlite')

	const db = new Database(sampleDbPath)
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT NOT NULL
		);
		CREATE TABLE orders (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id TEXT NOT NULL REFERENCES users(id),
			total_cents INTEGER NOT NULL,
			status TEXT NOT NULL
		);
		INSERT INTO users (id, name, email) VALUES
			('u1', 'Ada Lovelace', 'ada@example.com'),
			('u2', 'Grace Hopper', 'grace@example.com'),
			('u3', 'Alan Turing', 'alan@example.com');
		INSERT INTO orders (user_id, total_cents, status) VALUES
			('u1', 2500, 'paid'),
			('u1', 4200, 'shipped'),
			('u2', 1999, 'paid');
	`)
	db.close()

	store = new DataStore(join(workDir, 'data'))
	manager = new ConnectionManager(store)
	const conn = store.addConnection({
		name: 'Test Prod DB',
		driver: 'sqlite',
		location: 'local',
		path: sampleDbPath,
		isProduction: true,
	})
	connId = conn.id
})

afterAll(() => {
	manager.closeAll()
	store.close()
	rmSync(workDir, { recursive: true, force: true })
})

describe('DataDip server API & safety boundaries', () => {
	test('introspects tables, FKs, and reverse FKs', async () => {
		const { status, data } = await apiCall('GET', `/api/connections/${connId}/schema`)
		expect(status).toBe(200)
		const schemas = data.schemas as Record<string, { foreignKeys: unknown[]; reverseForeignKeys: unknown[] }>
		expect(schemas.orders!.foreignKeys).toHaveLength(1)
		expect(schemas.users!.reverseForeignKeys).toHaveLength(1)
	})

	test('browses table with field projection, filters, and keyset cursor pagination', async () => {
		const page1 = await apiCall('POST', `/api/connections/${connId}/browse`, {
			table: 'users',
			fields: ['id', 'name'],
			order: [{ column: 'id', dir: 'asc' }],
			limit: 2,
		})
		expect(page1.status).toBe(200)
		expect(page1.data.columns).toEqual(['id', 'name'])
		expect((page1.data.rows as unknown[]).length).toBe(2)
		expect(page1.data.hasNext).toBe(true)
		expect(page1.data.nextCursor).toBe('u2')

		const page2 = await apiCall('POST', `/api/connections/${connId}/browse`, {
			table: 'users',
			fields: ['id', 'name'],
			order: [{ column: 'id', dir: 'asc' }],
			limit: 2,
			start: page1.data.nextCursor,
			direction: 'next',
		})
		expect(page2.status).toBe(200)
		const rows2 = page2.data.rows as { id: string }[]
		expect(rows2.map((r) => r.id)).toEqual(['u3'])
		expect(page2.data.hasNext).toBe(false)
		expect(page2.data.hasPrev).toBe(true)
	})

	test('peeks FK rows, counts reverse FKs, and searches IDs across tables', async () => {
		const peek = await apiCall('POST', `/api/connections/${connId}/peek`, {
			table: 'users',
			column: 'id',
			value: 'u1',
		})
		expect(peek.status).toBe(200)
		expect((peek.data.row as { name: string }).name).toBe('Ada Lovelace')

		const rev = await apiCall('POST', `/api/connections/${connId}/reverse-fks`, {
			table: 'users',
			row: { id: 'u1' },
		})
		expect(rev.status).toBe(200)
		expect(rev.data.counts).toEqual([{ fromTable: 'orders', fromColumn: 'user_id', toColumn: 'id', count: 2 }])

		const search = await apiCall('POST', `/api/connections/${connId}/search-id`, { value: 'u1' })
		expect(search.status).toBe(200)
		const matches = search.data.matches as { table: string; column: string }[]
		expect(matches.some((m) => m.table === 'users' && m.column === 'id')).toBe(true)
		expect(matches.some((m) => m.table === 'orders' && m.column === 'user_id')).toBe(true)
	})

	test('blocks writes in Read-Only mode, requires confirmation for destructive SQL when RW armed', async () => {
		// Default is Read-Only -> must reject 403
		const blocked = await apiCall('POST', `/api/connections/${connId}/query`, {
			sql: "UPDATE users SET name = 'Hacked' WHERE id = 'u1'",
		})
		expect(blocked.status).toBe(403)

		// Arm Read-Write -> prod sets a 10-minute timer
		const armed = await apiCall('POST', `/api/connections/${connId}/rw`, { armed: true })
		expect(armed.status).toBe(200)
		expect(armed.data.armed).toBe(true)
		expect(typeof armed.data.until).toBe('number')

		// Destructive SQL without WHERE must ask for confirmation first
		const danger = await apiCall('POST', `/api/connections/${connId}/query`, {
			sql: 'DELETE FROM orders',
		})
		expect(danger.status).toBe(200)
		expect(danger.data.needsConfirmation).toBe(true)

		// Safe staged mutation commits cleanly
		const mut = await apiCall('POST', `/api/connections/${connId}/mutate`, {
			table: 'users',
			updates: [{ pk: { id: 'u1' }, changes: { name: 'Ada Byron' } }],
		})
		expect(mut.status).toBe(200)
		expect(mut.data.applied).toBe(1)

		// Verify committed value and re-lock to Read-Only
		const check = await apiCall('POST', `/api/connections/${connId}/peek`, {
			table: 'users',
			column: 'id',
			value: 'u1',
		})
		expect((check.data.row as { name: string }).name).toBe('Ada Byron')

		await apiCall('POST', `/api/connections/${connId}/rw`, { armed: false })
	})

	test('saves and updates scratchpads and records query history', async () => {
		const created = await apiCall('POST', `/api/connections/${connId}/scratchpads`, {
			title: 'Prod Checks',
			sql: 'SELECT * FROM users;',
		})
		expect(created.status).toBe(201)
		const padId = (created.data.scratchpad as { id: string }).id

		const updated = await apiCall('PUT', `/api/scratchpads/${padId}`, {
			sql: 'SELECT COUNT(*) AS n FROM orders;',
		})
		expect(updated.status).toBe(200)
		expect((updated.data.scratchpad as { sql: string }).sql).toContain('COUNT(*)')

		const hist = await apiCall('GET', `/api/connections/${connId}/history`)
		expect(hist.status).toBe(200)
		expect(Array.isArray(hist.data.history)).toBe(true)
	})

	test('liveFile reloads external edits, keeps active removed connections as orphaned, restores or closes them', async () => {
		const liveDir = mkdtempSync(join(tmpdir(), 'datadip-live-'))
		const liveStore = new DataStore(liveDir)
		const liveMgr = new ConnectionManager(liveStore)
		try {
			const c1 = liveStore.addConnection({
				name: 'Active DB',
				driver: 'sqlite',
				location: 'local',
				path: sampleDbPath,
				isProduction: false,
			})
			const c2 = liveStore.addConnection({
				name: 'Idle DB',
				driver: 'sqlite',
				location: 'local',
				path: sampleDbPath,
				isProduction: false,
			})

			// Open c1 so it is active in manager.adapters; leave c2 idle.
			await liveMgr.pingConnection(c1.id)

			const waitForChange = () =>
				new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('timed out waiting for liveFile reload')), 3000)
					const unsub = liveMgr.subscribe(() => {
						clearTimeout(timer)
						unsub()
						resolve()
					})
				})

			// 1. Externally remove both c1 & c2 and add a hand-edited c3 (without an explicit id)
			const p1 = waitForChange()
			writeFileSync(
				liveStore.connectionsPath,
				`// Hand-edited config\n{\n\tconnections: [\n\t\t{ name: 'Edited DB', driver: 'sqlite', location: 'local', path: '${sampleDbPath.replaceAll("'", "\\'")}', isProduction: false },\n\t],\n}\n`,
				'utf8',
			)
			await p1

			const afterRemove = liveMgr.listConnectionsWithStatus()
			// Idle DB should be gone; Edited DB should appear; Active DB should remain orphaned
			expect(afterRemove.some((c) => c.id === c2.id)).toBe(false)
			expect(afterRemove.some((c) => c.name === 'Edited DB' && !c.orphaned)).toBe(true)
			const orphan = afterRemove.find((c) => c.id === c1.id) as ConnectionWithStatus | undefined
			expect(orphan?.orphaned).toBe(true)

			// Orphaned connection must remain queryable!
			const q = await liveMgr.runQuery(c1.id, 'SELECT COUNT(*) AS n FROM users')
			expect(q.results[0]?.rows[0]?.n).toBe(3)

			// 2. Malformed edit surfaces configError without overwriting the file
			const brokenText = '{ connections: [ BROKEN '
			const p2 = waitForChange()
			writeFileSync(liveStore.connectionsPath, brokenText, 'utf8')
			await p2
			expect(liveMgr.getConnectionsPayload().configError).toBeTruthy()
			expect(() => liveMgr.restoreOrphanedConnection(c1.id)).toThrow(/syntax error/)
			expect(readFileSync(liveStore.connectionsPath, 'utf8')).toBe(brokenText)

			// 3. Fix file -> error clears, then restore orphaned connection back to connections.ason
			const p3 = waitForChange()
			writeFileSync(liveStore.connectionsPath, '{ connections: [] }\n', 'utf8')
			await p3
			expect(liveMgr.getConnectionsPayload().configError).toBeNull()

			const restored = liveMgr.restoreOrphanedConnection(c1.id)
			expect(restored.id).toBe(c1.id)
			const afterRestore = liveMgr.listConnectionsWithStatus().find((c) => c.id === c1.id)
			expect(afterRestore?.orphaned).toBe(false)

			// 4. Remove externally again and close via API DELETE
			const p4 = waitForChange()
			writeFileSync(liveStore.connectionsPath, '{ connections: [] }\n', 'utf8')
			await p4
			expect(liveMgr.isOrphaned(c1.id)).toBe(true)

			const delReq = new Request(`http://127.0.0.1:4747/api/connections/${c1.id}`, { method: 'DELETE' })
			const delRes = await handleApiRequest(delReq, liveMgr)
			expect(delRes.status).toBe(200)
			expect(liveMgr.listConnectionsWithStatus().some((c) => c.id === c1.id)).toBe(false)
		} finally {
			liveMgr.closeAll()
			liveStore.close()
			rmSync(liveDir, { recursive: true, force: true })
		}
	})

	test('POST /api/connections/:id/disconnect closes active adapter & clears RW without deleting config', async () => {
		const events: boolean[] = []
		const unsub = manager.subscribe((payload) => {
			const c = payload.connections.find((x) => x.id === connId)
			if (c) events.push(c.connected)
		})
		try {
			manager.dropConnection(connId)
			events.length = 0

			// Opening adapter marks connection active and notifies SSE subscribers
			await manager.pingConnection(connId)
			manager.setRwMode(connId, true)
			expect(manager.listConnectionsWithStatus().find((c) => c.id === connId)?.connected).toBe(true)
			expect(manager.listConnectionsWithStatus().find((c) => c.id === connId)?.rwArmed).toBe(true)
			expect(events).toContain(true)

			// Disconnecting drops adapter & RW lock while keeping saved connection
			const req = new Request(`http://127.0.0.1:4747/api/connections/${connId}/disconnect`, { method: 'POST' })
			const res = await handleApiRequest(req, manager)
			expect(res.status).toBe(200)
			const after = manager.listConnectionsWithStatus().find((c) => c.id === connId)
			expect(after).toBeDefined()
			expect(after?.connected).toBe(false)
			expect(after?.rwArmed).toBe(false)
			expect(events[events.length - 1]).toBe(false)
		} finally {
			unsub()
		}
	})

	test('readServerInfo reads server.ason without opening state.db', () => {
		const probeDir = mkdtempSync(join(tmpdir(), 'datadip-probe-'))
		try {
			expect(readServerInfo(probeDir)).toBeNull()
			writeFileSync(
				join(probeDir, 'server.ason'),
				"{ pid: 12345, host: '127.0.0.1', port: 4747, url: 'http://127.0.0.1:4747', startedAt: '2026-11-26T00:00:00Z' }\n",
				'utf8',
			)
			const info = readServerInfo(probeDir)
			expect(info?.port).toBe(4747)
			expect(info?.url).toBe('http://127.0.0.1:4747')
		} finally {
			rmSync(probeDir, { recursive: true, force: true })
		}
	})
})

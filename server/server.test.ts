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

	test('saves and updates consoles and records query history', async () => {
		const created = await apiCall('POST', `/api/connections/${connId}/consoles`, {
			title: 'Prod Checks',
			sql: 'SELECT * FROM users;',
		})
		expect(created.status).toBe(201)
		const consoleId = (created.data.console as { id: string }).id

		const updated = await apiCall('PUT', `/api/consoles/${consoleId}`, {
			sql: 'SELECT COUNT(*) AS n FROM orders;',
		})
		expect(updated.status).toBe(200)
		expect((updated.data.console as { sql: string }).sql).toContain('COUNT(*)')

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

	test('runs concurrent SQLite queries in parallel workers and supports cancellation', async () => {
		const slowSql = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT COUNT(*) AS n FROM c`
		const [r1, r2] = await Promise.all([manager.runQuery(connId, slowSql), manager.runQuery(connId, slowSql)])
		expect(r1.results[0]?.rows[0]?.n).toBe(3000000)
		expect(r2.results[0]?.rows[0]?.n).toBe(3000000)

		// Cancel an in-flight long query
		const verySlowSql = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 500000000) SELECT COUNT(*) AS n FROM c`
		const qid = 'qcanceltest1'
		const pending = manager.runQuery(connId, verySlowSql, { queryId: qid })
		await new Promise((r) => setTimeout(r, 80))
		const cancelReq = new Request(`http://127.0.0.1:4747/api/connections/${connId}/query/cancel`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain; charset=utf-8' },
			body: `{ queryId: '${qid}' }`,
		})
		const cancelRes = await handleApiRequest(cancelReq, manager)
		expect(cancelRes.status).toBe(200)
		await expect(pending).rejects.toThrow(/cancelled/i)
	})

	test('SSH_ASKPASS broker authenticates via secret token, relays answers, and handles cancellation', async () => {
		// Unauthenticated internal askpass request must be rejected
		const badReq = new Request('http://127.0.0.1:4747/api/internal/ssh-askpass', {
			method: 'POST',
			headers: { 'content-type': 'text/plain; charset=utf-8', 'x-datadip-askpass-token': 'wrong' },
			body: "{ host: 'example.com', prompt: 'Enter passphrase for key:' }",
		})
		const badRes = await handleApiRequest(badReq, manager)
		expect(badRes.status).toBe(403)

		// Register a dummy SSE subscriber so the broker knows a UI client is present
		const unsub = manager.subscribe(() => {})
		try {
			// Start an askpass prompt request (blocks until UI answers)
			const askReq = new Request('http://127.0.0.1:4747/api/internal/ssh-askpass', {
				method: 'POST',
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'x-datadip-askpass-token': manager.sshPrompts.token,
				},
				body: "{ host: 'db.example.com', prompt: 'Enter passphrase for key /home/user/.ssh/id_ed25519:' }",
			})
			const askPromise = handleApiRequest(askReq, manager)

			await new Promise((r) => setTimeout(r, 20))
			const listRes = await handleApiRequest(new Request('http://127.0.0.1:4747/api/ssh/prompts'), manager)
			const listData = parseAson(await listRes.text()) as { prompts: { id: string; kind: string; host: string }[] }
			expect(listData.prompts).toHaveLength(1)
			expect(listData.prompts[0]!.kind).toBe('secret')
			expect(listData.prompts[0]!.host).toBe('db.example.com')

			// Answer via UI endpoint
			const ansRes = await handleApiRequest(
				new Request(`http://127.0.0.1:4747/api/ssh/prompts/${listData.prompts[0]!.id}`, {
					method: 'POST',
					headers: { 'content-type': 'text/plain; charset=utf-8' },
					body: "{ answer: 's3cr3t-pass' }",
				}),
				manager,
			)
			expect(ansRes.status).toBe(200)

			const askRes = await askPromise
			expect(askRes.status).toBe(200)
			const askData = parseAson(await askRes.text()) as { ok: boolean; answer?: string }
			expect(askData.ok).toBe(true)
			expect(askData.answer).toBe('s3cr3t-pass')
			expect(manager.sshPrompts.list()).toHaveLength(0)

			// Verify host-key confirm classification + cancellation
			const confirmReq = new Request('http://127.0.0.1:4747/api/internal/ssh-askpass', {
				method: 'POST',
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'x-datadip-askpass-token': manager.sshPrompts.token,
				},
				body: "{ host: 'new.example.com', prompt: 'Are you sure you want to continue connecting (yes/no/[fingerprint])?', askpassMode: 'confirm' }",
			})
			const confirmPromise = handleApiRequest(confirmReq, manager)
			await new Promise((r) => setTimeout(r, 20))
			const p2 = manager.sshPrompts.list()[0]!
			expect(p2.kind).toBe('confirm')
			manager.sshPrompts.respond(p2.id, { cancelled: true })
			const confirmData = parseAson(await (await confirmPromise).text()) as { ok: boolean; cancelled?: boolean }
			expect(confirmData.ok).toBe(false)
			expect(confirmData.cancelled).toBe(true)
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

	test('POST /api/connections/open-file opens & deduplicates local SQLite files and rejects invalid files', async () => {
		// Reuses the already-saved fixture connection pointing to sampleDbPath
		const res1 = await apiCall('POST', '/api/connections/open-file', { path: sampleDbPath })
		expect(res1.status).toBe(200)
		expect((res1.data.connection as { id: string }).id).toBe(connId)

		// Opens a brand-new SQLite file and adds it once
		const extraPath = join(workDir, 'adhoc.sqlite')
		const extraDb = new Database(extraPath)
		extraDb.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);')
		extraDb.close()

		const res2 = await apiCall('POST', '/api/connections/open-file', { path: extraPath })
		expect(res2.status).toBe(200)
		const adhocId = (res2.data.connection as { id: string }).id
		expect(adhocId).not.toBe(connId)

		const res3 = await apiCall('POST', '/api/connections/open-file', { path: extraPath })
		expect(res3.status).toBe(200)
		expect((res3.data.connection as { id: string }).id).toBe(adhocId)

		// Rejects non-SQLite files and missing files
		const badPath = join(workDir, 'not-a-db.txt')
		writeFileSync(badPath, 'hello world, not sqlite header!', 'utf8')
		const badRes = await apiCall('POST', '/api/connections/open-file', { path: badPath })
		expect(badRes.status).toBe(400)

		const missingRes = await apiCall('POST', '/api/connections/open-file', { path: join(workDir, 'missing.db') })
		expect(missingRes.status).toBe(404)
	})

	test('POST /api/connections/:id/export downloads full table and query results in CSV, TSV, JSON, Markdown, SQL', async () => {
		// Full table export as CSV
		const csvRes = await handleApiRequest(
			new Request(`http://127.0.0.1:4747/api/connections/${connId}/export`, {
				method: 'POST',
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				body: "{ mode: 'table', format: 'csv', browse: { table: 'users', limit: 100 } }",
			}),
			manager,
		)
		expect(csvRes.status).toBe(200)
		expect(csvRes.headers.get('content-disposition')).toContain('.csv"')
		expect(csvRes.headers.get('x-datadip-row-count')).toBe('3')
		const csvText = await csvRes.text()
		expect(csvText).toContain('id,name,email')
		expect(csvText).toContain('ada@example.com')

		// Query export as Markdown
		const mdRes = await handleApiRequest(
			new Request(`http://127.0.0.1:4747/api/connections/${connId}/export`, {
				method: 'POST',
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				body: "{ mode: 'query', format: 'markdown', sql: 'SELECT name, email FROM users ORDER BY id' }",
			}),
			manager,
		)
		expect(mdRes.status).toBe(200)
		expect(mdRes.headers.get('content-disposition')).toContain('.md"')
		const mdText = await mdRes.text()
		expect(mdText).toContain('| name | email |')
		expect(mdText).toContain('| Grace Hopper | grace@example.com |')

		// Query export rejects write SQL
		const writeRes = await handleApiRequest(
			new Request(`http://127.0.0.1:4747/api/connections/${connId}/export`, {
				method: 'POST',
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				body: "{ mode: 'query', format: 'csv', sql: 'DELETE FROM users WHERE id = 1' }",
			}),
			manager,
		)
		expect(writeRes.status).toBe(403)
	})

	test('PostgreSQL URL parser, redaction, TLS default, and identifier helpers work cleanly', async () => {
		const {
			parsePostgresUrl,
			buildPostgresConnectConfig,
			redactPostgresUrl,
			resolvePgTableRowCount,
			quotePgTable,
			normalizePgCell,
			PostgresAdapter,
		} = await import('./db/postgres.ts')
		const { maskConnectionPath } = await import('../src/shared/url.ts')
		const { formatRowCount } = await import('../src/lib/format.ts')
		const parsed = parsePostgresUrl('postgres://alice:s3cr3t@db.example.com:5433/prod_app?sslmode=require')
		expect(parsed.hostname).toBe('db.example.com')
		expect(parsed.port).toBe(5433)
		expect(parsed.database).toBe('prod_app')
		expect(parsed.sslMode).toBe('require')
		expect(redactPostgresUrl(parsed.rawUrl)).toBe('postgres://alice:••••@db.example.com:5433/prod_app?sslmode=require')
		expect(maskConnectionPath(parsed.rawUrl)).toBe('postgres://alice:••••@db.example.com:5433/prod_app?sslmode=require')
		expect(quotePgTable('users')).toBe('"public"."users"')
		expect(quotePgTable('billing.invoices')).toBe('"billing"."invoices"')
		expect(normalizePgCell({ a: 1 })).toBe('{"a":1}')
		expect(normalizePgCell(42n)).toBe('42')

		// Small Postgres tables use exact bounded counts; large ones use live stats + floored lower-bound formatting
		expect(
			resolvePgTableRowCount({ kind: 'table', exactProbeCount: 19, liveTup: 8, relTup: 8, hasStats: true }),
		).toEqual({
			rowCount: 19,
			rowCountEstimated: false,
		})
		expect(
			resolvePgTableRowCount({ kind: 'table', exactProbeCount: 0, liveTup: 0, relTup: null, hasStats: false }),
		).toEqual({
			rowCount: 0,
			rowCountEstimated: false,
		})
		expect(
			resolvePgTableRowCount({ kind: 'table', exactProbeCount: 1001, liveTup: 14166, relTup: 8000, hasStats: true }),
		).toEqual({
			rowCount: 14166,
			rowCountEstimated: true,
		})
		expect(resolvePgTableRowCount({ kind: 'table', liveTup: 1924812, relTup: 1800000, hasStats: true })).toEqual({
			rowCount: 1924812,
			rowCountEstimated: true,
		})
		expect(resolvePgTableRowCount({ kind: 'view', liveTup: null, relTup: null, hasStats: false })).toEqual({
			rowCount: null,
			rowCountEstimated: false,
		})
		expect(formatRowCount(19, false)).toBe('19')
		expect(formatRowCount(1000, true)).toBe('1,000+')
		expect(formatRowCount(14166, true)).toBe('14,100+')
		expect(formatRowCount(1924812, true)).toBe('1,920,000+')
		expect(formatRowCount(8, true)).toBe('~8')

		// Bare URLs default to sslmode=prefer (matching libpq), while explicit disable/require are respected
		const bare = parsePostgresUrl('postgresql://postgres:pw@db.example.com:5432/postgres')
		expect(bare.sslMode).toBeUndefined()
		expect(buildPostgresConnectConfig(bare)).toEqual({
			url: 'postgresql://postgres:pw@db.example.com:5432/postgres?sslmode=prefer',
		})
		const disabled = parsePostgresUrl('postgres://postgres:pw@127.0.0.1:5432/postgres?sslmode=disable')
		expect(disabled.sslMode).toBe('disable')
		expect(buildPostgresConnectConfig(disabled).url).toContain('sslmode=disable')
		// SSH tunnel preserves real hostname SNI when TLS is required, without disabling prefer fallback when unset
		expect(buildPostgresConnectConfig(bare, 55432)).toEqual({
			url: 'postgresql://postgres:pw@127.0.0.1:55432/postgres?sslmode=prefer',
		})
		expect(buildPostgresConnectConfig(parsed, 55432)).toEqual({
			url: 'postgres://alice:s3cr3t@127.0.0.1:55432/prod_app?sslmode=require',
			tls: { serverName: 'db.example.com', rejectUnauthorized: false },
		})

		// Live wire-protocol check: bare URL sends PostgreSQL SSLRequest (00000008 04d2162f) and falls back cleanly on 'N'
		const { createServer } = await import('node:net')
		let sawSslRequest = false
		let sawStartupAfterDecline = false
		const mockPg = createServer((sock) => {
			sock.once('data', (first) => {
				if (first.toString('hex') === '0000000804d2162f') {
					sawSslRequest = true
					sock.write('N')
					sock.once('data', () => {
						sawStartupAfterDecline = true
						const body = Buffer.from('SFATAL\0C28P01\0Mmock-pg-reached\0\0')
						const hdr = Buffer.alloc(5)
						hdr[0] = 0x45
						hdr.writeInt32BE(body.length + 4, 1)
						sock.write(Buffer.concat([hdr, body]))
						sock.end()
					})
				} else {
					sock.end()
				}
			})
		})
		await new Promise<void>((res) => mockPg.listen(0, '127.0.0.1', () => res()))
		const mockPort = (mockPg.address() as { port: number }).port
		const adapter = new PostgresAdapter(`postgresql://postgres:pw@127.0.0.1:${mockPort}/postgres`)
		try {
			await expect(adapter.ping()).rejects.toThrow('mock-pg-reached')
		} finally {
			adapter.close()
			mockPg.close()
		}
		expect(sawSslRequest).toBe(true)
		expect(sawStartupAfterDecline).toBe(true)
	})

	test('enforces alwaysReadOnly, persists workspace metadata, and supports cross-DB searchable history', async () => {
		const created = await apiCall('POST', '/api/connections', {
			name: 'Replica RO',
			driver: 'sqlite',
			location: 'local',
			path: sampleDbPath,
			isProduction: true,
			alwaysReadOnly: true,
			group: 'Acme Corp',
			tags: ['replica', 'eu-west'],
			color: 'blue',
		})
		expect(created.status).toBe(201)
		const roConn = created.data.connection as {
			id: string
			alwaysReadOnly?: boolean
			group?: string
			tags?: string[]
			color?: string
		}
		expect(roConn.alwaysReadOnly).toBe(true)
		expect(roConn.group).toBe('Acme Corp')
		expect(roConn.tags).toEqual(['replica', 'eu-west'])
		expect(roConn.color).toBe('blue')

		// Arming RW on an alwaysReadOnly connection must be rejected with 403
		const armRes = await apiCall('POST', `/api/connections/${roConn.id}/rw`, { armed: true })
		expect(armRes.status).toBe(403)

		// Run a query on the RO connection and search across all connections
		const qRes = await apiCall('POST', `/api/connections/${roConn.id}/query`, {
			sql: "SELECT email FROM users WHERE id = 'u1'",
		})
		expect(qRes.status).toBe(200)

		const crossHist = await apiCall('GET', '/api/history?connectionId=all&q=email')
		expect(crossHist.status).toBe(200)
		const entries = crossHist.data.history as { connectionId: string; connectionName?: string; sql: string }[]
		expect(entries.some((e) => e.connectionId === roConn.id && e.connectionName === 'Replica RO')).toBe(true)

		await apiCall('DELETE', `/api/connections/${roConn.id}`)
	})

	test('profiles columns, detects triggers & FTS5 shadow tables, inspects PRAGMA/WAL info, and gates maintenance', async () => {
		// Create a dedicated SQLite DB with a trigger and an FTS5 virtual table
		const internalsPath = join(workDir, 'internals.sqlite')
		const idb = new Database(internalsPath)
		idb.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA user_version = 7;
			CREATE TABLE notes (id INTEGER PRIMARY KEY, category TEXT, body TEXT);
			CREATE VIRTUAL TABLE notes_fts USING fts5(body);
			CREATE TRIGGER trg_notes_ai AFTER INSERT ON notes BEGIN
				INSERT INTO notes_fts(body) VALUES (new.body);
			END;
			INSERT INTO notes (category, body) VALUES ('ops', 'hello'), ('ops', 'world'), (NULL, 'orphan');
		`)
		idb.close()

		const created = await apiCall('POST', '/api/connections', {
			name: 'Internals Test',
			driver: 'sqlite',
			location: 'local',
			path: internalsPath,
			isProduction: false,
		})
		const id = (created.data.connection as { id: string }).id

		// Schema should expose triggers and flag FTS5 shadow tables as isInternal
		const schemaRes = await apiCall('GET', `/api/connections/${id}/schema`)
		expect(schemaRes.status).toBe(200)
		const tables = schemaRes.data.tables as { name: string; isInternal?: boolean }[]
		expect(tables.find((t) => t.name === 'notes')?.isInternal).toBeUndefined()
		expect(tables.find((t) => t.name === 'notes_fts_data')?.isInternal).toBe(true)
		const triggers = schemaRes.data.triggers as { name: string; table: string }[]
		expect(triggers.some((tr) => tr.name === 'trg_notes_ai' && tr.table === 'notes')).toBe(true)

		// Column profile
		const profRes = await apiCall('POST', `/api/connections/${id}/profile`, { table: 'notes', column: 'category' })
		expect(profRes.status).toBe(200)
		const profile = profRes.data.profile as {
			totalRows: number
			nullCount: number
			distinctCount: number
			topValues: { value: string | null; count: number }[]
		}
		expect(profile.totalRows).toBe(3)
		expect(profile.nullCount).toBe(1)
		expect(profile.distinctCount).toBe(1)
		expect(profile.topValues[0]).toEqual({ value: 'ops', count: 2 })

		// Database PRAGMA/WAL info
		const infoRes = await apiCall('GET', `/api/connections/${id}/info`)
		expect(infoRes.status).toBe(200)
		const info = infoRes.data.info as {
			driver: string
			userVersion: number
			journalMode: string
			fileSizeBytes: number
		}
		expect(info.driver).toBe('sqlite')
		expect(info.userVersion).toBe(7)
		expect(info.journalMode).toBe('WAL')
		expect(info.fileSizeBytes).toBeGreaterThan(0)

		// Maintenance blocked in Read-Only mode, allowed when RW armed
		const blockedMaint = await apiCall('POST', `/api/connections/${id}/maintenance`, { action: 'wal_checkpoint' })
		expect(blockedMaint.status).toBe(403)
		await apiCall('POST', `/api/connections/${id}/rw`, { armed: true })
		const okMaint = await apiCall('POST', `/api/connections/${id}/maintenance`, { action: 'wal_checkpoint' })
		expect(okMaint.status).toBe(200)
		expect(okMaint.data.ok).toBe(true)

		await apiCall('DELETE', `/api/connections/${id}`)
	})

	test('parses ~/.ssh/config aliases and RFC 4180 CSV / JSON imports', async () => {
		const { parseSshConfigText } = await import('./db/ssh-config.ts')
		const { parseImportText } = await import('../src/lib/import-parse.ts')

		const hosts = parseSshConfigText(`
			Host *
			  ServerAliveInterval 60
			Host prod-db staging-db
			  HostName 10.0.1.25
			  User deploy
			  Port 2222
		`)
		expect(hosts).toEqual([
			{ alias: 'prod-db', hostName: '10.0.1.25', user: 'deploy', port: 2222 },
			{ alias: 'staging-db', hostName: '10.0.1.25', user: 'deploy', port: 2222 },
		])

		const csv = parseImportText('name,note\n"Ada, L.","Line ""1"""\nGrace,\n')
		expect(csv.format).toBe('csv')
		expect(csv.columns).toEqual(['name', 'note'])
		expect(csv.rows).toEqual([
			{ name: 'Ada, L.', note: 'Line "1"' },
			{ name: 'Grace', note: null },
		])

		const js = parseImportText('[{"id":1,"meta":{"a":true}}]')
		expect(js.format).toBe('json')
		expect(js.rows).toEqual([{ id: 1, meta: '{"a":true}' }])
	})

	test('auto-infers undeclared FKs, supports manual virtual FKs and dismissals, and counts reverse FKs', async () => {
		const vfkPath = join(workDir, 'vfk.sqlite')
		const vdb = new Database(vfkPath)
		vdb.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE tickets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, owner TEXT);
			INSERT INTO users (id, name) VALUES ('u1', 'Ada'), ('u2', 'Grace');
			INSERT INTO tickets (id, user_id, owner) VALUES ('t1', 'u1', 'u2'), ('t2', 'u1', 'u1');
		`)
		vdb.close()

		const created = await apiCall('POST', '/api/connections', {
			name: 'Virtual FK Test',
			driver: 'sqlite',
			location: 'local',
			path: vfkPath,
			isProduction: false,
		})
		const id = (created.data.connection as { id: string }).id

		// 1. Auto-inference links tickets.user_id -> users.id out of the box
		const s1 = await apiCall('GET', `/api/connections/${id}/schema`)
		expect(s1.status).toBe(200)
		const schemas1 = s1.data.schemas as Record<
			string,
			{
				foreignKeys: { fromColumn: string; toTable: string; toColumn: string; source?: string }[]
				reverseForeignKeys: { fromTable: string; fromColumn: string; toColumn: string; source?: string }[]
			}
		>
		expect(schemas1.tickets!.foreignKeys).toEqual([
			expect.objectContaining({ fromColumn: 'user_id', toTable: 'users', toColumn: 'id', source: 'inferred' }),
		])
		expect(schemas1.users!.reverseForeignKeys).toEqual([
			{ fromTable: 'tickets', fromColumn: 'user_id', toColumn: 'id', source: 'inferred' },
		])

		// Live reverse-FK counts include auto-inferred FKs
		const rev1 = await apiCall('POST', `/api/connections/${id}/reverse-fks`, { table: 'users', row: { id: 'u1' } })
		expect(rev1.status).toBe(200)
		expect(rev1.data.counts).toEqual([
			{ fromTable: 'tickets', fromColumn: 'user_id', toColumn: 'id', source: 'inferred', count: 2 },
		])

		// 2. Add manual virtual FK for non-standard column `tickets.owner -> users.id`
		const addRes = await apiCall('POST', `/api/connections/${id}/virtual-fks`, {
			fromTable: 'tickets',
			fromColumn: 'owner',
			toTable: 'users',
			toColumn: 'id',
		})
		expect(addRes.status).toBe(200)
		expect(addRes.data.virtualForeignKeys).toEqual([
			{ fromTable: 'tickets', fromColumn: 'owner', toTable: 'users', toColumn: 'id' },
		])

		const rev2 = await apiCall('POST', `/api/connections/${id}/reverse-fks`, { table: 'users', row: { id: 'u2' } })
		expect(rev2.status).toBe(200)
		expect(rev2.data.counts).toEqual([
			{ fromTable: 'tickets', fromColumn: 'owner', toColumn: 'id', source: 'virtual', count: 1 },
			{ fromTable: 'tickets', fromColumn: 'user_id', toColumn: 'id', source: 'inferred', count: 0 },
		])

		// 3. Dismiss auto-inferred FK on `tickets.user_id`
		const ignRes = await apiCall('POST', `/api/connections/${id}/ignored-fks`, {
			fromTable: 'tickets',
			fromColumn: 'user_id',
		})
		expect(ignRes.status).toBe(200)
		const s3 = await apiCall('GET', `/api/connections/${id}/schema`)
		const schemas3 = s3.data.schemas as typeof schemas1
		expect(schemas3.tickets!.foreignKeys.map((fk) => [fk.fromColumn, fk.source])).toEqual([['owner', 'virtual']])

		// 4. Remove manual virtual FK and restore ignored inference
		await apiCall('DELETE', `/api/connections/${id}/virtual-fks`, {
			fromTable: 'tickets',
			fromColumn: 'owner',
			toTable: 'users',
			toColumn: 'id',
		})
		await apiCall('DELETE', `/api/connections/${id}/ignored-fks`, {
			fromTable: 'tickets',
			fromColumn: 'user_id',
		})
		const s4 = await apiCall('GET', `/api/connections/${id}/schema`)
		const schemas4 = s4.data.schemas as typeof schemas1
		expect(schemas4.tickets!.foreignKeys.map((fk) => [fk.fromColumn, fk.source])).toEqual([['user_id', 'inferred']])

		await apiCall('DELETE', `/api/connections/${id}`)
	})
})

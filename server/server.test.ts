// Integration tests for DataStore, LocalSqliteAdapter, Read-Only/Read-Write safety gates, and /api/* ASON contract.
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseAson, stringify as stringifyAson } from '../src/shared/ason.ts'
import { handleApiRequest } from './api.ts'
import { ConnectionManager } from './db/manager.ts'
import { DataStore } from './store.ts'

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
})

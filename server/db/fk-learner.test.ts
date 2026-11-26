// Integration tests for PassiveFkLearner: incremental browsing, retroactive learning, UUID/ULID/typed-ID verification, polymorphic/integer/1:1 guards, drift, and persistence.
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionManager } from './manager.ts'
import { DataStore } from '../store.ts'

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz'

function mkId(prefix: string, seed: number, len = 12): string {
	let s = seed >>> 0
	let out = ''
	for (let i = 0; i < len; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		out += BASE32[(s >>> 20) & 31]!
	}
	return `${prefix}${out}`
}

function mkUuidV4(seed: number): string {
	const hex = '0123456789abcdef'
	let s = seed >>> 0
	const pick = (n: number) => {
		let out = ''
		for (let i = 0; i < n; i++) {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0
			out += hex[(s >>> 24) & 15]!
		}
		return out
	}
	return `${pick(8)}-${pick(4)}-4${pick(3)}-a${pick(3)}-${pick(12)}`
}

function mkUlidSameMs(seed: number): string {
	return `01J9X4K2M0${mkId('', seed, 16).toUpperCase()}`
}

const tempDirs: string[] = []
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'datadip-fklearn-'))
	tempDirs.push(dir)
	return dir
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const d = tempDirs.pop()!
		try {
			rmSync(d, { recursive: true, force: true })
		} catch {}
	}
})

describe('PassiveFkLearner', () => {
	test('learns delimiterless typed-ID FKs (sender, author_id, reply_to) without upfront scans and emits schema-changed', async () => {
		const dir = makeTempDir()
		const dbPath = join(dir, 'app.db')
		const db = new Database(dbPath)
		db.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				sender TEXT,
				author_id TEXT,
				reply_to TEXT,
				external_ref TEXT,
				body TEXT
			);
		`)
		const userIds = Array.from({ length: 12 }, (_, i) => mkId('u', i + 1))
		const msgIds = Array.from({ length: 12 }, (_, i) => mkId('m', i + 100))
		for (let i = 0; i < userIds.length; i++) {
			db.run('INSERT INTO users (id, name) VALUES (?, ?)', [userIds[i]!, `User ${i}`])
		}
		for (let i = 0; i < msgIds.length; i++) {
			db.run('INSERT INTO messages (id, sender, author_id, reply_to, external_ref, body) VALUES (?, ?, ?, ?, ?, ?)', [
				msgIds[i]!,
				userIds[i % userIds.length]!,
				userIds[(i + 1) % userIds.length]!,
				i > 0 ? msgIds[i - 1]! : null,
				mkId('ext_', i + 900),
				`hello world ${i}`,
			])
		}
		db.close()

		const store = new DataStore(join(dir, 'state'), { watch: false })
		const manager = new ConnectionManager(store)
		const events: unknown[] = []
		manager.subscribeSchemaChanges((ev) => events.push(ev))

		const conn = store.addConnection({
			name: 'TypedApp',
			driver: 'sqlite',
			location: 'local',
			path: dbPath,
			isProduction: false,
		})

		// Before browsing any rows: zero learned FKs on connect!
		const initialSchema = await manager.getSchema(conn.id)
		expect(initialSchema.schemas.messages!.foreignKeys).toEqual([])

		// Browse users first, then messages
		await manager.browseTable(conn.id, { table: 'users', limit: 50 })
		await manager.fkLearner.waitForIdle()
		await manager.browseTable(conn.id, { table: 'messages', limit: 50 })
		await manager.fkLearner.waitForIdle()

		const updatedSchema = await manager.getSchema(conn.id)
		const msgFks = updatedSchema.schemas.messages!.foreignKeys
		expect(msgFks.find((f) => f.fromColumn === 'sender')?.toTable).toBe('users')
		expect(msgFks.find((f) => f.fromColumn === 'sender')?.inferenceKind).toBe('data')
		expect(msgFks.find((f) => f.fromColumn === 'author_id')?.toTable).toBe('users')
		expect(msgFks.find((f) => f.fromColumn === 'reply_to')?.toTable).toBe('messages')
		// External ref that matches no PK must NEVER become an FK
		expect(msgFks.find((f) => f.fromColumn === 'external_ref')).toBeUndefined()
		expect(msgFks.find((f) => f.fromColumn === 'body')).toBeUndefined()
		expect(events.length).toBeGreaterThanOrEqual(1)

		// Verify persistence across ConnectionManager restart
		manager.closeAll()
		const manager2 = new ConnectionManager(store)
		const reloadedSchema = await manager2.getSchema(conn.id)
		expect(reloadedSchema.schemas.messages!.foreignKeys.find((f) => f.fromColumn === 'sender')?.toTable).toBe('users')

		// Dismissing a learned FK removes it and prevents re-learning on future browse
		store.addIgnoredForeignKey(conn.id, { fromTable: 'messages', fromColumn: 'sender' })
		await manager2.browseTable(conn.id, { table: 'messages', limit: 50 })
		await manager2.fkLearner.waitForIdle()
		const afterDismiss = await manager2.getSchema(conn.id)
		expect(afterDismiss.schemas.messages!.foreignKeys.find((f) => f.fromColumn === 'sender')).toBeUndefined()

		manager2.closeAll()
		store.close()
	})

	test('learns UUIDs and ULIDs even on opaque column names while avoiding ULID timestamp-prefix traps and plain integers', async () => {
		const dir = makeTempDir()
		const dbPath = join(dir, 'mixed.db')
		const db = new Database(dbPath)
		db.exec(`
			CREATE TABLE accounts (id TEXT PRIMARY KEY, label TEXT);
			CREATE TABLE workspaces (id TEXT PRIMARY KEY, label TEXT);
			CREATE TABLE seq_items (id INTEGER PRIMARY KEY, label TEXT);
			CREATE TABLE audit (
				id TEXT PRIMARY KEY,
				opaque_actor TEXT,
				opaque_ws TEXT,
				seq_num INTEGER
			);
		`)
		const accIds = Array.from({ length: 10 }, (_, i) => mkUuidV4(i + 1))
		const wsIds = Array.from({ length: 10 }, (_, i) => mkUlidSameMs(i + 100))
		const auditIds = Array.from({ length: 10 }, (_, i) => mkUlidSameMs(i + 500))
		for (let i = 0; i < 10; i++) {
			db.run('INSERT INTO accounts VALUES (?, ?)', [accIds[i]!, `acc ${i}`])
			db.run('INSERT INTO workspaces VALUES (?, ?)', [wsIds[i]!, `ws ${i}`])
			db.run('INSERT INTO seq_items VALUES (?, ?)', [i + 1, `item ${i}`])
			db.run('INSERT INTO audit VALUES (?, ?, ?, ?)', [auditIds[i]!, accIds[i]!, wsIds[i]!, i + 1])
		}
		db.close()

		const store = new DataStore(join(dir, 'state'), { watch: false })
		const manager = new ConnectionManager(store)
		const conn = store.addConnection({
			name: 'MixedDb',
			driver: 'sqlite',
			location: 'local',
			path: dbPath,
			isProduction: false,
		})

		await manager.getSchema(conn.id)
		await manager.browseTable(conn.id, { table: 'audit', limit: 50 })
		await manager.fkLearner.waitForIdle()

		const schema = await manager.getSchema(conn.id)
		const fks = schema.schemas.audit!.foreignKeys
		expect(fks.find((f) => f.fromColumn === 'opaque_actor')?.toTable).toBe('accounts')
		expect(fks.find((f) => f.fromColumn === 'opaque_ws')?.toTable).toBe('workspaces')
		// Plain integer column `seq_num` with values 1..10 overlapping `seq_items.id` must NEVER be guessed!
		expect(fks.find((f) => f.fromColumn === 'seq_num')).toBeUndefined()

		manager.closeAll()
		store.close()
	})

	test('rejects polymorphic columns, handles soft-deleted orphans, and disambiguates 1:1 extension tables', async () => {
		const dir = makeTempDir()
		const dbPath = join(dir, 'edge.db')
		const db = new Database(dbPath)
		db.exec(`
			CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
			CREATE TABLE user_profiles (
				id TEXT PRIMARY KEY REFERENCES users(id),
				bio TEXT
			);
			CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT);
			CREATE TABLE events (
				id TEXT PRIMARY KEY,
				actor TEXT,
				entity_ref TEXT,
				poly_uuid TEXT
			);
			CREATE TABLE uuid_a (id TEXT PRIMARY KEY);
			CREATE TABLE uuid_b (id TEXT PRIMARY KEY);
		`)
		const userIds = Array.from({ length: 12 }, (_, i) => mkId('u', i + 1))
		const orgIds = Array.from({ length: 12 }, (_, i) => mkId('o', i + 100))
		const ua = Array.from({ length: 6 }, (_, i) => mkUuidV4(i + 10))
		const ub = Array.from({ length: 6 }, (_, i) => mkUuidV4(i + 200))

		for (let i = 0; i < 12; i++) {
			db.run('INSERT INTO users VALUES (?, ?)', [userIds[i]!, `U${i}`])
			db.run('INSERT INTO user_profiles VALUES (?, ?)', [userIds[i]!, `Bio ${i}`])
			db.run('INSERT INTO orgs VALUES (?, ?)', [orgIds[i]!, `O${i}`])
		}
		for (const id of ua) db.run('INSERT INTO uuid_a VALUES (?)', [id])
		for (const id of ub) db.run('INSERT INTO uuid_b VALUES (?)', [id])

		// 10/12 actor values exist in users (2 soft-deleted orphans -> 83% inclusion >= 75% threshold)
		// entity_ref mixes users + orgs (polymorphic typed IDs)
		// poly_uuid mixes uuid_a + uuid_b (polymorphic UUIDs)
		for (let i = 0; i < 12; i++) {
			const actor = i < 10 ? userIds[i]! : mkId('u', 9900 + i)
			const entityRef = i % 2 === 0 ? userIds[i]! : orgIds[i]!
			const polyUuid = i < 6 ? ua[i]! : ub[i - 6]!
			db.run('INSERT INTO events VALUES (?, ?, ?, ?)', [mkId('e', i + 500), actor, entityRef, polyUuid])
		}
		db.close()

		const store = new DataStore(join(dir, 'state'), { watch: false })
		const manager = new ConnectionManager(store)
		const conn = store.addConnection({
			name: 'EdgeDb',
			driver: 'sqlite',
			location: 'local',
			path: dbPath,
			isProduction: false,
		})

		await manager.getSchema(conn.id)
		await manager.browseTable(conn.id, { table: 'events', limit: 50 })
		await manager.fkLearner.waitForIdle()

		const schema = await manager.getSchema(conn.id)
		const fks = schema.schemas.events!.foreignKeys
		// 1:1 disambiguation: user_profiles.id references users.id, so `actor` resolves to `users` (parent), NOT `user_profiles`!
		expect(fks.find((f) => f.fromColumn === 'actor')?.toTable).toBe('users')
		// Polymorphic columns must NOT emit broken single-target FKs
		expect(fks.find((f) => f.fromColumn === 'entity_ref')).toBeUndefined()
		expect(fks.find((f) => f.fromColumn === 'poly_uuid')).toBeUndefined()
		// Parent users.id must NEVER reverse-point to user_profiles.id
		expect(schema.schemas.users!.foreignKeys).toEqual([])

		manager.closeAll()
		store.close()
	})

	test('retroactively learns FKs when child table is browsed before parent table, and demotes on polymorphic drift', async () => {
		const dir = makeTempDir()
		const dbPath = join(dir, 'retro.db')
		const db = new Database(dbPath)
		// Create 40 dummy tables so target `zenith_nodes` sits outside Pass 1 & Pass 2 initial probe cap (>36),
		// proving retroactive matching when `zenith_nodes` is browsed later!
		for (let t = 0; t < 40; t++) {
			db.exec(`CREATE TABLE dummy_${String(t).padStart(2, '0')} (id TEXT PRIMARY KEY);`)
		}
		db.exec(`
			CREATE TABLE zenith_nodes (id TEXT PRIMARY KEY);
			CREATE TABLE other_nodes (id TEXT PRIMARY KEY);
			CREATE TABLE links (id TEXT PRIMARY KEY, target_ref TEXT, drifting_ref TEXT);
		`)
		const zIds = Array.from({ length: 8 }, (_, i) => mkId('zn_', i + 1))
		const oIds = Array.from({ length: 8 }, (_, i) => mkId('on_', i + 50))
		for (const id of zIds) db.run('INSERT INTO zenith_nodes VALUES (?)', [id])
		for (const id of oIds) db.run('INSERT INTO other_nodes VALUES (?)', [id])

		// Page 1 (rows 0..5): all drifting_ref are `zn_`
		for (let i = 0; i < 6; i++) {
			db.run('INSERT INTO links VALUES (?, ?, ?)', [`l_${String(i).padStart(2, '0')}`, zIds[i]!, zIds[i]!])
		}
		// Page 2 (rows 6..11): drifting_ref switches to `on_` (polymorphic drift!)
		for (let i = 6; i < 12; i++) {
			db.run('INSERT INTO links VALUES (?, ?, ?)', [`l_${String(i).padStart(2, '0')}`, zIds[i % 8]!, oIds[i - 6]!])
		}
		db.close()

		const store = new DataStore(join(dir, 'state'), { watch: false })
		const manager = new ConnectionManager(store)
		const conn = store.addConnection({
			name: 'RetroDb',
			driver: 'sqlite',
			location: 'local',
			path: dbPath,
			isProduction: false,
		})

		await manager.getSchema(conn.id)

		// Browse page 1 of links FIRST (only 6 rows, ordered by id)
		await manager.browseTable(conn.id, { table: 'links', limit: 6, order: [{ column: 'id', dir: 'asc' }] })
		await manager.fkLearner.waitForIdle()

		// Browse zenith_nodes later -> retroactive learning matches `target_ref` and `drifting_ref`
		await manager.browseTable(conn.id, { table: 'zenith_nodes', limit: 20 })
		await manager.fkLearner.waitForIdle()

		const midSchema = await manager.getSchema(conn.id)
		expect(midSchema.schemas.links!.foreignKeys.find((f) => f.fromColumn === 'target_ref')?.toTable).toBe(
			'zenith_nodes',
		)
		expect(midSchema.schemas.links!.foreignKeys.find((f) => f.fromColumn === 'drifting_ref')?.toTable).toBe(
			'zenith_nodes',
		)

		// Now browse page 2 of links -> `drifting_ref` reveals `on_` values -> automatically demoted!
		await manager.browseTable(conn.id, {
			table: 'links',
			limit: 6,
			offset: 6,
			order: [{ column: 'id', dir: 'asc' }],
		})
		await manager.fkLearner.waitForIdle()

		const finalSchema = await manager.getSchema(conn.id)
		expect(finalSchema.schemas.links!.foreignKeys.find((f) => f.fromColumn === 'target_ref')?.toTable).toBe(
			'zenith_nodes',
		)
		expect(finalSchema.schemas.links!.foreignKeys.find((f) => f.fromColumn === 'drifting_ref')).toBeUndefined()

		manager.closeAll()
		store.close()
	})
})

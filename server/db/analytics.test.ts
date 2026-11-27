// Integration tests for server/db/analytics.ts against a real SQLite event stream database.
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STITCHED_ACTOR_SENTINEL } from '../../src/shared/analytics.ts'
import {
	detectAnalyticsTable,
	runAnalyticsActorJourney,
	runAnalyticsActors,
	runAnalyticsFunnel,
	runAnalyticsRetention,
	runAnalyticsTrends,
} from './analytics.ts'
import { LocalSqliteAdapter } from './sqlite-local.ts'

let dir = ''
let adapter: LocalSqliteAdapter

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'datadip-analytics-'))
	const dbPath = join(dir, 'app.db')
	const db = new Database(dbPath)
	db.exec(`
		CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, admin INTEGER DEFAULT 0, test INTEGER DEFAULT 0, created_at INTEGER);
		CREATE TABLE events (
			id TEXT PRIMARY KEY,
			visitor_id TEXT,
			user_id TEXT,
			event TEXT NOT NULL,
			data TEXT,
			status INTEGER,
			created_at INTEGER NOT NULL,
			admin_id TEXT
		);
	`)
	const day = 86_400_000
	const base = Date.UTC(2026, 10, 10, 12, 0, 0)
	db.query('INSERT INTO users (id, name, admin, test, created_at) VALUES (?, ?, ?, ?, ?)').run('u1', 'ada', 0, 0, base)
	db.query('INSERT INTO users (id, name, admin, test, created_at) VALUES (?, ?, ?, ?, ?)').run('u3', 'boss', 1, 0, base)
	db.query('INSERT INTO users (id, name, admin, test, created_at) VALUES (?, ?, ?, ?, ?)').run(
		'u4',
		'qa_bot',
		0,
		1,
		base,
	)
	const ins = db.query(
		'INSERT INTO events (id, visitor_id, user_id, event, data, status, created_at, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
	)
	// Day 0: v1 views -> signs up as u1 -> views chat with dynamic ID; v2 views only + hits 404
	ins.run('e1', 'v1', null, 'POST /api/view', "{ path: '/' }", 200, base, null)
	ins.run('e2', 'v1', 'u1', 'POST /api/signup', null, 200, base + 20_000, null)
	ins.run('e3', 'v1', 'u1', 'GET /api/chats/c1m6e6d9bv26', null, 200, base + 50_000, null)
	ins.run('e4', 'v2', null, 'POST /api/view', "{ path: '/' }", 200, base + 60_000, null)
	ins.run('e5', 'v2', null, 'POST /api/claim', null, 404, base + 90_000, null)
	// Day 1: u1 returns and visits another chat ID; admin event and test user event
	ins.run('e6', 'v1', 'u1', 'GET /api/chats/c1m7hq49z70a', null, 200, base + day, null)
	ins.run('e7', 'v3', 'u3', 'POST /api/admin/action', null, 200, base + day + 1000, 'adm1')
	ins.run('e8', 'v4', 'u4', 'POST /api/view', null, 200, base + day + 2000, null)
	db.close()

	adapter = new LocalSqliteAdapter(dbPath)
})

afterAll(() => {
	adapter.close()
	rmSync(dir, { recursive: true, force: true })
})

describe('server analytics engine (SQLite)', () => {
	test('auto-detects events table, epoch_ms format, actors, status, and HTTP events', async () => {
		const schema = await adapter.getSchema()
		const det = await detectAnalyticsTable(adapter, 'sqlite', schema)
		expect(det.table).toBe('events')
		expect(det.timeColumn).toBe('created_at')
		expect(det.timeFormat).toBe('epoch_ms')
		expect(det.eventColumn).toBe('event')
		expect(det.defaultActorColumn).toBe('user_id')
		expect(det.statusColumn).toBe('status')
		expect(det.adminColumn).toBe('admin_id')
		expect(det.userDirectory?.table).toBe('users')
		expect(det.userDirectory?.labelColumn).toBe('name')
		expect(det.userDirectory?.adminColumn).toBe('admin')
		expect(det.userDirectory?.testColumn).toBe('test')
		expect(det.userDirectory?.adminCount).toBe(1)
		expect(det.userDirectory?.testCount).toBe(1)
		expect(det.looksLikeHttpEvents).toBe(true)
		expect(det.totalRows).toBe(8)
	})

	test('runs Trends with URL normalization and admin/test/signed-in exclusions', async () => {
		const schema = await adapter.getSchema()
		const res = await runAnalyticsTrends(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: STITCHED_ACTOR_SENTINEL,
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			statusColumn: 'status',
			range: '7d',
			interval: 'day',
			metric: 'events',
			breakdownColumn: 'event',
			normalizeUrls: true,
			excludeAdmin: true,
			excludeTestUsers: true,
		})
		expect(res.kpis.totalEvents).toBe(6)
		expect(res.kpis.uniqueUsers).toBe(1)
		expect(res.kpis.uniqueAnonVisitors).toBe(2)
		expect(res.kpis.errorCount).toBe(1)
		// Dynamic chat IDs collapse into one route
		const chatsSeries = res.series.find((s) => s.key === 'GET /api/chats/:id')
		expect(chatsSeries?.total).toBe(2)

		// Signed-in only + excludeAdmin + excludeTestUsers yields strictly the 1 real user (u1) with 3 events
		const signedIn = await runAnalyticsTrends(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: 'user_id',
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			statusColumn: 'status',
			range: '7d',
			interval: 'day',
			metric: 'events',
			breakdownColumn: 'event',
			normalizeUrls: true,
			excludeAdmin: true,
			excludeTestUsers: true,
			signedInOnly: true,
		})
		expect(signedIn.kpis.totalEvents).toBe(3)
		expect(signedIn.kpis.uniqueActors).toBe(1)
	})

	test('runs Funnel with visitor -> user identity stitching', async () => {
		const schema = await adapter.getSchema()
		const res = await runAnalyticsFunnel(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: STITCHED_ACTOR_SENTINEL,
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			range: 'all',
			normalizeUrls: true,
			stitchIdentity: true,
			excludeAdmin: true,
			excludeTestUsers: true,
			windowSeconds: 3600,
			steps: [
				{ pattern: 'POST /api/view', match: 'exact' },
				{ pattern: 'POST /api/signup', match: 'exact' },
				{ pattern: 'GET /api/chats/:id', match: 'exact' },
			],
		})
		expect(res.stitchedIdentity).toBe(true)
		expect(res.steps[0]!.count).toBe(2) // u1 (stitched from v1) + v2
		expect(res.steps[1]!.count).toBe(1) // u1
		expect(res.steps[2]!.count).toBe(1) // u1
		expect(res.steps[1]!.medianSecondsFromPrev).toBe(20)
	})

	test('runs Retention, Actors, and Actor Journey', async () => {
		const schema = await adapter.getSchema()
		const ret = await runAnalyticsRetention(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: STITCHED_ACTOR_SENTINEL,
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			range: 'all',
			granularity: 'day',
			periods: 7,
			stitchIdentity: true,
			excludeAdmin: true,
			excludeTestUsers: true,
		})
		expect(ret.cohorts).toHaveLength(1)
		expect(ret.cohorts[0]!.size).toBe(2)
		expect(ret.cohorts[0]!.pcts[0]).toBe(100)
		expect(ret.cohorts[0]!.pcts[1]).toBe(50) // 1 of 2 returned on Day 1

		const actors = await runAnalyticsActors(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: STITCHED_ACTOR_SENTINEL,
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			statusColumn: 'status',
			range: 'all',
		})
		expect(actors.actors.length).toBeGreaterThanOrEqual(3)

		const journey = await runAnalyticsActorJourney(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: STITCHED_ACTOR_SENTINEL,
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			statusColumn: 'status',
			payloadColumn: 'data',
			range: 'all',
			actorId: 'u1',
			normalizeUrls: true,
		})
		expect(journey.events.length).toBe(3)
		expect(journey.events[0]!.event).toBe('GET /api/chats/:id')
	})

	test('computes exact unique_actors without double-counting normalized routes or Other, and returns true topEvent', async () => {
		const schema = await adapter.getSchema()
		// Add a second distinct event for u1 on the same day so topEvent != alphabetical MAX
		const res = await runAnalyticsTrends(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: 'user_id',
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			statusColumn: 'status',
			range: 'all',
			interval: 'day',
			metric: 'unique_actors',
			breakdownColumn: 'event',
			topN: 1,
			normalizeUrls: true,
			excludeAdmin: true,
			excludeTestUsers: true,
			signedInOnly: true,
		})
		// Only 1 real signed-in user (u1) exists: no series or Other bucket may ever report > 1 unique person
		expect(res.kpis.uniqueActors).toBe(1)
		for (const s of res.series) {
			expect(s.total).toBeLessThanOrEqual(1)
			for (const v of s.values) {
				expect(v).toBeLessThanOrEqual(1)
			}
		}

		// People topEvent should reflect actual frequency (GET /api/chats/:id occurred twice for u1 vs POST /api/signup once)
		const actors = await runAnalyticsActors(adapter, 'sqlite', schema, {
			table: 'events',
			timeColumn: 'created_at',
			timeFormat: 'epoch_ms',
			eventColumn: 'event',
			actorColumn: 'user_id',
			userIdColumn: 'user_id',
			visitorIdColumn: 'visitor_id',
			statusColumn: 'status',
			range: 'all',
			normalizeUrls: true,
			excludeAdmin: true,
			excludeTestUsers: true,
			signedInOnly: true,
		})
		const u1 = actors.actors.find((a) => a.actorId === 'u1')
		expect(u1?.topEvent).toBe('GET /api/chats/:id')
	})

	test('handles text status columns safely without crashing integer casts', async () => {
		const subDir = mkdtempSync(join(tmpdir(), 'datadip-analytics-text-status-'))
		const subPath = join(subDir, 'pay.db')
		const db = new Database(subPath)
		db.exec(`
			CREATE TABLE payments (
				id TEXT PRIMARY KEY,
				user_id TEXT,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			INSERT INTO payments VALUES ('p1', 'u1', 'failed', '2026-11-04T17:43:46.305Z');
			INSERT INTO payments VALUES ('p2', 'u1', 'succeeded', '2026-11-04T18:07:20.401456Z');
		`)
		db.close()
		const payAdapter = new LocalSqliteAdapter(subPath)
		try {
			const paySchema = await payAdapter.getSchema()
			const det = await detectAnalyticsTable(payAdapter, 'sqlite', paySchema, 'payments')
			// Text status column should not be mistaken for HTTP integer status codes
			expect(det.statusColumn).toBeNull()
			// Even if explicitly passed, safeStatusIntExpr prevents cast errors and < endMs+1ms keeps microsecond rows
			const tr = await runAnalyticsTrends(payAdapter, 'sqlite', paySchema, {
				table: 'payments',
				timeColumn: 'created_at',
				timeFormat: 'iso',
				actorColumn: 'user_id',
				userIdColumn: 'user_id',
				statusColumn: 'status',
				range: 'all',
				anchorEndMs: det.maxTimeMs,
				interval: 'day',
				metric: 'events',
			})
			expect(tr.kpis.totalEvents).toBe(2)
			expect(tr.kpis.errorCount).toBe(0)
		} finally {
			payAdapter.close()
			rmSync(subDir, { recursive: true, force: true })
		}
	})
})

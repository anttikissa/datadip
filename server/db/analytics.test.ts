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
		CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
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
	const ins = db.query(
		'INSERT INTO events (id, visitor_id, user_id, event, data, status, created_at, admin_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
	)
	// Day 0: v1 views -> signs up as u1 -> views chat with dynamic ID; v2 views only + hits 404
	ins.run('e1', 'v1', null, 'POST /api/view', "{ path: '/' }", 200, base, null)
	ins.run('e2', 'v1', 'u1', 'POST /api/signup', null, 200, base + 20_000, null)
	ins.run('e3', 'v1', 'u1', 'GET /api/chats/c1m6e6d9bv26', null, 200, base + 50_000, null)
	ins.run('e4', 'v2', null, 'POST /api/view', "{ path: '/' }", 200, base + 60_000, null)
	ins.run('e5', 'v2', null, 'POST /api/claim', null, 404, base + 90_000, null)
	// Day 1: u1 returns and visits another chat ID; admin event excluded when filtered
	ins.run('e6', 'v1', 'u1', 'GET /api/chats/c1m7hq49z70a', null, 200, base + day, null)
	ins.run('e7', 'v3', 'u3', 'POST /api/admin/action', null, 200, base + day + 1000, 'adm1')
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
		expect(det.defaultActorColumn).toBe(STITCHED_ACTOR_SENTINEL)
		expect(det.statusColumn).toBe('status')
		expect(det.adminColumn).toBe('admin_id')
		expect(det.looksLikeHttpEvents).toBe(true)
		expect(det.totalRows).toBe(7)
	})

	test('runs Trends with URL normalization and admin filter', async () => {
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
			filters: [{ column: 'admin_id', op: 'isnull', value: '' }],
		})
		expect(res.kpis.totalEvents).toBe(6)
		expect(res.kpis.errorCount).toBe(1)
		// Dynamic chat IDs collapse into one route
		const chatsSeries = res.series.find((s) => s.key === 'GET /api/chats/:id')
		expect(chatsSeries?.total).toBe(2)
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
			filters: [{ column: 'admin_id', op: 'isnull', value: '' }],
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
})

// Unit tests for product analytics detection, URL normalization, funnel stitching, and cohort retention math.
import { describe, expect, test } from 'bun:test'
import {
	computeFunnel,
	computeRetention,
	detectBestAnalyticsTable,
	detectTableColumns,
	generateBuckets,
	inferTimeFormat,
	looksLikeHttpEventList,
	normalizeEventName,
	STITCHED_ACTOR_SENTINEL,
} from './analytics.ts'
import type { DatabaseSchema, TableSchema } from './types.ts'

function makeTable(name: string, columns: { name: string; type: string; pk?: number }[]): TableSchema {
	return {
		name,
		type: 'table',
		ddl: '',
		columns: columns.map((c) => ({
			name: c.name,
			type: c.type,
			notNull: false,
			defaultValue: null,
			primaryKey: c.pk ?? 0,
		})),
		foreignKeys: [],
		reverseForeignKeys: [],
		indexes: [],
		primaryKeyColumns: columns.filter((c) => c.pk).map((c) => c.name),
	}
}

describe('analytics schema detection', () => {
	test('prefers events table with time, event, and actor columns', () => {
		const users = makeTable('users', [
			{ name: 'id', type: 'TEXT', pk: 1 },
			{ name: 'email', type: 'TEXT' },
			{ name: 'created_at', type: 'INTEGER' },
		])
		const events = makeTable('events', [
			{ name: 'id', type: 'TEXT', pk: 1 },
			{ name: 'visitor_id', type: 'TEXT' },
			{ name: 'user_id', type: 'TEXT' },
			{ name: 'event', type: 'TEXT' },
			{ name: 'data', type: 'TEXT' },
			{ name: 'status', type: 'INTEGER' },
			{ name: 'created_at', type: 'INTEGER' },
			{ name: 'admin_id', type: 'TEXT' },
		])
		const schema: DatabaseSchema = {
			tables: [
				{ name: 'users', type: 'table', rowCount: 50 },
				{ name: 'events', type: 'table', rowCount: 5000 },
			],
			schemas: { users, events },
			durationMs: 5,
		}

		expect(detectBestAnalyticsTable(schema)).toBe('events')
		const detected = detectTableColumns(events)
		expect(detected.timeColumn).toBe('created_at')
		expect(detected.eventColumn).toBe('event')
		expect(detected.userIdColumn).toBe('user_id')
		expect(detected.visitorIdColumn).toBe('visitor_id')
		expect(detected.defaultActorColumn).toBe('user_id')
		expect(detected.statusColumn).toBe('status')
		expect(detected.adminColumn).toBe('admin_id')
		expect(detected.payloadColumn).toBe('data')
	})

	test('infers epoch_ms, epoch_s, and iso time formats', () => {
		expect(inferTimeFormat(1795726676999, 'INTEGER')).toBe('epoch_ms')
		expect(inferTimeFormat(1795726676, 'INTEGER')).toBe('epoch_s')
		expect(inferTimeFormat('2026-11-26T12:00:00Z', 'TEXT')).toBe('iso')
		expect(inferTimeFormat('2026-11-26 12:00:00', 'TIMESTAMP')).toBe('iso')
	})
})

describe('normalizeEventName', () => {
	test('collapses dynamic IDs and query strings while preserving static segments', () => {
		expect(normalizeEventName('GET /api/chats/c1m6e6d9bv26')).toBe('GET /api/chats/:id')
		expect(normalizeEventName('POST /api/chats/c1m6e6d9bv26/messages')).toBe('POST /api/chats/:id/messages')
		expect(normalizeEventName('GET /api/posts/550e8400-e29b-41d4-a716-446655440000')).toBe('GET /api/posts/:id')
		expect(normalizeEventName('GET /api/users/48291/profile?tab=activity')).toBe('GET /api/users/:id/profile')
		expect(normalizeEventName('POST /api/location')).toBe('POST /api/location')
		expect(normalizeEventName('GET /api/v2/notifications')).toBe('GET /api/v2/notifications')
		expect(normalizeEventName('user_signed_up')).toBe('user_signed_up')
		expect(looksLikeHttpEventList(['POST /api/view', 'GET /api/feed', 'user_signed_up'])).toBe(true)
	})
})

describe('computeFunnel', () => {
	test('stitches visitor_id -> user_id and respects ordering & conversion window', () => {
		const t0 = 1_700_000_000_000
		const events = [
			// Person A: anonymous view -> signs up as u1 -> creates post within 2m
			{ actorKey: 'v1', userId: null, visitorId: 'v1', event: 'POST /api/view', tsMs: t0 },
			{ actorKey: 'u1', userId: 'u1', visitorId: 'v1', event: 'POST /api/signup', tsMs: t0 + 30_000 },
			{ actorKey: 'u1', userId: 'u1', visitorId: null, event: 'POST /api/posts', tsMs: t0 + 90_000 },
			// Person B: views -> signs up, never posts
			{ actorKey: 'v2', userId: null, visitorId: 'v2', event: 'POST /api/view', tsMs: t0 + 10_000 },
			{ actorKey: 'u2', userId: 'u2', visitorId: 'v2', event: 'POST /api/signup', tsMs: t0 + 70_000 },
			// Person C: views -> signs up AFTER 1h window (excluded from step 2 under 1h window)
			{ actorKey: 'v3', userId: null, visitorId: 'v3', event: 'POST /api/view', tsMs: t0 },
			{ actorKey: 'u3', userId: 'u3', visitorId: 'v3', event: 'POST /api/signup', tsMs: t0 + 7_200_000 },
		]

		const steps = [
			{ pattern: 'POST /api/view', match: 'exact' as const },
			{ pattern: 'POST /api/signup', match: 'exact' as const },
			{ pattern: 'POST /api/posts', match: 'exact' as const },
		]

		const res = computeFunnel(events, steps, 3600, true)
		expect(res[0]!.count).toBe(3)
		expect(res[0]!.overallPct).toBe(100)
		expect(res[1]!.count).toBe(2)
		expect(res[1]!.medianSecondsFromPrev).toBe(45) // median of [30, 60]
		expect(res[1]!.dropoffCount).toBe(1)
		expect(res[2]!.count).toBe(1)
		expect(res[2]!.stepPct).toBe(50)
		expect(res[2]!.sampleActors).toEqual(['u1'])
	})
})

describe('computeRetention', () => {
	test('computes daily cohort matrix and leaves future periods null', () => {
		const day0 = Date.UTC(2026, 10, 1)
		const day = 86_400_000
		const points = [
			// Cohort Nov 1: u1, u2; u1 returns D1 & D2; u2 returns D2 only
			{ actorId: 'u1', bucketMs: day0, isCohortEvent: true, isReturnEvent: true },
			{ actorId: 'u2', bucketMs: day0, isCohortEvent: true, isReturnEvent: true },
			{ actorId: 'u1', bucketMs: day0 + day, isCohortEvent: true, isReturnEvent: true },
			{ actorId: 'u1', bucketMs: day0 + 2 * day, isCohortEvent: true, isReturnEvent: true },
			{ actorId: 'u2', bucketMs: day0 + 2 * day, isCohortEvent: true, isReturnEvent: true },
			// Cohort Nov 2: u3; returns D1 (Nov 3)
			{ actorId: 'u3', bucketMs: day0 + day, isCohortEvent: true, isReturnEvent: true },
			{ actorId: 'u3', bucketMs: day0 + 2 * day, isCohortEvent: true, isReturnEvent: true },
		]

		const { cohorts, averagePcts } = computeRetention(points, 'day', 3, day0 + 2 * day)
		expect(cohorts).toHaveLength(2)
		expect(cohorts[0]!.label).toBe('2026-11-01')
		expect(cohorts[0]!.size).toBe(2)
		expect(cohorts[0]!.pcts).toEqual([100, 50, 100, null])
		expect(cohorts[1]!.label).toBe('2026-11-02')
		expect(cohorts[1]!.size).toBe(1)
		expect(cohorts[1]!.pcts).toEqual([100, 100, null, null])
		// Average D1 = (1 + 1) / (2 + 1) = 66.7%
		expect(averagePcts[0]).toBe(100)
		expect(averagePcts[1]).toBe(66.7)
		expect(averagePcts[2]).toBe(100)
		expect(averagePcts[3]).toBeNull()
	})

	test('generates continuous zero-gap buckets', () => {
		const start = Date.UTC(2026, 10, 1)
		const end = Date.UTC(2026, 10, 4)
		expect(generateBuckets(start, end, 'day')).toHaveLength(4)
	})
})

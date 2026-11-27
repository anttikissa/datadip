// Unit tests for Smart Value Lenses (Unix epochs, Crockford tid, UUIDv7/v1, ULID, KSUID, ObjectId, and Snowflakes).
import { describe, expect, test } from 'bun:test'
import { autoDecodeSingleValue, decodeWithFormat, detectColumnLenses, formatUtcTimestamp } from './lenses.ts'
import { tidAt } from './tid.ts'

describe('Smart Value Lenses decoders', () => {
	test('decodes Crockford tid creation timestamp accurately', () => {
		const ms = Date.UTC(2026, 10, 26, 20, 10, 55, 385)
		const id = tidAt('e', ms, 2)
		expect(decodeWithFormat(id, 'tid')).toBe(ms)
		// Lenient Crockford reading (uppercase, o->0, i/l->1)
		const upper = id.toUpperCase().replace('0', 'O').replace('1', 'I')
		expect(decodeWithFormat(upper, 'tid')).toBe(ms)
	})

	test('decodes UUIDv7 and prefixed UUIDv7', () => {
		const ms = Date.UTC(2026, 5, 15, 12, 30, 0)
		const hex = ms.toString(16).padStart(12, '0')
		const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`
		expect(decodeWithFormat(uuid, 'uuidv7')).toBe(ms)
		expect(decodeWithFormat(`usr_${uuid}`, 'uuidv7')).toBe(ms)
	})

	test('decodes ULID and prefixed ULID', () => {
		// 01ARZ3NDEK -> 1469922850259 (2016-07-30T23:54:10.259Z)
		const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
		expect(decodeWithFormat(ulid, 'ulid')).toBe(1469922850259)
		expect(decodeWithFormat(`org_${ulid}`, 'ulid')).toBe(1469922850259)
	})

	test('decodes MongoDB ObjectId and Unix epochs', () => {
		const sec = Math.floor(Date.UTC(2026, 1, 1, 0, 0, 0) / 1000)
		const oid = sec.toString(16).padStart(8, '0') + 'a1b2c3d4e5f6a7b8'
		expect(decodeWithFormat(oid, 'objectid')).toBe(sec * 1000)
		expect(decodeWithFormat(1795719055385, 'epoch_ms')).toBe(1795719055385)
		expect(decodeWithFormat(1795719055, 'epoch_s')).toBe(1795719055000)
		expect(formatUtcTimestamp(Date.UTC(2026, 10, 26, 20, 10, 55))).toBe('2026-11-26 20:10:55')
	})

	test('decodes Twitter and Discord Snowflakes', () => {
		// Discord epoch = 1420070400000; offset 60000ms -> (60000n << 22n)
		const discId = (60_000n << 22n).toString()
		expect(decodeWithFormat(discId, 'snowflake_discord')).toBe(1420070460000)
	})
})

describe('detectColumnLenses', () => {
	test('auto-detects epoch_ms timestamps and Crockford tids without false positives on status or event', () => {
		const t1 = Date.UTC(2026, 10, 26, 20, 10, 55)
		const t2 = Date.UTC(2026, 10, 26, 20, 11, 12)
		const rows = [
			{
				id: tidAt('e', t1, 2),
				user_id: tidAt('u', t1 - 86_400_000, 2),
				event: 'POST /api/view',
				status: 200,
				created_at: t1,
			},
			{
				id: tidAt('e', t2, 2),
				user_id: tidAt('u', t2 - 86_400_000, 2),
				event: 'GET /api/feed',
				status: 404,
				created_at: t2,
			},
		]
		const lenses = detectColumnLenses(
			['id', 'user_id', 'event', 'status', 'created_at'],
			{ id: 'TEXT', user_id: 'TEXT', event: 'TEXT', status: 'INTEGER', created_at: 'INTEGER' },
			rows,
		)
		expect(lenses.created_at).toEqual({ format: 'epoch_ms', mode: 'utc', auto: true })
		expect(lenses.id).toEqual({ format: 'tid', mode: 'raw', auto: true })
		expect(lenses.user_id).toEqual({ format: 'tid', mode: 'raw', auto: true })
		expect(lenses.status).toBeUndefined()
		expect(lenses.event).toBeUndefined()
	})

	test('autoDecodeSingleValue does not misclassify small integers as timestamps', () => {
		expect(autoDecodeSingleValue(200, 'status')).toBeNull()
		expect(autoDecodeSingleValue(42, 'count')).toBeNull()
		expect(autoDecodeSingleValue(1795719055385, 'created_at')?.format).toBe('epoch_ms')
	})
})

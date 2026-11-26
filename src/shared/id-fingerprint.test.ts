// Unit tests for statistical ID-format fingerprinting, prefix boundary detection, and candidate target scoring.
import { describe, expect, test } from 'bun:test'
import { fingerprintValues, mergeFingerprints, scoreCandidateTarget, signaturesCompatible } from './id-fingerprint.ts'

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz'

function deterministicBase32(seed: number, len: number): string {
	let s = seed >>> 0
	let out = ''
	for (let i = 0; i < len; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0
		out += BASE32[(s >>> 20) & 31]!
	}
	return out
}

function deterministicUuidV4(seed: number): string {
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

function deterministicUuidV7SameMs(seed: number): string {
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
	// Shared millisecond timestamp prefix `0193a4f2-7c00-7...`
	return `0193a4f2-7c00-7${pick(3)}-9${pick(3)}-${pick(12)}`
}

function deterministicUlidSameMinute(seed: number): string {
	// Shared 10-char timestamp `01J9X4K2M0` + 16 random Crockford base32 chars
	return `01J9X4K2M0${deterministicBase32(seed, 16).toUpperCase()}`
}

describe('id-fingerprint', () => {
	test('detects delimited typed IDs (Stripe / Crockford style)', () => {
		const ids = Array.from({ length: 12 }, (_, i) => `usr_${deterministicBase32(i + 1, 14)}`)
		const fp = fingerprintValues(ids, { isPk: true })
		expect(fp.signature.kind).toBe('typed-delim')
		expect(fp.signature.prefix).toBe('usr_')
		expect(fp.signature.estimatedBits).toBeGreaterThanOrEqual(50)
	})

	test('detects multi-segment delimited prefixes like pk_live_', () => {
		const ids = Array.from({ length: 10 }, (_, i) => `pk_live_${deterministicBase32(i + 10, 16)}`)
		const fp = fingerprintValues(ids, { isPk: true })
		expect(fp.signature.kind).toBe('typed-delim')
		expect(fp.signature.prefix).toBe('pk_live_')
	})

	test('detects delimiterless single-char typed IDs (e.g. u + Crockford base32)', () => {
		const ids = Array.from({ length: 12 }, (_, i) => `u${deterministicBase32(i + 100, 12)}`)
		const fp = fingerprintValues(ids, { isPk: true })
		expect(fp.signature.kind).toBe('typed-nodelim')
		expect(fp.signature.prefix).toBe('u')
		expect(fp.signature.charset).toBe('base32')
	})

	test('detects delimiterless alpha prefix + timestamp-prefixed Crockford IDs without swallowing timestamp digits', () => {
		// All rows generated on same day start with `u01k8` — must extract prefix `u`, NOT `u01k8`!
		const ids = Array.from({ length: 12 }, (_, i) => `u01k8${deterministicBase32(i + 200, 10)}`)
		const fp = fingerprintValues(ids, { isPk: true })
		expect(fp.signature.kind).toBe('typed-nodelim')
		expect(fp.signature.prefix).toBe('u')
	})

	test('detects delimiterless single-char prefix + ULID (27 chars)', () => {
		const ids = Array.from({ length: 10 }, (_, i) => `u${deterministicUlidSameMinute(i + 50)}`)
		const fp = fingerprintValues(ids, { isPk: true })
		expect(fp.signature.kind).toBe('typed-nodelim')
		expect(fp.signature.prefix).toBe('u')
		expect(fp.signature.charset).toBe('ulid')
	})

	test('defeats ULID and UUIDv7 shared timestamp-prefix traps', () => {
		const ulids = Array.from({ length: 20 }, (_, i) => deterministicUlidSameMinute(i + 1))
		const ulidFp = fingerprintValues(ulids, { isPk: true })
		expect(ulidFp.signature.kind).toBe('ulid')
		expect(ulidFp.signature.prefix).toBeUndefined()

		const uuid7s = Array.from({ length: 20 }, (_, i) => deterministicUuidV7SameMs(i + 1))
		const uuid7Fp = fingerprintValues(uuid7s, { isPk: true })
		expect(uuid7Fp.signature.kind).toBe('uuid')
		expect(uuid7Fp.signature.prefix).toBeUndefined()

		const uuid4s = Array.from({ length: 20 }, (_, i) => deterministicUuidV4(i + 1))
		const uuid4Fp = fingerprintValues(uuid4s, { isPk: true })
		expect(uuid4Fp.signature.kind).toBe('uuid')
	})

	test('detects polymorphic columns for both delimited and delimiterless typed IDs', () => {
		const mixedDelim = [
			...Array.from({ length: 6 }, (_, i) => `usr_${deterministicBase32(i + 1, 12)}`),
			...Array.from({ length: 6 }, (_, i) => `org_${deterministicBase32(i + 100, 12)}`),
		]
		const fpDelim = fingerprintValues(mixedDelim)
		expect(fpDelim.signature.kind).toBe('polymorphic')
		expect(fpDelim.signature.prefixes).toEqual(['usr_', 'org_'])

		const mixedNoDelim = [
			...Array.from({ length: 6 }, (_, i) => `u${deterministicBase32(i + 1, 12)}`),
			...Array.from({ length: 6 }, (_, i) => `o${deterministicBase32(i + 100, 12)}`),
		]
		const fpNoDelim = fingerprintValues(mixedNoDelim)
		expect(fpNoDelim.signature.kind).toBe('polymorphic')
		expect(fpNoDelim.signature.prefixes).toEqual(['o', 'u'])
	})

	test('rejects integers, numeric strings, timestamps, emails, URLs, slugs, and short enums', () => {
		expect(fingerprintValues([1, 2, 3, 4, 5, 6]).signature.kind).toBe('non-id')
		expect(fingerprintValues(['100001', '100002', '100003', '100004']).signature.kind).toBe('non-id')
		expect(
			fingerprintValues([
				'2026-11-26T10:00:00Z',
				'2026-11-26T11:00:00Z',
				'2026-11-26T12:00:00Z',
				'2026-11-26T13:00:00Z',
			]).signature.kind,
		).toBe('non-id')
		expect(fingerprintValues(['alice@example.com', 'bob@example.com', 'carol@example.com']).signature.kind).toBe(
			'non-id',
		)
		expect(fingerprintValues(['https://example.com/a', 'https://example.com/b']).signature.kind).toBe('non-id')
		expect(fingerprintValues(['active', 'pending', 'closed', 'archived']).signature.kind).toBe('non-id')
		expect(fingerprintValues(['my-first-blog-post', 'another-nice-article', 'hello-world-story']).signature.kind).toBe(
			'non-id',
		)
	})

	test('matches single-distinct-value FK page against learned delimiterless PK signature', () => {
		const userPks = Array.from({ length: 10 }, (_, i) => `u${deterministicBase32(i + 1, 12)}`)
		const userFp = fingerprintValues(userPks, { isPk: true })
		expect(userFp.signature.kind).toBe('typed-nodelim')
		expect(userFp.signature.prefix).toBe('u')

		// 50 messages all sent by 1 user -> only 1 distinct value on the page
		const senderVals = Array.from({ length: 50 }, () => userPks[0]!)
		const senderFp = fingerprintValues(senderVals, { isPk: false })
		expect(senderFp.signature.kind).toBe('opaque-id')
		expect(signaturesCompatible(senderFp.signature, senderFp.samples, userFp.signature)).toBe(true)

		// Incompatible prefix from orders does NOT match
		const orderId = `o${deterministicBase32(999, 12)}`
		const orderFp = fingerprintValues([orderId], { isPk: false })
		expect(signaturesCompatible(orderFp.signature, orderFp.samples, userFp.signature)).toBe(false)
	})

	test('mergeFingerprints catches polymorphic drift across pages', () => {
		const page1 = Array.from({ length: 6 }, (_, i) => `usr_${deterministicBase32(i + 1, 12)}`)
		const fp1 = mergeFingerprints(null, page1)
		expect(fp1.signature.kind).toBe('typed-delim')
		expect(fp1.signature.prefix).toBe('usr_')

		const page2 = Array.from({ length: 6 }, (_, i) => `org_${deterministicBase32(i + 50, 12)}`)
		const fp2 = mergeFingerprints(fp1, page2)
		expect(fp2.signature.kind).toBe('polymorphic')
	})

	test('scoreCandidateTarget prioritizes learned PK signature, prefix affinity, and role-noun priors', () => {
		const userIds = Array.from({ length: 8 }, (_, i) => `u${deterministicBase32(i + 1, 12)}`)
		const userSig = fingerprintValues(userIds, { isPk: true }).signature
		const orgIds = Array.from({ length: 8 }, (_, i) => `o${deterministicBase32(i + 1, 12)}`)
		const orgSig = fingerprintValues(orgIds, { isPk: true }).signature

		const sUser = scoreCandidateTarget(
			'messages',
			'sender',
			userSig,
			userIds,
			{ table: 'users', pkColumn: 'id', pkType: 'TEXT', rowCount: 100 },
			userSig,
			2,
		)
		const sOrg = scoreCandidateTarget(
			'messages',
			'sender',
			userSig,
			userIds,
			{ table: 'orgs', pkColumn: 'id', pkType: 'TEXT', rowCount: 20 },
			orgSig,
			1,
		)
		expect(sUser.score).toBeGreaterThan(250)
		expect(sOrg.score).toBeLessThan(-500)
	})
})

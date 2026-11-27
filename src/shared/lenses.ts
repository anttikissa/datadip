// Smart Value Lenses: real-time detection and timestamp decoding for Unix epochs, Crockford tid, UUIDv7/v1, ULID, KSUID, ObjectId, and Snowflakes.

export type LensFormat =
	| 'epoch_ms'
	| 'epoch_s'
	| 'epoch_us'
	| 'epoch_ns'
	| 'tid'
	| 'uuidv7'
	| 'uuidv1'
	| 'ulid'
	| 'ksuid'
	| 'objectid'
	| 'snowflake_twitter'
	| 'snowflake_discord'
	| 'cocoa_s'

export type LensDisplayMode = 'raw' | 'utc' | 'local' | 'relative' | 'inline'

export interface DecodedLensValue {
	format: LensFormat
	formatLabel: string
	shortTag: string
	ms: number
	utc: string
	local: string
	shortDate: string
	relative: string
	isTimeBearingId: boolean
}

export interface ColumnLensConfig {
	format: LensFormat | 'off'
	mode: LensDisplayMode
	auto: boolean
}

export const LENS_FORMAT_META: Record<LensFormat, { label: string; shortTag: string; isId: boolean }> = {
	epoch_ms: { label: 'Unix ms', shortTag: 'ms', isId: false },
	epoch_s: { label: 'Unix sec', shortTag: 'sec', isId: false },
	epoch_us: { label: 'Unix µs', shortTag: 'µs', isId: false },
	epoch_ns: { label: 'Unix ns', shortTag: 'ns', isId: false },
	tid: { label: 'Crockford tid', shortTag: 'tid', isId: true },
	uuidv7: { label: 'UUID v7', shortTag: 'v7', isId: true },
	uuidv1: { label: 'UUID v1', shortTag: 'v1', isId: true },
	ulid: { label: 'ULID', shortTag: 'ulid', isId: true },
	ksuid: { label: 'KSUID', shortTag: 'ksuid', isId: true },
	objectid: { label: 'ObjectId', shortTag: 'oid', isId: true },
	snowflake_twitter: { label: 'Snowflake (Twitter)', shortTag: 'snow', isId: true },
	snowflake_discord: { label: 'Snowflake (Discord)', shortTag: 'disc', isId: true },
	cocoa_s: { label: 'Apple / Cocoa epoch', shortTag: 'cocoa', isId: false },
}

const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1) // 946684800000
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1) // 4102444800000
const MIN_ID_MS = Date.UTC(2010, 0, 1)
const MIN_TIGHT_EPOCH_MS = Date.UTC(2015, 0, 1)
const MAX_TIGHT_EPOCH_MS = Date.UTC(2035, 0, 1)

// Lenient Crockford base32 lookup (case-insensitive, O->0, I/L->1)
const CROCKFORD_VAL = new Int8Array(128).fill(-1)
const CROCKFORD_CHARS = '0123456789abcdefghjkmnpqrstvwxyz'
for (let i = 0; i < CROCKFORD_CHARS.length; i++) {
	const lower = CROCKFORD_CHARS.charCodeAt(i)
	const upper = CROCKFORD_CHARS[i]!.toUpperCase().charCodeAt(0)
	CROCKFORD_VAL[lower] = i
	CROCKFORD_VAL[upper] = i
}
CROCKFORD_VAL['o'.charCodeAt(0)] = 0
CROCKFORD_VAL['O'.charCodeAt(0)] = 0
CROCKFORD_VAL['i'.charCodeAt(0)] = 1
CROCKFORD_VAL['I'.charCodeAt(0)] = 1
CROCKFORD_VAL['l'.charCodeAt(0)] = 1
CROCKFORD_VAL['L'.charCodeAt(0)] = 1

function decodeCrockford(str: string): number | null {
	let n = 0
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		if (code >= 128) return null
		const v = CROCKFORD_VAL[code]!
		if (v < 0) return null
		n = n * 32 + v
	}
	return n
}

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE62_VAL = new Int8Array(128).fill(-1)
for (let i = 0; i < BASE62_CHARS.length; i++) {
	BASE62_VAL[BASE62_CHARS.charCodeAt(i)] = i
}

function decodeBase62BigInt(str: string): bigint | null {
	let n = 0n
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		if (code >= 128) return null
		const v = BASE62_VAL[code]!
		if (v < 0) return null
		n = n * 62n + BigInt(v)
	}
	return n
}

const UUID_V7_RE = /^(?:[a-z][a-z0-9]{0,15}_)?([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V1_RE =
	/^(?:[a-z][a-z0-9]{0,15}_)?([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ULID_RE = /^(?:[a-z][a-z0-9]{0,15}_)?([0-7][0-9a-hjkmnp-tv-z]{9})[0-9a-hjkmnp-tv-z]{16}$/i
const KSUID_RE = /^(?:[a-z][a-z0-9]{0,15}_)?([0-9A-Za-z]{27})$/
const OBJECTID_RE = /^([0-9a-f]{8})[0-9a-f]{16}$/i
// Crockford tid: 1 type letter + 9 timestamp chars + 2..6 random chars (total 12..16)
const TID_RE = /^([a-z])([0-9a-hjkmnp-tv-zilo]{9})([0-9a-hjkmnp-tv-zilo]{2,6})$/i

const UUID_V1_EPOCH_DIFF_100NS = 122192928000000000n
const KSUID_EPOCH_SEC = 1400000000
const TWITTER_SNOWFLAKE_EPOCH_MS = 1288834974657n
const DISCORD_SNOWFLAKE_EPOCH_MS = 1420070400000n
const COCOA_EPOCH_OFFSET_SEC = 978307200

const TIME_COL_NAME_HINT =
	/(^|_)(at|time|ts|timestamp|date|created|updated|deleted|seen|expires|expiry|since|until|start|end|started|ended|epoch|ms|sec|seconds|millis|modified|visited|logged|sent|received|published|born|birth|last|first)(_|$)/i
const ID_COL_NAME_HINT = /(^|_)(id|pk|key|uuid|ulid|guid|oid|tid|ref|token|cursor)$/i

function toNumeric(val: unknown): number | null {
	if (typeof val === 'number') return Number.isFinite(val) ? val : null
	if (typeof val === 'bigint') return Number(val)
	if (typeof val === 'string') {
		const t = val.trim()
		if (!/^-?\d+(\.\d+)?$/.test(t)) return null
		const n = Number(t)
		return Number.isFinite(n) ? n : null
	}
	return null
}

function toBigInt(val: unknown): bigint | null {
	if (typeof val === 'bigint') return val
	if (typeof val === 'number' && Number.isSafeInteger(val)) return BigInt(val)
	if (typeof val === 'string') {
		const t = val.trim()
		if (!/^\d{1,20}$/.test(t)) return null
		try {
			return BigInt(t)
		} catch {
			return null
		}
	}
	return null
}

export function decodeWithFormat(value: unknown, format: LensFormat): number | null {
	if (value === null || value === undefined || value === '') return null

	if (format === 'epoch_ms') {
		const n = toNumeric(value)
		if (n === null || n < MIN_PLAUSIBLE_MS || n > MAX_PLAUSIBLE_MS) return null
		return Math.round(n)
	}
	if (format === 'epoch_s') {
		const n = toNumeric(value)
		if (n === null) return null
		const ms = Math.round(n * 1000)
		return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'epoch_us') {
		const n = toNumeric(value)
		if (n === null) return null
		const ms = Math.round(n / 1000)
		return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'epoch_ns') {
		const bi = toBigInt(value)
		if (bi === null) return null
		const ms = Number(bi / 1_000_000n)
		return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'cocoa_s') {
		const n = toNumeric(value)
		if (n === null || n < 0) return null
		const ms = Math.round((n + COCOA_EPOCH_OFFSET_SEC) * 1000)
		return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'snowflake_twitter' || format === 'snowflake_discord') {
		const bi = toBigInt(value)
		if (bi === null || bi <= 0n) return null
		const epoch = format === 'snowflake_twitter' ? TWITTER_SNOWFLAKE_EPOCH_MS : DISCORD_SNOWFLAKE_EPOCH_MS
		const ms = Number((bi >> 22n) + epoch)
		return ms >= MIN_ID_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}

	if (typeof value !== 'string') return null
	const str = value.trim()
	if (!str) return null

	if (format === 'tid') {
		const m = TID_RE.exec(str)
		if (!m) return null
		const ms = decodeCrockford(m[2]!)
		if (ms === null || ms < MIN_ID_MS || ms > MAX_PLAUSIBLE_MS) return null
		return ms
	}
	if (format === 'uuidv7') {
		const m = UUID_V7_RE.exec(str)
		if (!m) return null
		const ms = Number.parseInt(m[1]! + m[2]!, 16)
		return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'uuidv1') {
		const m = UUID_V1_RE.exec(str)
		if (!m) return null
		const timeHex = m[3]! + m[2]! + m[1]!
		const ticks = BigInt('0x' + timeHex)
		if (ticks < UUID_V1_EPOCH_DIFF_100NS) return null
		const ms = Number((ticks - UUID_V1_EPOCH_DIFF_100NS) / 10_000n)
		return ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'ulid') {
		const m = ULID_RE.exec(str)
		if (!m) return null
		const ms = decodeCrockford(m[1]!)
		return ms !== null && ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'ksuid') {
		const m = KSUID_RE.exec(str)
		if (!m) return null
		const full = decodeBase62BigInt(m[1]!)
		if (full === null) return null
		const sec = Number(full >> 128n) + KSUID_EPOCH_SEC
		const ms = sec * 1000
		return ms >= Date.UTC(2014, 0, 1) && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}
	if (format === 'objectid') {
		const m = OBJECTID_RE.exec(str)
		if (!m) return null
		const ms = Number.parseInt(m[1]!, 16) * 1000
		return ms >= MIN_ID_MS && ms <= MAX_PLAUSIBLE_MS ? ms : null
	}

	return null
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n)
}

export function formatUtcTimestamp(ms: number): string {
	const d = new Date(ms)
	if (Number.isNaN(d.getTime())) return ''
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}

export function formatLocalTimestamp(ms: number): string {
	const d = new Date(ms)
	if (Number.isNaN(d.getTime())) return ''
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatShortDate(ms: number, nowMs = Date.now()): string {
	const d = new Date(ms)
	if (Number.isNaN(d.getTime())) return ''
	const now = new Date(nowMs)
	const sameYear = d.getUTCFullYear() === now.getUTCFullYear()
	const base = `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`
	return sameYear ? base : `${base}, ${d.getUTCFullYear()}`
}

export function formatRelativeTime(ms: number, nowMs = Date.now()): string {
	const diffSec = Math.round((nowMs - ms) / 1000)
	const abs = Math.abs(diffSec)
	const suffix = diffSec >= 0 ? 'ago' : 'from now'
	if (abs < 5) return 'just now'
	if (abs < 60) return `${abs}s ${suffix}`
	const mins = Math.round(abs / 60)
	if (mins < 60) return `${mins}m ${suffix}`
	const hrs = Math.round(abs / 3600)
	if (hrs < 36) return `${hrs}h ${suffix}`
	const days = Math.round(abs / 86400)
	if (days < 45) return `${days}d ${suffix}`
	const months = Math.round(days / 30)
	if (months < 18) return `${months}mo ${suffix}`
	const years = (days / 365).toFixed(1).replace(/\.0$/, '')
	return `${years}y ${suffix}`
}

export function buildDecodedLens(format: LensFormat, ms: number, nowMs = Date.now()): DecodedLensValue {
	const meta = LENS_FORMAT_META[format]
	return {
		format,
		formatLabel: meta.label,
		shortTag: meta.shortTag,
		ms,
		utc: formatUtcTimestamp(ms),
		local: formatLocalTimestamp(ms),
		shortDate: formatShortDate(ms, nowMs),
		relative: formatRelativeTime(ms, nowMs),
		isTimeBearingId: meta.isId,
	}
}

export function decodeCellWithLens(value: unknown, format: LensFormat, nowMs = Date.now()): DecodedLensValue | null {
	const ms = decodeWithFormat(value, format)
	if (ms === null) return null
	return buildDecodedLens(format, ms, nowMs)
}

// Single-value auto-detection (used by RowInspector & CellViewer where a single cell is inspected).
export function autoDecodeSingleValue(value: unknown, columnName = '', nowMs = Date.now()): DecodedLensValue | null {
	if (value === null || value === undefined || value === '') return null

	// Unambiguous string ID formats first
	if (typeof value === 'string') {
		for (const fmt of ['uuidv7', 'uuidv1', 'ulid', 'tid', 'ksuid'] as const) {
			const ms = decodeWithFormat(value, fmt)
			if (ms !== null) return buildDecodedLens(fmt, ms, nowMs)
		}
		if (ID_COL_NAME_HINT.test(columnName) || columnName === '') {
			const oidMs = decodeWithFormat(value, 'objectid')
			if (oidMs !== null) return buildDecodedLens('objectid', oidMs, nowMs)
		}
	}

	// Numeric Unix timestamps
	const n = toNumeric(value)
	if (n !== null) {
		const isTimeCol = TIME_COL_NAME_HINT.test(columnName)
		if (n >= 1e18 && n <= 4.1e18) {
			const ms = decodeWithFormat(value, 'epoch_ns')
			if (ms !== null) return buildDecodedLens('epoch_ns', ms, nowMs)
		}
		if (n >= 1e15 && n <= 4.1e15) {
			const ms = decodeWithFormat(value, 'epoch_us')
			if (ms !== null) return buildDecodedLens('epoch_us', ms, nowMs)
		}
		if (n >= MIN_PLAUSIBLE_MS && n <= MAX_PLAUSIBLE_MS) {
			if (isTimeCol || (n >= MIN_TIGHT_EPOCH_MS && n <= MAX_TIGHT_EPOCH_MS)) {
				return buildDecodedLens('epoch_ms', Math.round(n), nowMs)
			}
		}
		if (n >= MIN_PLAUSIBLE_MS / 1000 && n <= MAX_PLAUSIBLE_MS / 1000) {
			if (isTimeCol) return buildDecodedLens('epoch_s', Math.round(n * 1000), nowMs)
		}
	}
	return null
}

// Column-level auto-detection across visible rows: high precision so ordinary integers/strings never trigger false lenses.
export function detectColumnLenses(
	columns: string[],
	columnTypes: Record<string, string>,
	rows: Record<string, unknown>[],
): Record<string, ColumnLensConfig> {
	const out: Record<string, ColumnLensConfig> = {}
	if (rows.length === 0) return out

	const sampleRows = rows.slice(0, 60)

	for (const col of columns) {
		const values: unknown[] = []
		for (const r of sampleRows) {
			const v = r[col]
			if (v !== null && v !== undefined && v !== '') values.push(v)
		}
		if (values.length === 0) continue

		const colType = columnTypes[col] ?? ''
		const isTimeName = TIME_COL_NAME_HINT.test(col)
		const isIdName = ID_COL_NAME_HINT.test(col)

		// Skip columns already stored as SQL TIMESTAMP / DATE strings
		if (/\b(timestamp|timestamptz|datetime|date)\b/i.test(colType) && typeof values[0] === 'string') {
			continue
		}

		// 1. Check numeric Unix timestamps
		const numericMatches = (fmt: 'epoch_ns' | 'epoch_us' | 'epoch_ms' | 'epoch_s', tight: boolean): boolean => {
			let hits = 0
			for (const v of values) {
				const ms = decodeWithFormat(v, fmt)
				if (ms === null) continue
				if (tight && (ms < MIN_TIGHT_EPOCH_MS || ms > MAX_TIGHT_EPOCH_MS)) continue
				hits++
			}
			return hits / values.length >= 0.85
		}

		if (numericMatches('epoch_ns', false)) {
			out[col] = { format: 'epoch_ns', mode: 'utc', auto: true }
			continue
		}
		if (numericMatches('epoch_us', false)) {
			out[col] = { format: 'epoch_us', mode: 'utc', auto: true }
			continue
		}
		if (numericMatches('epoch_ms', !isTimeName)) {
			out[col] = { format: 'epoch_ms', mode: 'utc', auto: true }
			continue
		}
		if (isTimeName && numericMatches('epoch_s', false)) {
			out[col] = { format: 'epoch_s', mode: 'utc', auto: true }
			continue
		}

		// 2. Check time-bearing string IDs (default display mode: 'raw' with tooltip + header pill, or toggle to 'inline' / 'utc')
		const stringVals = values.filter((v): v is string => typeof v === 'string')
		if (stringVals.length / values.length < 0.85) continue

		const checkIdFmt = (fmt: 'uuidv7' | 'uuidv1' | 'ulid' | 'tid' | 'ksuid' | 'objectid'): boolean => {
			let hits = 0
			for (const s of stringVals) {
				if (decodeWithFormat(s, fmt) !== null) hits++
			}
			if (hits / stringVals.length < 0.85) return false
			// Extra guard for `tid`: ensure all matching tids share a consistent length or single-letter prefix style,
			// preventing random 12-char English words from ever matching.
			if (fmt === 'tid') {
				let withDigit = 0
				for (const s of stringVals) {
					if (/\d/.test(s)) withDigit++
				}
				if (withDigit / stringVals.length < 0.85) return false
			}
			return true
		}

		let detectedId: LensFormat | null = null
		if (checkIdFmt('uuidv7')) detectedId = 'uuidv7'
		else if (checkIdFmt('uuidv1')) detectedId = 'uuidv1'
		else if (checkIdFmt('ulid')) detectedId = 'ulid'
		else if (checkIdFmt('tid')) detectedId = 'tid'
		else if (isIdName && checkIdFmt('ksuid')) detectedId = 'ksuid'
		else if (isIdName && checkIdFmt('objectid')) detectedId = 'objectid'

		if (detectedId) {
			out[col] = { format: detectedId, mode: 'raw', auto: true }
		}
	}

	return out
}

export function formatCellByLensMode(rawText: string, decoded: DecodedLensValue, mode: LensDisplayMode): string {
	switch (mode) {
		case 'utc':
			return decoded.utc
		case 'local':
			return decoded.local
		case 'relative':
			return decoded.relative
		case 'inline':
			return `${rawText} · ${decoded.shortDate}`
		default:
			return rawText
	}
}

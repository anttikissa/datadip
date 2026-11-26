// Statistical ID-format fingerprinting, prefix boundary detection, and candidate target ranking for passive FK learning.

export type IdFormatKind = 'uuid' | 'ulid' | 'typed-delim' | 'typed-nodelim' | 'opaque-id' | 'polymorphic' | 'non-id'

export type IdCharset = 'uuid' | 'ulid' | 'hex' | 'base32' | 'base62' | 'alnum'

export interface ColumnIdSignature {
	kind: IdFormatKind
	prefix?: string
	prefixes?: string[]
	charset: IdCharset
	minLen: number
	maxLen: number
	suffixMinLen: number
	suffixMaxLen: number
	estimatedBits: number
	distinctCount: number
	nonNullCount: number
}

export interface ColumnFingerprint {
	signature: ColumnIdSignature
	samples: string[]
}

export interface CandidateTargetInfo {
	table: string
	pkColumn: string
	pkType: string
	rowCount: number | null
	rowCountEstimated?: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i
const NUMERIC_RE = /^[+-]?\d+(?:\.\d+)?$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}|$)/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const URL_RE = /^(?:https?:\/\/|ftp:\/\/|mailto:|\/[^\s]*\/)/i
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const HEX_RE = /^[0-9a-f]+$/i
const CROCKFORD_RE = /^[0-9a-hjkmnp-tv-z]+$/i
const BASE62_RE = /^[0-9A-Za-z]+$/
const ALNUM_URLSAFE_RE = /^[0-9A-Za-z_-]+$/
const DELIM_TYPED_RE = /^([a-zA-Z][a-zA-Z0-9]{0,15}(?:[_:\-.][a-zA-Z][a-zA-Z0-9]{0,11})?[_:\-.])([A-Za-z0-9_-]{6,64})$/
const ALPHA_LEAD_RE = /^([a-zA-Z]{1,6})([A-Za-z0-9]{6,64})$/

const MAX_SAMPLES = 32

const ROLE_TO_USER_WORDS = new Set([
	'author',
	'sender',
	'recipient',
	'receiver',
	'creator',
	'owner',
	'assignee',
	'reviewer',
	'reporter',
	'approver',
	'actor',
	'member',
	'manager',
	'supervisor',
	'admin',
	'editor',
	'moderator',
	'buyer',
	'seller',
	'requester',
	'follower',
	'following',
	'blocker',
	'inviter',
	'issuer',
	'payer',
	'payee',
	'operator',
	'handler',
	'agent',
	'staff',
	'employee',
	'teacher',
	'instructor',
	'student',
	'doctor',
	'patient',
	'host',
	'guest',
	'lead',
	'contact',
	'submitter',
	'publisher',
	'subscriber',
	'created_by',
	'updated_by',
	'modified_by',
	'deleted_by',
	'edited_by',
	'approved_by',
	'reviewed_by',
	'assigned_to',
	'assigned_by',
	'invited_by',
	'sent_by',
	'owned_by',
	'managed_by',
	'handled_by',
	'reported_by',
	'resolved_by',
	'closed_by',
	'opened_by',
	'verified_by',
	'published_by',
	'uploaded_by',
	'from_user',
	'to_user',
	'by_user',
])

const USER_TABLE_NAMES = new Set([
	'user',
	'users',
	'account',
	'accounts',
	'member',
	'members',
	'person',
	'persons',
	'people',
	'employee',
	'employees',
	'profile',
	'profiles',
	'actor',
	'actors',
	'principal',
	'principals',
	'admin',
	'admins',
	'staff',
	'customer',
	'customers',
	'agent',
	'agents',
])

const SELF_REF_NAMES = new Set([
	'parent',
	'root',
	'ancestor',
	'reply_to',
	'in_reply_to',
	'replied_to',
	'original',
	'source',
	'prev',
	'previous',
	'next',
	'supersedes',
	'replaced_by',
	'duplicate_of',
	'merged_into',
	'cloned_from',
	'forked_from',
	'base',
	'head',
])

const ABBREV_SYNONYMS: Record<string, string[]> = {
	org: ['organization', 'organizations', 'org', 'orgs'],
	dept: ['department', 'departments', 'dept', 'depts'],
	emp: ['employee', 'employees', 'emp', 'emps'],
	cust: ['customer', 'customers', 'cust'],
	acct: ['account', 'accounts', 'acct'],
	acc: ['account', 'accounts'],
	usr: ['user', 'users', 'usr'],
	msg: ['message', 'messages', 'msg', 'msgs'],
	conv: ['conversation', 'conversations', 'conv'],
	convo: ['conversation', 'conversations'],
	proj: ['project', 'projects', 'proj'],
	repo: ['repository', 'repositories', 'repo', 'repos'],
	cat: ['category', 'categories', 'cat', 'cats'],
	doc: ['document', 'documents', 'doc', 'docs'],
	inv: ['invoice', 'invoices', 'inv'],
	tx: ['transaction', 'transactions', 'tx', 'txs'],
	txn: ['transaction', 'transactions', 'txn', 'txns'],
	ord: ['order', 'orders', 'ord'],
	prod: ['product', 'products', 'prod'],
	sub: ['subscription', 'subscriptions', 'sub', 'subs'],
	ws: ['workspace', 'workspaces', 'ws'],
	env: ['environment', 'environments', 'env', 'envs'],
	cfg: ['config', 'configs', 'configuration', 'configurations'],
	req: ['request', 'requests', 'req'],
	res: ['response', 'responses', 'resource', 'resources'],
	img: ['image', 'images', 'img'],
	att: ['attachment', 'attachments'],
	notif: ['notification', 'notifications'],
	perm: ['permission', 'permissions'],
	sess: ['session', 'sessions'],
	auth: ['auth', 'user', 'users', 'account', 'accounts'],
	loc: ['location', 'locations'],
	addr: ['address', 'addresses'],
	comp: ['company', 'companies'],
	co: ['company', 'companies'],
	ch: ['channel', 'channels', 'charge', 'charges'],
	tkt: ['ticket', 'tickets'],
	pkg: ['package', 'packages'],
}

function emptyNonId(nonNullCount = 0, distinctCount = 0): ColumnIdSignature {
	return {
		kind: 'non-id',
		charset: 'alnum',
		minLen: 0,
		maxLen: 0,
		suffixMinLen: 0,
		suffixMaxLen: 0,
		estimatedBits: 0,
		distinctCount,
		nonNullCount,
	}
}

function shannonEntropy(chars: string): number {
	if (chars.length === 0) return 0
	const freq = new Map<string, number>()
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!
		freq.set(ch, (freq.get(ch) ?? 0) + 1)
	}
	let h = 0
	const n = chars.length
	for (const c of freq.values()) {
		const p = c / n
		h -= p * Math.log2(p)
	}
	return h
}

function positionEntropy(values: string[], pos: number): number {
	let col = ''
	for (const v of values) {
		if (pos < v.length) col += v[pos]!
	}
	return shannonEntropy(col)
}

function classifyCharset(values: string[]): { charset: IdCharset; bitsPerChar: number } {
	if (values.every((v) => UUID_RE.test(v))) return { charset: 'uuid', bitsPerChar: 4 }
	if (values.every((v) => ULID_RE.test(v))) return { charset: 'ulid', bitsPerChar: 5 }
	if (values.every((v) => HEX_RE.test(v))) return { charset: 'hex', bitsPerChar: 4 }
	if (values.every((v) => CROCKFORD_RE.test(v))) {
		const hasUpperAndLower = values.some((v) => /[a-z]/.test(v)) && values.some((v) => /[A-Z]/.test(v))
		return hasUpperAndLower ? { charset: 'base62', bitsPerChar: 5.95 } : { charset: 'base32', bitsPerChar: 5 }
	}
	if (values.every((v) => BASE62_RE.test(v))) {
		const hasUpperAndLower = values.some((v) => /[a-z]/.test(v)) && values.some((v) => /[A-Z]/.test(v))
		return hasUpperAndLower ? { charset: 'base62', bitsPerChar: 5.95 } : { charset: 'alnum', bitsPerChar: 5.17 }
	}
	return { charset: 'alnum', bitsPerChar: 5.2 }
}

function isDisqualifiedString(s: string): boolean {
	if (s.length < 6 || s.length > 128) return true
	if (/\s/.test(s)) return true
	if (NUMERIC_RE.test(s)) return true
	if (ISO_DATE_RE.test(s)) return true
	if (EMAIL_RE.test(s)) return true
	if (URL_RE.test(s)) return true
	if (SEMVER_RE.test(s)) return true
	if (IPV4_RE.test(s)) return true
	if (s.startsWith('{') || s.startsWith('[')) return true
	return false
}

// Reject prose/slug/enum strings that have no digit/hex/mixed-case randomness characteristics.
function looksLikeRandomPayload(suffixes: string[]): { ok: boolean; bits: number; charset: IdCharset } {
	if (suffixes.length === 0) return { ok: false, bits: 0, charset: 'alnum' }
	const { charset, bitsPerChar } = classifyCharset(suffixes)
	let minLen = Infinity
	let maxLen = 0
	for (const s of suffixes) {
		if (s.length < minLen) minLen = s.length
		if (s.length > maxLen) maxLen = s.length
	}
	if (minLen < 6) return { ok: false, bits: 0, charset }

	if (charset === 'uuid') return { ok: true, bits: 122, charset }
	if (charset === 'ulid') return { ok: true, bits: 80, charset }

	// Reject plain numeric suffixes (e.g. "INV-0001", "user_123456"): sequential numbers have huge collision risk unless prefixed?
	// Wait: prefixed sequential IDs like "usr_000123" are actually valid typed IDs ONLY if delimited and long enough,
	// whereas delimiterless "v123456" is risky. Still require either digits+letters OR hex OR mixed-case OR long alphanumeric.
	const allDigits = suffixes.every((s) => /^\d+$/.test(s))
	if (allDigits) {
		// Pure numeric suffix is risky for accidental overlap (e.g. order_1, item_1 -> no, wait: distinct prefix prevents cross-table collision,
		// so delimited `usr_10042` has prefix protection, handled specifically by caller; here return low bits).
		return { ok: false, bits: Math.round(minLen * 3.32), charset: 'alnum' }
	}

	// Reject pure lowercase English words / hyphenated slugs (no digits, no uppercase, contains hyphens/underscores separating words).
	const hasDigit = suffixes.some((s) => /\d/.test(s))
	const hasMixedCase = suffixes.some((s) => /[a-z]/.test(s) && /[A-Z]/.test(s))
	const hasInternalDelim = suffixes.some((s) => /[-_]/.test(s))
	if (!hasDigit && !hasMixedCase) {
		// Pure lowercase (or pure uppercase) letters only: could be plain words/enums ("active_user", "pending_review")
		// unless it's pure hex (which contains digits almost always when len >= 10) or very high entropy long token.
		if (hasInternalDelim || minLen < 12) return { ok: false, bits: 0, charset }
	}

	// Single-string character entropy check (rejects "aaaaaaaa", "abababab", repetitive placeholders).
	const avgStrEntropy = suffixes.reduce((acc, s) => acc + shannonEntropy(s), 0) / suffixes.length
	if (avgStrEntropy < 2.2) return { ok: false, bits: 0, charset }

	// If multiple distinct suffixes exist, verify cross-row variation (not a constant suffix or tiny 2-value enum).
	let crossRowFactor = 1
	if (suffixes.length >= 4) {
		const samplePositions = Math.min(minLen, 16)
		let posSum = 0
		let varyingPositions = 0
		// Measure tail half as well so timestamp-prefixed IDs (e.g. tid()/KSUID) still score high on random tail!
		for (let p = 0; p < samplePositions; p++) {
			const idx = maxLen <= 16 ? p : Math.floor((p / samplePositions) * minLen)
			const h = positionEntropy(suffixes, idx)
			posSum += h
			if (h >= 1.2) varyingPositions++
		}
		const maxPosH = Math.log2(suffixes.length)
		const meanTailH = posSum / samplePositions
		if (varyingPositions < Math.min(4, Math.floor(minLen / 2))) {
			return { ok: false, bits: 0, charset }
		}
		// Scale estimated bits gently by observed variation ratio
		crossRowFactor = Math.min(1, meanTailH / Math.max(1.5, Math.min(maxPosH * 0.65, bitsPerChar * 0.7)))
	}

	const rawBits = Math.round(minLen * bitsPerChar * Math.max(0.55, crossRowFactor))
	// Require tight length distribution for non-UUID/ULID opaque payloads (typed IDs & random IDs are fixed or near-fixed length).
	if (maxLen - minLen > 6 && !hasDigit) return { ok: false, bits: 0, charset }

	return { ok: rawBits >= 28, bits: rawBits, charset }
}

function longestCommonPrefix(strings: string[]): string {
	if (strings.length === 0) return ''
	let prefix = strings[0]!
	for (let i = 1; i < strings.length; i++) {
		const s = strings[i]!
		let j = 0
		const lim = Math.min(prefix.length, s.length)
		while (j < lim && prefix[j] === s[j]) j++
		prefix = prefix.slice(0, j)
		if (!prefix) break
	}
	return prefix
}

function selectSamples(distinct: string[]): string[] {
	if (distinct.length <= MAX_SAMPLES) return [...distinct]
	const out: string[] = []
	const step = distinct.length / MAX_SAMPLES
	for (let i = 0; i < MAX_SAMPLES; i++) {
		out.push(distinct[Math.floor(i * step)]!)
	}
	return out
}

export function fingerprintValues(rawValues: unknown[], opts?: { isPk?: boolean }): ColumnFingerprint {
	const strings: string[] = []
	let nonNullCount = 0
	for (const v of rawValues) {
		if (v === null || v === undefined) continue
		nonNullCount++
		if (typeof v !== 'string') {
			// Plain numbers/booleans/etc. are never ID-fingerprinted
			return { signature: emptyNonId(nonNullCount, 0), samples: [] }
		}
		const trimmed = v.trim()
		if (!trimmed) continue
		strings.push(trimmed)
	}

	if (strings.length === 0) {
		return { signature: emptyNonId(nonNullCount, 0), samples: [] }
	}

	const distinct = Array.from(new Set(strings))
	if (opts?.isPk && nonNullCount >= 5 && distinct.length / nonNullCount < 0.9) {
		return { signature: emptyNonId(nonNullCount, distinct.length), samples: [] }
	}

	// If more than 10% of distinct values are disqualified (prose, numbers, timestamps, emails, URLs, short strings), reject.
	let validCount = 0
	for (const s of distinct) {
		if (!isDisqualifiedString(s)) validCount++
	}
	if (validCount / distinct.length < 0.9) {
		return { signature: emptyNonId(nonNullCount, distinct.length), samples: [] }
	}

	const valid = distinct.filter((s) => !isDisqualifiedString(s))
	if (valid.length === 0) {
		return { signature: emptyNonId(nonNullCount, distinct.length), samples: [] }
	}

	let minLen = Infinity
	let maxLen = 0
	for (const s of valid) {
		if (s.length < minLen) minLen = s.length
		if (s.length > maxLen) maxLen = s.length
	}
	const samples = selectSamples(valid)

	// 1. Universal format check FIRST: UUID (prevents UUIDv7 timestamp prefix false positives!)
	const uuidCount = valid.filter((s) => UUID_RE.test(s)).length
	if (uuidCount / valid.length >= 0.95) {
		return {
			signature: {
				kind: 'uuid',
				charset: 'uuid',
				minLen: 36,
				maxLen: 36,
				suffixMinLen: 36,
				suffixMaxLen: 36,
				estimatedBits: 122,
				distinctCount: valid.length,
				nonNullCount,
			},
			samples,
		}
	}

	// 2. Universal format check SECOND: ULID (prevents ULID timestamp prefix false positives!)
	const ulidCount = valid.filter((s) => ULID_RE.test(s)).length
	if (ulidCount / valid.length >= 0.95) {
		return {
			signature: {
				kind: 'ulid',
				charset: 'ulid',
				minLen: 26,
				maxLen: 26,
				suffixMinLen: 26,
				suffixMaxLen: 26,
				estimatedBits: 80,
				distinctCount: valid.length,
				nonNullCount,
			},
			samples,
		}
	}

	// 3. Delimited typed ID check: e.g. usr_01J..., u_8k2m..., org-9f3a..., pk_live_...
	const delimGroups = new Map<string, string[]>()
	let delimMatches = 0
	for (const s of valid) {
		const m = DELIM_TYPED_RE.exec(s)
		if (!m) continue
		const pfx = m[1]!
		const suf = m[2]!
		// Avoid falsely splitting dashed UUID-like hex or multi-word slugs like "my-great-post"
		if (pfx.endsWith('-') && /^[a-z]+$/i.test(pfx.slice(0, -1)) && /^[a-z-]+$/i.test(suf)) continue
		delimMatches++
		const arr = delimGroups.get(pfx)
		if (arr) arr.push(suf)
		else delimGroups.set(pfx, [suf])
	}

	if (delimMatches / valid.length >= 0.9) {
		const sortedPrefixes = Array.from(delimGroups.entries()).sort((a, b) => b[1].length - a[1].length)
		const topPrefix = sortedPrefixes[0]!
		const topShare = topPrefix[1].length / delimMatches

		if (topShare >= 0.95) {
			const suffixes = topPrefix[1]
			const payload = looksLikeRandomPayload(suffixes)
			if (payload.ok) {
				let sMin = Infinity
				let sMax = 0
				for (const sf of suffixes) {
					if (sf.length < sMin) sMin = sf.length
					if (sf.length > sMax) sMax = sf.length
				}
				return {
					signature: {
						kind: 'typed-delim',
						prefix: topPrefix[0],
						charset: payload.charset,
						minLen,
						maxLen,
						suffixMinLen: sMin,
						suffixMaxLen: sMax,
						estimatedBits: payload.bits,
						distinctCount: valid.length,
						nonNullCount,
					},
					samples,
				}
			}
		} else if (sortedPrefixes.length >= 2) {
			// Check whether multiple prefixes all carry valid random ID payloads -> polymorphic typed-ID column!
			const validPrefixGroups = sortedPrefixes.filter(([, sfs]) => looksLikeRandomPayload(sfs).ok)
			if (validPrefixGroups.length >= 2) {
				const prefixes = validPrefixGroups.map(([p]) => p).slice(0, 12)
				return {
					signature: {
						kind: 'polymorphic',
						prefixes,
						charset: 'alnum',
						minLen,
						maxLen,
						suffixMinLen: Math.max(0, minLen - 4),
						suffixMaxLen: Math.max(0, maxLen - 2),
						estimatedBits: 48,
						distinctCount: valid.length,
						nonNullCount,
					},
					samples,
				}
			}
		}
	}

	// 4. Delimiterless typed-ID check: e.g. u8k2m9p4x1 (1..6 leading ASCII letters + fixed/near-fixed high-entropy payload)
	if (valid.every((s) => ALNUM_URLSAFE_RE.test(s) && !s.includes('-') && !s.includes('_')) && maxLen - minLen <= 4) {
		// 4a. Special exact case: single alpha prefix + ULID (27 chars: [a-zA-Z] + 26-char ULID)
		if (minLen === 27 && maxLen === 27 && valid.every((s) => /^[a-zA-Z]/.test(s) && ULID_RE.test(s.slice(1)))) {
			const firstChars = new Map<string, number>()
			for (const s of valid) firstChars.set(s[0]!, (firstChars.get(s[0]!) ?? 0) + 1)
			const sorted = Array.from(firstChars.entries()).sort((a, b) => b[1] - a[1])
			if (sorted[0]![1] / valid.length >= 0.95) {
				return {
					signature: {
						kind: 'typed-nodelim',
						prefix: sorted[0]![0],
						charset: 'ulid',
						minLen: 27,
						maxLen: 27,
						suffixMinLen: 26,
						suffixMaxLen: 26,
						estimatedBits: 80,
						distinctCount: valid.length,
						nonNullCount,
					},
					samples,
				}
			}
			if (sorted.length >= 2 && sorted.length <= 8) {
				return {
					signature: {
						kind: 'polymorphic',
						prefixes: sorted.map(([p]) => p),
						charset: 'ulid',
						minLen: 27,
						maxLen: 27,
						suffixMinLen: 26,
						suffixMaxLen: 26,
						estimatedBits: 80,
						distinctCount: valid.length,
						nonNullCount,
					},
					samples,
				}
			}
		}

		// 4b. General delimiterless alpha prefix + high-entropy payload (e.g. u8k2m9p4x1, usr9a8b7c6d, u01k8m3p9x2)
		const lcp = longestCommonPrefix(valid)
		const alphaPrefixMatch = /^[a-zA-Z]{1,6}/.exec(lcp)
		if (alphaPrefixMatch && valid.length >= 3) {
			const rawAlpha = alphaPrefixMatch[0]!
			// Walk down from rawAlpha.length to 1 to find the exact prefix boundary where suffix starts varying
			// or transitions cleanly from alpha prefix -> digit/timestamp-base32/random payload.
			let chosenPrefix: string | null = null
			for (let plen = rawAlpha.length; plen >= 1; plen--) {
				const cand = rawAlpha.slice(0, plen)
				const suffixes = valid.map((s) => s.slice(plen))
				if (suffixes.some((sf) => sf.length < 6)) continue
				const firstSufCharH = positionEntropy(suffixes, 0)
				const nextCharIsDigit = suffixes.every((sf) => /^\d/.test(sf))
				// Boundary criterion:
				// - If next char varies widely across rows (H >= 1.75 bits for >=4 rows, or H >= 1.3 for 3 rows), we are right at the random boundary!
				// - OR if next char is a constant digit (timestamp-prefixed Crockford/base32 ID like u01k8...) while cand is pure alpha,
				//   accept as long as later suffix positions have high entropy (verified by looksLikeRandomPayload).
				const boundaryOk = firstSufCharH >= (valid.length >= 4 ? 1.75 : 1.3) || (nextCharIsDigit && valid.length >= 4)
				if (!boundaryOk) continue

				// Guard against random hex strings that happened to start with 'a'..'f' on small samples (len 3..4):
				// If ALL values are pure hex and prefix is a single hex letter [a-fA-F], require >= 6 distinct rows
				// (prob of 6 random hex strings sharing first char is (1/16)^5 = 0.000095%).
				if (plen === 1 && /^[a-f]$/i.test(cand) && valid.every((s) => HEX_RE.test(s)) && valid.length < 6) {
					continue
				}

				const payload = looksLikeRandomPayload(suffixes)
				if (payload.ok && payload.bits >= 32) {
					chosenPrefix = cand
					let sMin = Infinity
					let sMax = 0
					for (const sf of suffixes) {
						if (sf.length < sMin) sMin = sf.length
						if (sf.length > sMax) sMax = sf.length
					}
					return {
						signature: {
							kind: 'typed-nodelim',
							prefix: chosenPrefix,
							charset: payload.charset,
							minLen,
							maxLen,
							suffixMinLen: sMin,
							suffixMaxLen: sMax,
							estimatedBits: payload.bits,
							distinctCount: valid.length,
							nonNullCount,
						},
						samples,
					}
				}
			}
		}

		// 4c. Detect delimiterless polymorphic column (e.g. mixes `u8k2m9p4x1` and `o3f7n0q2z8`):
		// Position 0 is always a letter with very low entropy (2-5 distinct letters) while positions 1..end are high-entropy!
		if (valid.length >= 8 && valid.every((s) => ALPHA_LEAD_RE.test(s))) {
			const pos0Set = new Set(valid.map((s) => s[0]!))
			const pos0H = positionEntropy(valid, 0)
			const pos1H = positionEntropy(valid, 1)
			if (pos0Set.size >= 2 && pos0Set.size <= 5 && pos0H < 1.6 && pos1H >= 2.5) {
				const suffixes = valid.map((s) => s.slice(1))
				const payload = looksLikeRandomPayload(suffixes)
				if (payload.ok && payload.bits >= 36) {
					return {
						signature: {
							kind: 'polymorphic',
							prefixes: Array.from(pos0Set).sort(),
							charset: payload.charset,
							minLen,
							maxLen,
							suffixMinLen: minLen - 1,
							suffixMaxLen: maxLen - 1,
							estimatedBits: payload.bits,
							distinctCount: valid.length,
							nonNullCount,
						},
						samples,
					}
				}
			}
		}
	}

	// 5. High-entropy opaque ID (no constant prefix, e.g. NanoID, 12+ char base62/base32/hex, or 1-2 row delimiterless typed ID!)
	if (minLen >= 8 && maxLen - minLen <= 4 && valid.every((s) => ALNUM_URLSAFE_RE.test(s))) {
		const payload = looksLikeRandomPayload(valid)
		if (payload.ok && payload.bits >= 40) {
			return {
				signature: {
					kind: 'opaque-id',
					charset: payload.charset,
					minLen,
					maxLen,
					suffixMinLen: minLen,
					suffixMaxLen: maxLen,
					estimatedBits: payload.bits,
					distinctCount: valid.length,
					nonNullCount,
				},
				samples,
			}
		}
	}

	return { signature: emptyNonId(nonNullCount, valid.length), samples: [] }
}

export function mergeFingerprints(
	prev: ColumnFingerprint | null,
	nextValues: unknown[],
	opts?: { isPk?: boolean },
): ColumnFingerprint {
	if (!prev || prev.samples.length === 0) {
		return fingerprintValues(nextValues, opts)
	}
	// Combine previous reservoir samples + new observed values for a sharper merged signature
	const combined: unknown[] = [...prev.samples]
	for (const v of nextValues) {
		if (v !== null && v !== undefined) combined.push(v)
	}
	const merged = fingerprintValues(combined, opts)
	merged.signature.nonNullCount = Math.max(merged.signature.nonNullCount, prev.signature.nonNullCount)
	return merged
}

export function isProbableIdSignature(sig: ColumnIdSignature): boolean {
	return sig.kind !== 'non-id' && sig.kind !== 'polymorphic'
}

// Checks whether values from a candidate FK column are structurally compatible with a learned target PK signature.
export function signaturesCompatible(
	fromSig: ColumnIdSignature,
	fromSamples: string[],
	pkSig: ColumnIdSignature,
): boolean {
	if (!isProbableIdSignature(fromSig) || !isProbableIdSignature(pkSig)) return false

	if (pkSig.kind === 'uuid') return fromSig.kind === 'uuid'
	if (pkSig.kind === 'ulid') return fromSig.kind === 'ulid'

	if (pkSig.kind === 'typed-delim') {
		if (!pkSig.prefix) return false
		if (fromSig.kind === 'typed-delim') {
			return fromSig.prefix === pkSig.prefix
		}
		// If fromCol had only 1-2 rows and fell into opaque-id, check sample prefix match directly!
		if (fromSamples.length > 0 && fromSamples.every((s) => s.startsWith(pkSig.prefix!))) {
			return true
		}
		return false
	}

	if (pkSig.kind === 'typed-nodelim') {
		if (!pkSig.prefix) return false
		if (fromSig.kind === 'typed-nodelim') {
			return (
				fromSig.prefix === pkSig.prefix &&
				Math.abs(fromSig.minLen - pkSig.minLen) <= 4 &&
				Math.abs(fromSig.maxLen - pkSig.maxLen) <= 4
			)
		}
		// Critical case: FK column has only 1-2 distinct values on page 1 (e.g. 50 messages all from 1 user `u8k2m9p4x1`),
		// so `fromSig` classified as `opaque-id` (couldn't prove LCP from 1-2 values), while `users.id` ALREADY learned `prefix = 'u'`!
		if (
			fromSig.kind === 'opaque-id' &&
			fromSamples.length > 0 &&
			fromSamples.every(
				(s) => s.startsWith(pkSig.prefix!) && s.length >= pkSig.minLen - 2 && s.length <= pkSig.maxLen + 2,
			)
		) {
			return true
		}
		return false
	}

	if (pkSig.kind === 'opaque-id') {
		if (fromSig.kind === 'opaque-id' || fromSig.kind === 'typed-nodelim') {
			// Compatible if lengths overlap closely
			return Math.abs(fromSig.minLen - pkSig.minLen) <= 4 && Math.abs(fromSig.maxLen - pkSig.maxLen) <= 4
		}
		return false
	}

	return false
}

function bareTableLower(table: string): string {
	const dot = table.indexOf('.')
	return (dot === -1 ? table : table.slice(dot + 1)).toLowerCase()
}

function tableSchemaPrefix(table: string): string {
	const dot = table.indexOf('.')
	return dot === -1 ? '' : table.slice(0, dot + 1)
}

function splitTokens(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

function stripIdSuffix(col: string): string {
	const low = col.toLowerCase()
	if (low.endsWith('_id') && low.length > 3) return low.slice(0, -3)
	if (col.length > 2 && col.endsWith('Id') && /[a-z0-9]Id$/.test(col)) {
		return col
			.slice(0, -2)
			.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
			.toLowerCase()
	}
	return col.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function consonantSkeleton(s: string): string {
	const low = s.toLowerCase().replace(/[^a-z]/g, '')
	if (low.length <= 2) return low
	return low[0]! + low.slice(1).replace(/[aeiou]/g, '')
}

function singularizeSimple(word: string): string {
	if (word.endsWith('ies') && word.length > 3) return word.slice(0, -3) + 'y'
	if (word.endsWith('ses') && word.length > 3) return word.slice(0, -2)
	if (word.endsWith('s') && !word.endsWith('ss') && word.length > 2) return word.slice(0, -1)
	return word
}

// Ranks candidate target tables for Tier 3 PK-index verification probes.
export function scoreCandidateTarget(
	fromTable: string,
	fromCol: string,
	fromSig: ColumnIdSignature,
	fromSamples: string[],
	target: CandidateTargetInfo,
	knownPkSig: ColumnIdSignature | null,
	pkCentrality: number,
): { score: number; reason: string } {
	let score = 0
	const reasons: string[] = []
	const bareTarget = bareTableLower(target.table)
	const targetSing = singularizeSimple(bareTarget)
	const targetTokens = splitTokens(bareTarget)
	const colStem = stripIdSuffix(fromCol)
	const colTokens = splitTokens(colStem)
	const lastColToken = colTokens[colTokens.length - 1] ?? colStem
	const isSelf = target.table === fromTable

	// 1. Learned PK signature match (strongest signal!)
	if (knownPkSig) {
		if (signaturesCompatible(fromSig, fromSamples, knownPkSig)) {
			if (knownPkSig.kind === 'typed-delim' || knownPkSig.kind === 'typed-nodelim') {
				score += 220
				reasons.push(`matches ${knownPkSig.prefix}* PK signature`)
			} else {
				score += 45
				reasons.push(`matches ${knownPkSig.kind} PK format`)
			}
		} else if (knownPkSig.kind !== 'non-id') {
			// Strongly incompatible learned PK signature (e.g. target has `org_` while col has `usr_`, or target is UUID while col is typed-delim)
			return { score: -1000, reason: 'incompatible PK signature' }
		}
	}

	// 2. Prefix-to-table-name affinity (works even BEFORE target table has been browsed!)
	const rawPrefix = (fromSig.prefix ?? '').replace(/[_:\-.]+$/g, '').toLowerCase()
	if (rawPrefix) {
		if (rawPrefix === bareTarget || rawPrefix === targetSing) {
			score += 120
			reasons.push(`prefix ${rawPrefix} matches table`)
		} else if (ABBREV_SYNONYMS[rawPrefix]?.includes(bareTarget) || ABBREV_SYNONYMS[rawPrefix]?.includes(targetSing)) {
			score += 110
			reasons.push(`prefix ${rawPrefix} maps to ${bareTarget}`)
		} else if (rawPrefix.length >= 2 && (targetSing.startsWith(rawPrefix) || bareTarget.startsWith(rawPrefix))) {
			score += 85
			reasons.push(`prefix ${rawPrefix} starts ${bareTarget}`)
		} else if (rawPrefix.length >= 2 && consonantSkeleton(targetSing).startsWith(rawPrefix)) {
			score += 75
			reasons.push(`prefix ${rawPrefix} abbreviates ${bareTarget}`)
		} else if (rawPrefix.length === 1 && targetSing.startsWith(rawPrefix)) {
			// Single-letter prefix like 'u' -> 'users' (prefer single-word tables over multi-word 'user_events')
			score += targetTokens.length === 1 ? 55 : 28
			reasons.push(`initial ${rawPrefix} matches ${bareTarget}`)
		}
	} else if (fromSamples.length > 0 && fromSig.kind === 'opaque-id') {
		// Even on 1-2 row FK pages where prefix wasn't isolated yet, check leading alpha char against table initial
		const firstChar = fromSamples[0]![0]?.toLowerCase() ?? ''
		if (/^[a-z]$/.test(firstChar) && fromSamples.every((s) => s[0]?.toLowerCase() === firstChar)) {
			if (targetSing.startsWith(firstChar)) {
				score += targetTokens.length === 1 ? 20 : 10
			}
		}
	}

	// 3. Column-name to table-name priors
	if (isSelf) {
		if (SELF_REF_NAMES.has(colStem) || SELF_REF_NAMES.has(lastColToken)) {
			score += 95
			reasons.push('self-reference name')
		} else {
			score -= 10
		}
	} else {
		if (
			colStem === targetSing ||
			colStem === bareTarget ||
			lastColToken === targetSing ||
			lastColToken === bareTarget
		) {
			score += 90
			reasons.push('column stem matches table')
		} else if (ABBREV_SYNONYMS[colStem]?.includes(bareTarget) || ABBREV_SYNONYMS[lastColToken]?.includes(bareTarget)) {
			score += 80
			reasons.push('column abbrev matches table')
		} else if (
			(ROLE_TO_USER_WORDS.has(colStem) || ROLE_TO_USER_WORDS.has(lastColToken)) &&
			USER_TABLE_NAMES.has(bareTarget)
		) {
			score += 85
			reasons.push('role column -> user table')
		} else if (targetTokens.some((t) => t.length >= 3 && colTokens.includes(t))) {
			score += 35
			reasons.push('shared name token')
		}
	}

	// 4. Same-schema bonus, centrality bonus, non-empty bonus
	if (tableSchemaPrefix(fromTable) === tableSchemaPrefix(target.table)) {
		score += 12
	}
	score += Math.min(25, pkCentrality * 5)
	if (target.rowCount !== null && target.rowCount > 0) {
		score += 8
	}

	return { score, reason: reasons.join(', ') || 'compatible PK' }
}

export function formatLearnedReason(
	sig: ColumnIdSignature,
	matched: number,
	sampled: number,
	toTable: string,
	toColumn: string,
): string {
	const ratio = `${matched}/${sampled} matched ${toTable}.${toColumn}`
	if ((sig.kind === 'typed-delim' || sig.kind === 'typed-nodelim') && sig.prefix) {
		return `Learned from ${sig.prefix}* IDs (${ratio})`
	}
	if (sig.kind === 'uuid') {
		return `Verified UUIDs (${ratio})`
	}
	if (sig.kind === 'ulid') {
		return `Verified ULIDs (${ratio})`
	}
	return `Verified IDs (${ratio})`
}

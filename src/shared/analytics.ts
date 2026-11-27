// Pure product-analytics types, schema auto-detection, route normalization, funnel matching, and cohort retention math.
import type { DatabaseSchema, TableSchema } from './types.ts'

export type TimeColumnFormat = 'epoch_ms' | 'epoch_s' | 'iso'
export type AnalyticsInterval = 'hour' | 'day' | 'week' | 'month'
export type AnalyticsRange = '24h' | '7d' | '14d' | '30d' | '90d' | 'all'
export type AnalyticsMetric = 'events' | 'unique_actors' | 'events_per_actor' | 'cumulative'
export type AnalyticsChartType = 'area' | 'line' | 'stacked_bar' | 'bar'
export type AnalyticsMode = 'trends' | 'funnel' | 'retention' | 'actors' | 'dashboard'
export type AnalyticsFilterOp = 'eq' | 'neq' | 'like' | 'not_like' | 'gte' | 'lte' | 'isnull' | 'notnull'

export interface AnalyticsFilter {
	column: string
	op: AnalyticsFilterOp
	value: string
}

export interface AnalyticsTopEvent {
	event: string
	count: number
	uniqueActors: number
	pct?: number
	sparkline?: number[]
}

export interface AnalyticsDetection {
	table: string
	timeColumn: string | null
	timeFormat: TimeColumnFormat
	eventColumn: string | null
	actorColumns: string[]
	defaultActorColumn: string | null
	userIdColumn: string | null
	visitorIdColumn: string | null
	statusColumn: string | null
	adminColumn: string | null
	payloadColumn: string | null
	looksLikeHttpEvents: boolean
	minTimeMs: number | null
	maxTimeMs: number | null
	totalRows: number
	topEvents: AnalyticsTopEvent[]
	durationMs: number
}

export interface AnalyticsBaseConfig {
	table: string
	timeColumn: string
	timeFormat: TimeColumnFormat
	eventColumn?: string | null
	actorColumn?: string | null
	userIdColumn?: string | null
	visitorIdColumn?: string | null
	statusColumn?: string | null
	payloadColumn?: string | null
	range: AnalyticsRange
	anchorEndMs?: number | null
	filters?: AnalyticsFilter[]
	normalizeUrls?: boolean
}

export interface TrendsRequest extends AnalyticsBaseConfig {
	interval: AnalyticsInterval
	metric: AnalyticsMetric
	breakdownColumn?: string | null
	selectedEvents?: string[]
	topN?: number
	queryId?: string
}

export interface TrendsSeries {
	key: string
	label: string
	values: number[]
	total: number
}

export interface TrendsKpis {
	totalEvents: number
	uniqueActors: number
	avgPerActor: number
	errorCount: number | null
	errorRatePct: number | null
	prevPeriodEvents: number | null
	deltaPct: number | null
}

export interface TrendsResponse {
	buckets: number[]
	interval: AnalyticsInterval
	rangeStartMs: number
	rangeEndMs: number
	series: TrendsSeries[]
	kpis: TrendsKpis
	topEvents: AnalyticsTopEvent[]
	sql: string
	durationMs: number
}

export interface FunnelStepSpec {
	label?: string
	pattern: string
	match: 'exact' | 'prefix' | 'contains'
}

export interface FunnelRequest extends AnalyticsBaseConfig {
	steps: FunnelStepSpec[]
	windowSeconds: number | null
	stitchIdentity?: boolean
	queryId?: string
}

export interface FunnelStepResult {
	index: number
	label: string
	pattern: string
	count: number
	overallPct: number
	stepPct: number
	dropoffCount: number
	dropoffPct: number
	medianSecondsFromPrev: number | null
	sampleActors: string[]
	dropoffSampleActors: string[]
}

export interface FunnelResponse {
	steps: FunnelStepResult[]
	windowSeconds: number | null
	stitchedIdentity: boolean
	scannedEvents: number
	truncated: boolean
	sql: string
	durationMs: number
}

export interface RetentionRequest extends AnalyticsBaseConfig {
	granularity: 'day' | 'week'
	periods: number
	cohortEvent?: string | null
	returnEvent?: string | null
	stitchIdentity?: boolean
	queryId?: string
}

export interface RetentionCohort {
	cohortStartMs: number
	label: string
	size: number
	counts: number[]
	pcts: (number | null)[]
}

export interface RetentionResponse {
	granularity: 'day' | 'week'
	periods: number
	cohorts: RetentionCohort[]
	averagePcts: (number | null)[]
	sql: string
	durationMs: number
}

export interface ActorsRequest extends AnalyticsBaseConfig {
	sortBy?: 'events' | 'last_seen' | 'errors'
	search?: string
	limit?: number
	queryId?: string
}

export interface ActorSummary {
	actorId: string
	userId: string | null
	visitorId: string | null
	eventCount: number
	activeDays: number
	errorCount: number
	firstSeenMs: number
	lastSeenMs: number
	topEvent: string | null
}

export interface ActorsResponse {
	actors: ActorSummary[]
	sql: string
	durationMs: number
}

export interface ActorJourneyRequest extends AnalyticsBaseConfig {
	actorId: string
	limit?: number
	queryId?: string
}

export interface JourneyEvent {
	id: string | null
	tsMs: number
	event: string
	rawEvent: string
	status: number | null
	data: string | null
	userId: string | null
	visitorId: string | null
}

export interface ActorJourneyResponse {
	actorId: string
	events: JourneyEvent[]
	sql: string
	durationMs: number
}

export interface SavedAnalyticsChart {
	id: string
	connectionId: string
	title: string
	mode: Exclude<AnalyticsMode, 'dashboard'>
	config: Record<string, unknown>
	createdAt: string
	updatedAt: string
}

export const STITCHED_ACTOR_SENTINEL = '__stitched__'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const MONDAY_EPOCH_OFFSET_MS = 4 * DAY_MS // 1970-01-01 was Thursday -> align week buckets to Monday UTC

const TIME_COL_PATTERNS: [RegExp, number][] = [
	[/^(created_at|occurred_at|event_time|event_at|timestamp|ts)$/i, 100],
	[/^(inserted_at|recorded_at|logged_at|happened_at|sent_at|time)$/i, 90],
	[/(_at|_time|_ts|_timestamp)$/i, 70],
	[/^(date|created|updated_at|visited_at|started_at)$/i, 55],
]

const EVENT_COL_PATTERNS: [RegExp, number][] = [
	[/^(event|event_name|event_type)$/i, 100],
	[/^(action|action_name|activity|kind|type)$/i, 85],
	[/^(path|route|endpoint|url|method|name|category)$/i, 60],
]

const ACTOR_COL_PATTERNS: [RegExp, number][] = [
	[/^(user_id|userid|uid)$/i, 100],
	[/^(visitor_id|visitorid|anon_id|anonymous_id|distinct_id)$/i, 95],
	[/^(actor_id|account_id|member_id|profile_id|customer_id)$/i, 85],
	[/^(session_id|device_id|client_id)$/i, 70],
]

const STATUS_COL_PATTERNS: [RegExp, number][] = [
	[/^(status|status_code|http_status|response_code)$/i, 100],
	[/^(code|result|outcome)$/i, 60],
]

const ADMIN_COL_PATTERNS: [RegExp, number][] = [[/^(admin_id|is_admin|impersonator_id|staff_id)$/i, 100]]

const PAYLOAD_COL_PATTERNS: [RegExp, number][] = [
	[/^(data|properties|props|payload|metadata|meta|details|params|context)$/i, 100],
]

const EVENT_TABLE_NAMES =
	/^(events|analytics_events|user_events|app_events|audit_logs?|activity(_log)?|page_?views|logs|telemetry|metrics|requests)$/i

function scorePatterns(name: string, patterns: [RegExp, number][]): number {
	for (const [re, score] of patterns) {
		if (re.test(name)) return score
	}
	return 0
}

function isTimestampType(colType: string): boolean {
	return /\b(timestamp|timestamptz|datetime|date)\b/i.test(colType)
}

function isTextType(colType: string): boolean {
	return !colType || /\b(text|char|varchar|clob|citext|string)\b/i.test(colType)
}

function isIntType(colType: string): boolean {
	return /\b(int|integer|bigint|int4|int8|smallint|numeric|real|float)\b/i.test(colType)
}

export interface StaticTableColumns {
	timeColumn: string | null
	eventColumn: string | null
	actorColumns: string[]
	userIdColumn: string | null
	visitorIdColumn: string | null
	defaultActorColumn: string | null
	statusColumn: string | null
	adminColumn: string | null
	payloadColumn: string | null
}

export function detectTableColumns(table: TableSchema): StaticTableColumns {
	let bestTime: { name: string; score: number } | null = null
	let bestEvent: { name: string; score: number } | null = null
	let bestStatus: { name: string; score: number } | null = null
	let bestAdmin: { name: string; score: number } | null = null
	let bestPayload: { name: string; score: number } | null = null
	const actorCandidates: { name: string; score: number }[] = []

	for (const col of table.columns) {
		const tScore = scorePatterns(col.name, TIME_COL_PATTERNS) + (isTimestampType(col.type) ? 40 : 0)
		if (tScore > 0 && (!bestTime || tScore > bestTime.score)) {
			bestTime = { name: col.name, score: tScore }
		}

		if (col.primaryKey === 0 && isTextType(col.type)) {
			const eScore = scorePatterns(col.name, EVENT_COL_PATTERNS)
			if (eScore > 0 && (!bestEvent || eScore > bestEvent.score)) {
				bestEvent = { name: col.name, score: eScore }
			}
		}

		const aScore = scorePatterns(col.name, ACTOR_COL_PATTERNS)
		if (aScore > 0) {
			actorCandidates.push({ name: col.name, score: aScore })
		}

		const sScore = scorePatterns(col.name, STATUS_COL_PATTERNS)
		if (sScore > 0 && (isIntType(col.type) || isTextType(col.type)) && (!bestStatus || sScore > bestStatus.score)) {
			bestStatus = { name: col.name, score: sScore }
		}

		const adScore = scorePatterns(col.name, ADMIN_COL_PATTERNS)
		if (adScore > 0 && (!bestAdmin || adScore > bestAdmin.score)) {
			bestAdmin = { name: col.name, score: adScore }
		}

		const pScore = scorePatterns(col.name, PAYLOAD_COL_PATTERNS)
		if (pScore > 0 && (!bestPayload || pScore > bestPayload.score)) {
			bestPayload = { name: col.name, score: pScore }
		}
	}

	actorCandidates.sort((a, b) => b.score - a.score)
	const actorColumns = actorCandidates.map((c) => c.name)
	// For entity tables like `users` (no user_id column, just `id`), fall back to single PK so unique actors = unique rows.
	if (actorColumns.length === 0 && table.primaryKeyColumns.length === 1) {
		actorColumns.push(table.primaryKeyColumns[0]!)
	}

	const userIdColumn = actorColumns.find((c) => /^(user_id|userid|uid)$/i.test(c)) ?? null
	const visitorIdColumn = actorColumns.find((c) => /^(visitor_id|visitorid|anon_id|anonymous_id)$/i.test(c)) ?? null
	const defaultActorColumn = userIdColumn && visitorIdColumn ? STITCHED_ACTOR_SENTINEL : (actorColumns[0] ?? null)

	return {
		timeColumn: bestTime?.name ?? null,
		eventColumn: bestEvent?.name ?? null,
		actorColumns,
		userIdColumn,
		visitorIdColumn,
		defaultActorColumn,
		statusColumn: bestStatus?.name ?? null,
		adminColumn: bestAdmin?.name ?? null,
		payloadColumn: bestPayload?.name ?? null,
	}
}

export function detectBestAnalyticsTable(schema: DatabaseSchema): string | null {
	let best: { name: string; score: number } | null = null
	for (const summary of schema.tables) {
		if (summary.isInternal) continue
		const ts = schema.schemas[summary.name]
		if (!ts) continue
		const cols = detectTableColumns(ts)
		if (!cols.timeColumn) continue

		const bareName = summary.name.includes('.') ? summary.name.split('.').pop()! : summary.name
		let score = 10
		if (EVENT_TABLE_NAMES.test(bareName)) score += 120
		else if (/event|log|audit|activit|metric|track/i.test(bareName)) score += 60
		else if (/^(users|accounts|signups|orders|sessions|posts|messages)$/i.test(bareName)) score += 30

		if (cols.eventColumn) score += 45
		if (cols.userIdColumn) score += 20
		if (cols.visitorIdColumn) score += 15
		if (summary.rowCount !== null && summary.rowCount > 0) score += Math.min(25, Math.log10(summary.rowCount + 1) * 5)
		if (summary.rowCount === 0) score -= 40

		if (!best || score > best.score) {
			best = { name: summary.name, score }
		}
	}
	return best?.name ?? schema.tables.find((t) => !t.isInternal)?.name ?? null
}

export function inferTimeFormat(sampleValue: unknown, colType = ''): TimeColumnFormat {
	if (sampleValue instanceof Date) return 'iso'
	if (typeof sampleValue === 'number' && Number.isFinite(sampleValue)) {
		return Math.abs(sampleValue) >= 1e11 ? 'epoch_ms' : 'epoch_s'
	}
	if (typeof sampleValue === 'bigint') {
		const n = Number(sampleValue)
		return Math.abs(n) >= 1e11 ? 'epoch_ms' : 'epoch_s'
	}
	if (typeof sampleValue === 'string') {
		const trimmed = sampleValue.trim()
		if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
			const n = Number(trimmed)
			if (Number.isFinite(n)) return Math.abs(n) >= 1e11 ? 'epoch_ms' : 'epoch_s'
		}
		return 'iso'
	}
	if (isTimestampType(colType)) return 'iso'
	if (isIntType(colType)) return 'epoch_ms'
	return 'iso'
}

export function parseTimestampToMs(val: unknown, format: TimeColumnFormat): number | null {
	if (val === null || val === undefined) return null
	if (val instanceof Date) return val.getTime()
	if (format === 'epoch_ms') {
		const n = Number(val)
		return Number.isFinite(n) ? Math.round(n) : null
	}
	if (format === 'epoch_s') {
		const n = Number(val)
		return Number.isFinite(n) ? Math.round(n * 1000) : null
	}
	const str = String(val).trim()
	if (!str) return null
	// Normalize SQLite "YYYY-MM-DD HH:MM:SS" to UTC ISO
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str) ? str.replace(' ', 'T') + (str.endsWith('Z') ? '' : 'Z') : str
	const ms = Date.parse(iso)
	return Number.isFinite(ms) ? ms : null
}

const UUID_SEG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_ID_RE = /^[0-9a-f]{16,}$/i
const DIGITS_RE = /^\d+$/

function isDynamicIdSegment(seg: string): boolean {
	if (!seg) return false
	if (DIGITS_RE.test(seg) || UUID_SEG_RE.test(seg) || HEX_ID_RE.test(seg)) return true
	// Typed or opaque IDs like `c1m6e6d9bv26`, `p1m6b71mh0de`, `usr_01J9X...`, ULIDs:
	// must be >= 8 chars, contain digits AND letters, and not look like a version/date or plain word.
	if (seg.length >= 8 && /^[a-z0-9_-]+$/i.test(seg)) {
		const digits = (seg.match(/\d/g) ?? []).length
		const letters = (seg.match(/[a-z]/gi) ?? []).length
		if (digits >= 2 && letters >= 2 && !/^v\d+/i.test(seg)) return true
	}
	return false
}

// Collapses dynamic path IDs and query strings in HTTP-style event names (e.g. "GET /api/chats/c1m6e6d9bv26" -> "GET /api/chats/:id").
export function normalizeEventName(raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed) return '(empty)'
	const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i.exec(trimmed)
	let prefix = ''
	let pathPart = ''
	if (methodMatch) {
		prefix = `${methodMatch[1]!.toUpperCase()} `
		pathPart = methodMatch[2]!
	} else if (trimmed.startsWith('/')) {
		pathPart = trimmed
	} else {
		return trimmed
	}
	const qIdx = pathPart.indexOf('?')
	const cleanPath = qIdx >= 0 ? pathPart.slice(0, qIdx) : pathPart
	const segments = cleanPath.split('/').map((seg) => (isDynamicIdSegment(seg) ? ':id' : seg))
	return prefix + segments.join('/')
}

export function looksLikeHttpEventList(events: string[]): boolean {
	if (events.length === 0) return false
	let hits = 0
	for (const ev of events) {
		if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(ev) || ev.startsWith('/')) hits++
	}
	return hits / events.length >= 0.4
}

export function rangeToDurationMs(range: AnalyticsRange): number | null {
	switch (range) {
		case '24h':
			return DAY_MS
		case '7d':
			return 7 * DAY_MS
		case '14d':
			return 14 * DAY_MS
		case '30d':
			return 30 * DAY_MS
		case '90d':
			return 90 * DAY_MS
		case 'all':
			return null
	}
}

export function defaultIntervalForRange(range: AnalyticsRange): AnalyticsInterval {
	if (range === '24h') return 'hour'
	if (range === '90d') return 'week'
	return 'day'
}

export function floorBucketMs(tsMs: number, interval: AnalyticsInterval): number {
	if (interval === 'hour') return Math.floor(tsMs / HOUR_MS) * HOUR_MS
	if (interval === 'day') return Math.floor(tsMs / DAY_MS) * DAY_MS
	if (interval === 'week') {
		return Math.floor((tsMs - MONDAY_EPOCH_OFFSET_MS) / WEEK_MS) * WEEK_MS + MONDAY_EPOCH_OFFSET_MS
	}
	const d = new Date(tsMs)
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

export function nextBucketMs(bucketMs: number, interval: AnalyticsInterval): number {
	if (interval === 'hour') return bucketMs + HOUR_MS
	if (interval === 'day') return bucketMs + DAY_MS
	if (interval === 'week') return bucketMs + WEEK_MS
	const d = new Date(bucketMs)
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

export function generateBuckets(
	startMs: number,
	endMs: number,
	interval: AnalyticsInterval,
	maxBuckets = 500,
): number[] {
	if (endMs < startMs) return []
	const buckets: number[] = []
	let cur = floorBucketMs(startMs, interval)
	const last = floorBucketMs(endMs, interval)
	while (cur <= last && buckets.length < maxBuckets) {
		buckets.push(cur)
		const next = nextBucketMs(cur, interval)
		if (next <= cur) break
		cur = next
	}
	return buckets
}

export function matchesFunnelStep(eventName: string, step: FunnelStepSpec): boolean {
	const pat = step.pattern.trim()
	if (!pat) return true
	if (step.match === 'exact') return eventName === pat
	if (step.match === 'prefix') return eventName.startsWith(pat)
	return eventName.toLowerCase().includes(pat.toLowerCase())
}

export interface RawFunnelEvent {
	actorKey: string
	userId: string | null
	visitorId: string | null
	event: string
	tsMs: number
}

// Stitches anonymous visitor_ids to authenticated user_ids whenever both appear together on any event row.
export function buildIdentityResolver(
	rows: { userId: string | null; visitorId: string | null; actorKey?: string }[],
	stitch: boolean,
): (row: { userId: string | null; visitorId: string | null; actorKey?: string }) => string | null {
	const visitorToUser = new Map<string, string>()
	if (stitch) {
		for (const r of rows) {
			if (r.visitorId && r.userId && !visitorToUser.has(r.visitorId)) {
				visitorToUser.set(r.visitorId, r.userId)
			}
		}
	}
	return (r) => {
		if (r.userId) return r.userId
		if (r.visitorId) return visitorToUser.get(r.visitorId) ?? r.visitorId
		return r.actorKey || null
	}
}

function median(values: number[]): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : Math.round(sorted[mid]!)
}

export function computeFunnel(
	events: RawFunnelEvent[],
	steps: FunnelStepSpec[],
	windowSeconds: number | null,
	stitchIdentity: boolean,
): FunnelStepResult[] {
	if (steps.length === 0) return []
	const resolveActor = buildIdentityResolver(events, stitchIdentity)

	// Group sorted events per resolved actor
	const byActor = new Map<string, { event: string; tsMs: number }[]>()
	for (const ev of events) {
		const actor = resolveActor(ev)
		if (!actor) continue
		let list = byActor.get(actor)
		if (!list) {
			list = []
			byActor.set(actor, list)
		}
		list.push({ event: ev.event, tsMs: ev.tsMs })
	}

	const stepActors: string[][] = steps.map(() => [])
	const stepDeltasSec: number[][] = steps.map(() => [])
	const windowMs = windowSeconds !== null && windowSeconds > 0 ? windowSeconds * 1000 : null

	for (const [actor, list] of byActor.entries()) {
		list.sort((a, b) => a.tsMs - b.tsMs)
		// Find the best sequential progression starting from each Step 0 occurrence (greedy earliest-complete)
		let bestReached = -1
		let bestTimes: number[] = []

		for (let startIdx = 0; startIdx < list.length; startIdx++) {
			if (!matchesFunnelStep(list[startIdx]!.event, steps[0]!)) continue
			const t0 = list[startIdx]!.tsMs
			const times = [t0]
			let stepCursor = 1
			for (let j = startIdx + 1; j < list.length && stepCursor < steps.length; j++) {
				const cand = list[j]!
				if (windowMs !== null && cand.tsMs - t0 > windowMs) break
				if (matchesFunnelStep(cand.event, steps[stepCursor]!)) {
					times.push(cand.tsMs)
					stepCursor++
				}
			}
			if (times.length - 1 > bestReached) {
				bestReached = times.length - 1
				bestTimes = times
				if (bestReached === steps.length - 1) break
			}
		}

		if (bestReached >= 0) {
			for (let s = 0; s <= bestReached; s++) {
				stepActors[s]!.push(actor)
				if (s > 0) {
					stepDeltasSec[s]!.push(Math.max(0, (bestTimes[s]! - bestTimes[s - 1]!) / 1000))
				}
			}
		}
	}

	const firstCount = stepActors[0]!.length
	return steps.map((step, i) => {
		const actors = stepActors[i]!
		const count = actors.length
		const prevActors = i > 0 ? stepActors[i - 1]! : actors
		const prevCount = i > 0 ? prevActors.length : count
		const reachedSet = new Set(actors)
		const dropoffActors = i > 0 ? prevActors.filter((a) => !reachedSet.has(a)) : []
		const dropoffCount = i > 0 ? Math.max(0, prevCount - count) : 0
		return {
			index: i,
			label: step.label?.trim() || step.pattern,
			pattern: step.pattern,
			count,
			overallPct: firstCount > 0 ? Number(((count / firstCount) * 100).toFixed(1)) : 0,
			stepPct: prevCount > 0 ? Number(((count / prevCount) * 100).toFixed(1)) : i === 0 ? 100 : 0,
			dropoffCount,
			dropoffPct: prevCount > 0 ? Number(((dropoffCount / prevCount) * 100).toFixed(1)) : 0,
			medianSecondsFromPrev: i > 0 ? median(stepDeltasSec[i]!) : null,
			sampleActors: actors.slice(0, 20),
			dropoffSampleActors: dropoffActors.slice(0, 20),
		}
	})
}

export interface RetentionActivityPoint {
	actorId: string
	bucketMs: number
	isCohortEvent: boolean
	isReturnEvent: boolean
}

export function computeRetention(
	points: RetentionActivityPoint[],
	granularity: 'day' | 'week',
	periods: number,
	maxObservedMs: number,
): { cohorts: RetentionCohort[]; averagePcts: (number | null)[] } {
	const stepMs = granularity === 'week' ? WEEK_MS : DAY_MS
	const maxBucketMs = floorBucketMs(maxObservedMs, granularity)

	// Find each actor's first cohort bucket, plus all active return buckets
	const firstCohort = new Map<string, number>()
	const returnBuckets = new Map<string, Set<number>>()

	for (const p of points) {
		if (!p.actorId) continue
		const b = floorBucketMs(p.bucketMs, granularity)
		if (p.isCohortEvent) {
			const prev = firstCohort.get(p.actorId)
			if (prev === undefined || b < prev) firstCohort.set(p.actorId, b)
		}
		if (p.isReturnEvent) {
			let set = returnBuckets.get(p.actorId)
			if (!set) {
				set = new Set<number>()
				returnBuckets.set(p.actorId, set)
			}
			set.add(b)
		}
	}

	// Group actors by cohort bucket
	const cohortMembers = new Map<number, string[]>()
	for (const [actor, cohortMs] of firstCohort.entries()) {
		let arr = cohortMembers.get(cohortMs)
		if (!arr) {
			arr = []
			cohortMembers.set(cohortMs, arr)
		}
		arr.push(actor)
	}

	const sortedBuckets = [...cohortMembers.keys()].sort((a, b) => a - b)
	// Keep the most recent 16 cohorts so the matrix stays crisp and scannable
	const visibleBuckets = sortedBuckets.slice(-16)

	const numCols = Math.max(2, Math.min(31, periods + 1))
	const cohorts: RetentionCohort[] = []

	for (const cohortMs of visibleBuckets) {
		const members = cohortMembers.get(cohortMs)!
		const size = members.length
		const counts: number[] = []
		const pcts: (number | null)[] = []

		for (let offset = 0; offset < numCols; offset++) {
			const targetBucket = cohortMs + offset * stepMs
			if (targetBucket > maxBucketMs) {
				counts.push(0)
				pcts.push(null)
				continue
			}
			if (offset === 0) {
				counts.push(size)
				pcts.push(100)
				continue
			}
			let retained = 0
			for (const actor of members) {
				if (returnBuckets.get(actor)?.has(targetBucket)) retained++
			}
			counts.push(retained)
			pcts.push(size > 0 ? Number(((retained / size) * 100).toFixed(1)) : 0)
		}

		const d = new Date(cohortMs)
		const label = d.toISOString().slice(0, 10)
		cohorts.push({ cohortStartMs: cohortMs, label, size, counts, pcts })
	}

	// Weighted average retention across cohorts that have matured to each offset
	const averagePcts: (number | null)[] = []
	for (let offset = 0; offset < numCols; offset++) {
		let totalRetained = 0
		let totalEligible = 0
		for (const c of cohorts) {
			if (c.pcts[offset] === null) continue
			totalRetained += c.counts[offset]!
			totalEligible += c.size
		}
		averagePcts.push(totalEligible > 0 ? Number(((totalRetained / totalEligible) * 100).toFixed(1)) : null)
	}

	return { cohorts, averagePcts }
}

// Full Product Analytics workspace (Amplitude / Mixpanel / PostHog / Datadog-style Trends, Funnels, Retention, People Journeys, and Saved Charts).
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import {
	IconArrowRight,
	IconChart,
	IconClose,
	IconPlus,
	IconRefresh,
	IconSql,
	IconTable,
	IconTrash,
} from '../lib/icons.tsx'
import {
	type ActorJourneyResponse,
	type ActorsResponse,
	type AnalyticsChartType,
	type AnalyticsDetection,
	type AnalyticsFilter,
	type AnalyticsFilterOp,
	type AnalyticsInterval,
	type AnalyticsMode,
	type AnalyticsMetric,
	type AnalyticsRange,
	type AnalyticsUserMeta,
	defaultIntervalForRange,
	type FunnelResponse,
	type FunnelStepSpec,
	nextBucketMs,
	normalizeEventName,
	type RetentionResponse,
	type SavedAnalyticsChart,
	STITCHED_ACTOR_SENTINEL,
	type TimeColumnFormat,
	type TrendsResponse,
} from '../shared/analytics.ts'
import {
	autoDecodeSingleValue,
	formatLocalTimestamp,
	formatRelativeTime,
	formatUtcTimestamp,
} from '../shared/lenses.ts'
import { tid } from '../shared/tid.ts'
import type { DatabaseSchema, FilterSpec } from '../shared/types.ts'
import {
	type AnalyticsTimezone,
	formatBucketLabel,
	formatDurationSec,
	FunnelChart,
	RetentionMatrix,
	Sparkline,
	TimeSeriesChart,
} from './AnalyticsCharts.tsx'

const RANGES: { id: AnalyticsRange; label: string }[] = [
	{ id: '24h', label: '24h' },
	{ id: '7d', label: '7d' },
	{ id: '14d', label: '14d' },
	{ id: '30d', label: '30d' },
	{ id: '90d', label: '90d' },
	{ id: 'all', label: 'All' },
]

const INTERVALS: { id: AnalyticsInterval; label: string }[] = [
	{ id: 'hour', label: 'Hourly' },
	{ id: 'day', label: 'Daily' },
	{ id: 'week', label: 'Weekly' },
	{ id: 'month', label: 'Monthly' },
]

function statusBadgeClass(status: number | null): string {
	if (status === null) return ''
	if (status >= 500) return 'status-5xx'
	if (status >= 400) return 'status-4xx'
	if (status >= 300) return 'status-3xx'
	return 'status-2xx'
}

function suggestInitialFunnelSteps(events: string[]): FunnelStepSpec[] {
	if (events.length === 0) {
		return [
			{ pattern: '', match: 'exact' },
			{ pattern: '', match: 'exact' },
		]
	}
	const uniq: string[] = []
	for (const e of events) {
		if (!uniq.includes(e)) uniq.push(e)
	}
	// Prefer a natural landing/view -> signup/auth/claim -> core action sequence if visible
	const step1 = uniq.find((e) => /view|visit|page|open|landing|home|manifest/i.test(e)) ?? uniq[0]!
	const step2 =
		uniq.find((e) => e !== step1 && /signup|register|claim|auth|login|onboard|verify/i.test(e)) ??
		uniq.find((e) => e !== step1) ??
		step1
	const step3 = uniq.find((e) => e !== step1 && e !== step2 && /post|message|chat|create|order|buy|pay|submit/i.test(e))
	const chosen = step3 ? [step1, step2, step3] : step2 !== step1 ? [step1, step2] : [step1]
	return chosen.map((pattern) => ({ pattern, match: 'exact' as const }))
}

export interface AnalyticsRoutePatch {
	table?: string | null
	mode?: AnalyticsMode
	range?: AnalyticsRange | null
	interval?: AnalyticsInterval | null
	metric?: AnalyticsMetric | null
	breakdown?: string | null
	chart?: AnalyticsChartType | null
	actor?: string | null
}

export function AnalyticsView(props: {
	connId: string
	schema: DatabaseSchema | null
	initialTable: string | null
	mode: AnalyticsMode
	initialRange?: AnalyticsRange | null
	initialInterval?: AnalyticsInterval | null
	initialMetric?: AnalyticsMetric | null
	initialBreakdown?: string | null
	initialChartType?: AnalyticsChartType | null
	initialActorId?: string | null
	onChangeRoute: (patch: AnalyticsRoutePatch, replace?: boolean) => void
	onOpenTable: (table: string, filters?: FilterSpec[]) => void
	onOpenInSql: (sql: string) => void
	onFollowFk: (targetTable: string, targetColumn: string, value: unknown) => void
	onNotify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
}) {
	const [detection, setDetection] = createSignal<AnalyticsDetection | null>(null)
	const [detecting, setDetecting] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)

	// Active schema mapping
	const [selectedTable, setSelectedTable] = createSignal<string>(props.initialTable ?? '')
	const [timeColumn, setTimeColumn] = createSignal<string>('')
	const [timeFormat, setTimeFormat] = createSignal<TimeColumnFormat>('epoch_ms')
	const [eventColumn, setEventColumn] = createSignal<string>('')
	const [actorColumn, setActorColumn] = createSignal<string>('')
	const [statusColumn, setStatusColumn] = createSignal<string>('')
	const [normalizeUrls, setNormalizeUrls] = createSignal<boolean>(true)
	const [excludeAdmin, setExcludeAdmin] = createSignal<boolean>(true)
	const [excludeTestUsers, setExcludeTestUsers] = createSignal<boolean>(true)
	const [signedInOnly, setSignedInOnly] = createSignal<boolean>(true)
	const [excludedActors, setExcludedActors] = createSignal<string[]>([])
	const [showExcludePopover, setShowExcludePopover] = createSignal(false)
	const [excludeSearch, setExcludeSearch] = createSignal('')
	const [errorsOnly, setErrorsOnly] = createSignal<boolean>(false)
	const [customFilters, setCustomFilters] = createSignal<AnalyticsFilter[]>([])
	const [showFilterAdder, setShowFilterAdder] = createSignal(false)
	const [draftFilterCol, setDraftFilterCol] = createSignal('')
	const [draftFilterOp, setDraftFilterOp] = createSignal<AnalyticsFilterOp>('eq')
	const [draftFilterVal, setDraftFilterVal] = createSignal('')

	// Time window & timezone
	const [range, setRange] = createSignal<AnalyticsRange>(props.initialRange ?? '30d')
	const [interval, setIntervalVal] = createSignal<AnalyticsInterval>(props.initialInterval ?? 'day')
	const [tz, setTz] = createSignal<AnalyticsTimezone>(
		(() => {
			try {
				return localStorage.getItem('datadip:analytics:tz') === 'local' ? 'local' : 'utc'
			} catch {
				return 'utc'
			}
		})(),
	)

	function toggleTz() {
		setTz((prev) => {
			const next: AnalyticsTimezone = prev === 'utc' ? 'local' : 'utc'
			try {
				localStorage.setItem('datadip:analytics:tz', next)
			} catch {}
			return next
		})
	}

	function formatTs(ms: number): string {
		return tz() === 'local' ? formatLocalTimestamp(ms) : `${formatUtcTimestamp(ms)} UTC`
	}

	// Trends state
	const [metric, setMetric] = createSignal<AnalyticsMetric>(props.initialMetric ?? 'events')
	const [chartType, setChartType] = createSignal<AnalyticsChartType>(props.initialChartType ?? 'area')
	const [breakdownCol, setBreakdownCol] = createSignal<string>(props.initialBreakdown ?? '')
	const [selectedEvents, setSelectedEvents] = createSignal<string[]>([])
	const [trendsData, setTrendsData] = createSignal<TrendsResponse | null>(null)
	const [trendsLoading, setTrendsLoading] = createSignal(false)

	// Funnel state
	const [funnelSteps, setFunnelSteps] = createSignal<FunnelStepSpec[]>([])
	const [funnelWindowSec, setFunnelWindowSec] = createSignal<number | null>(86400)
	const [stitchIdentity, setStitchIdentity] = createSignal<boolean>(true)
	const [funnelData, setFunnelData] = createSignal<FunnelResponse | null>(null)
	const [funnelLoading, setFunnelLoading] = createSignal(false)

	// Retention state
	const [retGranularity, setRetGranularity] = createSignal<'day' | 'week'>('day')
	const [retPeriods, setRetPeriods] = createSignal<number>(14)
	const [retCohortEvent, setRetCohortEvent] = createSignal<string>('')
	const [retReturnEvent, setRetReturnEvent] = createSignal<string>('')
	const [retData, setRetData] = createSignal<RetentionResponse | null>(null)
	const [retLoading, setRetLoading] = createSignal(false)

	// People / Actors state
	const [actorsSort, setActorsSort] = createSignal<'events' | 'last_seen' | 'errors'>('events')
	const [actorsSearch, setActorsSearch] = createSignal('')
	const [actorsData, setActorsData] = createSignal<ActorsResponse | null>(null)
	const [actorsLoading, setActorsLoading] = createSignal(false)
	const [selectedActorId, setSelectedActorId] = createSignal<string | null>(null)
	const [journeyData, setJourneyData] = createSignal<ActorJourneyResponse | null>(null)
	const [journeyLoading, setJourneyLoading] = createSignal(false)

	// Saved charts
	const [savedCharts, setSavedCharts] = createSignal<SavedAnalyticsChart[]>([])
	const [savePopoverOpen, setSavePopoverOpen] = createSignal(false)
	const [saveTitle, setSaveTitle] = createSignal('')
	const [refreshTick, setRefreshTick] = createSignal(0)

	// Controlled <select> refs (AGENTS.md SolidJS dynamic select rule)
	let tableSelectEl: HTMLSelectElement | undefined
	let timeSelectEl: HTMLSelectElement | undefined
	let eventSelectEl: HTMLSelectElement | undefined
	let actorSelectEl: HTMLSelectElement | undefined
	let breakdownSelectEl: HTMLSelectElement | undefined
	let filterColSelectEl: HTMLSelectElement | undefined
	let actorsSortSelectEl: HTMLSelectElement | undefined

	let activeQueryId: string | null = null
	let appliedInitialUrl = false

	const availableTables = createMemo(() => {
		const s = props.schema
		if (!s) return []
		return s.tables.filter((t) => !t.isInternal)
	})

	const activeTableSchema = createMemo(() => {
		const s = props.schema
		const tbl = selectedTable()
		if (!s || !tbl) return null
		return s.schemas[tbl] ?? null
	})

	const activeColumns = createMemo(() => activeTableSchema()?.columns ?? [])

	const actorOptions = createMemo(() => {
		const det = detection()
		const opts: { value: string; label: string }[] = []
		if (det?.userIdColumn) {
			opts.push({ value: det.userIdColumn, label: `Signed-in Users (${det.userIdColumn})` })
		}
		if (det?.userIdColumn && det?.visitorIdColumn) {
			opts.push({ value: STITCHED_ACTOR_SENTINEL, label: `All (${det.userIdColumn} + ${det.visitorIdColumn})` })
		}
		for (const c of activeColumns()) {
			if (c.name === det?.userIdColumn) continue
			opts.push({ value: c.name, label: c.name })
		}
		return opts
	})

	const userMetaById = createMemo(() => {
		const map = new Map<string, AnalyticsUserMeta>()
		for (const u of detection()?.userDirectory?.users ?? []) {
			map.set(u.id, u)
		}
		return map
	})

	function formatActorName(id: string): string {
		const u = userMetaById().get(id)
		return u?.label ? u.label : id
	}

	function loadSavedExcluded(connId: string): string[] {
		try {
			const raw = localStorage.getItem(`datadip:analytics:excluded:${connId}`)
			if (!raw) return []
			const arr = JSON.parse(raw)
			return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
		} catch {
			return []
		}
	}

	function updateExcludedActors(updater: (prev: string[]) => string[]) {
		setExcludedActors((prev) => {
			const next = [...new Set(updater(prev))]
			try {
				localStorage.setItem(`datadip:analytics:excluded:${props.connId}`, JSON.stringify(next))
			} catch {}
			return next
		})
	}

	function toggleExcludedActor(id: string) {
		updateExcludedActors((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
	}

	const hasAdminDetection = createMemo(() =>
		Boolean(detection()?.adminColumn || detection()?.userDirectory?.adminColumn),
	)
	const hasTestDetection = createMemo(() => Boolean(detection()?.userDirectory?.testColumn))
	const hasDualActors = createMemo(() => Boolean(detection()?.userIdColumn && detection()?.visitorIdColumn))

	const normalizedTopEventNames = createMemo(() => {
		const det = detection()
		if (!det) return []
		const norm = normalizeUrls()
		const seen = new Set<string>()
		const out: string[] = []
		for (const e of det.topEvents) {
			const name = norm ? normalizeEventName(e.event) : e.event
			if (!seen.has(name)) {
				seen.add(name)
				out.push(name)
			}
		}
		return out
	})

	const effectiveFilters = createMemo<AnalyticsFilter[]>(() => {
		const list = [...customFilters()]
		if (errorsOnly() && statusColumn()) {
			list.push({ column: statusColumn(), op: 'gte', value: '400' })
		}
		return list
	})

	// Sync dynamic <select> values whenever options or value change
	createEffect(
		() => [selectedTable(), availableTables()] as const,
		([v]) => {
			if (tableSelectEl && v) tableSelectEl.value = v
		},
	)
	createEffect(
		() => [timeColumn(), activeColumns()] as const,
		([v]) => {
			if (timeSelectEl) timeSelectEl.value = v
		},
	)
	createEffect(
		() => [eventColumn(), activeColumns()] as const,
		([v]) => {
			if (eventSelectEl) eventSelectEl.value = v
		},
	)
	createEffect(
		() => [actorColumn(), actorOptions()] as const,
		([v]) => {
			if (actorSelectEl) actorSelectEl.value = v
		},
	)
	createEffect(
		() => [breakdownCol(), activeColumns()] as const,
		([v]) => {
			if (breakdownSelectEl) breakdownSelectEl.value = v
		},
	)
	createEffect(
		() => [draftFilterCol(), activeColumns()] as const,
		([v]) => {
			if (filterColSelectEl && v) filterColSelectEl.value = v
		},
	)
	createEffect(
		() => [actorsSort(), statusColumn()] as const,
		([v]) => {
			if (actorsSortSelectEl) actorsSortSelectEl.value = v
		},
	)

	// Load saved charts for connection
	createEffect(
		() => props.connId,
		(connId) => {
			if (!connId) return
			api
				.listAnalyticsCharts(connId)
				.then((r) => setSavedCharts(r.charts))
				.catch(() => setSavedCharts([]))
		},
	)

	// Auto-detect table schema & top events whenever connection or requested table changes
	createEffect(
		() => [props.connId, props.initialTable, props.schema?.tables.length ?? 0] as const,
		([connId, initTable, tableCount]) => {
			if (!connId || tableCount === 0) return
			void runDetect(connId, initTable)
		},
	)

	async function runDetect(connId: string, table: string | null) {
		setDetecting(true)
		setError(null)
		try {
			const det = await api.analyticsDetect(connId, table)
			setDetection(det)
			setSelectedTable(det.table)
			setTimeColumn(det.timeColumn ?? '')
			setTimeFormat(det.timeFormat)
			setEventColumn(det.eventColumn ?? '')
			setActorColumn(det.defaultActorColumn ?? '')
			setStatusColumn(det.statusColumn ?? '')
			setNormalizeUrls(det.looksLikeHttpEvents)
			const useUrlInit = !appliedInitialUrl
			appliedInitialUrl = true
			setBreakdownCol(
				useUrlInit && props.initialBreakdown !== null && props.initialBreakdown !== undefined
					? props.initialBreakdown
					: (det.eventColumn ?? ''),
			)
			if (useUrlInit && props.initialMetric) setMetric(props.initialMetric)
			if (useUrlInit && props.initialChartType) setChartType(props.initialChartType)
			setSelectedEvents([])
			setExcludeAdmin(Boolean(det.adminColumn || det.userDirectory?.adminColumn))
			// On local dev DBs where every user is marked test=1, keep test users visible by default so charts aren't empty.
			const hasRealNonTestUsers = Boolean(
				det.userDirectory?.testColumn &&
				det.userDirectory.testCount > 0 &&
				det.userDirectory.testCount < det.userDirectory.totalUsers,
			)
			setExcludeTestUsers(hasRealNonTestUsers)
			setSignedInOnly(Boolean(det.userIdColumn && det.visitorIdColumn))
			setExcludedActors(loadSavedExcluded(connId))
			setErrorsOnly(false)
			setCustomFilters([])
			setDraftFilterCol(det.eventColumn ?? det.statusColumn ?? det.timeColumn ?? '')

			// Pick smart initial range based on observed time span (unless explicitly provided in URL)
			if (useUrlInit && props.initialRange) {
				setRange(props.initialRange)
				setIntervalVal(props.initialInterval ?? defaultIntervalForRange(props.initialRange))
			} else if (det.minTimeMs !== null && det.maxTimeMs !== null) {
				const spanDays = (det.maxTimeMs - det.minTimeMs) / 86_400_000
				if (spanDays <= 1.5) {
					setRange('24h')
					setIntervalVal('hour')
				} else if (spanDays <= 8) {
					setRange('7d')
					setIntervalVal('day')
				} else if (spanDays <= 35) {
					setRange('30d')
					setIntervalVal('day')
				} else {
					setRange('30d')
					setIntervalVal('day')
				}
			}

			// Seed smart initial funnel steps from top events
			const names = det.topEvents.map((e) => (det.looksLikeHttpEvents ? normalizeEventName(e.event) : e.event))
			setFunnelSteps(suggestInitialFunnelSteps(names))
			setRetCohortEvent('')
			setRetReturnEvent('')
			setSelectedActorId(useUrlInit && props.initialActorId ? props.initialActorId : null)
			setJourneyData(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setDetecting(false)
		}
	}

	function baseConfig(opts?: { allowAnonymous?: boolean }) {
		const det = detection()
		const wantSignedIn = !opts?.allowAnonymous && signedInOnly() && Boolean(det?.userIdColumn)
		return {
			table: selectedTable(),
			timeColumn: timeColumn(),
			timeFormat: timeFormat(),
			eventColumn: eventColumn() || null,
			actorColumn: actorColumn() || null,
			userIdColumn: det?.userIdColumn ?? null,
			visitorIdColumn: det?.visitorIdColumn ?? null,
			statusColumn: statusColumn() || null,
			payloadColumn: det?.payloadColumn ?? null,
			range: range(),
			anchorEndMs: det?.maxTimeMs ?? null,
			filters: effectiveFilters(),
			normalizeUrls: normalizeUrls(),
			excludeAdmin: excludeAdmin(),
			excludeTestUsers: excludeTestUsers(),
			signedInOnly: wantSignedIn,
			excludedActors: excludedActors(),
		}
	}

	const exclusionKey = createMemo(() =>
		[excludeAdmin(), excludeTestUsers(), signedInOnly(), excludedActors().join(',')].join('|'),
	)

	function cancelActiveQuery() {
		if (activeQueryId) {
			const qid = activeQueryId
			activeQueryId = null
			void api.cancelQuery(props.connId, qid).catch(() => {})
		}
	}

	// Reactive query runner for Trends
	createEffect(
		() =>
			[
				props.mode,
				props.connId,
				selectedTable(),
				timeColumn(),
				timeFormat(),
				eventColumn(),
				actorColumn(),
				statusColumn(),
				range(),
				interval(),
				metric(),
				breakdownCol(),
				selectedEvents().join('|'),
				normalizeUrls(),
				JSON.stringify(effectiveFilters()),
				exclusionKey(),
				refreshTick(),
			] as const,
		([mode, connId, tbl, tCol]) => {
			if (mode !== 'trends' || !connId || !tbl || !tCol) return
			cancelActiveQuery()
			const qid = tid('q')
			activeQueryId = qid
			let stale = false
			setTrendsLoading(true)
			setError(null)
			api
				.analyticsTrends(connId, {
					...baseConfig(),
					interval: interval(),
					metric: metric(),
					breakdownColumn: breakdownCol() || null,
					selectedEvents: selectedEvents(),
					topN: 6,
					queryId: qid,
				})
				.then((res) => {
					if (!stale) setTrendsData(res)
				})
				.catch((err) => {
					if (!stale) setError(err instanceof Error ? err.message : String(err))
				})
				.finally(() => {
					if (!stale) setTrendsLoading(false)
					if (activeQueryId === qid) activeQueryId = null
				})
			return () => {
				stale = true
			}
		},
	)

	// Reactive query runner for Funnel
	createEffect(
		() =>
			[
				props.mode,
				props.connId,
				selectedTable(),
				timeColumn(),
				timeFormat(),
				eventColumn(),
				actorColumn(),
				range(),
				normalizeUrls(),
				JSON.stringify(effectiveFilters()),
				exclusionKey(),
				JSON.stringify(funnelSteps()),
				funnelWindowSec(),
				stitchIdentity(),
				refreshTick(),
			] as const,
		([mode, connId, tbl, tCol, , evCol, actCol]) => {
			const steps = funnelSteps().filter((s) => s.pattern.trim().length > 0)
			if (mode !== 'funnel' || !connId || !tbl || !tCol || !evCol || !actCol || steps.length === 0) {
				if (mode === 'funnel' && (!evCol || !actCol)) setFunnelData(null)
				return
			}
			cancelActiveQuery()
			const qid = tid('q')
			activeQueryId = qid
			let stale = false
			setFunnelLoading(true)
			setError(null)
			api
				.analyticsFunnel(connId, {
					...baseConfig({ allowAnonymous: stitchIdentity() }),
					steps,
					windowSeconds: funnelWindowSec(),
					stitchIdentity: stitchIdentity(),
					queryId: qid,
				})
				.then((res) => {
					if (!stale) setFunnelData(res)
				})
				.catch((err) => {
					if (!stale) setError(err instanceof Error ? err.message : String(err))
				})
				.finally(() => {
					if (!stale) setFunnelLoading(false)
					if (activeQueryId === qid) activeQueryId = null
				})
			return () => {
				stale = true
			}
		},
	)

	// Reactive query runner for Retention
	createEffect(
		() =>
			[
				props.mode,
				props.connId,
				selectedTable(),
				timeColumn(),
				timeFormat(),
				eventColumn(),
				actorColumn(),
				range(),
				normalizeUrls(),
				JSON.stringify(effectiveFilters()),
				exclusionKey(),
				retGranularity(),
				retPeriods(),
				retCohortEvent(),
				retReturnEvent(),
				stitchIdentity(),
				refreshTick(),
			] as const,
		([mode, connId, tbl, tCol, , , actCol]) => {
			if (mode !== 'retention' || !connId || !tbl || !tCol) return
			if (!actCol) {
				setRetData(null)
				return
			}
			cancelActiveQuery()
			const qid = tid('q')
			activeQueryId = qid
			let stale = false
			setRetLoading(true)
			setError(null)
			api
				.analyticsRetention(connId, {
					...baseConfig({ allowAnonymous: stitchIdentity() }),
					granularity: retGranularity(),
					periods: retPeriods(),
					cohortEvent: retCohortEvent() || null,
					returnEvent: retReturnEvent() || null,
					stitchIdentity: stitchIdentity(),
					queryId: qid,
				})
				.then((res) => {
					if (!stale) setRetData(res)
				})
				.catch((err) => {
					if (!stale) setError(err instanceof Error ? err.message : String(err))
				})
				.finally(() => {
					if (!stale) setRetLoading(false)
					if (activeQueryId === qid) activeQueryId = null
				})
			return () => {
				stale = true
			}
		},
	)

	// Reactive query runner for Actors list
	createEffect(
		() =>
			[
				props.mode,
				props.connId,
				selectedTable(),
				timeColumn(),
				timeFormat(),
				actorColumn(),
				statusColumn(),
				range(),
				normalizeUrls(),
				JSON.stringify(effectiveFilters()),
				exclusionKey(),
				actorsSort(),
				actorsSearch(),
				refreshTick(),
			] as const,
		([mode, connId, tbl, tCol, , actCol]) => {
			if (mode !== 'actors' || !connId || !tbl || !tCol) return
			if (!actCol) {
				setActorsData(null)
				setJourneyData(null)
				return
			}
			cancelActiveQuery()
			const qid = tid('q')
			activeQueryId = qid
			let stale = false
			setActorsLoading(true)
			setError(null)
			api
				.analyticsActors(connId, {
					...baseConfig(),
					sortBy: actorsSort(),
					search: actorsSearch(),
					limit: 100,
					queryId: qid,
				})
				.then((res) => {
					if (stale) return
					setActorsData(res)
					if (!selectedActorId() && res.actors.length > 0) {
						setSelectedActorId(res.actors[0]!.actorId)
					}
				})
				.catch((err) => {
					if (!stale) setError(err instanceof Error ? err.message : String(err))
				})
				.finally(() => {
					if (!stale) setActorsLoading(false)
					if (activeQueryId === qid) activeQueryId = null
				})
			return () => {
				stale = true
			}
		},
	)

	// Load selected actor journey
	createEffect(
		() =>
			[
				props.mode,
				props.connId,
				selectedTable(),
				timeColumn(),
				selectedActorId(),
				range(),
				normalizeUrls(),
				refreshTick(),
			] as const,
		([mode, connId, tbl, tCol, actorId]) => {
			if (mode !== 'actors' || !connId || !tbl || !tCol || !actorId) return
			const qid = tid('q')
			let stale = false
			setJourneyLoading(true)
			api
				.analyticsJourney(connId, {
					...baseConfig(),
					actorId,
					limit: 250,
					queryId: qid,
				})
				.then((res) => {
					if (!stale) setJourneyData(res)
				})
				.catch(() => {
					if (!stale) setJourneyData(null)
				})
				.finally(() => {
					if (!stale) setJourneyLoading(false)
				})
			return () => {
				stale = true
			}
		},
	)

	function currentGeneratedSql(): string {
		if (props.mode === 'trends') return trendsData()?.sql ?? ''
		if (props.mode === 'funnel') return funnelData()?.sql ?? ''
		if (props.mode === 'retention') return retData()?.sql ?? ''
		if (props.mode === 'actors') return journeyData()?.sql ?? actorsData()?.sql ?? ''
		return ''
	}

	function drillDownBucket(bucketIdx: number) {
		const td = trendsData()
		if (!td || !selectedTable() || !timeColumn()) return
		const startMs = td.buckets[bucketIdx]
		if (startMs === undefined) return
		const endMs = nextBucketMs(startMs, td.interval) - 1
		const fmtVal = (ms: number, isStart: boolean) => {
			const fmt = timeFormat()
			if (fmt === 'epoch_ms') return String(ms)
			if (fmt === 'epoch_us') return String(ms * 1000)
			if (fmt === 'epoch_s') return String(Math.floor(ms / 1000))
			if (fmt === 'cocoa_s') return (ms / 1000 - 978_307_200).toFixed(3)
			// Space-separated UTC start compares cleanly against both SQLite `YYYY-MM-DD HH:MM:SS` and ISO `T...Z` strings
			return isStart ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : new Date(ms).toISOString()
		}
		const filters: FilterSpec[] = [
			{ column: timeColumn(), op: 'gte', value: fmtVal(startMs, true) },
			{ column: timeColumn(), op: 'lte', value: fmtVal(endMs, false) },
		]
		for (const f of effectiveFilters()) {
			if (f.op === 'not_like') continue
			filters.push({ column: f.column, op: f.op, value: f.value })
		}
		if (selectedEvents().length === 1 && eventColumn()) {
			const ev = selectedEvents()[0]!
			filters.push({
				column: eventColumn(),
				op: ev.includes(':id') ? 'like' : 'eq',
				value: ev.includes(':id') ? ev.replaceAll(':id', '%') : ev,
			})
		}
		props.onOpenTable(selectedTable(), filters)
	}

	function inspectActorInPeople(actorId: string) {
		setSelectedActorId(actorId)
		props.onChangeRoute({ mode: 'actors', actor: actorId })
	}

	async function handleSaveChart() {
		const mode = props.mode === 'dashboard' ? 'trends' : props.mode
		const title =
			saveTitle().trim() ||
			`${selectedTable()} · ${mode === 'trends' ? (metric() === 'unique_actors' ? 'Unique People' : 'Trends') : mode[0]!.toUpperCase() + mode.slice(1)}`
		const config: Record<string, unknown> = {
			table: selectedTable(),
			timeColumn: timeColumn(),
			timeFormat: timeFormat(),
			eventColumn: eventColumn(),
			actorColumn: actorColumn(),
			statusColumn: statusColumn(),
			range: range(),
			interval: interval(),
			metric: metric(),
			chartType: chartType(),
			breakdownCol: breakdownCol(),
			selectedEvents: selectedEvents(),
			normalizeUrls: normalizeUrls(),
			excludeAdmin: excludeAdmin(),
			excludeTestUsers: excludeTestUsers(),
			signedInOnly: signedInOnly(),
			excludedActors: excludedActors(),
			errorsOnly: errorsOnly(),
			customFilters: customFilters(),
			funnelSteps: funnelSteps(),
			funnelWindowSec: funnelWindowSec(),
			stitchIdentity: stitchIdentity(),
			retGranularity: retGranularity(),
			retPeriods: retPeriods(),
			retCohortEvent: retCohortEvent(),
			retReturnEvent: retReturnEvent(),
		}
		try {
			const res = await api.saveAnalyticsChart(props.connId, { title, mode, config })
			setSavedCharts((prev) => [res.chart, ...prev.filter((c) => c.id !== res.chart.id)])
			setSavePopoverOpen(false)
			setSaveTitle('')
			props.onNotify(`Saved "${res.chart.title}"`, 'ok')
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	async function loadSavedChart(chart: SavedAnalyticsChart) {
		const c = chart.config
		const targetTable = typeof c.table === 'string' && c.table ? c.table : selectedTable()
		props.onChangeRoute({ table: targetTable, mode: chart.mode })
		if (targetTable && targetTable !== selectedTable()) {
			await runDetect(props.connId, targetTable)
		}
		if (typeof c.timeColumn === 'string') setTimeColumn(c.timeColumn)
		if (typeof c.timeFormat === 'string') setTimeFormat(c.timeFormat as TimeColumnFormat)
		if (typeof c.eventColumn === 'string') setEventColumn(c.eventColumn)
		if (typeof c.actorColumn === 'string') setActorColumn(c.actorColumn)
		if (typeof c.statusColumn === 'string') setStatusColumn(c.statusColumn)
		if (typeof c.range === 'string') setRange(c.range as AnalyticsRange)
		if (typeof c.interval === 'string') setIntervalVal(c.interval as AnalyticsInterval)
		if (typeof c.metric === 'string') setMetric(c.metric as AnalyticsMetric)
		if (typeof c.chartType === 'string') setChartType(c.chartType as AnalyticsChartType)
		if (typeof c.breakdownCol === 'string') setBreakdownCol(c.breakdownCol)
		if (Array.isArray(c.selectedEvents)) setSelectedEvents(c.selectedEvents.map(String))
		if (typeof c.normalizeUrls === 'boolean') setNormalizeUrls(c.normalizeUrls)
		if (typeof c.excludeAdmin === 'boolean') setExcludeAdmin(c.excludeAdmin)
		if (typeof c.excludeTestUsers === 'boolean') setExcludeTestUsers(c.excludeTestUsers)
		if (typeof c.signedInOnly === 'boolean') setSignedInOnly(c.signedInOnly)
		if (Array.isArray(c.excludedActors)) updateExcludedActors(() => c.excludedActors as string[])
		if (typeof c.errorsOnly === 'boolean') setErrorsOnly(c.errorsOnly)
		if (Array.isArray(c.customFilters)) setCustomFilters(c.customFilters as AnalyticsFilter[])
		if (Array.isArray(c.funnelSteps)) setFunnelSteps(c.funnelSteps as FunnelStepSpec[])
		if (typeof c.funnelWindowSec === 'number' || c.funnelWindowSec === null) setFunnelWindowSec(c.funnelWindowSec)
		if (typeof c.stitchIdentity === 'boolean') setStitchIdentity(c.stitchIdentity)
		if (c.retGranularity === 'day' || c.retGranularity === 'week') setRetGranularity(c.retGranularity)
		if (typeof c.retPeriods === 'number') setRetPeriods(c.retPeriods)
		if (typeof c.retCohortEvent === 'string') setRetCohortEvent(c.retCohortEvent)
		if (typeof c.retReturnEvent === 'string') setRetReturnEvent(c.retReturnEvent)
	}

	async function deleteSavedChart(id: string) {
		try {
			await api.deleteAnalyticsChart(id)
			setSavedCharts((prev) => prev.filter((c) => c.id !== id))
			props.onNotify('Deleted saved chart', 'info')
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	// Group journey events into sessions (30-min inactivity gap)
	const journeySessions = createMemo(() => {
		const evs = journeyData()?.events ?? []
		if (evs.length === 0) return []
		// Events arrive newest-first; group into chronological sessions displayed newest session first
		const sessions: { startMs: number; endMs: number; events: typeof evs }[] = []
		const GAP_MS = 30 * 60 * 1000
		let cur: typeof evs = []
		for (const ev of evs) {
			if (cur.length > 0 && cur[cur.length - 1]!.tsMs - ev.tsMs > GAP_MS) {
				sessions.push({ startMs: cur[cur.length - 1]!.tsMs, endMs: cur[0]!.tsMs, events: cur })
				cur = []
			}
			cur.push(ev)
		}
		if (cur.length > 0) {
			sessions.push({ startMs: cur[cur.length - 1]!.tsMs, endMs: cur[0]!.tsMs, events: cur })
		}
		return sessions
	})

	const userFkTarget = createMemo(() => {
		const ts = activeTableSchema()
		const uCol = detection()?.userIdColumn
		if (!ts || !uCol) return null
		return ts.foreignKeys.find((fk) => fk.fromColumn === uCol) ?? null
	})

	const trendsLabels = createMemo(() => {
		const td = trendsData()
		if (!td) return []
		return td.buckets.map((ms) => formatBucketLabel(ms, td.interval, false, tz()))
	})

	const trendsFullLabels = createMemo(() => {
		const td = trendsData()
		if (!td) return []
		return td.buckets.map((ms) => formatBucketLabel(ms, td.interval, true, tz()))
	})

	return (
		<div class="main-pane analytics-pane">
			{/* Top mode & range toolbar */}
			<div class="view-toolbar analytics-toolbar">
				<div class="tab-group" role="tablist" aria-label="Analytics modes">
					{(
						[
							['trends', 'Trends'],
							['funnel', 'Funnel'],
							['retention', 'Retention'],
							['actors', 'People'],
							['dashboard', `Saved (${savedCharts().length})`],
						] as const
					).map(([id, label]) => (
						<button
							type="button"
							role="tab"
							aria-selected={props.mode === id ? 'true' : 'false'}
							class={['tab-btn', { active: props.mode === id }]}
							onClick={() => props.onChangeRoute({ mode: id })}
						>
							{label}
						</button>
					))}
				</div>

				{/* Table picker */}
				<label class="analytics-field-inline">
					<IconTable />
					<select
						ref={(el) => (tableSelectEl = el)}
						class="select sm mono"
						aria-label="Analytics table"
						value={selectedTable()}
						onChange={(e) => {
							const tbl = e.currentTarget.value
							props.onChangeRoute({ table: tbl })
							void runDetect(props.connId, tbl)
						}}
					>
						<For each={availableTables()}>
							{(t) => (
								<option value={t.name} selected={selectedTable() === t.name}>
									{t.name}
									{t.rowCount !== null ? ` (${t.rowCount.toLocaleString()})` : ''}
								</option>
							)}
						</For>
					</select>
				</label>

				{/* Date range pills */}
				<div class="tab-group" aria-label="Date range">
					<For each={RANGES}>
						{(r) => (
							<button
								type="button"
								class={['tab-btn mono', { active: range() === r.id }]}
								onClick={() => {
									const nextIv = defaultIntervalForRange(r.id)
									setRange(r.id)
									setIntervalVal(nextIv)
									props.onChangeRoute({ range: r.id, interval: nextIv }, true)
								}}
							>
								{r.label}
							</button>
						)}
					</For>
				</div>

				<Show when={props.mode === 'trends'}>
					<select
						class="select sm"
						aria-label="Bucket interval"
						value={interval()}
						onChange={(e) => {
							const next = e.currentTarget.value as AnalyticsInterval
							setIntervalVal(next)
							props.onChangeRoute({ interval: next }, true)
						}}
					>
						<For each={INTERVALS}>
							{(iv) => (
								<option value={iv.id} selected={interval() === iv.id}>
									{iv.label}
								</option>
							)}
						</For>
					</select>
				</Show>

				<Show when={props.mode !== 'dashboard'}>
					<button
						type="button"
						class="btn sm mono"
						title="Toggle chart and timeline display timezone between UTC and Local time"
						onClick={toggleTz}
					>
						{tz() === 'utc' ? 'UTC' : 'Local'}
					</button>
				</Show>

				<div style="flex:1" />

				{/* Save chart button + popover */}
				<Show when={props.mode !== 'dashboard'}>
					<div style="position:relative">
						<button
							type="button"
							class="btn sm"
							onClick={() => {
								setSaveTitle(
									`${selectedTable()} · ${props.mode === 'trends' ? (metric() === 'unique_actors' ? 'Unique People' : 'Trends') : props.mode[0]!.toUpperCase() + props.mode.slice(1)}`,
								)
								setSavePopoverOpen((v) => !v)
							}}
						>
							Save
						</button>
						<Show when={savePopoverOpen()}>
							<div class="analytics-popover" style="right:0;top:32px;width:270px">
								<div class="field-label" style="margin-bottom:6px">
									Save chart to this database
								</div>
								<input
									class="input"
									style="height:28px;margin-bottom:8px"
									placeholder="Chart title…"
									value={saveTitle()}
									onInput={(e) => setSaveTitle(e.currentTarget.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') void handleSaveChart()
										if (e.key === 'Escape') setSavePopoverOpen(false)
									}}
								/>
								<div style="display:flex;justify-content:flex-end;gap:6px">
									<button type="button" class="btn sm" onClick={() => setSavePopoverOpen(false)}>
										Cancel
									</button>
									<button type="button" class="btn sm primary" onClick={() => void handleSaveChart()}>
										Save Chart
									</button>
								</div>
							</div>
						</Show>
					</div>
				</Show>

				<Show when={currentGeneratedSql()}>
					<button
						type="button"
						class="btn sm"
						title="Open the exact SQL query in a Console tab"
						onClick={() => props.onOpenInSql(currentGeneratedSql())}
					>
						<IconSql />
						SQL
					</button>
				</Show>

				<Show when={trendsLoading() || funnelLoading() || retLoading() || actorsLoading()}>
					<button
						type="button"
						class="btn sm danger"
						title="Cancel running analytics query"
						onClick={() => {
							cancelActiveQuery()
							setTrendsLoading(false)
							setFunnelLoading(false)
							setRetLoading(false)
							setActorsLoading(false)
							props.onNotify('Cancelled analytics query', 'info')
						}}
					>
						Stop
					</button>
				</Show>

				<button
					type="button"
					class="icon-btn ghost"
					style="width:26px;height:26px"
					title="Refresh analytics"
					aria-label="Refresh analytics"
					onClick={() => setRefreshTick((n) => n + 1)}
				>
					<IconRefresh />
				</button>
			</div>

			{/* Compact Schema Mapping & Quick Filter Strip */}
			<Show when={props.mode !== 'dashboard' && activeTableSchema()}>
				<div class="analytics-config-strip">
					<label class="analytics-field-inline">
						<span>Time</span>
						<select
							ref={(el) => (timeSelectEl = el)}
							class="select sm mono"
							value={timeColumn()}
							onChange={(e) => setTimeColumn(e.currentTarget.value)}
						>
							<option value="">(none)</option>
							<For each={activeColumns()}>
								{(c) => (
									<option value={c.name} selected={timeColumn() === c.name}>
										{c.name}
									</option>
								)}
							</For>
						</select>
					</label>

					<select
						class="select sm mono"
						style="width:auto"
						title="Timestamp unit"
						aria-label="Timestamp format"
						value={timeFormat()}
						onChange={(e) => setTimeFormat(e.currentTarget.value as TimeColumnFormat)}
					>
						<option value="epoch_ms" selected={timeFormat() === 'epoch_ms'}>
							ms
						</option>
						<option value="epoch_s" selected={timeFormat() === 'epoch_s'}>
							sec
						</option>
						<option value="epoch_us" selected={timeFormat() === 'epoch_us'}>
							µs
						</option>
						<option value="cocoa_s" selected={timeFormat() === 'cocoa_s'}>
							Cocoa
						</option>
						<option value="iso" selected={timeFormat() === 'iso'}>
							ISO
						</option>
					</select>

					<label class="analytics-field-inline">
						<span>Event</span>
						<select
							ref={(el) => (eventSelectEl = el)}
							class="select sm mono"
							value={eventColumn()}
							onChange={(e) => {
								const next = e.currentTarget.value
								setEventColumn(next)
								if (props.mode === 'trends') setBreakdownCol(next)
							}}
						>
							<option value="">(none)</option>
							<For each={activeColumns()}>
								{(c) => (
									<option value={c.name} selected={eventColumn() === c.name}>
										{c.name}
									</option>
								)}
							</For>
						</select>
					</label>

					<label class="analytics-field-inline">
						<span>Person</span>
						<select
							ref={(el) => (actorSelectEl = el)}
							class="select sm mono"
							value={actorColumn()}
							onChange={(e) => {
								const next = e.currentTarget.value
								setActorColumn(next)
								if (next === STITCHED_ACTOR_SENTINEL || next === detection()?.visitorIdColumn) {
									setSignedInOnly(false)
								} else if (next === detection()?.userIdColumn && detection()?.visitorIdColumn) {
									setSignedInOnly(true)
								}
							}}
						>
							<option value="">(none)</option>
							<For each={actorOptions()}>
								{(o) => (
									<option value={o.value} selected={actorColumn() === o.value}>
										{o.label}
									</option>
								)}
							</For>
						</select>
					</label>

					<Show when={hasDualActors()}>
						<button
							type="button"
							class={['btn sm', { 'active-toggle': signedInOnly() }]}
							title={`Exclude anonymous rows where ${detection()!.userIdColumn} IS NULL (hides anonymous visitors and bot scanners)`}
							onClick={() => {
								const next = !signedInOnly()
								setSignedInOnly(next)
								if (next && detection()?.userIdColumn) {
									setActorColumn(detection()!.userIdColumn!)
								} else if (!next && detection()?.userIdColumn && detection()?.visitorIdColumn) {
									setActorColumn(STITCHED_ACTOR_SENTINEL)
								}
							}}
						>
							Signed-in only
						</button>
					</Show>

					<Show when={hasAdminDetection()}>
						<button
							type="button"
							class={['btn sm', { 'active-toggle': excludeAdmin() }]}
							title={
								detection()?.userDirectory?.adminColumn
									? `Exclude admin users (${detection()!.userDirectory!.table}.${detection()!.userDirectory!.adminColumn} = 1)${detection()?.adminColumn ? ` and ${detection()!.adminColumn} IS NOT NULL` : ''}`
									: `Exclude rows where ${detection()!.adminColumn} IS NOT NULL`
							}
							onClick={() => setExcludeAdmin((v) => !v)}
						>
							Exclude admins
							<Show when={(detection()?.userDirectory?.adminCount ?? 0) > 0}>
								<span class="mono" style="opacity:0.75">
									({detection()!.userDirectory!.adminCount})
								</span>
							</Show>
						</button>
					</Show>

					<Show when={hasTestDetection()}>
						<button
							type="button"
							class={['btn sm', { 'active-toggle': excludeTestUsers() }]}
							title={`Exclude test users where ${detection()!.userDirectory!.table}.${detection()!.userDirectory!.testColumn} = 1`}
							onClick={() => setExcludeTestUsers((v) => !v)}
						>
							Exclude test
							<Show when={(detection()?.userDirectory?.testCount ?? 0) > 0}>
								<span class="mono" style="opacity:0.75">
									({detection()!.userDirectory!.testCount})
								</span>
							</Show>
						</button>
					</Show>

					{/* Exclude specific users / test accounts popover (persisted per connection) */}
					<Show when={(detection()?.userDirectory?.users.length ?? 0) > 0 || excludedActors().length > 0}>
						<div style="position:relative">
							<button
								type="button"
								class={['btn sm', { 'active-toggle': excludedActors().length > 0 }]}
								title="Exclude specific test, internal, or noisy users across all analytics views (saved per connection)"
								onClick={() => setShowExcludePopover((v) => !v)}
							>
								Exclude people
								<Show when={excludedActors().length > 0}>
									<span class="mono">({excludedActors().length})</span>
								</Show>
							</button>
							<Show when={showExcludePopover()}>
								<div class="analytics-popover" style="left:0;top:30px;width:310px">
									<div style="display:flex;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:6px">
										<strong style="font-size:12px">Exclude people</strong>
										<div style="display:flex;gap:4px">
											<Show when={(detection()?.userDirectory?.users ?? []).some((u) => u.looksLikeTest)}>
												<button
													type="button"
													class="btn sm"
													style="height:22px;font-size:11px;padding:0 6px"
													onClick={() => {
														const ids = (detection()?.userDirectory?.users ?? [])
															.filter((u) => u.looksLikeTest)
															.map((u) => u.id)
														updateExcludedActors((prev) => [...prev, ...ids])
													}}
												>
													+ Test-named
												</button>
											</Show>
											<Show when={excludedActors().length > 0}>
												<button
													type="button"
													class="btn sm"
													style="height:22px;font-size:11px;padding:0 6px"
													onClick={() => updateExcludedActors(() => [])}
												>
													Clear
												</button>
											</Show>
										</div>
									</div>
									<input
										class="input mono"
										style="width:100%;height:26px;font-size:11.5px;margin-bottom:6px"
										placeholder="Search username or ID…"
										value={excludeSearch()}
										onInput={(e) => setExcludeSearch(e.currentTarget.value)}
									/>
									<div class="exclude-people-list">
										<For
											each={(() => {
												const q = excludeSearch().trim().toLowerCase()
												const dirUsers = detection()?.userDirectory?.users ?? []
												const knownIds = new Set(dirUsers.map((u) => u.id))
												const extra: AnalyticsUserMeta[] = excludedActors()
													.filter((id) => !knownIds.has(id))
													.map((id) => ({ id, label: null, isAdmin: false, isTest: false, looksLikeTest: false }))
												const all = [...extra, ...dirUsers]
												if (!q) return all.slice(0, 60)
												return all
													.filter(
														(u) => u.id.toLowerCase().includes(q) || (u.label && u.label.toLowerCase().includes(q)),
													)
													.slice(0, 60)
											})()}
										>
											{(u) => {
												const checked = () => excludedActors().includes(u.id)
												const hiddenByFlag = () => (u.isAdmin && excludeAdmin()) || (u.isTest && excludeTestUsers())
												return (
													<label class={['exclude-person-row', { muted: hiddenByFlag() }]}>
														<input type="checkbox" checked={checked()} onChange={() => toggleExcludedActor(u.id)} />
														<span class="exclude-person-name">
															<strong>{u.label ?? u.id}</strong>
															<Show when={u.label}>
																<span class="mono" style="color:var(--ink-muted);font-size:10.5px;margin-left:5px">
																	{u.id}
																</span>
															</Show>
														</span>
														<Show when={u.isAdmin}>
															<span class="tag mono" style="font-size:9.5px">
																admin
															</span>
														</Show>
														<Show when={u.isTest}>
															<span class="tag mono" style="font-size:9.5px">
																test
															</span>
														</Show>
														<Show when={!u.isTest && u.looksLikeTest}>
															<span class="tag mono" style="font-size:9.5px;color:var(--warn)">
																test?
															</span>
														</Show>
													</label>
												)
											}}
										</For>
									</div>
									<div style="display:flex;justify-content:flex-end;margin-top:6px">
										<button type="button" class="btn sm" onClick={() => setShowExcludePopover(false)}>
											Done
										</button>
									</div>
								</div>
							</Show>
						</div>
					</Show>

					<Show when={eventColumn()}>
						<button
							type="button"
							class={['btn sm', { 'active-toggle': normalizeUrls() }]}
							title="Collapse dynamic IDs and query strings in HTTP route events (e.g. /api/chats/:id)"
							onClick={() => setNormalizeUrls((v) => !v)}
						>
							Normalize URLs
						</button>
					</Show>

					<Show when={statusColumn()}>
						<button
							type="button"
							class={['btn sm', { 'active-toggle': errorsOnly() }]}
							title={`Only include rows where ${statusColumn()} >= 400`}
							onClick={() => setErrorsOnly((v) => !v)}
						>
							Errors ≥ 400
						</button>
					</Show>

					{/* Active custom filters */}
					<For each={customFilters()}>
						{(f, idx) => (
							<span class="analytics-filter-chip mono">
								{f.column} {f.op} {f.op === 'isnull' || f.op === 'notnull' ? '' : f.value}
								<button
									type="button"
									class="chip-x"
									aria-label="Remove filter"
									onClick={() => setCustomFilters((prev) => prev.filter((_, i) => i !== idx()))}
								>
									×
								</button>
							</span>
						)}
					</For>

					<div style="position:relative">
						<button
							type="button"
							class="btn sm"
							onClick={() => {
								if (!draftFilterCol() && activeColumns().length > 0) setDraftFilterCol(activeColumns()[0]!.name)
								setShowFilterAdder((v) => !v)
							}}
						>
							<IconPlus />
							Filter
						</button>
						<Show when={showFilterAdder()}>
							<div class="analytics-popover" style="left:0;top:30px;width:300px">
								<div style="display:flex;flex-direction:column;gap:8px">
									<select
										ref={(el) => (filterColSelectEl = el)}
										class="select sm mono"
										value={draftFilterCol()}
										onChange={(e) => setDraftFilterCol(e.currentTarget.value)}
									>
										<For each={activeColumns()}>
											{(c) => (
												<option value={c.name} selected={draftFilterCol() === c.name}>
													{c.name}
												</option>
											)}
										</For>
									</select>
									<select
										class="select sm mono"
										value={draftFilterOp()}
										onChange={(e) => setDraftFilterOp(e.currentTarget.value as AnalyticsFilterOp)}
									>
										<option value="eq">=</option>
										<option value="neq">!=</option>
										<option value="like">contains</option>
										<option value="not_like">not contains</option>
										<option value="gte">&gt;=</option>
										<option value="lte">&lt;=</option>
										<option value="isnull">is null</option>
										<option value="notnull">is not null</option>
									</select>
									<Show when={draftFilterOp() !== 'isnull' && draftFilterOp() !== 'notnull'}>
										<input
											class="input mono"
											style="height:28px"
											placeholder="Value…"
											value={draftFilterVal()}
											onInput={(e) => setDraftFilterVal(e.currentTarget.value)}
											onKeyDown={(e) => {
												if (e.key === 'Enter' && draftFilterCol()) {
													setCustomFilters((prev) => [
														...prev,
														{ column: draftFilterCol(), op: draftFilterOp(), value: draftFilterVal() },
													])
													setDraftFilterVal('')
													setShowFilterAdder(false)
												}
											}}
										/>
									</Show>
									<div style="display:flex;justify-content:flex-end;gap:6px">
										<button type="button" class="btn sm" onClick={() => setShowFilterAdder(false)}>
											Cancel
										</button>
										<button
											type="button"
											class="btn sm primary"
											onClick={() => {
												if (!draftFilterCol()) return
												setCustomFilters((prev) => [
													...prev,
													{ column: draftFilterCol(), op: draftFilterOp(), value: draftFilterVal() },
												])
												setDraftFilterVal('')
												setShowFilterAdder(false)
											}}
										>
											Apply
										</button>
									</div>
								</div>
							</div>
						</Show>
					</div>
				</div>
			</Show>

			{/* Main Scrollable Analytics Content */}
			<div class="analytics-body">
				<Show when={error()}>
					{(msg) => (
						<div class="error-box" style="margin-bottom:14px">
							{msg()}
						</div>
					)}
				</Show>

				<Show when={detecting() && !detection()}>
					<div class="chart-empty" style="height:260px">
						Inspecting table schema &amp; event distribution…
					</div>
				</Show>

				<Show when={!detecting() && !timeColumn() && props.mode !== 'dashboard'}>
					<div class="analytics-card" style="padding:24px;text-align:center">
						<p style="margin:0 0 8px;font-weight:600">No timestamp column detected on "{selectedTable()}"</p>
						<p style="margin:0;color:var(--ink-secondary);font-size:12.5px">
							Pick a table with a timestamp column (like <span class="mono">events</span> or{' '}
							<span class="mono">users</span>), or select the <span class="mono">Time</span> column manually above.
						</p>
					</div>
				</Show>

				{/* --- TRENDS MODE --- */}
				<Show when={props.mode === 'trends' && timeColumn()}>
					{/* KPI strip */}
					<div class="analytics-kpi-grid">
						<div class="analytics-kpi-card">
							<div class="analytics-kpi-label">Total {eventColumn() ? 'Events' : 'Rows'}</div>
							<div class="analytics-kpi-row">
								<span class="analytics-kpi-val mono">
									{trendsData() ? trendsData()!.kpis.totalEvents.toLocaleString() : '—'}
								</span>
								<Show when={typeof trendsData()?.kpis.deltaPct === 'number'}>
									<span class={['analytics-delta mono', (trendsData()?.kpis.deltaPct ?? 0) >= 0 ? 'up' : 'down']}>
										{(trendsData()?.kpis.deltaPct ?? 0) >= 0 ? '+' : ''}
										{trendsData()?.kpis.deltaPct}% vs prev
									</span>
								</Show>
							</div>
						</div>

						<div class="analytics-kpi-card">
							<div class="analytics-kpi-label">
								{signedInOnly() || actorColumn() === detection()?.userIdColumn ? 'Unique Users' : 'Unique People'}
							</div>
							<div class="analytics-kpi-row">
								<span class="analytics-kpi-val mono">
									{trendsData() ? trendsData()!.kpis.uniqueActors.toLocaleString() : '—'}
								</span>
								<span class="analytics-kpi-sub mono">
									{(() => {
										const k = trendsData()?.kpis
										if (!k) return actorColumn() || 'no actor'
										if (
											!signedInOnly() &&
											typeof k.uniqueUsers === 'number' &&
											typeof k.uniqueAnonVisitors === 'number'
										) {
											return `${k.uniqueUsers.toLocaleString()} users · ${k.uniqueAnonVisitors.toLocaleString()} anon`
										}
										if (signedInOnly()) return 'signed-in users'
										return actorColumn() || 'no actor'
									})()}
								</span>
							</div>
						</div>

						<div class="analytics-kpi-card">
							<div class="analytics-kpi-label">Avg / Person</div>
							<div class="analytics-kpi-row">
								<span class="analytics-kpi-val mono">
									{trendsData() ? trendsData()!.kpis.avgPerActor.toLocaleString() : '—'}
								</span>
								<span class="analytics-kpi-sub">in selected window</span>
							</div>
						</div>

						<Show
							when={trendsData()?.kpis.errorCount !== null && trendsData()?.kpis.errorCount !== undefined}
							fallback={
								<div class="analytics-kpi-card">
									<div class="analytics-kpi-label">Query Speed</div>
									<div class="analytics-kpi-row">
										<span class="analytics-kpi-val mono">{trendsData() ? `${trendsData()!.durationMs}ms` : '—'}</span>
										<span class="analytics-kpi-sub mono">
											{trendsData() ? `${trendsData()!.buckets.length} buckets` : ''}
										</span>
									</div>
								</div>
							}
						>
							<div class="analytics-kpi-card">
								<div class="analytics-kpi-label">Errors (≥ 400)</div>
								<div class="analytics-kpi-row">
									<span
										class="analytics-kpi-val mono"
										style={(trendsData()?.kpis.errorCount ?? 0) > 0 ? 'color:var(--prod)' : undefined}
									>
										{trendsData()!.kpis.errorCount!.toLocaleString()}
									</span>
									<Show when={trendsData()?.kpis.errorRatePct !== null}>
										<span class="analytics-kpi-sub mono">{trendsData()!.kpis.errorRatePct}% rate</span>
									</Show>
								</div>
							</div>
						</Show>
					</div>

					{/* Main Chart Card */}
					<div class="analytics-card">
						<div class="analytics-card-head">
							<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
								<div class="tab-group">
									{(
										[
											['events', 'Volume'],
											['unique_actors', 'Unique People'],
											['events_per_actor', 'Per Person'],
											['cumulative', 'Cumulative'],
										] as const
									).map(([id, label]) => (
										<button
											type="button"
											class={['tab-btn', { active: metric() === id }]}
											onClick={() => {
												setMetric(id)
												props.onChangeRoute({ metric: id }, true)
											}}
										>
											{label}
										</button>
									))}
								</div>

								<label class="analytics-field-inline">
									<span>Breakdown</span>
									<select
										ref={(el) => (breakdownSelectEl = el)}
										class="select sm mono"
										value={breakdownCol()}
										onChange={(e) => {
											const next = e.currentTarget.value
											setBreakdownCol(next)
											setSelectedEvents([])
											props.onChangeRoute({ breakdown: next }, true)
										}}
									>
										<option value="">None (Total)</option>
										<For each={activeColumns()}>
											{(c) => (
												<option value={c.name} selected={breakdownCol() === c.name}>
													{c.name}
												</option>
											)}
										</For>
									</select>
								</label>

								<Show when={selectedEvents().length > 0}>
									<button type="button" class="btn sm" onClick={() => setSelectedEvents([])}>
										Showing {selectedEvents().length} selected ×
									</button>
								</Show>
							</div>

							<div style="display:flex;align-items:center;gap:8px">
								<Show when={trendsLoading()}>
									<span class="mono" style="font-size:11px;color:var(--accent)">
										Loading…
									</span>
								</Show>
								<div class="tab-group">
									{(
										[
											['area', 'Area'],
											['line', 'Line'],
											['stacked_bar', 'Stacked'],
											['bar', 'Bar'],
										] as const
									).map(([id, label]) => (
										<button
											type="button"
											class={['tab-btn', { active: chartType() === id }]}
											onClick={() => {
												setChartType(id)
												props.onChangeRoute({ chart: id }, true)
											}}
										>
											{label}
										</button>
									))}
								</div>
							</div>
						</div>

						<div style="padding:12px 14px 10px">
							<Show
								when={trendsData()}
								fallback={
									<div class="chart-empty" style="height:290px">
										Loading chart…
									</div>
								}
							>
								{(td) => (
									<TimeSeriesChart
										labels={trendsLabels()}
										fullLabels={trendsFullLabels()}
										bucketsMs={td().buckets}
										series={td().series}
										chartType={chartType()}
										height={290}
										exportFilename={`${selectedTable() || 'analytics'}-${metric()}-${range()}.svg`}
										onClickBucket={drillDownBucket}
									/>
								)}
							</Show>
						</div>
					</div>

					{/* Top Events Breakdown Table */}
					<Show when={(trendsData()?.topEvents.length ?? 0) > 0}>
						<div class="analytics-card" style="margin-top:14px">
							<div class="analytics-card-head">
								<strong>
									Top Events{' '}
									<span class="mono" style="font-weight:400;color:var(--ink-muted)">
										({trendsData()!.topEvents.length})
									</span>
								</strong>
								<span style="font-size:11.5px;color:var(--ink-muted)">
									Click any event to focus it on the chart, or add it directly to a Funnel
								</span>
							</div>
							<div class="analytics-table-wrap">
								<table class="analytics-table">
									<thead>
										<tr>
											<th>Event</th>
											<th style="width:84px">Trend</th>
											<th style="text-align:right;width:90px">Count</th>
											<th style="text-align:right;width:84px">People</th>
											<th style="text-align:right;width:68px">Share</th>
											<th style="width:150px;text-align:right">Actions</th>
										</tr>
									</thead>
									<tbody>
										<For each={trendsData()!.topEvents}>
											{(ev) => {
												const isFocused = () => selectedEvents().includes(ev.event)
												return (
													<tr class={{ focused: isFocused() }}>
														<td>
															<div class="analytics-ev-cell">
																<button
																	type="button"
																	class="analytics-ev-name mono"
																	onClick={() => {
																		setBreakdownCol(eventColumn())
																		setSelectedEvents((prev) =>
																			prev.includes(ev.event)
																				? prev.filter((x) => x !== ev.event)
																				: [...prev, ev.event],
																		)
																	}}
																>
																	{ev.event}
																</button>
																<div class="analytics-ev-bar-track">
																	<div
																		class="analytics-ev-bar-fill"
																		style={`width:${Math.max(1.5, Math.min(100, ev.pct ?? 0))}%`}
																	/>
																</div>
															</div>
														</td>
														<td>
															<Sparkline values={ev.sparkline ?? []} />
														</td>
														<td class="mono" style="text-align:right;font-weight:500">
															{ev.count.toLocaleString()}
														</td>
														<td class="mono" style="text-align:right;color:var(--ink-secondary)">
															{ev.uniqueActors.toLocaleString()}
														</td>
														<td class="mono" style="text-align:right;color:var(--ink-muted)">
															{ev.pct ?? 0}%
														</td>
														<td style="text-align:right">
															<div style="display:inline-flex;gap:4px">
																<button
																	type="button"
																	class="btn sm"
																	style="height:22px;font-size:11px;padding:0 6px"
																	onClick={() => {
																		setFunnelSteps((prev) => {
																			const cleaned = prev.filter((s) => s.pattern.trim())
																			if (cleaned.some((s) => s.pattern === ev.event)) return cleaned
																			return [...cleaned, { pattern: ev.event, match: 'exact' }]
																		})
																		props.onChangeRoute({ mode: 'funnel' })
																	}}
																>
																	+ Funnel
																</button>
																<button
																	type="button"
																	class="btn sm"
																	style="height:22px;font-size:11px;padding:0 6px"
																	onClick={() => {
																		if (!eventColumn()) return
																		props.onOpenTable(selectedTable(), [
																			{
																				column: eventColumn(),
																				op: ev.event.includes(':id') ? 'like' : 'eq',
																				value: ev.event.includes(':id') ? ev.event.replaceAll(':id', '%') : ev.event,
																			},
																		])
																	}}
																>
																	Rows
																</button>
															</div>
														</td>
													</tr>
												)
											}}
										</For>
									</tbody>
								</table>
							</div>
						</div>
					</Show>
				</Show>

				{/* --- FUNNEL MODE --- */}
				<Show when={props.mode === 'funnel' && timeColumn()}>
					<Show
						when={eventColumn() && actorColumn()}
						fallback={
							<div class="analytics-card" style="padding:24px;text-align:center">
								<p style="margin:0 0 8px;font-weight:600">Funnel requires both an Event column and a Person column</p>
								<p style="margin:0;color:var(--ink-secondary);font-size:12.5px">
									Select <span class="mono">Event</span> and <span class="mono">Person</span> columns above, or switch
									to a table with user/event history.
								</p>
							</div>
						}
					>
						<datalist id="datadip-analytics-events">
							<For each={normalizedTopEventNames()}>{(name) => <option value={name} />}</For>
						</datalist>

						<div class="analytics-card" style="margin-bottom:14px">
							<div class="analytics-card-head">
								<div style="display:flex;align-items:baseline;gap:8px">
									<strong>Conversion Funnel Steps</strong>
									<span style="font-size:11.5px;color:var(--ink-muted)">
										Ordered progression per person within the conversion window
									</span>
								</div>
								<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
									<label class="analytics-field-inline">
										<span>Window</span>
										<select
											class="select sm mono"
											value={funnelWindowSec() === null ? 'any' : String(funnelWindowSec())}
											onChange={(e) => {
												const v = e.currentTarget.value
												setFunnelWindowSec(v === 'any' ? null : Number(v))
											}}
										>
											<option value="3600" selected={funnelWindowSec() === 3600}>
												1 hour
											</option>
											<option value="86400" selected={funnelWindowSec() === 86400}>
												24 hours
											</option>
											<option value="604800" selected={funnelWindowSec() === 604800}>
												7 days
											</option>
											<option value="2592000" selected={funnelWindowSec() === 2592000}>
												30 days
											</option>
											<option value="any" selected={funnelWindowSec() === null}>
												Entire range
											</option>
										</select>
									</label>

									<Show when={detection()?.userIdColumn && detection()?.visitorIdColumn}>
										<button
											type="button"
											class={['btn sm', { 'active-toggle': stitchIdentity() }]}
											title="Link anonymous visitor_id events to authenticated user_id when they co-occur (essential for signup funnels)"
											onClick={() => setStitchIdentity((v) => !v)}
										>
											Stitch visitor → user
										</button>
									</Show>
								</div>
							</div>

							<div class="funnel-builder">
								<For each={funnelSteps()}>
									{(step, idx) => (
										<div class="funnel-builder-row">
											<span class="funnel-step-num mono">{idx() + 1}</span>
											<select
												class="select sm"
												style="width:94px"
												value={step.match}
												onChange={(e) => {
													const match = e.currentTarget.value as FunnelStepSpec['match']
													setFunnelSteps((prev) => prev.map((s, i) => (i === idx() ? { ...s, match } : s)))
												}}
											>
												<option value="exact" selected={step.match === 'exact'}>
													Exact
												</option>
												<option value="prefix" selected={step.match === 'prefix'}>
													Starts with
												</option>
												<option value="contains" selected={step.match === 'contains'}>
													Contains
												</option>
											</select>
											<input
												class="input mono"
												style="flex:1;height:28px"
												list="datadip-analytics-events"
												placeholder="Event name or pattern (e.g. POST /api/view)…"
												value={step.pattern}
												onInput={(e) => {
													const pattern = e.currentTarget.value
													setFunnelSteps((prev) => prev.map((s, i) => (i === idx() ? { ...s, pattern } : s)))
												}}
											/>
											<Show when={funnelSteps().length > 2}>
												<button
													type="button"
													class="icon-btn ghost"
													style="width:26px;height:26px"
													aria-label="Remove step"
													onClick={() => setFunnelSteps((prev) => prev.filter((_, i) => i !== idx()))}
												>
													<IconClose />
												</button>
											</Show>
										</div>
									)}
								</For>

								<div style="display:flex;align-items:center;gap:8px;margin-top:4px">
									<Show when={funnelSteps().length < 8}>
										<button
											type="button"
											class="btn sm"
											onClick={() => setFunnelSteps((prev) => [...prev, { pattern: '', match: 'exact' }])}
										>
											<IconPlus />
											Add Step
										</button>
									</Show>
									<Show when={funnelLoading()}>
										<span class="mono" style="font-size:11.5px;color:var(--accent)">
											Computing funnel…
										</span>
									</Show>
									<Show when={!funnelLoading() ? funnelData() : null}>
										{(fd) => (
											<>
												<span class="mono" style="font-size:11.5px;color:var(--ink-muted)">
													{fd().scannedEvents.toLocaleString()} events scanned in {fd().durationMs}ms
													{fd().stitchedIdentity ? ' · identity stitched' : ''}
												</span>
												<Show when={fd().truncated}>
													<span class="analytics-warn-pill mono">
														Truncated at 120k events -- narrow range for exact conversion
													</span>
												</Show>
											</>
										)}
									</Show>
								</div>
							</div>
						</div>

						<div class="analytics-card">
							<div class="analytics-card-head">
								<strong>Conversion Results</strong>
								<Show when={funnelData() && funnelData()!.steps.length >= 2}>
									<span class="mono" style="font-size:12px;color:var(--accent);font-weight:600">
										Overall: {funnelData()!.steps[funnelData()!.steps.length - 1]!.overallPct}%
									</span>
								</Show>
							</div>
							<div style="padding:14px">
								<Show
									when={funnelData()}
									fallback={
										<div class="chart-empty" style="height:200px">
											Select events above to compute funnel conversion.
										</div>
									}
								>
									{(fd) => (
										<FunnelChart
											steps={fd().steps}
											onInspectActor={inspectActorInPeople}
											formatActor={formatActorName}
										/>
									)}
								</Show>
							</div>
						</div>
					</Show>
				</Show>

				{/* --- RETENTION MODE --- */}
				<Show when={props.mode === 'retention' && timeColumn()}>
					<Show
						when={actorColumn()}
						fallback={
							<div class="analytics-card" style="padding:24px;text-align:center">
								<p style="margin:0 0 8px;font-weight:600">Retention requires a Person / Actor column</p>
								<p style="margin:0;color:var(--ink-secondary);font-size:12.5px">
									Select a <span class="mono">Person</span> column (e.g. <span class="mono">user_id</span>) above, or
									switch to a table that tracks people or accounts.
								</p>
							</div>
						}
					>
						<div class="analytics-card" style="margin-bottom:14px">
							<div class="analytics-card-head">
								<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
									<div class="tab-group">
										<button
											type="button"
											class={['tab-btn', { active: retGranularity() === 'day' }]}
											onClick={() => {
												setRetGranularity('day')
												setRetPeriods(14)
											}}
										>
											Daily (D0–D14)
										</button>
										<button
											type="button"
											class={['tab-btn', { active: retGranularity() === 'week' }]}
											onClick={() => {
												setRetGranularity('week')
												setRetPeriods(8)
											}}
										>
											Weekly (W0–W8)
										</button>
									</div>

									<Show when={eventColumn()}>
										<label class="analytics-field-inline">
											<span>Cohort event</span>
											<input
												class="input mono"
												style="width:185px;height:26px;font-size:12px"
												list="datadip-analytics-events"
												placeholder="Any first event"
												value={retCohortEvent()}
												onInput={(e) => setRetCohortEvent(e.currentTarget.value)}
											/>
										</label>
										<label class="analytics-field-inline">
											<span>Return event</span>
											<input
												class="input mono"
												style="width:185px;height:26px;font-size:12px"
												list="datadip-analytics-events"
												placeholder="Any active event"
												value={retReturnEvent()}
												onInput={(e) => setRetReturnEvent(e.currentTarget.value)}
											/>
										</label>
									</Show>

									<Show when={detection()?.userIdColumn && detection()?.visitorIdColumn}>
										<button
											type="button"
											class={['btn sm', { 'active-toggle': stitchIdentity() }]}
											onClick={() => setStitchIdentity((v) => !v)}
										>
											Stitch visitor → user
										</button>
									</Show>
								</div>

								<Show when={retLoading()}>
									<span class="mono" style="font-size:11.5px;color:var(--accent)">
										Computing cohorts…
									</span>
								</Show>
							</div>
						</div>

						<datalist id="datadip-analytics-events">
							<For each={normalizedTopEventNames()}>{(name) => <option value={name} />}</For>
						</datalist>

						<Show
							when={retData()}
							fallback={
								<div class="chart-empty" style="height:240px">
									Loading retention cohorts…
								</div>
							}
						>
							{(rd) => <RetentionMatrix data={rd()} />}
						</Show>
					</Show>
				</Show>

				{/* --- PEOPLE / ACTORS & JOURNEYS MODE --- */}
				<Show when={props.mode === 'actors' && timeColumn()}>
					<Show
						when={actorColumn()}
						fallback={
							<div class="analytics-card" style="padding:24px;text-align:center">
								<p style="margin:0 0 8px;font-weight:600">People view requires a Person / Actor column</p>
								<p style="margin:0;color:var(--ink-secondary);font-size:12.5px">
									Select a <span class="mono">Person</span> column above to inspect individual timelines and sessions.
								</p>
							</div>
						}
					>
						<div class="actors-split">
							{/* Left: ranked actors list */}
							<div class="analytics-card actors-list-pane">
								<div class="analytics-card-head" style="gap:6px">
									<input
										class="input mono"
										style="flex:1;height:26px;font-size:12px"
										placeholder="Filter by user or visitor ID…"
										value={actorsSearch()}
										onInput={(e) => setActorsSearch(e.currentTarget.value)}
									/>
									<select
										ref={(el) => (actorsSortSelectEl = el)}
										class="select sm"
										value={actorsSort()}
										onChange={(e) => setActorsSort(e.currentTarget.value as 'events' | 'last_seen' | 'errors')}
									>
										<option value="events" selected={actorsSort() === 'events'}>
											Most Events
										</option>
										<option value="last_seen" selected={actorsSort() === 'last_seen'}>
											Last Seen
										</option>
										<Show when={statusColumn()}>
											<option value="errors" selected={actorsSort() === 'errors'}>
												Most Errors
											</option>
										</Show>
									</select>
								</div>
								<div class="actors-list-scroll">
									<Show when={actorsLoading() && !actorsData()}>
										<div class="chart-empty" style="height:180px">
											Loading people…
										</div>
									</Show>
									<For each={actorsData()?.actors ?? []}>
										{(actor) => {
											const isSelected = () => selectedActorId() === actor.actorId
											const decodedId = () => autoDecodeSingleValue(actor.actorId, 'user_id')
											const meta = () => userMetaById().get(actor.userId ?? actor.actorId)
											return (
												<button
													type="button"
													class={['actor-row', { active: isSelected() }]}
													onClick={() => {
														setSelectedActorId(actor.actorId)
														props.onChangeRoute({ actor: actor.actorId }, true)
													}}
												>
													<div class="actor-row-top">
														<span class="actor-id">
															<Show when={meta()?.label} fallback={<span class="mono">{actor.actorId}</span>}>
																<strong>{meta()!.label}</strong>{' '}
																<span class="mono" style="color:var(--ink-muted);font-size:11px">
																	{actor.actorId}
																</span>
															</Show>
															<Show when={meta()?.isAdmin}>
																<span class="tag mono" style="margin-left:5px;font-size:9.5px">
																	admin
																</span>
															</Show>
															<Show when={meta()?.isTest || meta()?.looksLikeTest}>
																<span class="tag mono" style="margin-left:5px;font-size:9.5px">
																	{meta()?.isTest ? 'test' : 'test?'}
																</span>
															</Show>
														</span>
														<span class="actor-count mono">{actor.eventCount.toLocaleString()}</span>
													</div>
													<div class="actor-row-meta mono">
														<span>{actor.activeDays}d active</span>
														<span>· {formatRelativeTime(actor.lastSeenMs)}</span>
														<Show when={actor.errorCount > 0}>
															<span style="color:var(--prod)">· {actor.errorCount} err</span>
														</Show>
														<Show when={decodedId()}>
															{(d) => (
																<span title={`${d().formatLabel}: ${d().utc} UTC`}>· created {d().shortDate}</span>
															)}
														</Show>
													</div>
												</button>
											)
										}}
									</For>
								</div>
							</div>

							{/* Right: Session timeline */}
							<div class="analytics-card actors-journey-pane">
								<div class="analytics-card-head">
									<div style="display:flex;align-items:baseline;gap:8px;min-width:0">
										<strong class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
											{selectedActorId()
												? (() => {
														const id = selectedActorId()!
														const lbl = userMetaById().get(id)?.label
														return lbl ? `${lbl} (${id})` : id
													})()
												: 'Select a person'}
										</strong>
										<Show when={selectedActorId() ? autoDecodeSingleValue(selectedActorId(), 'user_id') : null}>
											{(d) => (
												<span class="tag mono" title={`Decoded ${d().formatLabel} creation timestamp`}>
													{d().shortTag} · {d().utc} UTC ({d().relative})
												</span>
											)}
										</Show>
									</div>
									<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
										<Show when={selectedActorId()}>
											<button
												type="button"
												class="btn sm"
												title="Exclude this person from Trends, Funnels, Retention, and People (saved for this connection)"
												onClick={() => {
													const id = selectedActorId()
													if (!id) return
													toggleExcludedActor(id)
													setSelectedActorId(null)
													setJourneyData(null)
													props.onNotify(`Excluded ${formatActorName(id)} from analytics`, 'info')
												}}
											>
												Exclude
											</button>
										</Show>
										<Show when={userFkTarget() && selectedActorId()}>
											<button
												type="button"
												class="btn sm"
												onClick={() =>
													props.onFollowFk(userFkTarget()!.toTable, userFkTarget()!.toColumn, selectedActorId())
												}
											>
												Open in {userFkTarget()!.toTable}
												<IconArrowRight />
											</button>
										</Show>
										<Show when={selectedActorId()}>
											<button
												type="button"
												class="btn sm"
												onClick={() => {
													const col =
														actorColumn() === STITCHED_ACTOR_SENTINEL
															? (detection()?.userIdColumn ?? detection()?.visitorIdColumn ?? '')
															: actorColumn()
													if (col)
														props.onOpenTable(selectedTable(), [{ column: col, op: 'eq', value: selectedActorId()! }])
												}}
											>
												View Rows
											</button>
										</Show>
									</div>
								</div>

								<div class="journey-scroll">
									<Show when={journeyLoading()}>
										<div class="chart-empty" style="height:200px">
											Loading session timeline…
										</div>
									</Show>
									<Show when={!journeyLoading() && journeySessions().length === 0}>
										<div class="chart-empty" style="height:200px">
											No events found for this person in the current window.
										</div>
									</Show>
									<For each={journeySessions()}>
										{(session, sIdx) => (
											<div class="journey-session">
												<div class="journey-session-head mono">
													<span>
														Session {journeySessions().length - sIdx()} · {formatTs(session.startMs)}
													</span>
													<span>
														{session.events.length} events ·{' '}
														{formatDurationSec(Math.round((session.endMs - session.startMs) / 1000))}
													</span>
												</div>
												<div class="journey-events">
													<For each={session.events}>
														{(ev, eIdx) => {
															const prevEv = () => session.events[eIdx() + 1]
															const deltaSec = () =>
																prevEv() ? Math.max(0, Math.round((ev.tsMs - prevEv()!.tsMs) / 1000)) : null
															return (
																<div class="journey-event-row">
																	<span class="journey-ts mono">
																		{(tz() === 'local'
																			? formatLocalTimestamp(ev.tsMs)
																			: formatUtcTimestamp(ev.tsMs)
																		).slice(11)}
																	</span>
																	<span class="journey-delta mono">
																		{deltaSec() !== null ? `+${formatDurationSec(deltaSec())}` : 'start'}
																	</span>
																	<span class="journey-ev-name mono" title={ev.rawEvent}>
																		{ev.event}
																	</span>
																	<Show when={ev.status !== null}>
																		<span class={['journey-status mono', statusBadgeClass(ev.status)]}>
																			{ev.status}
																		</span>
																	</Show>
																	<Show when={ev.data}>
																		<span class="journey-data mono" title={ev.data!}>
																			{ev.data}
																		</span>
																	</Show>
																</div>
															)
														}}
													</For>
												</div>
											</div>
										)}
									</For>
								</div>
							</div>
						</div>
					</Show>
				</Show>

				{/* --- SAVED CHARTS / DASHBOARD MODE --- */}
				<Show when={props.mode === 'dashboard'}>
					<Show
						when={savedCharts().length > 0}
						fallback={
							<div class="analytics-card" style="padding:36px 24px;text-align:center">
								<div style="display:inline-flex;margin-bottom:8px;color:var(--ink-muted)">
									<IconChart />
								</div>
								<div style="font-weight:600;margin-bottom:6px">No saved charts yet</div>
								<p style="margin:0 0 14px;color:var(--ink-secondary);font-size:12.5px">
									Configure a Trend, Funnel, or Retention view and click <strong>Save</strong> to pin it here for quick
									access.
								</p>
								<button type="button" class="btn sm primary" onClick={() => props.onChangeRoute({ mode: 'trends' })}>
									Explore Trends
								</button>
							</div>
						}
					>
						<div class="saved-charts-grid">
							<For each={savedCharts()}>
								{(chart) => (
									<div class="analytics-card saved-chart-card">
										<div class="analytics-card-head">
											<div style="display:flex;align-items:baseline;gap:8px;min-width:0">
												<strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{chart.title}</strong>
												<span class="tag mono">{chart.mode}</span>
											</div>
											<button
												type="button"
												class="icon-btn ghost"
												style="width:24px;height:24px"
												aria-label={`Delete ${chart.title}`}
												onClick={() => void deleteSavedChart(chart.id)}
											>
												<IconTrash />
											</button>
										</div>
										<div class="saved-chart-meta mono">
											<span>table: {String(chart.config.table ?? '—')}</span>
											<span>· range: {String(chart.config.range ?? '30d')}</span>
											<Show when={chart.config.metric}>
												<span>· {String(chart.config.metric)}</span>
											</Show>
										</div>
										<div style="padding:10px 14px;display:flex;justify-content:flex-end">
											<button type="button" class="btn sm primary" onClick={() => loadSavedChart(chart)}>
												Open Chart
												<IconArrowRight />
											</button>
										</div>
									</div>
								)}
							</For>
						</div>
					</Show>
				</Show>
			</div>
		</div>
	)
}

// Pure-SVG zero-dependency charts for DataDip Analytics and SQL Console: TimeSeriesChart, FunnelChart, RetentionMatrix, Sparkline, and QueryResultChart.
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import type {
	AnalyticsChartType,
	AnalyticsInterval,
	FunnelStepResult,
	RetentionResponse,
	TrendsSeries,
} from '../shared/analytics.ts'
import type { QueryStatementResult } from '../shared/types.ts'

export const CHART_PALETTE = [
	'#2563eb', // blue
	'#16a34a', // emerald
	'#d97706', // amber
	'#9333ea', // purple
	'#e11d48', // rose
	'#0891b2', // cyan
	'#ea580c', // orange
	'#4f46e5', // indigo
	'#65a30d', // lime
	'#db2777', // pink
	'#0d9488', // teal
	'#64748b', // slate (used for Other)
]

export function seriesColor(idx: number, key?: string): string {
	if (key === '__other__') return '#888e9b'
	return CHART_PALETTE[idx % (CHART_PALETTE.length - 1)]!
}

function niceMax(maxVal: number): number {
	if (maxVal <= 0) return 4
	const mag = 10 ** Math.floor(Math.log10(maxVal))
	const norm = maxVal / mag
	const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
	return Math.ceil(maxVal / (step * mag * 0.25)) * (step * mag * 0.25)
}

function formatAxisNum(n: number): string {
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
	if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}k`
	if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
	return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatBucketLabel(ms: number, interval: AnalyticsInterval, full = false): string {
	const d = new Date(ms)
	if (Number.isNaN(d.getTime())) return ''
	const mon = MONTHS[d.getUTCMonth()]
	const day = d.getUTCDate()
	const hh = String(d.getUTCHours()).padStart(2, '0')
	if (interval === 'hour') {
		return full ? `${mon} ${day}, ${hh}:00 UTC` : `${mon} ${day} ${hh}:00`
	}
	if (interval === 'month') {
		return `${mon} ${d.getUTCFullYear()}`
	}
	if (interval === 'week') {
		return full ? `Week of ${mon} ${day}, ${d.getUTCFullYear()}` : `${mon} ${day}`
	}
	return full ? `${mon} ${day}, ${d.getUTCFullYear()}` : `${mon} ${day}`
}

export function formatDurationSec(sec: number | null): string {
	if (sec === null || !Number.isFinite(sec)) return '—'
	if (sec < 60) return `${Math.round(sec)}s`
	if (sec < 3600) return `${(sec / 60).toFixed(1).replace(/\.0$/, '')}m`
	if (sec < 86400) return `${(sec / 3600).toFixed(1).replace(/\.0$/, '')}h`
	return `${(sec / 86400).toFixed(1).replace(/\.0$/, '')}d`
}

export function TimeSeriesChart(props: {
	labels: string[]
	fullLabels?: string[]
	bucketsMs?: number[]
	series: TrendsSeries[]
	chartType: AnalyticsChartType
	height?: number
	onClickBucket?: (index: number) => void
}) {
	let containerEl: HTMLDivElement | undefined
	const [width, setWidth] = createSignal(720)
	const [hoverIdx, setHoverIdx] = createSignal<number | null>(null)
	const [hiddenKeys, setHiddenKeys] = createSignal<Set<string>>(new Set())

	onSettled(() => {
		if (!containerEl) return
		const update = () => {
			if (!containerEl) return
			const w = containerEl.clientWidth
			if (w > 120) setWidth(w)
		}
		update()
		const ro = new ResizeObserver(update)
		ro.observe(containerEl)
		return () => ro.disconnect()
	})

	// Clear hidden series if series keys completely change
	createEffect(
		() => props.series.map((s) => s.key).join('|'),
		() => {
			setHiddenKeys(new Set<string>())
		},
	)

	const height = () => props.height ?? 290
	const pad = { top: 18, right: 16, bottom: 32, left: 48 }
	const innerW = () => Math.max(120, width() - pad.left - pad.right)
	const innerH = () => Math.max(80, height() - pad.top - pad.bottom)

	const visibleSeries = createMemo(() => {
		const hidden = hiddenKeys()
		return props.series.map((s, idx) => ({ ...s, color: seriesColor(idx, s.key) })).filter((s) => !hidden.has(s.key))
	})

	const n = () => props.labels.length

	const yMax = createMemo(() => {
		const vis = visibleSeries()
		if (vis.length === 0 || n() === 0) return 4
		let mx = 0
		if (props.chartType === 'stacked_bar') {
			for (let i = 0; i < n(); i++) {
				let sum = 0
				for (const s of vis) sum += Math.max(0, s.values[i] ?? 0)
				if (sum > mx) mx = sum
			}
		} else {
			for (const s of vis) {
				for (const v of s.values) {
					if (v > mx) mx = v
				}
			}
		}
		return niceMax(mx)
	})

	const yTicks = createMemo(() => {
		const mx = yMax()
		return [0, mx * 0.25, mx * 0.5, mx * 0.75, mx]
	})

	function xPos(i: number): number {
		const count = n()
		if (count <= 1) return pad.left + innerW() / 2
		if (props.chartType === 'bar' || props.chartType === 'stacked_bar') {
			const slot = innerW() / count
			return pad.left + slot * i + slot / 2
		}
		return pad.left + (i / (count - 1)) * innerW()
	}

	function yPos(val: number): number {
		const mx = yMax()
		const clamped = Math.max(0, val)
		return pad.top + innerH() - (clamped / mx) * innerH()
	}

	const xTickIndices = createMemo(() => {
		const count = n()
		if (count === 0) return []
		const maxTicks = Math.max(2, Math.floor(innerW() / 92))
		if (count <= maxTicks) return Array.from({ length: count }, (_, i) => i)
		const step = Math.ceil(count / maxTicks)
		const out: number[] = []
		for (let i = 0; i < count; i += step) out.push(i)
		if (out[out.length - 1] !== count - 1) out.push(count - 1)
		return out
	})

	function handlePointerMove(e: MouseEvent) {
		const count = n()
		if (count === 0 || !containerEl) return
		const rect = containerEl.getBoundingClientRect()
		const relX = e.clientX - rect.left - pad.left
		if (relX < -10 || relX > innerW() + 10) {
			setHoverIdx(null)
			return
		}
		const idx =
			props.chartType === 'bar' || props.chartType === 'stacked_bar'
				? Math.floor((relX / innerW()) * count)
				: Math.round((relX / innerW()) * Math.max(1, count - 1))
		setHoverIdx(Math.max(0, Math.min(count - 1, idx)))
	}

	function toggleSeries(key: string, solo: boolean) {
		setHiddenKeys((prev) => {
			if (solo) {
				const allKeys = props.series.map((s) => s.key)
				const currentlySolo = prev.size === allKeys.length - 1 && !prev.has(key)
				if (currentlySolo) return new Set<string>()
				return new Set(allKeys.filter((k) => k !== key))
			}
			const next = new Set(prev)
			if (next.has(key)) next.delete(key)
			else if (next.size < props.series.length - 1) next.add(key)
			return next
		})
	}

	const barSlotW = () => (n() > 0 ? innerW() / n() : 20)

	const hoveredData = createMemo(() => {
		const idx = hoverIdx()
		if (idx === null || idx < 0 || idx >= n()) return null
		const rows = visibleSeries().map((s) => ({
			key: s.key,
			label: s.label,
			color: s.color,
			value: s.values[idx] ?? 0,
		}))
		const total = rows.reduce((acc, r) => acc + r.value, 0)
		return {
			idx,
			label: props.fullLabels?.[idx] ?? props.labels[idx] ?? '',
			rows: rows.sort((a, b) => b.value - a.value),
			total,
		}
	})

	return (
		<div class="chart-wrap">
			<div
				ref={(el) => (containerEl = el)}
				class="chart-stage"
				onMouseMove={handlePointerMove}
				onMouseLeave={() => setHoverIdx(null)}
				onClick={() => {
					const idx = hoverIdx()
					if (idx !== null && props.onClickBucket) props.onClickBucket(idx)
				}}
				style={props.onClickBucket ? 'cursor:pointer' : undefined}
			>
				<Show
					when={n() > 0 && props.series.length > 0}
					fallback={
						<div class="chart-empty" style={`height:${height()}px`}>
							No data points in this time window
						</div>
					}
				>
					<svg width={width()} height={height()} class="chart-svg" role="img" aria-label="Time series chart">
						{/* Horizontal gridlines + Y labels */}
						<For each={yTicks()}>
							{(tick) => {
								const y = () => yPos(tick)
								return (
									<g>
										<line
											x1={pad.left}
											x2={width() - pad.right}
											y1={y()}
											y2={y()}
											class={tick === 0 ? 'chart-axis-line' : 'chart-grid-line'}
										/>
										<text x={pad.left - 8} y={y() + 3.5} text-anchor="end" class="chart-tick mono">
											{formatAxisNum(tick)}
										</text>
									</g>
								)
							}}
						</For>

						{/* X-axis tick labels */}
						<For each={xTickIndices()}>
							{(idx) => (
								<text x={xPos(idx)} y={height() - 10} text-anchor="middle" class="chart-tick mono">
									{props.labels[idx]}
								</text>
							)}
						</For>

						{/* Hover column highlight */}
						<Show when={hoverIdx() !== null}>
							{props.chartType === 'bar' || props.chartType === 'stacked_bar' ? (
								<rect
									x={pad.left + barSlotW() * (hoverIdx() ?? 0)}
									y={pad.top}
									width={barSlotW()}
									height={innerH()}
									class="chart-hover-band"
								/>
							) : (
								<line
									x1={xPos(hoverIdx() ?? 0)}
									x2={xPos(hoverIdx() ?? 0)}
									y1={pad.top}
									y2={pad.top + innerH()}
									class="chart-crosshair"
								/>
							)}
						</Show>

						{/* Stacked Bar */}
						<Show when={props.chartType === 'stacked_bar'}>
							<For each={props.labels}>
								{(_, i) => {
									const bw = () => Math.max(2, Math.min(44, barSlotW() * 0.72))
									const bx = () => pad.left + barSlotW() * i() + (barSlotW() - bw()) / 2
									const segments = createMemo(() => {
										let acc = 0
										const out: { y: number; h: number; color: string }[] = []
										for (const s of visibleSeries()) {
											const v = Math.max(0, s.values[i()] ?? 0)
											if (v <= 0) continue
											const yBottom = yPos(acc)
											acc += v
											const yTop = yPos(acc)
											out.push({ y: yTop, h: Math.max(1, yBottom - yTop), color: s.color })
										}
										return out
									})
									return (
										<g>
											<For each={segments()}>
												{(seg) => <rect x={bx()} y={seg.y} width={bw()} height={seg.h} fill={seg.color} rx="1.5" />}
											</For>
										</g>
									)
								}}
							</For>
						</Show>

						{/* Grouped Bar */}
						<Show when={props.chartType === 'bar'}>
							<For each={props.labels}>
								{(_, i) => {
									const vis = visibleSeries()
									const groupW = Math.max(4, Math.min(48, barSlotW() * 0.78))
									const eachW = Math.max(1.5, groupW / Math.max(1, vis.length))
									const startX = pad.left + barSlotW() * i() + (barSlotW() - groupW) / 2
									return (
										<g>
											<For each={vis}>
												{(s, si) => {
													const v = s.values[i()] ?? 0
													const y = yPos(v)
													const h = Math.max(0, yPos(0) - y)
													return (
														<rect
															x={startX + si() * eachW}
															y={y}
															width={Math.max(1, eachW - 1)}
															height={h}
															fill={s.color}
															rx="1.5"
														/>
													)
												}}
											</For>
										</g>
									)
								}}
							</For>
						</Show>

						{/* Area / Line */}
						<Show when={props.chartType === 'line' || props.chartType === 'area'}>
							<For each={visibleSeries()}>
								{(s) => {
									const pathD = createMemo(() => {
										if (n() === 0) return ''
										return s.values
											.map((v, i) => `${i === 0 ? 'M' : 'L'}${xPos(i).toFixed(1)},${yPos(v).toFixed(1)}`)
											.join(' ')
									})
									const areaD = createMemo(() => {
										if (n() === 0) return ''
										const base = yPos(0).toFixed(1)
										return `${pathD()} L${xPos(n() - 1).toFixed(1)},${base} L${xPos(0).toFixed(1)},${base} Z`
									})
									return (
										<g>
											<Show when={props.chartType === 'area'}>
												<path
													d={areaD()}
													fill={s.color}
													fill-opacity={visibleSeries().length === 1 ? '0.14' : '0.07'}
												/>
											</Show>
											<path d={pathD()} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" />
											<Show when={n() <= 32}>
												<For each={s.values}>
													{(v, i) => (
														<circle
															cx={xPos(i())}
															cy={yPos(v)}
															r={hoverIdx() === i() ? 4 : 2.2}
															fill={s.color}
															class="chart-dot"
														/>
													)}
												</For>
											</Show>
											<Show when={n() > 32 && hoverIdx() !== null}>
												<circle
													cx={xPos(hoverIdx() ?? 0)}
													cy={yPos(s.values[hoverIdx() ?? 0] ?? 0)}
													r="4"
													fill={s.color}
													class="chart-dot"
												/>
											</Show>
										</g>
									)
								}}
							</For>
						</Show>
					</svg>

					{/* Floating Hover Tooltip */}
					<Show when={hoveredData()}>
						{(hd) => {
							const leftSide = () => xPos(hd().idx) > width() * 0.62
							const leftPx = () =>
								leftSide() ? Math.max(8, xPos(hd().idx) - 224) : Math.min(width() - 228, xPos(hd().idx) + 14)
							return (
								<div class="chart-tooltip" style={`left:${leftPx()}px;top:14px`}>
									<div class="chart-tooltip-head mono">{hd().label}</div>
									<div class="chart-tooltip-rows">
										<For each={hd().rows.slice(0, 8)}>
											{(r) => (
												<div class="chart-tooltip-row">
													<span class="chart-dot-swatch" style={`background:${r.color}`} />
													<span class="chart-tooltip-label mono">{r.label}</span>
													<span class="chart-tooltip-val mono">{r.value.toLocaleString()}</span>
												</div>
											)}
										</For>
									</div>
									<Show when={hd().rows.length > 1}>
										<div class="chart-tooltip-foot mono">
											<span>Total</span>
											<strong>{hd().total.toLocaleString()}</strong>
										</div>
									</Show>
									<Show when={props.onClickBucket}>
										<div class="chart-tooltip-hint">Click to browse rows in this bucket</div>
									</Show>
								</div>
							)
						}}
					</Show>
				</Show>
			</div>

			{/* Interactive Legend */}
			<Show when={props.series.length > 1}>
				<div class="chart-legend">
					<For each={props.series}>
						{(s, idx) => {
							const isHidden = () => hiddenKeys().has(s.key)
							const color = seriesColor(idx(), s.key)
							return (
								<button
									type="button"
									class={['chart-legend-item', { muted: isHidden() }]}
									title="Click to toggle · Option/Alt-click to solo"
									onClick={(e) => toggleSeries(s.key, e.altKey)}
									onDblClick={() => toggleSeries(s.key, true)}
								>
									<span class="chart-dot-swatch" style={`background:${color}`} />
									<span class="mono">{s.label}</span>
									<span class="chart-legend-total mono">{s.total.toLocaleString()}</span>
								</button>
							)
						}}
					</For>
				</div>
			</Show>
		</div>
	)
}

export function Sparkline(props: { values: number[]; color?: string; width?: number; height?: number }) {
	const w = () => props.width ?? 68
	const h = () => props.height ?? 18
	const path = createMemo(() => {
		const vals = props.values
		if (!vals || vals.length === 0) return ''
		const mx = Math.max(1, ...vals)
		if (vals.length === 1) return `M0,${h() / 2} L${w()},${h() / 2}`
		return vals
			.map((v, i) => {
				const x = (i / (vals.length - 1)) * w()
				const y = h() - 2 - (v / mx) * (h() - 4)
				return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
			})
			.join(' ')
	})
	return (
		<svg width={w()} height={h()} viewBox={`0 0 ${w()} ${h()}`} class="sparkline-svg" aria-hidden="true">
			<Show when={path()}>
				<path
					d={path()}
					fill="none"
					stroke={props.color ?? 'var(--accent)'}
					stroke-width="1.5"
					stroke-linejoin="round"
				/>
			</Show>
		</svg>
	)
}

export function FunnelChart(props: { steps: FunnelStepResult[]; onInspectActor?: (actorId: string) => void }) {
	const maxCount = createMemo(() => Math.max(1, props.steps[0]?.count ?? 1))

	return (
		<div class="funnel-viz">
			<Show
				when={props.steps.length > 0 && (props.steps[0]?.count ?? 0) > 0}
				fallback={
					<div class="chart-empty" style="height:220px">
						No actors matched Step 1 in this time window.
					</div>
				}
			>
				<div class="funnel-steps-list">
					<For each={props.steps}>
						{(step, i) => {
							const pctW = () => Math.max(2, (step.count / maxCount()) * 100)
							const color = () => CHART_PALETTE[i() % 6]!
							return (
								<div class="funnel-row">
									<Show when={i() > 0}>
										<div class="funnel-connector">
											<span class="funnel-conn-pill mono">
												{step.stepPct}% continued · {step.dropoffCount.toLocaleString()} dropped ({step.dropoffPct}%)
												<Show when={step.medianSecondsFromPrev !== null}>
													{' '}
													· median {formatDurationSec(step.medianSecondsFromPrev)}
												</Show>
											</span>
											<Show when={step.dropoffSampleActors.length > 0 && props.onInspectActor}>
												<button
													type="button"
													class="btn sm ghost-btn"
													style="height:20px;font-size:11px;padding:0 6px"
													onClick={() => props.onInspectActor?.(step.dropoffSampleActors[0]!)}
												>
													Inspect drop-off ({step.dropoffSampleActors[0]})
												</button>
											</Show>
										</div>
									</Show>
									<div class="funnel-step-card">
										<div class="funnel-step-head">
											<span class="funnel-step-num mono">{i() + 1}</span>
											<span class="funnel-step-title mono">{step.label}</span>
											<div style="flex:1" />
											<span class="funnel-step-count mono">{step.count.toLocaleString()}</span>
											<span class="funnel-step-pct mono">{step.overallPct}%</span>
										</div>
										<div class="funnel-bar-track">
											<div class="funnel-bar-fill" style={`width:${pctW()}%;background:${color()}`} />
										</div>
										<Show when={step.sampleActors.length > 0 && props.onInspectActor}>
											<div class="funnel-actors-strip">
												<span class="funnel-actors-label">Converted:</span>
												<For each={step.sampleActors.slice(0, 6)}>
													{(aid) => (
														<button
															type="button"
															class="fk-link mono"
															style="font-size:11px;padding:1px 6px"
															onClick={() => props.onInspectActor?.(aid)}
														>
															{aid}
														</button>
													)}
												</For>
											</div>
										</Show>
									</div>
								</div>
							)
						}}
					</For>
				</div>
			</Show>
		</div>
	)
}

export function RetentionMatrix(props: { data: RetentionResponse }) {
	const prefix = () => (props.data.granularity === 'week' ? 'W' : 'D')
	const cols = createMemo(() => {
		const count = props.data.averagePcts.length
		return Array.from({ length: count }, (_, i) => i)
	})

	function cellBg(pct: number | null): string {
		if (pct === null) return 'transparent'
		const alpha = pct <= 0 ? 0.03 : 0.1 + (Math.min(100, pct) / 100) * 0.62
		return `rgba(37, 99, 235, ${alpha.toFixed(2)})`
	}

	function cellInk(pct: number | null): string | undefined {
		if (pct === null) return 'var(--ink-muted)'
		if (pct >= 55) return '#ffffff'
		return undefined
	}

	const curveSeries = createMemo<TrendsSeries[]>(() => [
		{
			key: 'avg',
			label: 'Weighted Average Retention %',
			values: props.data.averagePcts.map((p) => p ?? 0),
			total: props.data.cohorts.reduce((a, c) => a + c.size, 0),
		},
	])

	const curveLabels = createMemo(() => cols().map((i) => `${prefix()}${i}`))

	return (
		<div class="retention-wrap">
			<Show
				when={props.data.cohorts.length > 0}
				fallback={
					<div class="chart-empty" style="height:220px">
						No cohorts found in this time window.
					</div>
				}
			>
				{/* Average Retention Curve */}
				<div class="analytics-card" style="margin-bottom:14px">
					<div class="analytics-card-head">
						<strong>Average Retention Curve (%)</strong>
						<span class="mono" style="font-size:11.5px;color:var(--ink-muted)">
							{props.data.cohorts.length} cohorts ·{' '}
							{props.data.cohorts.reduce((a, c) => a + c.size, 0).toLocaleString()} people
						</span>
					</div>
					<TimeSeriesChart labels={curveLabels()} series={curveSeries()} chartType="area" height={190} />
				</div>

				{/* Cohort Heatmap Table */}
				<div class="analytics-card">
					<div class="analytics-card-head">
						<strong>Cohort Retention Matrix</strong>
						<span style="font-size:11.5px;color:var(--ink-muted)">
							% of cohort returning on{' '}
							{props.data.granularity === 'week' ? 'each subsequent week' : 'each subsequent day'}
						</span>
					</div>
					<div class="retention-table-scroll">
						<table class="retention-table mono">
							<thead>
								<tr>
									<th style="text-align:left;min-width:104px">Cohort</th>
									<th style="text-align:right;min-width:56px">People</th>
									<For each={cols()}>
										{(i) => (
											<th>
												{prefix()}
												{i}
											</th>
										)}
									</For>
								</tr>
							</thead>
							<tbody>
								<tr class="retention-avg-row">
									<td style="text-align:left;font-weight:600">Average</td>
									<td style="text-align:right">
										{props.data.cohorts.reduce((a, c) => a + c.size, 0).toLocaleString()}
									</td>
									<For each={props.data.averagePcts}>
										{(pct) => (
											<td style={`background:${cellBg(pct)};color:${cellInk(pct) ?? 'inherit'}`}>
												{pct === null ? '—' : `${pct}%`}
											</td>
										)}
									</For>
								</tr>
								<For each={props.data.cohorts}>
									{(c) => (
										<tr>
											<td style="text-align:left">{c.label}</td>
											<td style="text-align:right;color:var(--ink-secondary)">{c.size.toLocaleString()}</td>
											<For each={c.pcts}>
												{(pct, idx) => (
													<td
														style={`background:${cellBg(pct)};color:${cellInk(pct) ?? 'inherit'}`}
														title={
															pct === null
																? 'Period not yet elapsed'
																: `${c.counts[idx()]?.toLocaleString()} / ${c.size.toLocaleString()} people (${pct}%)`
														}
													>
														{pct === null ? '' : `${pct}%`}
													</td>
												)}
											</For>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</div>
				</div>
			</Show>
		</div>
	)
}

// Instant chart renderer for any SQL Console query result!
export function QueryResultChart(props: { result: QueryStatementResult }) {
	const numericCols = createMemo(() => {
		const res = props.result
		if (res.rows.length === 0) return []
		const sample = res.rows.slice(0, 40)
		return res.columns.filter((col) => {
			let numHits = 0
			let nonNull = 0
			for (const r of sample) {
				const v = r[col]
				if (v === null || v === undefined || v === '') continue
				nonNull++
				if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) numHits++
			}
			return nonNull > 0 && numHits / nonNull >= 0.85
		})
	})

	const defaultX = createMemo(() => {
		const res = props.result
		const nums = new Set(numericCols())
		const nonNum = res.columns.find((c) => !nums.has(c))
		return nonNum ?? res.columns[0] ?? ''
	})

	const [xCol, setXCol] = createSignal('')
	const [yCols, setYCols] = createSignal<string[]>([])
	const [chartType, setChartType] = createSignal<AnalyticsChartType>('bar')
	let xSelectEl: HTMLSelectElement | undefined

	createEffect(
		() => props.result,
		(res) => {
			const x = defaultX()
			setXCol(x)
			const ys = numericCols().filter((c) => c !== x)
			setYCols(ys.slice(0, 4))
			// Default to line/area if X looks like a date/time column, bar otherwise
			setChartType(/date|time|day|week|month|hour|bucket|_at/i.test(x) ? 'area' : 'bar')
			if (xSelectEl) xSelectEl.value = x
		},
	)

	// Sync dynamic <select> value per AGENTS.md SolidJS rule
	createEffect(
		() => [xCol(), props.result.columns] as const,
		([val]) => {
			if (xSelectEl && val) xSelectEl.value = val
		},
	)

	const chartData = createMemo(() => {
		const rows = props.result.rows.slice(0, 200)
		const x = xCol()
		const ys = yCols()
		if (!x || ys.length === 0) return { labels: [], series: [] as TrendsSeries[] }
		const labels = rows.map((r) => String(r[x] ?? '(null)').slice(0, 28))
		const fullLabels = rows.map((r) => String(r[x] ?? '(null)'))
		const series: TrendsSeries[] = ys.map((col) => {
			const values = rows.map((r) => {
				const n = Number(r[col])
				return Number.isFinite(n) ? n : 0
			})
			return { key: col, label: col, values, total: values.reduce((a, b) => a + b, 0) }
		})
		return { labels, fullLabels, series }
	})

	function toggleY(col: string) {
		setYCols((prev) => {
			if (prev.includes(col)) return prev.length > 1 ? prev.filter((c) => c !== col) : prev
			return [...prev, col]
		})
	}

	return (
		<div class="query-chart-pane">
			<div class="query-chart-bar">
				<label class="analytics-field-inline">
					<span>X Axis</span>
					<select
						ref={(el) => (xSelectEl = el)}
						class="select sm mono"
						value={xCol()}
						onChange={(e) => {
							const nextX = e.currentTarget.value
							setXCol(nextX)
							setYCols((prev) => {
								const filtered = prev.filter((c) => c !== nextX)
								if (filtered.length > 0) return filtered
								return numericCols()
									.filter((c) => c !== nextX)
									.slice(0, 2)
							})
						}}
					>
						<For each={props.result.columns}>
							{(c) => (
								<option value={c} selected={xCol() === c}>
									{c}
								</option>
							)}
						</For>
					</select>
				</label>

				<div class="analytics-field-inline">
					<span>Y Series</span>
					<div style="display:flex;gap:4px;flex-wrap:wrap">
						<For each={numericCols().filter((c) => c !== xCol())}>
							{(c) => (
								<button
									type="button"
									class={['btn sm mono', { primary: yCols().includes(c) }]}
									onClick={() => toggleY(c)}
								>
									{c}
								</button>
							)}
						</For>
					</div>
				</div>

				<div style="flex:1" />

				<div class="tab-group">
					{(['bar', 'area', 'line', 'stacked_bar'] as const).map((t) => (
						<button type="button" class={['tab-btn', { active: chartType() === t }]} onClick={() => setChartType(t)}>
							{t === 'stacked_bar' ? 'Stacked' : t[0]!.toUpperCase() + t.slice(1)}
						</button>
					))}
				</div>
			</div>

			<Show
				when={numericCols().length > 0}
				fallback={
					<div class="chart-empty" style="height:220px">
						No numeric columns in this result set to plot. Try adding a COUNT(*), SUM(), or AVG() column.
					</div>
				}
			>
				<div style="padding:12px 16px">
					<TimeSeriesChart
						labels={chartData().labels}
						fullLabels={chartData().fullLabels}
						series={chartData().series}
						chartType={chartType()}
						height={240}
					/>
				</div>
			</Show>
		</div>
	)
}

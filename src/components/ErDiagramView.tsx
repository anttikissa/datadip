// Interactive pure-SVG Schema / ER Diagram with pan, zoom, draggable table cards, FK edge highlighting, and click-to-browse.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { formatRowCount } from '../lib/format.ts'
import { IconSearch } from '../lib/icons.tsx'
import type { DatabaseSchema, TableSchema } from '../shared/types.ts'

interface NodePos {
	x: number
	y: number
}

const CARD_W = 240
const HEADER_H = 34
const ROW_H = 22
const MAX_VISIBLE_COLS = 14
const COL_GAP = 72
const ROW_GAP = 48

function cardHeight(ts: TableSchema): number {
	const count = Math.min(ts.columns.length, MAX_VISIBLE_COLS) + (ts.columns.length > MAX_VISIBLE_COLS ? 1 : 0)
	return HEADER_H + Math.max(1, count) * ROW_H + 10
}

function computeInitialLayout(tables: TableSchema[]): Record<string, NodePos> {
	// Sort most-connected tables first so hubs sit centrally
	const sorted = [...tables].sort((a, b) => {
		const degA = a.foreignKeys.length + a.reverseForeignKeys.length
		const degB = b.foreignKeys.length + b.reverseForeignKeys.length
		return degB - degA || a.name.localeCompare(b.name)
	})
	const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(sorted.length))))
	const colY = new Array<number>(cols).fill(40)
	const out: Record<string, NodePos> = {}
	for (const ts of sorted) {
		// Place in shortest column
		let bestCol = 0
		for (let i = 1; i < cols; i++) {
			if (colY[i]! < colY[bestCol]!) bestCol = i
		}
		out[ts.name] = {
			x: 40 + bestCol * (CARD_W + COL_GAP),
			y: colY[bestCol]!,
		}
		colY[bestCol]! += cardHeight(ts) + ROW_GAP
	}
	return out
}

export function ErDiagramView(props: { schema: DatabaseSchema | null; onOpenTable: (table: string) => void }) {
	const [positions, setPositions] = createSignal<Record<string, NodePos>>({})
	const [pan, setPan] = createSignal({ x: 20, y: 20 })
	const [zoom, setZoom] = createSignal(1)
	const [hovered, setHovered] = createSignal<string | null>(null)
	const [filter, setFilter] = createSignal('')
	const [showInternal, setShowInternal] = createSignal(false)
	let svgEl: SVGSVGElement | undefined

	const visibleTables = createMemo<TableSchema[]>(() => {
		const s = props.schema
		if (!s) return []
		const internalNames = new Set(s.tables.filter((t) => t.isInternal).map((t) => t.name))
		const q = filter().trim().toLowerCase()
		return s.tables
			.filter((t) => t.type === 'table' && (showInternal() || !internalNames.has(t.name)))
			.map((t) => s.schemas[t.name])
			.filter((ts): ts is TableSchema => Boolean(ts))
			.filter(
				(ts) => !q || ts.name.toLowerCase().includes(q) || ts.columns.some((c) => c.name.toLowerCase().includes(q)),
			)
	})

	const rowCountByTable = createMemo(() => {
		const map = new Map<string, { count: number | null; estimated?: boolean }>()
		for (const t of props.schema?.tables ?? []) map.set(t.name, { count: t.rowCount, estimated: t.rowCountEstimated })
		return map
	})

	createEffect(
		() =>
			visibleTables()
				.map((t) => t.name)
				.join('|'),
		() => {
			setPositions(computeInitialLayout(visibleTables()))
		},
	)

	const edges = createMemo(() => {
		const visSet = new Set(visibleTables().map((t) => t.name))
		const list: { id: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string }[] = []
		for (const ts of visibleTables()) {
			for (const fk of ts.foreignKeys) {
				if (!visSet.has(fk.toTable)) continue
				list.push({
					id: `${ts.name}.${fk.fromColumn}->${fk.toTable}.${fk.toColumn}`,
					fromTable: ts.name,
					fromColumn: fk.fromColumn,
					toTable: fk.toTable,
					toColumn: fk.toColumn,
				})
			}
		}
		return list
	})

	const connectedToHovered = createMemo(() => {
		const h = hovered()
		if (!h) return null
		const set = new Set<string>([h])
		for (const e of edges()) {
			if (e.fromTable === h) set.add(e.toTable)
			if (e.toTable === h) set.add(e.fromTable)
		}
		return set
	})

	function fitToView() {
		const list = visibleTables()
		const pos = positions()
		if (!svgEl || list.length === 0) return
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity
		for (const ts of list) {
			const p = pos[ts.name]
			if (!p) continue
			minX = Math.min(minX, p.x)
			minY = Math.min(minY, p.y)
			maxX = Math.max(maxX, p.x + CARD_W)
			maxY = Math.max(maxY, p.y + cardHeight(ts))
		}
		if (!Number.isFinite(minX)) return
		const rect = svgEl.getBoundingClientRect()
		const contentW = Math.max(100, maxX - minX + 80)
		const contentH = Math.max(100, maxY - minY + 80)
		const nextZoom = Math.max(0.35, Math.min(1.25, Math.min(rect.width / contentW, rect.height / contentH)))
		setZoom(Math.round(nextZoom * 100) / 100)
		setPan({
			x: Math.round((rect.width - (maxX - minX) * nextZoom) / 2 - minX * nextZoom),
			y: Math.round((rect.height - (maxY - minY) * nextZoom) / 2 - minY * nextZoom),
		})
	}

	function startPan(e: MouseEvent) {
		if (e.button !== 0) return
		const startX = e.clientX
		const startY = e.clientY
		const orig = pan()
		const onMove = (ev: MouseEvent) => {
			setPan({ x: orig.x + (ev.clientX - startX), y: orig.y + (ev.clientY - startY) })
		}
		const onUp = () => {
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
	}

	function startNodeDrag(e: MouseEvent, tableName: string) {
		e.stopPropagation()
		if (e.button !== 0) return
		const startX = e.clientX
		const startY = e.clientY
		const orig = positions()[tableName] ?? { x: 0, y: 0 }
		const scale = zoom()
		let moved = false
		const onMove = (ev: MouseEvent) => {
			const dx = (ev.clientX - startX) / scale
			const dy = (ev.clientY - startY) / scale
			if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true
			setPositions((prev) => ({
				...prev,
				[tableName]: { x: Math.round(orig.x + dx), y: Math.round(orig.y + dy) },
			}))
		}
		const onUp = () => {
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
			if (!moved) props.onOpenTable(tableName)
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
	}

	function edgePath(e: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }): string {
		const pos = positions()
		const p1 = pos[e.fromTable]
		const p2 = pos[e.toTable]
		const ts1 = props.schema?.schemas[e.fromTable]
		const ts2 = props.schema?.schemas[e.toTable]
		if (!p1 || !p2 || !ts1 || !ts2) return ''

		const colIdx1 = Math.max(
			0,
			Math.min(
				MAX_VISIBLE_COLS - 1,
				ts1.columns.findIndex((c) => c.name === e.fromColumn),
			),
		)
		const colIdx2 = Math.max(
			0,
			Math.min(
				MAX_VISIBLE_COLS - 1,
				ts2.columns.findIndex((c) => c.name === e.toColumn),
			),
		)
		const y1 = p1.y + HEADER_H + colIdx1 * ROW_H + ROW_H / 2
		const y2 = p2.y + HEADER_H + colIdx2 * ROW_H + ROW_H / 2

		if (e.fromTable === e.toTable) {
			const x = p1.x + CARD_W
			return `M ${x} ${y1} C ${x + 54} ${y1 - 24}, ${x + 54} ${y2 + 24}, ${x} ${y2}`
		}

		const fromRight = p1.x + CARD_W / 2 <= p2.x + CARD_W / 2
		const x1 = fromRight ? p1.x + CARD_W : p1.x
		const x2 = fromRight ? p2.x : p2.x + CARD_W
		const dx = Math.max(48, Math.abs(x2 - x1) * 0.45)
		const c1x = fromRight ? x1 + dx : x1 - dx
		const c2x = fromRight ? x2 - dx : x2 + dx
		return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`
	}

	return (
		<div class="main-pane">
			<div class="view-toolbar">
				<span style="font-weight:600;font-size:13px">Schema / ER Diagram</span>
				<span class="tag mono">
					{visibleTables().length} tables · {edges().length} FKs
				</span>
				<div style="position:relative;display:inline-flex;align-items:center">
					<span style="position:absolute;left:8px;color:var(--ink-muted);display:inline-flex;pointer-events:none">
						<IconSearch />
					</span>
					<input
						class="input mono"
						style="padding-left:26px;width:200px;height:26px;font-size:12px"
						placeholder="Filter tables or columns…"
						value={filter()}
						onInput={(e) => setFilter(e.currentTarget.value)}
					/>
				</div>
				<div style="flex:1" />
				<Show when={(props.schema?.tables.filter((t) => t.isInternal).length ?? 0) > 0}>
					<button
						type="button"
						class={['btn sm', { 'active-toggle': showInternal() }]}
						onClick={() => setShowInternal((v) => !v)}
					>
						Show Internal/FTS5
					</button>
				</Show>
				<button
					type="button"
					class="btn sm"
					onClick={() => setZoom((z) => Math.max(0.35, Math.round((z - 0.15) * 100) / 100))}
				>
					−
				</button>
				<span class="mono" style="font-size:11.5px;min-width:42px;text-align:center">
					{Math.round(zoom() * 100)}%
				</span>
				<button
					type="button"
					class="btn sm"
					onClick={() => setZoom((z) => Math.min(2, Math.round((z + 0.15) * 100) / 100))}
				>
					+
				</button>
				<button type="button" class="btn sm" onClick={fitToView}>
					Fit
				</button>
				<button type="button" class="btn sm" onClick={() => setPositions(computeInitialLayout(visibleTables()))}>
					Reset Layout
				</button>
			</div>

			<div class="er-canvas-wrap">
				<Show
					when={visibleTables().length > 0}
					fallback={
						<div class="empty-state" style="padding:40px">
							No tables to visualize.
						</div>
					}
				>
					<svg
						ref={(el) => (svgEl = el)}
						class="er-svg"
						onMouseDown={startPan}
						onWheel={(e) => {
							e.preventDefault()
							const factor = e.deltaY > 0 ? 0.92 : 1.08
							setZoom((z) => Math.max(0.3, Math.min(2, Math.round(z * factor * 100) / 100)))
						}}
					>
						<defs>
							<marker id="er-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
								<path d="M0,1 L7,4 L0,7 Z" fill="var(--border-strong)" />
							</marker>
							<marker id="er-arrow-hi" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
								<path d="M0,1 L7,4 L0,7 Z" fill="var(--accent)" />
							</marker>
						</defs>

						<g transform={`translate(${pan().x} ${pan().y}) scale(${zoom()})`}>
							{/* Foreign key edges */}
							<For each={edges()}>
								{(edge) => {
									const isHi = () => hovered() === edge.fromTable || hovered() === edge.toTable
									const isDim = () => Boolean(hovered()) && !isHi()
									return (
										<path
											d={edgePath(edge)}
											fill="none"
											stroke={isHi() ? 'var(--accent)' : 'var(--border-strong)'}
											stroke-width={isHi() ? 2.2 : 1.4}
											stroke-opacity={isDim() ? 0.18 : 0.9}
											marker-end={isHi() ? 'url(#er-arrow-hi)' : 'url(#er-arrow)'}
										>
											<title>
												{edge.fromTable}.{edge.fromColumn} → {edge.toTable}.{edge.toColumn}
											</title>
										</path>
									)
								}}
							</For>

							{/* Table cards */}
							<For each={visibleTables()}>
								{(ts) => {
									const pos = () => positions()[ts.name] ?? { x: 40, y: 40 }
									const h = () => cardHeight(ts)
									const fkSet = () => new Set(ts.foreignKeys.map((fk) => fk.fromColumn))
									const isDim = () => {
										const conn = connectedToHovered()
										return conn !== null && !conn.has(ts.name)
									}
									const isFocus = () => hovered() === ts.name
									const rows = () => rowCountByTable().get(ts.name)
									return (
										<g
											class="er-node"
											transform={`translate(${pos().x} ${pos().y})`}
											opacity={isDim() ? 0.35 : 1}
											onMouseEnter={() => setHovered(ts.name)}
											onMouseLeave={() => setHovered(null)}
											onMouseDown={(e) => startNodeDrag(e, ts.name)}
										>
											<rect
												width={CARD_W}
												height={h()}
												rx="8"
												fill="var(--bg-surface)"
												stroke={isFocus() ? 'var(--accent)' : 'var(--border-strong)'}
												stroke-width={isFocus() ? 2 : 1}
											/>
											<path
												d={`M 0 8 Q 0 0 8 0 L ${CARD_W - 8} 0 Q ${CARD_W} 0 ${CARD_W} 8 L ${CARD_W} ${HEADER_H} L 0 ${HEADER_H} Z`}
												fill="var(--bg-canvas)"
											/>
											<line x1="0" y1={HEADER_H} x2={CARD_W} y2={HEADER_H} stroke="var(--border-subtle)" />
											<text x="11" y="21" class="er-title">
												{ts.name.length > 22 ? ts.name.slice(0, 21) + '…' : ts.name}
											</text>
											<Show when={rows()?.count !== null && rows()?.count !== undefined}>
												<text x={CARD_W - 10} y="21" text-anchor="end" class="er-count">
													{formatRowCount(rows()!.count, rows()!.estimated)}
												</text>
											</Show>

											<For each={ts.columns.slice(0, MAX_VISIBLE_COLS)}>
												{(col, idx) => {
													const y = HEADER_H + idx() * ROW_H + 15
													const isPk = col.primaryKey > 0
													const isFk = fkSet().has(col.name)
													return (
														<g>
															<Show when={isPk}>
																<circle cx="12" cy={y - 4} r="3" fill="#d97706" />
															</Show>
															<Show when={!isPk && isFk}>
																<circle cx="12" cy={y - 4} r="3" fill="var(--accent)" />
															</Show>
															<text x={isPk || isFk ? 22 : 11} y={y} class="er-col-name">
																{col.name.length > 20 ? col.name.slice(0, 19) + '…' : col.name}
															</text>
															<text x={CARD_W - 10} y={y} text-anchor="end" class="er-col-type">
																{col.type.length > 10 ? col.type.slice(0, 9) + '…' : col.type}
															</text>
														</g>
													)
												}}
											</For>
											<Show when={ts.columns.length > MAX_VISIBLE_COLS}>
												<text x="11" y={HEADER_H + MAX_VISIBLE_COLS * ROW_H + 15} class="er-col-type">
													+{ts.columns.length - MAX_VISIBLE_COLS} more columns…
												</text>
											</Show>
										</g>
									)
								}}
							</For>
						</g>
					</svg>
				</Show>
				<div class="er-legend mono">
					<span>Drag canvas to pan · Scroll to zoom · Drag card to arrange · Click card to open table</span>
				</div>
			</div>
		</div>
	)
}

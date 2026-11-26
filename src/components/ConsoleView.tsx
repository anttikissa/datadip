// Multi-statement SQL Console with auto-save, CodeMirror 6, concurrent per-console runs, Stop/Cancel, Split view, History, and FK links.
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { clearConsoleRun, getConsoleRun, updateConsoleRun } from '../lib/console-runs.ts'
import {
	copyToClipboard,
	exportRowsCsv,
	exportRowsJson,
	exportRowsTsv,
	formatCellText,
	formatIsoShort,
} from '../lib/format.ts'
import { IconAlert, IconArrowRight, IconClose, IconCopy, IconPlay, IconTable, IconTrash } from '../lib/icons.tsx'
import { hasTextSelection, isEditableTarget, isPrimaryMod, modKeyLabel } from '../lib/shortcuts.ts'
import { formatSql, statementAtCursor } from '../shared/sql.ts'
import { tid } from '../shared/tid.ts'
import type { Console, DatabaseSchema, DriverKind, ForeignKeyInfo, QueryHistoryEntry } from '../shared/types.ts'
import { CellViewer, type CellViewerState } from './CellViewer.tsx'
import type { ConfirmState } from './ConfirmDialog.tsx'
import { FkPeekCard, type FkPeekState } from './FkPeekCard.tsx'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor.tsx'

function formatElapsed(startedAt: number | null, nowMs: number): string {
	if (!startedAt) return '0.0s'
	const sec = Math.max(0, (nowMs - startedAt) / 1000)
	return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`
}

export function ConsoleView(props: {
	connId: string
	connName?: string
	driver?: DriverKind
	isProduction?: boolean
	console: Console | null
	schema: DatabaseSchema | null
	dark: boolean
	nowMs?: number
	focusTick?: number
	splitOpen?: boolean
	isSplitPane?: boolean
	allConsoles?: Console[]
	onToggleSplit?: () => void
	onCloseSplit?: () => void
	onSelectConsole?: (consoleId: string) => void
	onConsoleUpdated: (sqlConsole: Console) => void
	onConsoleDeleted: (consoleId: string) => void
	onFollowFk: (targetTable: string, targetColumn: string, value: unknown) => void
	onOpenTable: (table: string) => void
	onRequestConfirm: (state: ConfirmState) => void
	onNotify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
	onSchemaChanged: () => void
	onRwTimerUpdated: (until: number | null) => void
}) {
	const [title, setTitle] = createSignal('')
	const [sql, setSql] = createSignal('')
	const [saveState, setSaveState] = createSignal<'saved' | 'saving'>('saved')

	const [showHistory, setShowHistory] = createSignal(false)
	const [historyScope, setHistoryScope] = createSignal<'current' | 'all'>('current')
	const [historyQuery, setHistoryQuery] = createSignal('')
	const [showExport, setShowExport] = createSignal(false)
	const [history, setHistory] = createSignal<QueryHistoryEntry[]>([])
	const [peek, setPeek] = createSignal<FkPeekState | null>(null)
	const [activeCell, setActiveCell] = createSignal<{ row: number; col: number } | null>(null)
	const [cellViewer, setCellViewer] = createSignal<CellViewerState | null>(null)
	const [colWidths, setColWidths] = createSignal<Record<string, number>>({})
	const [freezeFirst, setFreezeFirst] = createSignal(false)

	function startColResize(e: MouseEvent, colName: string) {
		e.preventDefault()
		e.stopPropagation()
		const th = (e.currentTarget as HTMLElement).parentElement
		if (!th) return
		const startX = e.clientX
		const startW = th.getBoundingClientRect().width
		const onMove = (ev: MouseEvent) => {
			const nextW = Math.max(64, Math.min(1400, Math.round(startW + (ev.clientX - startX))))
			setColWidths((prev) => ({ ...prev, [colName]: nextW }))
		}
		const onUp = () => {
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
	}

	function autoFitColumn(e: MouseEvent, colName: string) {
		e.preventDefault()
		e.stopPropagation()
		const res = currentResult()
		if (!res) return
		let maxChars = colName.length + 6
		for (const row of res.rows) {
			const firstLine = formatCellText(row[colName]).split('\n')[0] ?? ''
			if (firstLine.length > maxChars) maxChars = firstLine.length
		}
		const fitted = Math.max(96, Math.min(720, Math.round(maxChars * 7.6 + 28)))
		setColWidths((prev) => ({ ...prev, [colName]: fitted }))
	}

	function colWidthStyle(colName: string): string | undefined {
		const w = colWidths()[colName]
		return w ? `width:${w}px;min-width:${w}px;max-width:${w}px` : undefined
	}

	let wrapEl: HTMLDivElement | undefined
	let gridScrollEl: HTMLDivElement | undefined
	let editorHandle: SqlEditorHandle | undefined
	let consoleSelectEl: HTMLSelectElement | undefined
	let saveTimer: ReturnType<typeof setTimeout> | null = null
	let peekTimer: ReturnType<typeof setTimeout> | null = null
	const peekCache = new Map<string, Record<string, unknown> | null>()

	const consoleId = () => props.console?.id
	const runState = createMemo(() => getConsoleRun(consoleId()))
	const running = () => runState().running
	const results = () => runState().results
	const activeTab = () => runState().activeTab
	const totalMs = () => runState().totalMs
	const runError = () => runState().runError

	createEffect(
		() => props.console?.id,
		() => {
			const sqlConsole = props.console
			if (saveTimer) clearTimeout(saveTimer)
			setTitle(sqlConsole?.title ?? 'Untitled console')
			setSql(sqlConsole?.sql ?? '')
			setSaveState('saved')
		},
	)

	// Keep dynamic split-pane console selector synced with props.console?.id after options update.
	createEffect(
		() => [props.console?.id, props.allConsoles] as const,
		([id]) => {
			if (consoleSelectEl && id) consoleSelectEl.value = id
		},
	)

	createEffect(
		() => props.focusTick,
		(tick) => {
			if (tick) queueMicrotask(() => editorHandle?.focus())
		},
	)

	function scheduleSave(nextTitle: string, nextSql: string) {
		const sqlConsole = props.console
		if (!sqlConsole) return
		setSaveState('saving')
		if (saveTimer) clearTimeout(saveTimer)
		saveTimer = setTimeout(async () => {
			try {
				const res = await api.updateConsole(sqlConsole.id, { title: nextTitle, sql: nextSql })
				props.onConsoleUpdated(res.console)
				setSaveState('saved')
			} catch {
				setSaveState('saved')
			}
		}, 450)
	}

	async function executeSql(targetSql: string, confirmedDestructive = false) {
		const trimmed = targetSql.trim()
		if (!trimmed) {
			props.onNotify('Nothing to run', 'info')
			return
		}
		const targetConsoleId = consoleId() ?? `ephemeral:${props.connId}`
		const queryId = tid('q')
		updateConsoleRun(targetConsoleId, {
			running: true,
			startedAt: Date.now(),
			queryId,
			runError: null,
		})
		try {
			const res = await api.runQuery(props.connId, trimmed, confirmedDestructive, queryId)
			if (res.needsConfirmation) {
				updateConsoleRun(targetConsoleId, { running: false, startedAt: null, queryId: null })
				props.onRequestConfirm({
					title: 'Confirm Destructive SQL',
					message: 'This query modifies schema or affects rows without a WHERE clause. Proceed?',
					warnings: res.warnings,
					sqlPreview: [trimmed],
					confirmLabel: 'Execute Anyway',
					danger: true,
					onConfirm: () => executeSql(trimmed, true),
				})
				return
			}
			updateConsoleRun(targetConsoleId, {
				running: false,
				startedAt: null,
				queryId: null,
				results: res.results,
				activeTab: 0,
				totalMs: res.totalDurationMs,
				runError: null,
			})
			if (res.rwArmedUntil !== undefined) props.onRwTimerUpdated(res.rwArmedUntil)
			if (res.results.some((r) => r.changes > 0 || /^\s*(CREATE|DROP|ALTER)\b/i.test(r.sql))) {
				props.onSchemaChanged()
			}
			if (showHistory()) void loadHistory()
		} catch (err) {
			updateConsoleRun(targetConsoleId, {
				running: false,
				startedAt: null,
				queryId: null,
				runError: err instanceof Error ? err.message : String(err),
			})
		}
	}

	async function cancelCurrent() {
		const qid = runState().queryId
		if (!qid) return
		try {
			await api.cancelQuery(props.connId, qid)
			props.onNotify('Cancelling query…', 'info')
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	function runCurrent(cursorOffset?: number, selectionText?: string) {
		const sel = selectionText !== undefined ? selectionText : (editorHandle?.getSelection() ?? '')
		if (sel.trim()) {
			void executeSql(sel)
			return
		}
		const pos = cursorOffset !== undefined ? cursorOffset : (editorHandle?.getCursor() ?? 0)
		const stmt = statementAtCursor(sql(), pos)
		if (stmt) void executeSql(stmt.text)
		else void executeSql(sql())
	}

	function runAll() {
		void executeSql(sql())
	}

	function runExplain(cursorOffset?: number, selectionText?: string) {
		const sel = selectionText !== undefined ? selectionText : (editorHandle?.getSelection() ?? '')
		const pos = cursorOffset !== undefined ? cursorOffset : (editorHandle?.getCursor() ?? 0)
		const target = sel.trim() || statementAtCursor(sql(), pos)?.text || sql().trim()
		if (!target) return
		const stripped = target.replace(/^\s*EXPLAIN\s+(QUERY\s+PLAN\s+)?/i, '')
		const prefix = props.driver === 'postgres' ? 'EXPLAIN' : 'EXPLAIN QUERY PLAN'
		void executeSql(`${prefix} ${stripped}`)
	}

	function handleFormat() {
		const formatted = formatSql(sql())
		setSql(formatted)
		editorHandle?.replaceAll(formatted)
		scheduleSave(title(), formatted)
	}

	async function loadHistory(scope = historyScope(), q = historyQuery()) {
		try {
			const res = await api.listHistory(scope === 'all' ? 'all' : props.connId, 150, q)
			setHistory(res.history)
		} catch {}
	}

	const currentResult = createMemo(() => results()[activeTab()] ?? null)

	createEffect(
		() => currentResult(),
		(res) => {
			setCellViewer(null)
			if (res && !res.error && res.columns.length > 0 && res.rows.length > 0) {
				setActiveCell({ row: 0, col: 0 })
			} else {
				setActiveCell(null)
			}
		},
	)

	function isPaneActive(): boolean {
		if (!wrapEl) return !props.isSplitPane
		const active = document.activeElement
		if (active && wrapEl.contains(active)) return true
		if (props.isSplitPane) return false
		const activeWrap = active instanceof HTMLElement ? active.closest('.console-wrap') : null
		return !activeWrap || activeWrap === wrapEl
	}

	function scrollActiveCellIntoView(row: number, col: number) {
		gridScrollEl
			?.querySelector<HTMLElement>(`td[data-r="${row}"][data-c="${col}"]`)
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}

	function openResultCellViewer(rowIdx: number, colName: string, value: unknown, el?: HTMLElement) {
		const anchor = el
			? (() => {
					const r = el.getBoundingClientRect()
					return { left: r.left, top: r.top, bottom: r.bottom, right: r.right }
				})()
			: {
					left: Math.round(window.innerWidth / 2 - 240),
					top: 180,
					bottom: 210,
					right: Math.round(window.innerWidth / 2 + 240),
				}
		setCellViewer({
			rowIdx,
			colName,
			colType: '',
			value,
			mode: 'view',
			anchor,
		})
	}

	function copyActiveResultCell(e?: ClipboardEvent) {
		const res = currentResult()
		const cur = activeCell()
		if (!res || res.error || !cur) return
		const colName = res.columns[cur.col]
		const row = res.rows[cur.row]
		if (!colName || !row) return
		const text = formatCellText(row[colName])
		if (e?.clipboardData) {
			e.preventDefault()
			e.clipboardData.setData('text/plain', text)
			props.onNotify(`Copied ${colName}`)
			return
		}
		void copyToClipboard(text).then((ok) => {
			if (ok) props.onNotify(`Copied ${colName}`)
		})
	}

	function copyActiveResultRowTsv() {
		const res = currentResult()
		const cur = activeCell()
		if (!res || res.error || !cur) return
		const row = res.rows[cur.row]
		if (!row) return
		void copyToClipboard(exportRowsTsv(res.columns, [row])).then((ok) => {
			if (ok) props.onNotify(`Copied row ${cur.row + 1} with headers (TSV)`)
		})
	}

	onSettled(() => {
		const onCopy = (e: ClipboardEvent) => {
			if (!isPaneActive()) return
			if (isEditableTarget(e.target) || document.querySelector('dialog[open]') || cellViewer()) return
			if (hasTextSelection(e.target)) return
			copyActiveResultCell(e)
		}

		const onKey = (e: KeyboardEvent) => {
			if (document.querySelector('dialog[open]')) return
			if (!isPaneActive()) return
			const key = e.key.toLowerCase()
			const primaryMod = isPrimaryMod(e)
			const target = e.target as HTMLElement | null

			// Cmd+. cancels the running query in the active console
			if (primaryMod && !e.altKey && !e.shiftKey && e.key === '.') {
				if (running()) {
					e.preventDefault()
					void cancelCurrent()
				}
				return
			}

			// Ctrl+C cancels running query when there is no active text selection
			if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'c' && running()) {
				const cmSelected = Boolean(target?.closest('.cm-editor') && editorHandle?.getSelection())
				if (!hasTextSelection(target) && !cmSelected) {
					e.preventDefault()
					void cancelCurrent()
					return
				}
			}

			// Cmd+Shift+H toggles Query History panel (avoids Cmd+H macOS Hide App)
			if (!props.isSplitPane && primaryMod && e.shiftKey && !e.altKey && key === 'h') {
				e.preventDefault()
				const next = !showHistory()
				setShowHistory(next)
				if (next) void loadHistory()
				return
			}

			if (isEditableTarget(target) || cellViewer()) return

			if (e.key === 'Escape' && showHistory()) {
				setShowHistory(false)
				return
			}

			const res = currentResult()
			const cur = activeCell()
			if (!res || res.error || !cur || res.rows.length === 0 || res.columns.length === 0) return

			if (primaryMod && !e.altKey && !e.shiftKey && (e.key === 'Enter' || e.key === 'ArrowDown')) {
				const colName = res.columns[cur.col]
				const row = res.rows[cur.row]
				if (colName && row) {
					const fk = currentFkMap().get(colName)
					const val = row[colName]
					if (fk && val !== null && val !== undefined) {
						e.preventDefault()
						props.onFollowFk(fk.toTable, fk.toColumn, val)
						return
					}
				}
			}

			if (primaryMod && e.shiftKey && !e.altKey && key === 'c') {
				e.preventDefault()
				copyActiveResultRowTsv()
				return
			}

			if (primaryMod && !e.shiftKey && !e.altKey && key === 'c') {
				if (!hasTextSelection(target)) {
					e.preventDefault()
					copyActiveResultCell()
				}
				return
			}

			const noMods = !e.metaKey && !e.ctrlKey && !e.altKey
			if (noMods && (e.key === 'ArrowDown' || e.key === 'j')) {
				e.preventDefault()
				const next = { row: Math.min(res.rows.length - 1, cur.row + 1), col: cur.col }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && (e.key === 'ArrowUp' || e.key === 'k')) {
				e.preventDefault()
				const next = { row: Math.max(0, cur.row - 1), col: cur.col }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && (e.key === 'ArrowRight' || e.key === 'l')) {
				e.preventDefault()
				const next = { row: cur.row, col: Math.min(res.columns.length - 1, cur.col + 1) }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && (e.key === 'ArrowLeft' || e.key === 'h')) {
				e.preventDefault()
				const next = { row: cur.row, col: Math.max(0, cur.col - 1) }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && !e.shiftKey && key === 'c') {
				copyActiveResultCell()
			} else if (noMods && e.key === 'Enter') {
				const colName = res.columns[cur.col]
				const row = res.rows[cur.row]
				if (!colName || !row) return
				const fk = currentFkMap().get(colName)
				const val = row[colName]
				if (fk && val !== null && val !== undefined) {
					e.preventDefault()
					props.onFollowFk(fk.toTable, fk.toColumn, val)
				} else {
					e.preventDefault()
					const td = gridScrollEl?.querySelector<HTMLElement>(`td[data-r="${cur.row}"][data-c="${cur.col}"]`)
					openResultCellViewer(cur.row, colName, val, td ?? undefined)
				}
			}
		}

		window.addEventListener('copy', onCopy)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('copy', onCopy)
			window.removeEventListener('keydown', onKey)
		}
	})

	const currentFkMap = createMemo(() => {
		const map = new Map<string, ForeignKeyInfo>()
		const src = currentResult()?.sourceTable
		if (!src || !props.schema) return map
		const ts = props.schema.schemas[src]
		if (!ts) return map
		for (const fk of ts.foreignKeys) map.set(fk.fromColumn, fk)
		return map
	})

	function startFkPeek(e: MouseEvent, fk: ForeignKeyInfo, value: unknown) {
		if (value === null || value === undefined) return
		if (peekTimer) clearTimeout(peekTimer)
		const x = e.clientX
		const y = e.clientY
		const key = `${fk.toTable}.${fk.toColumn}=${String(value)}`
		peekTimer = setTimeout(() => {
			if (peekCache.has(key)) {
				setPeek({
					x,
					y,
					targetTable: fk.toTable,
					targetColumn: fk.toColumn,
					value,
					loading: false,
					row: peekCache.get(key) ?? null,
				})
				return
			}
			setPeek({ x, y, targetTable: fk.toTable, targetColumn: fk.toColumn, value, loading: true, row: null })
			api
				.peekRow(props.connId, fk.toTable, fk.toColumn, value)
				.then((r) => {
					peekCache.set(key, r.row)
					setPeek((cur) => (cur ? { ...cur, loading: false, row: r.row } : null))
				})
				.catch(() => setPeek((cur) => (cur ? { ...cur, loading: false, row: null } : null)))
		}, 180)
	}

	function cancelFkPeek() {
		if (peekTimer) clearTimeout(peekTimer)
		setPeek(null)
	}

	const elapsedText = () => formatElapsed(runState().startedAt, props.nowMs ?? Date.now())

	return (
		<div ref={(el) => (wrapEl = el)} class="console-wrap">
			{/* Console toolbar */}
			<div class="view-toolbar">
				<Show
					when={props.isSplitPane && props.allConsoles && props.onSelectConsole}
					fallback={
						<input
							class="input"
							style="width:170px;height:26px;font-weight:600"
							value={title()}
							onInput={(e) => {
								const v = e.currentTarget.value
								setTitle(v)
								scheduleSave(v, sql())
							}}
							aria-label="Console title"
						/>
					}
				>
					<select
						ref={consoleSelectEl}
						class="select"
						style="height:26px;max-width:170px;font-weight:600"
						value={props.console?.id ?? ''}
						onChange={(e) => props.onSelectConsole?.(e.currentTarget.value)}
						aria-label="Split console selector"
					>
						<For each={props.allConsoles}>
							{(p) => (
								<option value={p.id} selected={p.id === props.console?.id}>
									{p.title}
								</option>
							)}
						</For>
					</select>
				</Show>

				<Show when={props.connName}>
					<span
						class={['console-db-pill', { prod: props.isProduction }]}
						title={`Connected database: ${props.connName}`}
					>
						<Show when={props.isProduction}>
							<IconAlert />
						</Show>
						<span>{props.connName}</span>
					</span>
				</Show>

				<span style="font-size:11px;color:var(--ink-muted)">{saveState() === 'saving' ? 'Saving…' : 'Saved'}</span>

				<div class="topbar-sep" />

				<Show
					when={!running()}
					fallback={
						<button
							type="button"
							class="btn sm stop-btn"
							title={`Cancel running query (${modKeyLabel('.')} or Ctrl+C)`}
							onClick={() => void cancelCurrent()}
						>
							<span class="status-pulse" />
							Stop ({elapsedText()})
							<span class="kbd" style="border-color:rgba(255,255,255,0.35);background:transparent;color:inherit">
								{modKeyLabel('.')}
							</span>
						</button>
					}
				>
					<button type="button" class="btn sm primary" onClick={() => runCurrent()}>
						<IconPlay />
						Run
						<span class="kbd" style="border-color:rgba(255,255,255,0.35);background:transparent;color:inherit">
							{modKeyLabel('↵')}
						</span>
					</button>
				</Show>

				<button type="button" class="btn sm" disabled={running()} onClick={runAll}>
					Run All
					<span class="kbd">{modKeyLabel('↵', true)}</span>
				</button>

				<Show when={!props.isSplitPane}>
					<button type="button" class="btn sm" disabled={running()} onClick={() => runExplain()}>
						Explain
						<span class="kbd">{modKeyLabel('E', true)}</span>
					</button>
				</Show>

				<button type="button" class="btn sm" title={`Format SQL (${modKeyLabel('F', true)})`} onClick={handleFormat}>
					Format
					<span class="kbd">{modKeyLabel('F', true)}</span>
				</button>

				<div style="flex:1" />

				<Show when={!props.isSplitPane && props.onToggleSplit}>
					<button
						type="button"
						class={['btn sm', { 'active-toggle': props.splitOpen }]}
						onClick={() => props.onToggleSplit?.()}
						title="Open a second console side-by-side to run parallel queries"
					>
						{props.splitOpen ? 'Unsplit' : 'Split Console'}
					</button>
				</Show>

				<Show when={!props.isSplitPane}>
					<button
						type="button"
						class={['btn sm', { primary: showHistory() }]}
						title={`Toggle Query History (${modKeyLabel('H', true)})`}
						onClick={() => {
							const next = !showHistory()
							setShowHistory(next)
							if (next) void loadHistory()
						}}
					>
						History
						<span
							class="kbd"
							style={
								showHistory() ? 'border-color:rgba(255,255,255,0.35);background:transparent;color:inherit' : undefined
							}
						>
							{modKeyLabel('H', true)}
						</span>
					</button>
				</Show>

				<Show when={props.isSplitPane && props.onCloseSplit}>
					<button
						type="button"
						class="icon-btn ghost"
						style="height:26px;width:26px"
						aria-label="Close split console"
						onClick={() => props.onCloseSplit?.()}
					>
						<IconClose />
					</button>
				</Show>

				<Show when={!props.isSplitPane && props.console}>
					{(sqlConsole) => (
						<button
							type="button"
							class="icon-btn ghost"
							style="height:26px;width:26px"
							aria-label="Delete console"
							onClick={() =>
								props.onRequestConfirm({
									title: `Delete "${sqlConsole().title}"?`,
									message: 'This permanently deletes this saved console.',
									confirmLabel: 'Delete Console',
									danger: true,
									onConfirm: async () => {
										await api.deleteConsole(sqlConsole().id)
										clearConsoleRun(sqlConsole().id)
										props.onConsoleDeleted(sqlConsole().id)
									},
								})
							}
						>
							<IconTrash />
						</button>
					)}
				</Show>
			</div>

			{/* Editor + Results (+ optional History drawer) */}
			<div style="flex:1;min-height:0;display:flex;overflow:hidden">
				<div class="console-split">
					<div class="editor-pane">
						<SqlEditor
							value={sql()}
							dark={props.dark}
							schema={props.schema}
							onChange={(next) => {
								setSql(next)
								scheduleSave(title(), next)
							}}
							onRunCurrent={(cur, sel) => runCurrent(cur, sel)}
							onRunAll={runAll}
							onExplain={(cur, sel) => runExplain(cur, sel)}
							onFormat={handleFormat}
							onReady={(h) => {
								editorHandle = h
								if (!props.isSplitPane) queueMicrotask(() => h.focus())
							}}
						/>
					</div>

					<div class="results-pane">
						<div class="results-tabs">
							<Show
								when={results().length > 0}
								fallback={
									<span style="font-size:12px;color:var(--ink-muted)">
										{running()
											? `Running query on ${props.connName || 'database'}… ${elapsedText()} (${modKeyLabel('.')} to cancel)`
											: `Press ${modKeyLabel('↵')} to run statement, ${modKeyLabel('↵', true)} to run all, ${modKeyLabel('/')} to comment.`}
									</span>
								}
							>
								<Show when={running()}>
									<span class="mono" style="font-size:11.5px;color:var(--accent);font-weight:600">
										Running… {elapsedText()}
									</span>
								</Show>
								<For each={results()}>
									{(r, idx) => (
										<button
											type="button"
											class={['btn sm', { primary: activeTab() === idx() }]}
											onClick={() => {
												const id = consoleId()
												if (id) updateConsoleRun(id, { activeTab: idx() })
											}}
										>
											{r.error
												? `Result ${idx() + 1} (Error)`
												: r.columns.length > 0
													? `Result ${idx() + 1} (${r.rowCount}${r.truncated ? '+' : ''} rows)`
													: `Result ${idx() + 1} (${r.changes} changed)`}
										</button>
									)}
								</For>
							</Show>

							<div style="flex:1" />

							<Show when={currentResult()?.sourceTable && props.schema?.schemas[currentResult()!.sourceTable!]}>
								<button type="button" class="btn sm" onClick={() => props.onOpenTable(currentResult()!.sourceTable!)}>
									<IconTable />
									Open {currentResult()!.sourceTable}
								</button>
							</Show>

							<Show when={(currentResult()?.rows.length ?? 0) > 0}>
								<button
									type="button"
									class={['btn sm', { 'active-toggle': freezeFirst() }]}
									aria-pressed={freezeFirst() ? 'true' : 'false'}
									title="Pin the first result column while scrolling horizontally"
									onClick={() => setFreezeFirst((v) => !v)}
								>
									Freeze 1st
								</button>
								<button
									type="button"
									class="btn sm"
									onClick={async () => {
										const r = currentResult()!
										if (await copyToClipboard(exportRowsCsv(r.columns, r.rows))) {
											props.onNotify('Copied result as CSV', 'ok')
										}
									}}
								>
									<IconCopy />
									CSV
								</button>
								<button
									type="button"
									class="btn sm"
									onClick={async () => {
										const r = currentResult()!
										if (await copyToClipboard(exportRowsJson(r.rows))) {
											props.onNotify('Copied result as JSON', 'ok')
										}
									}}
								>
									JSON
								</button>
								<div class="popover-anchor">
									<button type="button" class="btn sm" onClick={() => setShowExport((v) => !v)}>
										Download
									</button>
									<Show when={showExport()}>
										<div class="popover-menu right" style="min-width:170px">
											{(
												[
													['csv', 'Download CSV'],
													['tsv', 'Download TSV'],
													['json', 'Download JSON'],
													['markdown', 'Download Markdown'],
													['sql', 'Download SQL INSERT'],
												] as const
											).map(([fmt, label]) => (
												<button
													type="button"
													class="popover-item"
													onClick={async () => {
														const r = currentResult()
														setShowExport(false)
														if (!r) return
														try {
															const out = await api.exportToFile(props.connId, {
																mode: 'query',
																format: fmt,
																sql: r.sql,
															})
															props.onNotify(
																`Downloaded ${out.filename} (${out.rowCount.toLocaleString()} rows${out.truncated ? ', capped at 100k' : ''})`,
																'ok',
															)
														} catch (err) {
															props.onNotify(err instanceof Error ? err.message : String(err), 'error')
														}
													}}
												>
													{label}
												</button>
											))}
										</div>
									</Show>
								</div>
							</Show>

							<Show when={totalMs() !== null}>
								<span class="mono" style="font-size:11.5px;color:var(--ink-secondary)">
									{totalMs()} ms
								</span>
							</Show>
						</div>

						<div ref={(el) => (gridScrollEl = el)} class="grid-scroll" tabindex="-1">
							<Show when={runError()}>{(err) => <div class="error-box">{err()}</div>}</Show>

							<Show when={currentResult()}>
								{(res) => (
									<Show
										when={!res().error}
										fallback={
											<div class="error-box">
												<div style="font-weight:600;margin-bottom:6px">SQL Error</div>
												<div>{res().error}</div>
												<div style="margin-top:8px;opacity:0.75">{res().sql}</div>
											</div>
										}
									>
										<Show
											when={res().columns.length > 0}
											fallback={
												<div style="padding:20px" class="mono">
													Statement succeeded in {res().durationMs} ms · {res().changes} row(s) affected
													{res().lastInsertRowid ? ` · last_insert_rowid = ${res().lastInsertRowid}` : ''}.
												</div>
											}
										>
											<table class={['data-table', { 'freeze-first': freezeFirst() }]}>
												<thead>
													<tr>
														<th style="width:44px;text-align:right;color:var(--ink-muted)">#</th>
														<For each={res().columns}>
															{(col) => (
																<th style={colWidthStyle(col)}>
																	<span>{col}</span>
																	<Show when={currentFkMap().get(col)}>
																		{(fk) => (
																			<span class="th-badge fk" style="margin-left:6px">
																				→ {fk().toTable}
																			</span>
																		)}
																	</Show>
																	<span
																		class="col-resizer"
																		title="Drag to resize · Double-click to auto-fit"
																		onMouseDown={(e) => startColResize(e, col)}
																		onDblClick={(e) => autoFitColumn(e, col)}
																	/>
																</th>
															)}
														</For>
													</tr>
												</thead>
												<tbody>
													<Show when={res().rows.length === 0}>
														<tr>
															<td colspan={res().columns.length + 1} class="empty-state">
																Query returned 0 rows ({res().durationMs} ms).
															</td>
														</tr>
													</Show>
													<For each={res().rows}>
														{(row, rIdx) => (
															<tr>
																<td class="row-num">{rIdx() + 1}</td>
																<For each={res().columns}>
																	{(col, cIdx) => {
																		const val = () => row[col]
																		const fk = () => currentFkMap().get(col)
																		const active = () => activeCell()?.row === rIdx() && activeCell()?.col === cIdx()
																		return (
																			<td
																				data-r={rIdx()}
																				data-c={cIdx()}
																				style={colWidthStyle(col)}
																				class={{ 'cell-active': active() }}
																				onClick={() => {
																					setActiveCell({ row: rIdx(), col: cIdx() })
																					if (!window.getSelection()?.toString()) {
																						gridScrollEl?.focus({ preventScroll: true })
																					}
																				}}
																				onDblClick={(e) => openResultCellViewer(rIdx(), col, val(), e.currentTarget)}
																			>
																				<Show
																					when={fk() && val() !== null && val() !== undefined}
																					fallback={
																						val() === null || val() === undefined ? (
																							<span class="cell-null">NULL</span>
																						) : (
																							formatCellText(val())
																						)
																					}
																				>
																					<button
																						type="button"
																						class="fk-link"
																						onMouseEnter={(e) => startFkPeek(e, fk()!, val())}
																						onMouseLeave={cancelFkPeek}
																						onClick={(e) => {
																							e.stopPropagation()
																							props.onFollowFk(fk()!.toTable, fk()!.toColumn, val())
																						}}
																					>
																						<span>{formatCellText(val())}</span>
																						<IconArrowRight />
																					</button>
																				</Show>
																			</td>
																		)
																	}}
																</For>
															</tr>
														)}
													</For>
												</tbody>
											</table>
										</Show>
									</Show>
								)}
							</Show>
						</div>
					</div>
				</div>

				{/* Query History Drawer */}
				<Show when={showHistory()}>
					<aside class="inspector" style="width:360px">
						<div class="inspector-head">
							<span>Query History ({history().length})</span>
							<div style="display:flex;gap:4px">
								<Show when={historyScope() === 'current'}>
									<button
										type="button"
										class="btn sm"
										onClick={async () => {
											await api.clearHistory(props.connId)
											setHistory([])
										}}
									>
										Clear
									</button>
								</Show>
								<button class="icon-btn ghost" type="button" onClick={() => setShowHistory(false)}>
									<IconClose />
								</button>
							</div>
						</div>
						<div style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);display:flex;flex-direction:column;gap:6px">
							<div style="display:flex;gap:6px;align-items:center">
								<input
									class="input mono"
									style="height:26px;font-size:11.5px;flex:1"
									placeholder="Search SQL history…"
									value={historyQuery()}
									onInput={(e) => {
										const next = e.currentTarget.value
										setHistoryQuery(next)
										void loadHistory(historyScope(), next)
									}}
								/>
								<div class="tab-group">
									<button
										type="button"
										class={['tab-btn', { active: historyScope() === 'current' }]}
										onClick={() => {
											setHistoryScope('current')
											void loadHistory('current', historyQuery())
										}}
									>
										This DB
									</button>
									<button
										type="button"
										class={['tab-btn', { active: historyScope() === 'all' }]}
										onClick={() => {
											setHistoryScope('all')
											void loadHistory('all', historyQuery())
										}}
									>
										All DBs
									</button>
								</div>
							</div>
						</div>
						<div class="inspector-body" style="gap:8px">
							<Show when={history().length === 0}>
								<div style="color:var(--ink-muted)">
									{historyQuery().trim() ? 'No matching queries.' : 'No executed queries yet.'}
								</div>
							</Show>
							<For each={history()}>
								{(h) => (
									<div style="border:1px solid var(--border-strong);border-radius:var(--radius);padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--bg-subtle)">
										<div
											style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:11px;color:var(--ink-muted)"
											class="mono"
										>
											<span>{formatIsoShort(h.executedAt)}</span>
											<span>
												{h.durationMs} ms · {h.error ? 'ERR' : `${h.rowCount} rows`}
											</span>
										</div>
										<Show when={historyScope() === 'all' && h.connectionName}>
											<div>
												<span class="tag">{h.connectionName}</span>
											</div>
										</Show>
										<pre
											class="mono"
											style="margin:0;font-size:11.5px;white-space:pre-wrap;max-height:90px;overflow:hidden"
										>
											{h.sql}
										</pre>
										<Show when={h.error}>
											<div style="font-size:11px;color:var(--prod)" class="mono">
												{h.error}
											</div>
										</Show>
										<div style="display:flex;gap:6px">
											<button type="button" class="btn sm" onClick={() => editorHandle?.insertText(`\n${h.sql}\n`)}>
												Insert
											</button>
											<button type="button" class="btn sm" onClick={() => void executeSql(h.sql)}>
												Re-run
											</button>
										</div>
									</div>
								)}
							</For>
						</div>
					</aside>
				</Show>
			</div>

			<FkPeekCard state={peek()} />

			<CellViewer
				state={cellViewer()}
				canEdit={false}
				rwArmed={false}
				onClose={() => setCellViewer(null)}
				onCommitEdit={() => {}}
				onSwitchToEdit={() => {}}
				onNotify={props.onNotify}
			/>
		</div>
	)
}

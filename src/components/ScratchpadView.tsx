// Multi-statement SQL Console with auto-save, CodeMirror 6, concurrent per-console runs, Stop/Cancel, Split view, History, and FK links.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { clearConsoleRun, getConsoleRun, updateConsoleRun } from '../lib/console-runs.ts'
import { copyToClipboard, exportRowsCsv, exportRowsJson, formatCellText, formatIsoShort } from '../lib/format.ts'
import { IconAlert, IconArrowRight, IconClose, IconCopy, IconPlay, IconTable, IconTrash } from '../lib/icons.tsx'
import { formatSql, statementAtCursor } from '../shared/sql.ts'
import { tid } from '../shared/tid.ts'
import type { DatabaseSchema, ForeignKeyInfo, QueryHistoryEntry, Scratchpad } from '../shared/types.ts'
import type { ConfirmState } from './ConfirmDialog.tsx'
import { FkPeekCard, type FkPeekState } from './FkPeekCard.tsx'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor.tsx'

function formatElapsed(startedAt: number | null, nowMs: number): string {
	if (!startedAt) return '0.0s'
	const sec = Math.max(0, (nowMs - startedAt) / 1000)
	return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`
}

export function ScratchpadView(props: {
	connId: string
	connName?: string
	isProduction?: boolean
	scratchpad: Scratchpad | null
	schema: DatabaseSchema | null
	dark: boolean
	nowMs?: number
	focusTick?: number
	splitOpen?: boolean
	isSplitPane?: boolean
	allConsoles?: Scratchpad[]
	onToggleSplit?: () => void
	onCloseSplit?: () => void
	onSelectPad?: (padId: string) => void
	onScratchpadUpdated: (pad: Scratchpad) => void
	onScratchpadDeleted: (padId: string) => void
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
	const [history, setHistory] = createSignal<QueryHistoryEntry[]>([])
	const [peek, setPeek] = createSignal<FkPeekState | null>(null)

	let editorHandle: SqlEditorHandle | undefined
	let padSelectEl: HTMLSelectElement | undefined
	let saveTimer: ReturnType<typeof setTimeout> | null = null
	let peekTimer: ReturnType<typeof setTimeout> | null = null
	const peekCache = new Map<string, Record<string, unknown> | null>()

	const padId = () => props.scratchpad?.id
	const runState = createMemo(() => getConsoleRun(padId()))
	const running = () => runState().running
	const results = () => runState().results
	const activeTab = () => runState().activeTab
	const totalMs = () => runState().totalMs
	const runError = () => runState().runError

	createEffect(
		() => props.scratchpad?.id,
		() => {
			const pad = props.scratchpad
			if (saveTimer) clearTimeout(saveTimer)
			setTitle(pad?.title ?? 'Untitled console')
			setSql(pad?.sql ?? '')
			setSaveState('saved')
		},
	)

	// Keep dynamic split-pane console selector synced with props.scratchpad?.id after options update.
	createEffect(
		() => [props.scratchpad?.id, props.allConsoles] as const,
		([id]) => {
			if (padSelectEl && id) padSelectEl.value = id
		},
	)

	createEffect(
		() => props.focusTick,
		(tick) => {
			if (tick) queueMicrotask(() => editorHandle?.focus())
		},
	)

	function scheduleSave(nextTitle: string, nextSql: string) {
		const pad = props.scratchpad
		if (!pad) return
		setSaveState('saving')
		if (saveTimer) clearTimeout(saveTimer)
		saveTimer = setTimeout(async () => {
			try {
				const res = await api.updateScratchpad(pad.id, { title: nextTitle, sql: nextSql })
				props.onScratchpadUpdated(res.scratchpad)
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
		const targetPadId = padId() ?? `ephemeral:${props.connId}`
		const queryId = tid('q')
		updateConsoleRun(targetPadId, {
			running: true,
			startedAt: Date.now(),
			queryId,
			runError: null,
		})
		try {
			const res = await api.runQuery(props.connId, trimmed, confirmedDestructive, queryId)
			if (res.needsConfirmation) {
				updateConsoleRun(targetPadId, { running: false, startedAt: null, queryId: null })
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
			updateConsoleRun(targetPadId, {
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
			updateConsoleRun(targetPadId, {
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
		void executeSql(`EXPLAIN QUERY PLAN ${stripped}`)
	}

	function handleFormat() {
		const formatted = formatSql(sql())
		setSql(formatted)
		editorHandle?.replaceAll(formatted)
		scheduleSave(title(), formatted)
	}

	async function loadHistory() {
		try {
			const res = await api.listHistory(props.connId, 100)
			setHistory(res.history)
		} catch {}
	}

	const currentResult = createMemo(() => results()[activeTab()] ?? null)

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
		<div class="scratchpad-wrap">
			{/* Console toolbar */}
			<div class="view-toolbar">
				<Show
					when={props.isSplitPane && props.allConsoles && props.onSelectPad}
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
						ref={padSelectEl}
						class="select"
						style="height:26px;max-width:170px;font-weight:600"
						value={props.scratchpad?.id ?? ''}
						onChange={(e) => props.onSelectPad?.(e.currentTarget.value)}
						aria-label="Split console selector"
					>
						<For each={props.allConsoles}>
							{(p) => (
								<option value={p.id} selected={p.id === props.scratchpad?.id}>
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
						<button type="button" class="btn sm stop-btn" onClick={() => void cancelCurrent()}>
							<span class="status-pulse" />
							Stop ({elapsedText()})
						</button>
					}
				>
					<button type="button" class="btn sm primary" onClick={() => runCurrent()}>
						<IconPlay />
						Run
						<span class="kbd" style="border-color:rgba(255,255,255,0.35);background:transparent;color:inherit">
							⌘↵
						</span>
					</button>
				</Show>

				<button type="button" class="btn sm" disabled={running()} onClick={runAll}>
					Run All
					<span class="kbd">⇧⌘↵</span>
				</button>

				<Show when={!props.isSplitPane}>
					<button type="button" class="btn sm" disabled={running()} onClick={() => runExplain()}>
						Explain
						<span class="kbd">⇧⌘E</span>
					</button>
				</Show>

				<button type="button" class="btn sm" onClick={handleFormat}>
					Format
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
						onClick={() => {
							const next = !showHistory()
							setShowHistory(next)
							if (next) void loadHistory()
						}}
					>
						History
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

				<Show when={!props.isSplitPane && props.scratchpad}>
					{(pad) => (
						<button
							type="button"
							class="icon-btn ghost"
							style="height:26px;width:26px"
							aria-label="Delete console"
							onClick={() =>
								props.onRequestConfirm({
									title: `Delete "${pad().title}"?`,
									message: 'This permanently deletes this saved console.',
									confirmLabel: 'Delete Console',
									danger: true,
									onConfirm: async () => {
										await api.deleteScratchpad(pad().id)
										clearConsoleRun(pad().id)
										props.onScratchpadDeleted(pad().id)
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
				<div class="scratchpad-split">
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
											? `Running query on ${props.connName || 'database'}… ${elapsedText()}`
											: 'Press ⌘Enter to run the highlighted statement under cursor, or ⇧⌘Enter to run all statements.'}
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
												const id = padId()
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
							</Show>

							<Show when={totalMs() !== null}>
								<span class="mono" style="font-size:11.5px;color:var(--ink-secondary)">
									{totalMs()} ms
								</span>
							</Show>
						</div>

						<div class="grid-scroll">
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
											<table class="data-table">
												<thead>
													<tr>
														<th style="width:44px;text-align:right;color:var(--ink-muted)">#</th>
														<For each={res().columns}>
															{(col) => (
																<th>
																	<span>{col}</span>
																	<Show when={currentFkMap().get(col)}>
																		{(fk) => (
																			<span class="th-badge fk" style="margin-left:6px">
																				→ {fk().toTable}
																			</span>
																		)}
																	</Show>
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
																	{(col) => {
																		const val = () => row[col]
																		const fk = () => currentFkMap().get(col)
																		return (
																			<td>
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
																						onClick={() => props.onFollowFk(fk()!.toTable, fk()!.toColumn, val())}
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
					<aside class="inspector" style="width:340px">
						<div class="inspector-head">
							<span>Query History ({history().length})</span>
							<div style="display:flex;gap:4px">
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
								<button class="icon-btn ghost" type="button" onClick={() => setShowHistory(false)}>
									<IconClose />
								</button>
							</div>
						</div>
						<div class="inspector-body" style="gap:8px">
							<Show when={history().length === 0}>
								<div style="color:var(--ink-muted)">No executed queries yet.</div>
							</Show>
							<For each={history()}>
								{(h) => (
									<div style="border:1px solid var(--border-strong);border-radius:var(--radius);padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--bg-subtle)">
										<div
											style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-muted)"
											class="mono"
										>
											<span>{formatIsoShort(h.executedAt)}</span>
											<span>
												{h.durationMs} ms · {h.error ? 'ERR' : `${h.rowCount} rows`}
											</span>
										</div>
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
		</div>
	)
}

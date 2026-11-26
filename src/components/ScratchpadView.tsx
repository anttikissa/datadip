// Multi-statement SQL Scratchpad with auto-save, CodeMirror 6, Explain, Format, History drawer, and clickable FK links in results.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { copyToClipboard, exportRowsCsv, exportRowsJson, formatCellText, formatIsoShort } from '../lib/format.ts'
import { IconArrowRight, IconClose, IconCopy, IconPlay, IconTable, IconTrash } from '../lib/icons.tsx'
import { formatSql, statementAtCursor } from '../shared/sql.ts'
import type {
	DatabaseSchema,
	ForeignKeyInfo,
	QueryHistoryEntry,
	QueryStatementResult,
	Scratchpad,
} from '../shared/types.ts'
import type { ConfirmState } from './ConfirmDialog.tsx'
import { FkPeekCard, type FkPeekState } from './FkPeekCard.tsx'
import { SqlEditor, type SqlEditorHandle } from './SqlEditor.tsx'

export function ScratchpadView(props: {
	connId: string
	scratchpad: Scratchpad | null
	schema: DatabaseSchema | null
	dark: boolean
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
	const [running, setRunning] = createSignal(false)
	const [results, setResults] = createSignal<QueryStatementResult[]>([])
	const [activeTab, setActiveTab] = createSignal(0)
	const [totalMs, setTotalMs] = createSignal<number | null>(null)
	const [runError, setRunError] = createSignal<string | null>(null)

	const [showHistory, setShowHistory] = createSignal(false)
	const [history, setHistory] = createSignal<QueryHistoryEntry[]>([])
	const [peek, setPeek] = createSignal<FkPeekState | null>(null)

	let editorHandle: SqlEditorHandle | undefined
	let saveTimer: ReturnType<typeof setTimeout> | null = null
	let peekTimer: ReturnType<typeof setTimeout> | null = null
	const peekCache = new Map<string, Record<string, unknown> | null>()

	createEffect(
		() => props.scratchpad?.id,
		() => {
			const pad = props.scratchpad
			if (saveTimer) clearTimeout(saveTimer)
			setTitle(pad?.title ?? 'Untitled scratchpad')
			setSql(pad?.sql ?? '')
			setSaveState('saved')
			setRunError(null)
			setResults([])
			setActiveTab(0)
			setTotalMs(null)
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
		setRunning(true)
		setRunError(null)
		try {
			const res = await api.runQuery(props.connId, trimmed, confirmedDestructive)
			if (res.needsConfirmation) {
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
			setResults(res.results)
			setActiveTab(0)
			setTotalMs(res.totalDurationMs)
			if (res.rwArmedUntil !== undefined) props.onRwTimerUpdated(res.rwArmedUntil)
			if (res.results.some((r) => r.changes > 0 || /^\s*(CREATE|DROP|ALTER)\b/i.test(r.sql))) {
				props.onSchemaChanged()
			}
			if (showHistory()) void loadHistory()
		} catch (err) {
			setRunError(err instanceof Error ? err.message : String(err))
		} finally {
			setRunning(false)
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

	return (
		<div class="scratchpad-wrap">
			{/* Scratchpad toolbar */}
			<div class="view-toolbar">
				<input
					class="input"
					style="width:220px;height:26px;font-weight:600"
					value={title()}
					onInput={(e) => {
						const v = e.currentTarget.value
						setTitle(v)
						scheduleSave(v, sql())
					}}
					aria-label="Scratchpad title"
				/>
				<span style="font-size:11px;color:var(--ink-muted)">{saveState() === 'saving' ? 'Saving…' : 'Saved'}</span>

				<div class="topbar-sep" />

				<button type="button" class="btn sm primary" disabled={running()} onClick={() => runCurrent()}>
					<IconPlay />
					Run Statement
					<span class="kbd" style="border-color:rgba(255,255,255,0.35);background:transparent;color:inherit">
						⌘↵
					</span>
				</button>

				<button type="button" class="btn sm" disabled={running()} onClick={runAll}>
					Run All
					<span class="kbd">⇧⌘↵</span>
				</button>

				<button type="button" class="btn sm" disabled={running()} onClick={() => runExplain()}>
					Explain
					<span class="kbd">⌘E</span>
				</button>

				<button type="button" class="btn sm" onClick={handleFormat}>
					Format
					<span class="kbd">⇧⌘F</span>
				</button>

				<div style="flex:1" />

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

				<Show when={props.scratchpad}>
					{(pad) => (
						<button
							type="button"
							class="icon-btn ghost"
							style="height:26px;width:26px"
							aria-label="Delete scratchpad"
							onClick={() =>
								props.onRequestConfirm({
									title: `Delete "${pad().title}"?`,
									message: 'This permanently deletes this saved scratchpad.',
									confirmLabel: 'Delete Scratchpad',
									danger: true,
									onConfirm: async () => {
										await api.deleteScratchpad(pad().id)
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
							onReady={(h) => (editorHandle = h)}
						/>
					</div>

					<div class="results-pane">
						<div class="results-tabs">
							<Show
								when={results().length > 0}
								fallback={
									<span style="font-size:12px;color:var(--ink-muted)">
										{running()
											? 'Running query…'
											: 'Press ⌘Enter to run the highlighted statement under cursor, or ⇧⌘Enter to run all statements.'}
									</span>
								}
							>
								<For each={results()}>
									{(r, idx) => (
										<button
											type="button"
											class={['btn sm', { primary: activeTab() === idx() }]}
											onClick={() => setActiveTab(idx())}
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
									Open {currentResult()!.sourceTable} in Table Browser
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

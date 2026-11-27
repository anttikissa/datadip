// Anchored Cell Viewer & multi-line Cell Editor popover for inspecting or editing truncated/long table cells.
import { createEffect, createMemo, createSignal, onSettled, Show } from 'solid-js'
import { copyToClipboard, formatCellText, tryFormatTimestampHint, tryPrettyJson } from '../lib/format.ts'
import { IconClock, IconClose, IconCopy, IconLock, IconUnlock } from '../lib/icons.tsx'
import { isPrimaryMod, modKeyLabel } from '../lib/shortcuts.ts'
import { autoDecodeSingleValue } from '../shared/lenses.ts'

export interface CellViewerState {
	rowIdx: number
	colName: string
	colType: string
	value: unknown
	mode: 'view' | 'edit'
	anchor: { left: number; top: number; bottom: number; right: number }
}

export function CellViewer(props: {
	state: CellViewerState | null
	canEdit: boolean
	rwArmed: boolean
	onClose: () => void
	onCommitEdit: (rowIdx: number, colName: string, draft: string, setNull: boolean) => void
	onRequestArmRw?: () => void
	onSwitchToEdit: () => void
	onNotify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
}) {
	let popEl: HTMLDivElement | undefined
	let textAreaEl: HTMLTextAreaElement | undefined
	let viewAreaEl: HTMLTextAreaElement | undefined

	const [pretty, setPretty] = createSignal(true)
	const [draft, setDraft] = createSignal('')

	createEffect(
		() => props.state,
		(st) => {
			if (!st) return
			setPretty(true)
			setDraft(st.value === null || st.value === undefined ? '' : String(st.value))
			queueMicrotask(() => {
				if (st.mode === 'edit') {
					textAreaEl?.focus()
					textAreaEl?.setSelectionRange(textAreaEl.value.length, textAreaEl.value.length)
				} else {
					viewAreaEl?.focus()
				}
			})
		},
	)

	onSettled(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!props.state) return
			if (e.key === 'Escape') {
				e.preventDefault()
				e.stopPropagation()
				props.onClose()
				return
			}
			if (isPrimaryMod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
				const target = props.state.mode === 'edit' ? textAreaEl : viewAreaEl
				if (target) {
					e.preventDefault()
					e.stopPropagation()
					target.focus()
					target.select()
				}
			}
		}
		const onMouseDown = (e: MouseEvent) => {
			if (!props.state || !popEl) return
			if (!popEl.contains(e.target as Node)) {
				props.onClose()
			}
		}
		window.addEventListener('keydown', onKey, true)
		window.addEventListener('mousedown', onMouseDown, true)
		return () => {
			window.removeEventListener('keydown', onKey, true)
			window.removeEventListener('mousedown', onMouseDown, true)
		}
	})

	const rawText = createMemo(() => (props.state ? formatCellText(props.state.value) : ''))
	const prettyJson = createMemo(() => (props.state ? tryPrettyJson(props.state.value) : null))
	const lens = createMemo(() => (props.state ? autoDecodeSingleValue(props.state.value, props.state.colName) : null))
	const tsHint = createMemo(() => (props.state && !lens() ? tryFormatTimestampHint(props.state.value) : null))
	const displayedText = createMemo(() => (pretty() && prettyJson() ? prettyJson()! : rawText()))

	const posStyle = createMemo(() => {
		const st = props.state
		if (!st) return ''
		const width = Math.min(540, window.innerWidth - 28)
		const left = Math.max(14, Math.min(st.anchor.left, window.innerWidth - width - 14))
		const spaceBelow = window.innerHeight - st.anchor.bottom - 16
		const preferBelow = spaceBelow >= 240 || spaceBelow >= st.anchor.top
		if (preferBelow) {
			const top = Math.min(st.anchor.bottom + 6, window.innerHeight - 220)
			return `left:${left}px;top:${top}px;width:${width}px`
		}
		const bottom = Math.max(14, window.innerHeight - st.anchor.top + 6)
		return `left:${left}px;bottom:${bottom}px;width:${width}px`
	})

	return (
		<Show when={props.state}>
			{(st) => (
				<div
					ref={(el) => (popEl = el)}
					class="cell-viewer"
					style={posStyle()}
					role="dialog"
					aria-label={`Cell ${st().colName}`}
				>
					<div class="cell-viewer-head">
						<div style="display:flex;align-items:baseline;gap:6px;min-width:0">
							<span class="mono" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
								{st().colName}
							</span>
							<span class="th-type">{st().colType}</span>
							<Show when={st().value !== null && st().value !== undefined}>
								<span class="tag">{rawText().length.toLocaleString()} chars</span>
							</Show>
						</div>
						<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
							<Show when={st().mode === 'view' && prettyJson()}>
								<button
									type="button"
									class={['btn sm', { 'active-toggle': pretty() }]}
									onClick={() => setPretty((v) => !v)}
								>
									{pretty() ? 'Pretty JSON' : 'Raw'}
								</button>
							</Show>
							<Show when={st().mode === 'view'}>
								<button
									type="button"
									class="btn sm"
									onClick={async () => {
										if (await copyToClipboard(displayedText())) {
											props.onNotify(`Copied ${st().colName}`, 'ok')
										}
									}}
								>
									<IconCopy />
									Copy
								</button>
							</Show>
							<button
								type="button"
								class="icon-btn ghost"
								style="width:24px;height:24px"
								onClick={props.onClose}
								aria-label="Close cell viewer"
							>
								<IconClose />
							</button>
						</div>
					</div>

					<Show
						when={st().mode === 'edit'}
						fallback={
							<>
								<div class="cell-viewer-body">
									<Show
										when={st().value !== null && st().value !== undefined}
										fallback={<span class="cell-null mono">NULL</span>}
									>
										<textarea
											ref={(el) => (viewAreaEl = el)}
											readonly
											class="cell-viewer-pre cell-viewer-ro"
											rows={Math.max(2, Math.min(14, displayedText().split('\n').length))}
											value={displayedText()}
											aria-label={`${st().colName} value`}
										/>
									</Show>
									<Show when={lens()}>
										{(d) => (
											<div class="lens-decoded-strip mono" style="margin-top:8px">
												<span class="lens-decoded-badge">
													<IconClock />
													{d().formatLabel}
												</span>
												<span>{d().utc} UTC</span>
												<span style="color:var(--ink-muted)">· Local: {d().local}</span>
												<span style="color:var(--ink-muted)">({d().relative})</span>
											</div>
										)}
									</Show>
									<Show when={tsHint()}>{(h) => <div class="inspector-hint mono">{h()}</div>}</Show>
								</div>
								<div class="cell-viewer-foot">
									<Show
										when={props.rwArmed}
										fallback={
											<>
												<span style="display:inline-flex;align-items:center;gap:5px;color:var(--ink-muted)">
													<IconLock />
													Read-Only
												</span>
												<Show when={props.canEdit && props.onRequestArmRw}>
													<button
														type="button"
														class="btn sm ghost-btn"
														onClick={() => {
															props.onClose()
															props.onRequestArmRw?.()
														}}
													>
														<IconUnlock />
														Switch to Read-Write to edit
													</button>
												</Show>
											</>
										}
									>
										<span style="color:var(--ink-muted)">Press Esc to close</span>
										<Show when={props.canEdit}>
											<button type="button" class="btn sm primary" onClick={props.onSwitchToEdit}>
												Edit Value
											</button>
										</Show>
									</Show>
								</div>
							</>
						}
					>
						<div class="cell-viewer-body">
							<textarea
								ref={(el) => (textAreaEl = el)}
								class="cell-viewer-textarea mono"
								rows={7}
								value={draft()}
								onInput={(e) => setDraft(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (isPrimaryMod(e) && !e.altKey && !e.shiftKey && e.key === 'Enter') {
										e.preventDefault()
										props.onCommitEdit(st().rowIdx, st().colName, draft(), false)
									}
								}}
							/>
						</div>
						<div class="cell-viewer-foot">
							<button
								type="button"
								class="btn sm"
								onClick={() => props.onCommitEdit(st().rowIdx, st().colName, '', true)}
							>
								Set NULL
							</button>
							<div style="display:flex;gap:6px">
								<button type="button" class="btn sm" onClick={props.onClose}>
									Cancel
								</button>
								<button
									type="button"
									class="btn sm primary"
									onClick={() => props.onCommitEdit(st().rowIdx, st().colName, draft(), false)}
								>
									Stage Edit ({modKeyLabel('↵')})
								</button>
							</div>
						</div>
					</Show>
				</div>
			)}
		</Show>
	)
}

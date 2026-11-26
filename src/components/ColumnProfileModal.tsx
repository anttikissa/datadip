// Native <dialog> column profiling view showing null %, distinct count, min/max, and top values with click-to-filter.
import { createEffect, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { IconClose } from '../lib/icons.tsx'
import type { ColumnProfile, FilterOp } from '../shared/types.ts'

export function ColumnProfileModal(props: {
	open: boolean
	connId: string
	table: string
	column: string | null
	onClose: () => void
	onApplyFilter: (column: string, op: FilterOp, value: string) => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	const [profile, setProfile] = createSignal<ColumnProfile | null>(null)
	const [loading, setLoading] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)

	createEffect(
		() => [props.open, props.connId, props.table, props.column] as const,
		([open, connId, table, column]) => {
			if (!dialogEl) return
			if (!open || !column) {
				if (dialogEl.open) dialogEl.close()
				return
			}
			if (!dialogEl.open) dialogEl.showModal()
			let cancelled = false
			setLoading(true)
			setError(null)
			setProfile(null)
			api
				.profileColumn(connId, table, column)
				.then((res) => {
					if (!cancelled) setProfile(res.profile)
				})
				.catch((err) => {
					if (!cancelled) setError(err instanceof Error ? err.message : String(err))
				})
				.finally(() => {
					if (!cancelled) setLoading(false)
				})
			return () => {
				cancelled = true
			}
		},
	)

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="modal wide"
			onCancel={(e) => {
				e.preventDefault()
				props.onClose()
			}}
			onClick={(e) => {
				if (e.target === dialogEl) props.onClose()
			}}
		>
			<div class="modal-head">
				<span class="mono" style="font-size:12.5px">
					Column Profile · {props.table}.{props.column}
				</span>
				<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
					<IconClose />
				</button>
			</div>

			<div class="modal-body">
				<Show when={loading()}>
					<div style="padding:18px 0;color:var(--ink-muted);text-align:center">Profiling column…</div>
				</Show>
				<Show when={error()}>
					{(msg) => (
						<div class="error-box" style="margin:0">
							{msg()}
						</div>
					)}
				</Show>
				<Show when={profile()}>
					{(p) => {
						const maxCount = () => Math.max(1, ...p().topValues.map((v) => v.count))
						return (
							<>
								<div class="profile-stats-grid">
									<div class="profile-stat">
										<div class="field-label">Total Rows</div>
										<div class="profile-stat-val mono">{p().totalRows.toLocaleString()}</div>
									</div>
									<div class="profile-stat">
										<div class="field-label">Distinct</div>
										<div class="profile-stat-val mono">{p().distinctCount.toLocaleString()}</div>
									</div>
									<div class="profile-stat">
										<div class="field-label">Nulls</div>
										<div class="profile-stat-val mono">
											{p().nullCount.toLocaleString()}{' '}
											<span style="font-size:11px;color:var(--ink-muted)">({p().nullPct}%)</span>
										</div>
									</div>
									<div class="profile-stat">
										<div class="field-label">Type / Time</div>
										<div class="profile-stat-val mono" style="font-size:12px">
											{p().columnType} · {p().durationMs}ms
										</div>
									</div>
								</div>

								<div class="field-row">
									<div class="profile-minmax">
										<span class="field-label">Min</span>
										<span class="mono">{p().min ?? 'NULL'}</span>
									</div>
									<div class="profile-minmax">
										<span class="field-label">Max</span>
										<span class="mono">{p().max ?? 'NULL'}</span>
									</div>
								</div>

								<div>
									<div class="field-label" style="margin-bottom:6px">
										Top Values (click to filter table)
									</div>
									<Show
										when={p().topValues.length > 0}
										fallback={<div style="color:var(--ink-muted);font-size:12px">Table has no rows.</div>}
									>
										<div class="profile-bars">
											<For each={p().topValues}>
												{(item) => {
													const pct = () =>
														p().totalRows > 0 ? Math.round((item.count / p().totalRows) * 1000) / 10 : 0
													const barPct = () => Math.max(2, Math.round((item.count / maxCount()) * 100))
													return (
														<button
															type="button"
															class="profile-bar-row"
															onClick={() => {
																if (item.value === null) {
																	props.onApplyFilter(p().column, 'isnull', '')
																} else {
																	props.onApplyFilter(p().column, 'eq', item.value)
																}
																props.onClose()
															}}
														>
															<span class="profile-bar-fill" style={`width:${barPct()}%`} />
															<span class="profile-bar-label mono">
																{item.value === null ? <span class="cell-null">NULL</span> : item.value}
															</span>
															<span class="profile-bar-count mono">
																{item.count.toLocaleString()} ({pct()}%)
															</span>
														</button>
													)
												}}
											</For>
										</div>
									</Show>
								</div>
							</>
						)
					}}
				</Show>
			</div>

			<div class="modal-foot">
				<button type="button" class="btn" onClick={() => props.onClose()}>
					Close
				</button>
			</div>
		</dialog>
	)
}

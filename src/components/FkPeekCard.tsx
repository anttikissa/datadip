// Floating FK hover-peek card showing target row fields without leaving the current grid.
import { For, Show } from 'solid-js'
import { formatCellText } from '../lib/format.ts'

export interface FkPeekState {
	x: number
	y: number
	targetTable: string
	targetColumn: string
	value: unknown
	loading: boolean
	row: Record<string, unknown> | null
}

export function FkPeekCard(props: { state: FkPeekState | null }) {
	return (
		<Show when={props.state}>
			{(st) => {
				const entries = () => (st().row ? Object.entries(st().row!).slice(0, 8) : [])
				const left = () => Math.min(window.innerWidth - 336, Math.max(12, st().x + 14))
				const top = () => Math.min(window.innerHeight - 270, Math.max(52, st().y + 16))
				return (
					<div class="fk-peek" style={{ left: `${left()}px`, top: `${top()}px` }}>
						<div class="fk-peek-head">
							<span>
								{st().targetTable}.{st().targetColumn} = {formatCellText(st().value)}
							</span>
							<span style="color:var(--ink-muted);font-weight:400">Click to follow</span>
						</div>
						<div class="fk-peek-body">
							<Show when={st().loading}>
								<span style="color:var(--ink-muted)">Loading row…</span>
							</Show>
							<Show when={!st().loading && !st().row}>
								<span style="color:var(--ink-muted)">No matching row found</span>
							</Show>
							<For each={entries()}>
								{([k, v]) => (
									<div class="fk-peek-row">
										<span class="fk-peek-key">{k}</span>
										<span class="fk-peek-val">
											{v === null ? <span class="cell-null">NULL</span> : formatCellText(v)}
										</span>
									</div>
								)}
							</For>
						</div>
					</div>
				)
			}}
		</Show>
	)
}

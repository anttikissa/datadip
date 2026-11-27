// Slide-over Row Inspector showing formatted JSON/ASON, timestamp hints, outgoing FKs, and live incoming (reverse) FK counts.
import { createEffect, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import {
	copyToClipboard,
	exportRowsAson,
	exportRowsJson,
	exportRowsSqlInsert,
	formatCellText,
	tryFormatTimestampHint,
	tryPrettyJson,
} from '../lib/format.ts'
import { IconArrowRight, IconClock, IconClose, IconCopy, IconLink, IconTrash } from '../lib/icons.tsx'
import { autoDecodeSingleValue } from '../shared/lenses.ts'
import type { ForeignKeyInfo, ReverseFkCount, TableSchema } from '../shared/types.ts'

export function RowInspector(props: {
	connId: string
	tableSchema: TableSchema
	row: Record<string, unknown> | null
	rwArmed: boolean
	onClose: () => void
	onFollowFk: (targetTable: string, targetColumn: string, value: unknown) => void
	onLinkColumn?: (columnName: string) => void
	onDuplicateRow?: (row: Record<string, unknown>) => void
	onDeleteRow: (row: Record<string, unknown>) => void
	onNotify: (msg: string) => void
}) {
	const [revCounts, setRevCounts] = createSignal<ReverseFkCount[]>([])
	const [loadingRev, setLoadingRev] = createSignal(false)

	createEffect(
		() => [props.connId, props.tableSchema.name, props.row] as const,
		([connId, tableName, row]) => {
			if (!row || props.tableSchema.reverseForeignKeys.length === 0) {
				setRevCounts([])
				return
			}
			let cancelled = false
			setLoadingRev(true)
			api
				.countReverseFks(connId, tableName, row)
				.then((res) => {
					if (!cancelled) setRevCounts(res.counts)
				})
				.catch(() => {
					if (!cancelled) setRevCounts([])
				})
				.finally(() => {
					if (!cancelled) setLoadingRev(false)
				})
			return () => {
				cancelled = true
			}
		},
	)

	function fkFor(colName: string): ForeignKeyInfo | undefined {
		return props.tableSchema.foreignKeys.find((fk) => fk.fromColumn === colName)
	}

	async function copyRow(kind: 'json' | 'ason' | 'sql') {
		const row = props.row
		if (!row) return
		const cols = props.tableSchema.columns.map((c) => c.name)
		const text =
			kind === 'json'
				? exportRowsJson([row])
				: kind === 'ason'
					? exportRowsAson([row])
					: exportRowsSqlInsert(props.tableSchema.name, cols, [row])
		if (await copyToClipboard(text)) props.onNotify(`Copied row as ${kind.toUpperCase()}`)
	}

	return (
		<Show when={props.row}>
			{(row) => (
				<aside class="inspector" aria-label="Row Inspector">
					<div class="inspector-head">
						<span class="mono" style="font-size:12px">
							Row Inspector · {props.tableSchema.name}
						</span>
						<div style="display:flex;align-items:center;gap:4px">
							<button class="btn sm" type="button" onClick={() => copyRow('json')}>
								JSON
							</button>
							<button class="btn sm" type="button" onClick={() => copyRow('ason')}>
								ASON
							</button>
							<button class="btn sm" type="button" onClick={() => copyRow('sql')}>
								SQL
							</button>
							<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close inspector">
								<IconClose />
							</button>
						</div>
					</div>

					<div class="inspector-body">
						<Show when={props.tableSchema.reverseForeignKeys.length > 0}>
							<div>
								<div class="field-label" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em">
									Referenced By (Incoming FKs)
								</div>
								<Show when={loadingRev()}>
									<div style="font-size:12px;color:var(--ink-muted)">Counting references…</div>
								</Show>
								<div class="ref-list">
									<For each={revCounts()}>
										{(rfk) => (
											<button
												type="button"
												class="ref-card"
												onClick={() => props.onFollowFk(rfk.fromTable, rfk.fromColumn, row()[rfk.toColumn])}
											>
												<span class="mono" style="font-size:12px">
													<strong>{rfk.fromTable}</strong>.{rfk.fromColumn}
												</span>
												<span class="ref-card-meta">
													<Show when={rfk.source}>
														{(src) => (
															<span
																class={['tag', { virtual: src() === 'virtual', inferred: src() === 'inferred' }]}
																title={rfk.inferenceReason}
															>
																{src() === 'virtual' ? 'VIRTUAL' : rfk.inferenceKind === 'data' ? 'LEARNED' : 'AUTO'}
															</span>
														)}
													</Show>
													<span class="tag">{rfk.count} rows</span>
													<IconArrowRight />
												</span>
											</button>
										)}
									</For>
								</div>
							</div>
						</Show>

						<div>
							<div class="field-label" style="margin-bottom:6px;text-transform:uppercase;letter-spacing:0.06em">
								Fields ({props.tableSchema.columns.length})
							</div>
							<For each={props.tableSchema.columns}>
								{(col) => {
									const val = () => row()[col.name]
									const fk = () => fkFor(col.name)
									const pretty = () => tryPrettyJson(val())
									const lens = () => autoDecodeSingleValue(val(), col.name)
									const tsHint = () => (lens() ? null : tryFormatTimestampHint(val()))
									return (
										<div class="inspector-field">
											<div class="inspector-field-head">
												<span style="display:inline-flex;align-items:baseline;gap:5px">
													<strong class="mono">{col.name}</strong>
													<span class="th-type">{col.type}</span>
													<Show when={col.primaryKey > 0}>
														<span class="th-badge pk">PK</span>
													</Show>
													<Show when={fk()}>
														{(f) => (
															<span
																class={[
																	'th-badge',
																	'fk',
																	{ virtual: f().source === 'virtual', inferred: f().source === 'inferred' },
																]}
																title={
																	f().source === 'virtual'
																		? `Virtual FK → ${f().toTable}.${f().toColumn}`
																		: f().source === 'inferred'
																			? `Auto-inferred FK → ${f().toTable}.${f().toColumn}`
																			: `Foreign key → ${f().toTable}.${f().toColumn}`
																}
															>
																→ {f().toTable}
															</span>
														)}
													</Show>
												</span>
												<span style="display:inline-flex;align-items:center;gap:2px;align-self:center">
													<Show when={props.onLinkColumn}>
														<button
															type="button"
															class="icon-btn ghost"
															style="width:22px;height:22px"
															title={
																fk()
																	? `Manage foreign key link for ${col.name}`
																	: `Link ${col.name} as virtual foreign key`
															}
															aria-label={`Configure foreign key for ${col.name}`}
															onClick={() => props.onLinkColumn?.(col.name)}
														>
															<IconLink />
														</button>
													</Show>
													<button
														type="button"
														class="icon-btn ghost"
														style="width:22px;height:22px"
														onClick={async () => {
															if (await copyToClipboard(formatCellText(val()))) {
																props.onNotify(`Copied ${col.name}`)
															}
														}}
														aria-label={`Copy ${col.name}`}
													>
														<IconCopy />
													</button>
												</span>
											</div>

											<Show
												when={fk() && val() !== null && val() !== undefined}
												fallback={
													<pre class="inspector-val">
														{val() === null || val() === undefined ? (
															<span class="cell-null">NULL</span>
														) : (
															(pretty() ?? formatCellText(val()))
														)}
													</pre>
												}
											>
												<div style="display:flex;align-items:center;gap:8px">
													<button
														type="button"
														class="fk-link mono"
														style="padding:4px 8px"
														onClick={() => props.onFollowFk(fk()!.toTable, fk()!.toColumn, val())}
													>
														<span>{formatCellText(val())}</span>
														<IconArrowRight />
														<span style="opacity:0.75">{fk()!.toTable}</span>
													</button>
												</div>
											</Show>

											<Show when={lens()}>
												{(d) => (
													<div class="lens-decoded-strip mono">
														<span class="lens-decoded-badge">
															<IconClock />
															{d().formatLabel}
														</span>
														<span>{d().utc} UTC</span>
														<span style="color:var(--ink-muted)">({d().relative})</span>
														<button
															type="button"
															class="icon-btn ghost"
															style="width:18px;height:18px;margin-left:auto"
															title={`Copy ${d().utc} UTC`}
															aria-label="Copy decoded timestamp"
															onClick={async () => {
																if (await copyToClipboard(`${d().utc} UTC`)) {
																	props.onNotify(`Copied ${d().utc} UTC`)
																}
															}}
														>
															<IconCopy />
														</button>
													</div>
												)}
											</Show>
											<Show when={tsHint()}>{(hint) => <div class="inspector-hint mono">{hint()}</div>}</Show>
										</div>
									)
								}}
							</For>
						</div>

						<Show
							when={
								props.rwArmed && props.tableSchema.type === 'table' && props.tableSchema.primaryKeyColumns.length > 0
							}
						>
							<div style="padding-top:6px;display:flex;flex-direction:column;gap:8px">
								<Show when={props.onDuplicateRow}>
									<button
										type="button"
										class="btn"
										style="width:100%;justify-content:center"
										onClick={() => props.onDuplicateRow?.(row())}
									>
										<IconCopy />
										Duplicate Row
									</button>
								</Show>
								<button
									type="button"
									class="btn danger"
									style="width:100%;justify-content:center"
									onClick={() => props.onDeleteRow(row())}
								>
									<IconTrash />
									Delete This Row
								</button>
							</div>
						</Show>
					</div>
				</aside>
			)}
		</Show>
	)
}

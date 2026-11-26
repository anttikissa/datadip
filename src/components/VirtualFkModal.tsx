// Modal dialog for configuring local virtual (undeclared) foreign keys and managing auto-inferred links.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { IconClose, IconTrash } from '../lib/icons.tsx'
import type { DatabaseSchema, ForeignKeyInfo } from '../shared/types.ts'
import { guessTargetTableForColumn } from '../shared/virtual-fks.ts'

function defaultTargetColumn(targetTable: string, schema: DatabaseSchema | null): string {
	const ts = schema?.schemas[targetTable]
	if (!ts || ts.columns.length === 0) return ''
	if (ts.primaryKeyColumns.length > 0) return ts.primaryKeyColumns[0]!
	const idCol = ts.columns.find((c) => c.name.toLowerCase() === 'id')
	return idCol?.name ?? ts.columns[0]!.name
}

export function VirtualFkModal(props: {
	open: boolean
	connId: string
	fromTable: string
	initialFromColumn?: string | null
	schema: DatabaseSchema | null
	onClose: () => void
	onChanged: (msg: string) => void
	onNotify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	let fromColEl: HTMLSelectElement | undefined
	let toTableEl: HTMLSelectElement | undefined
	let toColEl: HTMLSelectElement | undefined

	const [fromColumn, setFromColumn] = createSignal('')
	const [toTable, setToTable] = createSignal('')
	const [toColumn, setToColumn] = createSignal('')
	const [busy, setBusy] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)

	const sourceSchema = createMemo(() => props.schema?.schemas[props.fromTable] ?? null)
	const sourceColumns = createMemo(() => sourceSchema()?.columns ?? [])
	const targetTables = createMemo(() => {
		const all = props.schema?.tables ?? []
		const nonInternal = all.filter((t) => !t.isInternal)
		return nonInternal.length > 0 ? nonInternal : all
	})
	const targetColumns = createMemo(() => props.schema?.schemas[toTable()]?.columns ?? [])

	const existingForColumn = createMemo<ForeignKeyInfo[]>(() => {
		const col = fromColumn()
		if (!col) return []
		return (sourceSchema()?.foreignKeys ?? []).filter((fk) => fk.fromColumn === col)
	})

	createEffect(
		() => [props.open, props.fromTable, props.initialFromColumn] as const,
		([open, fromTable, initCol]) => {
			if (dialogEl) {
				if (open && !dialogEl.open) dialogEl.showModal()
				else if (!open && dialogEl.open) dialogEl.close()
			}
			if (!open) return
			setError(null)
			const cols = sourceColumns()
			const chosenFrom =
				(initCol && cols.some((c) => c.name === initCol) ? initCol : null) ??
				cols.find((c) => c.name.endsWith('_id') || c.name.endsWith('Id'))?.name ??
				cols[0]?.name ??
				''
			setFromColumn(chosenFrom)
			const guessedTable = guessTargetTableForColumn(fromTable, chosenFrom, props.schema)
			setToTable(guessedTable)
			setToColumn(defaultTargetColumn(guessedTable, props.schema))
		},
	)

	// Keep controlled <select> DOM values synchronized whenever options or selected values change.
	createEffect(
		() => [fromColumn(), sourceColumns()] as const,
		([val]) => {
			if (fromColEl) fromColEl.value = val
		},
	)
	createEffect(
		() => [toTable(), targetTables()] as const,
		([val]) => {
			if (toTableEl) toTableEl.value = val
		},
	)
	createEffect(
		() => [toColumn(), targetColumns()] as const,
		([val]) => {
			if (toColEl) toColEl.value = val
		},
	)

	function handleFromColumnChange(nextCol: string) {
		setFromColumn(nextCol)
		const guessedTable = guessTargetTableForColumn(props.fromTable, nextCol, props.schema)
		if (guessedTable) {
			setToTable(guessedTable)
			setToColumn(defaultTargetColumn(guessedTable, props.schema))
		}
	}

	function handleToTableChange(nextTable: string) {
		setToTable(nextTable)
		setToColumn(defaultTargetColumn(nextTable, props.schema))
	}

	async function handleSave(e: Event) {
		e.preventDefault()
		const fc = fromColumn().trim()
		const tt = toTable().trim()
		const tc = toColumn().trim()
		if (!fc || !tt || !tc) {
			setError('Choose source column, target table, and target column.')
			return
		}
		setBusy(true)
		setError(null)
		try {
			await api.addVirtualFk(props.connId, {
				fromTable: props.fromTable,
				fromColumn: fc,
				toTable: tt,
				toColumn: tc,
			})
			props.onChanged(`Linked ${props.fromTable}.${fc} → ${tt}.${tc}`)
			props.onClose()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	async function handleRemoveVirtual(fk: ForeignKeyInfo) {
		setBusy(true)
		setError(null)
		try {
			await api.removeVirtualFk(props.connId, {
				fromTable: props.fromTable,
				fromColumn: fk.fromColumn,
				toTable: fk.toTable,
				toColumn: fk.toColumn,
			})
			props.onChanged(`Removed virtual FK ${props.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`)
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		} finally {
			setBusy(false)
		}
	}

	async function handleDismissInferred(fk: ForeignKeyInfo) {
		setBusy(true)
		setError(null)
		try {
			await api.ignoreInferredFk(props.connId, {
				fromTable: props.fromTable,
				fromColumn: fk.fromColumn,
			})
			props.onChanged(`Dismissed inferred FK on ${props.fromTable}.${fk.fromColumn}`)
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		} finally {
			setBusy(false)
		}
	}

	async function handleConfirmInferred(fk: ForeignKeyInfo) {
		setBusy(true)
		setError(null)
		try {
			await api.addVirtualFk(props.connId, {
				fromTable: props.fromTable,
				fromColumn: fk.fromColumn,
				toTable: fk.toTable,
				toColumn: fk.toColumn,
			})
			props.onChanged(`Saved virtual FK ${props.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`)
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		} finally {
			setBusy(false)
		}
	}

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="modal"
			onCancel={(e) => {
				e.preventDefault()
				props.onClose()
			}}
		>
			<div class="modal-head">
				<span>Foreign Key Link · {props.fromTable}</span>
				<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
					<IconClose />
				</button>
			</div>
			<form novalidate onSubmit={handleSave}>
				<div class="modal-body">
					<Show when={error()}>{(msg) => <div class="error-box">{msg()}</div>}</Show>

					<div class="field-group">
						<label class="field-label" for="vfk-from-col">
							Column in <span class="mono">{props.fromTable}</span>
						</label>
						<select
							id="vfk-from-col"
							ref={(el) => (fromColEl = el)}
							class="select mono"
							value={fromColumn()}
							onChange={(e) => handleFromColumnChange(e.currentTarget.value)}
						>
							<For each={sourceColumns()}>
								{(col) => (
									<option value={col.name} selected={col.name === fromColumn()}>
										{col.name} ({col.type})
									</option>
								)}
							</For>
						</select>
					</div>

					<Show when={existingForColumn().length > 0}>
						<div class="field-group">
							<span class="field-label">Active links on {fromColumn()}</span>
							<div style="display:flex;flex-direction:column;gap:6px">
								<For each={existingForColumn()}>
									{(fk) => (
										<div class="vfk-existing-row">
											<div style="display:flex;flex-direction:column;gap:2px;min-width:0">
												<span class="mono" style="font-size:12px">
													{fk.fromColumn} → <strong>{fk.toTable}</strong>.{fk.toColumn}
												</span>
												<Show when={fk.inferenceReason}>
													{(reason) => <span style="font-size:11px;color:var(--ink-muted)">{reason()}</span>}
												</Show>
											</div>
											<div class="vfk-existing-actions">
												<span
													class={['tag', { virtual: fk.source === 'virtual', inferred: fk.source === 'inferred' }]}
													title={fk.inferenceReason}
												>
													{fk.source === 'virtual'
														? 'VIRTUAL'
														: fk.source === 'inferred'
															? fk.inferenceKind === 'data'
																? 'LEARNED'
																: 'AUTO'
															: 'DB FK'}
												</span>
												<Show when={fk.source === 'inferred'}>
													<button
														type="button"
														class="btn sm"
														disabled={busy()}
														onClick={() => void handleConfirmInferred(fk)}
													>
														Save
													</button>
													<button
														type="button"
														class="btn sm"
														disabled={busy()}
														onClick={() => void handleDismissInferred(fk)}
													>
														Dismiss
													</button>
												</Show>
												<Show when={fk.source === 'virtual'}>
													<button
														type="button"
														class="icon-btn ghost"
														style="width:24px;height:24px;color:var(--danger);align-self:center"
														title="Remove virtual foreign key"
														aria-label={`Remove virtual FK to ${fk.toTable}.${fk.toColumn}`}
														disabled={busy()}
														onClick={() => void handleRemoveVirtual(fk)}
													>
														<IconTrash />
													</button>
												</Show>
											</div>
										</div>
									)}
								</For>
							</div>
						</div>
					</Show>

					<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
						<div class="field-group">
							<label class="field-label" for="vfk-to-table">
								References Table
							</label>
							<select
								id="vfk-to-table"
								ref={(el) => (toTableEl = el)}
								class="select mono"
								value={toTable()}
								onChange={(e) => handleToTableChange(e.currentTarget.value)}
							>
								<For each={targetTables()}>
									{(t) => (
										<option value={t.name} selected={t.name === toTable()}>
											{t.name}
										</option>
									)}
								</For>
							</select>
						</div>

						<div class="field-group">
							<label class="field-label" for="vfk-to-col">
								References Column
							</label>
							<select
								id="vfk-to-col"
								ref={(el) => (toColEl = el)}
								class="select mono"
								value={toColumn()}
								onChange={(e) => setToColumn(e.currentTarget.value)}
							>
								<For each={targetColumns()}>
									{(col) => (
										<option value={col.name} selected={col.name === toColumn()}>
											{col.name}
											{col.primaryKey > 0 ? ' (PK)' : ''}
										</option>
									)}
								</For>
							</select>
						</div>
					</div>

					<Show when={fromColumn() && toTable() && toColumn()}>
						<div class="vfk-preview mono">
							{props.fromTable}.{fromColumn()} → {toTable()}.{toColumn()}
						</div>
					</Show>

					<p style="margin:0;font-size:12px;color:var(--ink-muted);line-height:1.45">
						Saved locally in <span class="mono">connections.ason</span> for FK navigation, hover peek, reverse FK
						counts, and the ER diagram. Never modifies your database.
					</p>
				</div>
				<div class="modal-foot">
					<button type="button" class="btn" onClick={() => props.onClose()}>
						Cancel
					</button>
					<button type="submit" class="btn primary" disabled={busy() || !fromColumn() || !toTable() || !toColumn()}>
						{busy() ? 'Saving…' : 'Save Virtual FK'}
					</button>
				</div>
			</form>
		</dialog>
	)
}

// Native <dialog> modal for importing CSV or JSON files/text into a table with column mapping and preview.
import { createEffect, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { IconClose } from '../lib/icons.tsx'
import { type ParsedImport, parseImportText } from '../lib/import-parse.ts'
import type { TableSchema } from '../shared/types.ts'

export function ImportModal(props: {
	open: boolean
	connId: string
	tableSchema: TableSchema | null
	onClose: () => void
	onImported: (count: number) => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	const [rawText, setRawText] = createSignal('')
	const [filename, setFilename] = createSignal<string | undefined>(undefined)
	const [parsed, setParsed] = createSignal<ParsedImport | null>(null)
	const [mapping, setMapping] = createSignal<Record<string, string>>({})
	const [error, setError] = createSignal<string | null>(null)
	const [importing, setImporting] = createSignal(false)

	createEffect(
		() => props.open,
		(open) => {
			if (!dialogEl) return
			if (open) {
				setRawText('')
				setFilename(undefined)
				setParsed(null)
				setMapping({})
				setError(null)
				if (!dialogEl.open) dialogEl.showModal()
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	function parseSource(text: string, name?: string) {
		setError(null)
		setRawText(text)
		setFilename(name)
		if (!text.trim()) {
			setParsed(null)
			setMapping({})
			return
		}
		try {
			const res = parseImportText(text, name)
			setParsed(res)
			const tableCols = props.tableSchema?.columns ?? []
			const lowerMap = new Map(tableCols.map((c) => [c.name.toLowerCase(), c.name]))
			const nextMap: Record<string, string> = {}
			for (const srcCol of res.columns) {
				nextMap[srcCol] = lowerMap.get(srcCol.toLowerCase()) ?? ''
			}
			setMapping(nextMap)
		} catch (err) {
			setParsed(null)
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	async function handleFileChange(file: File | undefined) {
		if (!file) return
		try {
			const text = await file.text()
			parseSource(text, file.name)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	async function handleImport() {
		const data = parsed()
		const ts = props.tableSchema
		if (!data || !ts) return
		const colTypes = new Map(ts.columns.map((c) => [c.name, c.type.toUpperCase()]))
		const activePairs = Object.entries(mapping()).filter(([, dst]) => Boolean(dst))
		if (activePairs.length === 0) {
			setError('Map at least one source column to a table column.')
			return
		}
		if (data.rows.length > 5000) {
			setError('Import is capped at 5,000 rows per batch. Split larger files or use SQL COPY.')
			return
		}

		const inserts: Record<string, unknown>[] = data.rows.map((row) => {
			const out: Record<string, unknown> = {}
			for (const [src, dst] of activePairs) {
				const raw = row[src]
				if (raw === null || raw === undefined || raw === '') {
					out[dst] = null
				} else if (typeof raw === 'string') {
					const t = colTypes.get(dst) ?? ''
					if ((t.includes('INT') || t.includes('REAL') || t.includes('NUM')) && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
						out[dst] = Number(raw.trim())
					} else {
						out[dst] = raw
					}
				} else {
					out[dst] = raw
				}
			}
			return out
		})

		setImporting(true)
		setError(null)
		try {
			const res = await api.mutateTable(props.connId, {
				table: ts.name,
				inserts,
			})
			props.onImported(res.applied)
			props.onClose()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setImporting(false)
		}
	}

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="modal wide"
			onCancel={(e) => {
				e.preventDefault()
				props.onClose()
			}}
		>
			<div class="modal-head">
				<span>Import CSV / JSON into {props.tableSchema?.name}</span>
				<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
					<IconClose />
				</button>
			</div>

			<div class="modal-body">
				<div class="field-group">
					<label class="field-label" for="import-file">
						Choose a .csv or .json file (or paste data below)
					</label>
					<input
						id="import-file"
						type="file"
						accept=".csv,.json,text/csv,application/json"
						class="input"
						style="padding:5px 8px"
						onChange={(e) => void handleFileChange(e.currentTarget.files?.[0])}
					/>
				</div>

				<div class="field-group">
					<label class="field-label" for="import-paste">
						Data (CSV with header row or JSON array of objects)
					</label>
					<textarea
						id="import-paste"
						class="input mono"
						rows={4}
						style="height:auto;padding:8px;font-size:12px"
						placeholder={'name,email\nAda Lovelace,ada@example.com'}
						value={rawText()}
						onInput={(e) => parseSource(e.currentTarget.value, filename())}
					/>
				</div>

				<Show when={error()}>
					{(msg) => (
						<div class="error-box" style="margin:0">
							{msg()}
						</div>
					)}
				</Show>

				<Show when={parsed()}>
					{(data) => (
						<>
							<div style="display:flex;align-items:center;justify-content:space-between;font-size:12px">
								<span>
									Parsed <strong>{data().rows.length.toLocaleString()}</strong> row(s) ({data().format.toUpperCase()})
								</span>
								<span style="color:var(--ink-muted)">Inserts run in a single transaction</span>
							</div>

							<div class="field-group">
								<div class="field-label">Column Mapping</div>
								<div class="import-map-grid">
									<For each={data().columns}>
										{(srcCol) => {
											let selEl: HTMLSelectElement | undefined
											createEffect(
												() => [mapping()[srcCol] ?? '', props.tableSchema?.columns] as const,
												([val]) => {
													if (selEl) selEl.value = val
												},
											)
											return (
												<div class="import-map-row">
													<span class="mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis">
														{srcCol}
													</span>
													<span style="color:var(--ink-muted)">→</span>
													<select
														ref={(el) => (selEl = el)}
														class="select mono"
														style="height:26px;font-size:12px"
														value={mapping()[srcCol] ?? ''}
														onChange={(e) => setMapping((prev) => ({ ...prev, [srcCol]: e.currentTarget.value }))}
													>
														<option value="" selected={!mapping()[srcCol]}>
															(skip column)
														</option>
														<For each={props.tableSchema?.columns ?? []}>
															{(col) => (
																<option value={col.name} selected={mapping()[srcCol] === col.name}>
																	{col.name} ({col.type})
																</option>
															)}
														</For>
													</select>
												</div>
											)
										}}
									</For>
								</div>
							</div>

							<Show when={data().rows.length > 0}>
								<div class="field-group">
									<div class="field-label">Preview (first {Math.min(5, data().rows.length)} rows)</div>
									<div style="overflow-x:auto;border:1px solid var(--border-strong);border-radius:var(--radius)">
										<table class="data-table" style="width:100%">
											<thead>
												<tr>
													<For each={data().columns}>{(c) => <th>{c}</th>}</For>
												</tr>
											</thead>
											<tbody>
												<For each={data().rows.slice(0, 5)}>
													{(row) => (
														<tr>
															<For each={data().columns}>
																{(c) => (
																	<td>
																		{row[c] === null || row[c] === undefined ? (
																			<span class="cell-null">NULL</span>
																		) : (
																			String(row[c])
																		)}
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
						</>
					)}
				</Show>
			</div>

			<div class="modal-foot">
				<button type="button" class="btn" onClick={() => props.onClose()}>
					Cancel
				</button>
				<button
					type="button"
					class="btn primary"
					disabled={importing() || !parsed() || (parsed()?.rows.length ?? 0) === 0}
					onClick={() => void handleImport()}
				>
					{importing() ? 'Importing…' : `Import ${parsed()?.rows.length ?? 0} Row(s)`}
				</button>
			</div>
		</dialog>
	)
}

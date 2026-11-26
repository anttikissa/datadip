// Native <dialog> Database Info / SQLite PRAGMA & WAL Inspector with checkpoint & VACUUM maintenance actions.
import { createEffect, createSignal, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { formatBytes } from '../lib/format.ts'
import { IconClose, IconRefresh } from '../lib/icons.tsx'
import type { DatabaseInfo } from '../shared/types.ts'
import type { ConfirmState } from './ConfirmDialog.tsx'

export function DbInfoModal(props: {
	open: boolean
	connId: string | null
	connName: string
	rwArmed: boolean
	onClose: () => void
	onRequestConfirm: (st: ConfirmState) => void
	onNotify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	const [info, setInfo] = createSignal<DatabaseInfo | null>(null)
	const [loading, setLoading] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)
	const [busyAction, setBusyAction] = createSignal<string | null>(null)

	async function loadInfo(id: string) {
		setLoading(true)
		setError(null)
		try {
			const res = await api.getDbInfo(id)
			setInfo(res.info)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setLoading(false)
		}
	}

	createEffect(
		() => [props.open, props.connId] as const,
		([open, connId]) => {
			if (!dialogEl) return
			if (open && connId) {
				if (!dialogEl.open) dialogEl.showModal()
				void loadInfo(connId)
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	function triggerMaintenance(action: 'wal_checkpoint' | 'vacuum') {
		const id = props.connId
		if (!id) return
		const label = action === 'wal_checkpoint' ? 'WAL Checkpoint (TRUNCATE)' : 'VACUUM'
		props.onRequestConfirm({
			title: `Run ${label} on "${props.connName}"?`,
			message:
				action === 'wal_checkpoint'
					? 'Flushes WAL frames back into the main SQLite database file and truncates the -wal file.'
					: 'Rebuilds the entire SQLite database file to reclaim unused freelist pages. May briefly lock writes.',
			confirmLabel: `Run ${label}`,
			danger: action === 'vacuum',
			onConfirm: async () => {
				setBusyAction(action)
				try {
					const res = await api.runMaintenance(id, action)
					props.onNotify(`${res.message} (${res.durationMs} ms)`, 'ok')
					await loadInfo(id)
				} catch (err) {
					props.onNotify(err instanceof Error ? err.message : String(err), 'error')
				} finally {
					setBusyAction(null)
				}
			},
		})
	}

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
				<span>Database Info &amp; Internals · {props.connName}</span>
				<div style="display:flex;align-items:center;gap:4px">
					<button
						type="button"
						class="icon-btn ghost"
						aria-label="Refresh info"
						onClick={() => props.connId && void loadInfo(props.connId)}
					>
						<IconRefresh />
					</button>
					<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
						<IconClose />
					</button>
				</div>
			</div>

			<div class="modal-body">
				<Show when={loading() && !info()}>
					<div style="padding:18px 0;color:var(--ink-muted);text-align:center">Inspecting database…</div>
				</Show>
				<Show when={error()}>
					{(msg) => (
						<div class="error-box" style="margin:0">
							{msg()}
						</div>
					)}
				</Show>

				<Show when={info()}>
					{(d) => (
						<>
							<div class="info-kv-grid">
								<div class="info-kv">
									<span class="field-label">Engine</span>
									<span class="mono">
										{d().driver === 'postgres' ? 'PostgreSQL' : 'SQLite'} {d().version}
									</span>
								</div>
								<Show when={d().driver === 'sqlite'}>
									<div class="info-kv">
										<span class="field-label">File Size</span>
										<span class="mono">{d().fileSizeBytes != null ? formatBytes(d().fileSizeBytes!) : '—'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">WAL / SHM Size</span>
										<span class="mono">
											{d().walSizeBytes != null ? formatBytes(d().walSizeBytes!) : 'none'} /{' '}
											{d().shmSizeBytes != null ? formatBytes(d().shmSizeBytes!) : 'none'}
										</span>
									</div>
									<div class="info-kv">
										<span class="field-label">journal_mode</span>
										<span class="mono">{d().journalMode ?? '—'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">synchronous</span>
										<span class="mono">{d().synchronous ?? '—'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">user_version</span>
										<span class="mono">{d().userVersion ?? 0}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">foreign_keys</span>
										<span class="mono">{d().foreignKeys ? 'ON' : 'OFF'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">Pages (Freelist)</span>
										<span class="mono">
											{(d().pageCount ?? 0).toLocaleString()} × {d().pageSize ?? 0}B (
											{(d().freelistCount ?? 0).toLocaleString()} free)
										</span>
									</div>
									<div class="info-kv">
										<span class="field-label">Encoding / Auto-Vacuum</span>
										<span class="mono">
											{d().encoding ?? '—'} / {d().autoVacuum ?? '—'}
										</span>
									</div>
								</Show>

								<Show when={d().driver === 'postgres'}>
									<div class="info-kv">
										<span class="field-label">Database</span>
										<span class="mono">{d().currentDatabase ?? '—'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">Current User</span>
										<span class="mono">{d().currentUser ?? '—'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">Database Size</span>
										<span class="mono">
											{d().databaseSizeBytes != null ? formatBytes(d().databaseSizeBytes!) : '—'}
										</span>
									</div>
									<div class="info-kv">
										<span class="field-label">Encoding</span>
										<span class="mono">{d().encoding ?? '—'}</span>
									</div>
									<div class="info-kv">
										<span class="field-label">Server Read-Only</span>
										<span class="mono">{d().readOnly ? 'YES' : 'NO'}</span>
									</div>
								</Show>
							</div>

							<Show when={d().driver === 'sqlite'}>
								<div class="info-maint-bar">
									<div>
										<div style="font-weight:600;font-size:12.5px">SQLite Maintenance</div>
										<div style="font-size:11.5px;color:var(--ink-secondary)">
											{props.rwArmed
												? 'Run WAL checkpoint or VACUUM against this database.'
												: 'Switch to Read-Write mode to run WAL checkpoint or VACUUM.'}
										</div>
									</div>
									<div style="display:flex;gap:8px;flex-shrink:0">
										<button
											type="button"
											class="btn sm"
											disabled={!props.rwArmed || Boolean(busyAction())}
											onClick={() => triggerMaintenance('wal_checkpoint')}
										>
											{busyAction() === 'wal_checkpoint' ? 'Checkpointing…' : 'WAL Checkpoint'}
										</button>
										<button
											type="button"
											class="btn sm"
											disabled={!props.rwArmed || Boolean(busyAction())}
											onClick={() => triggerMaintenance('vacuum')}
										>
											{busyAction() === 'vacuum' ? 'Running VACUUM…' : 'VACUUM'}
										</button>
									</div>
								</div>
							</Show>
						</>
					)}
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

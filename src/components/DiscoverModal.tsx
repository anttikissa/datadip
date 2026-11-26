// Auto-discover wizard scanning local or SSH host directories for SQLite databases.
import { createEffect, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { formatBytes, formatIsoShort } from '../lib/format.ts'
import { IconClose, IconCompass } from '../lib/icons.tsx'
import type { DiscoveredDb } from '../shared/types.ts'

export function DiscoverModal(props: {
	open: boolean
	defaultSshHost?: string
	onClose: () => void
	onImported: () => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	const [location, setLocation] = createSignal<'local' | 'ssh'>('ssh')
	const [sshHost, setSshHost] = createSignal('')
	const [sshUser, setSshUser] = createSignal('')
	const [roots, setRoots] = createSignal('~, /var/lib')
	const [maxDepth, setMaxDepth] = createSignal('4')
	const [markProd, setMarkProd] = createSignal(true)

	const [scanning, setScanning] = createSignal(false)
	const [importing, setImporting] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)
	const [found, setFound] = createSignal<DiscoveredDb[]>([])
	const [selected, setSelected] = createSignal<Set<string>>(new Set())

	createEffect(
		() => props.open,
		(open) => {
			if (!dialogEl) return
			if (open) {
				if (!sshHost() && props.defaultSshHost) setSshHost(props.defaultSshHost)
				setError(null)
				if (!dialogEl.open) dialogEl.showModal()
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	async function runScan() {
		setError(null)
		setFound([])
		setSelected(new Set<string>())
		if (location() === 'ssh' && !sshHost().trim()) {
			setError('Enter an SSH host to scan.')
			return
		}
		setScanning(true)
		try {
			const rootList = roots()
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
			const res = await api.discover({
				location: location(),
				sshHost: location() === 'ssh' ? sshHost().trim() : undefined,
				sshUser: location() === 'ssh' ? sshUser().trim() || undefined : undefined,
				roots: rootList.length > 0 ? rootList : undefined,
				maxDepth: Number(maxDepth()) || 4,
			})
			setFound(res.databases)
			const initial = new Set<string>()
			for (const db of res.databases) {
				if (!db.alreadySaved) initial.add(db.path)
			}
			setSelected(initial)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setScanning(false)
		}
	}

	function togglePath(path: string) {
		const next = new Set(selected())
		if (next.has(path)) next.delete(path)
		else next.add(path)
		setSelected(next)
	}

	async function importSelected() {
		const picks = found().filter((d) => selected().has(d.path) && !d.alreadySaved)
		if (picks.length === 0) return
		setImporting(true)
		setError(null)
		try {
			for (const db of picks) {
				await api.addConnection({
					name: db.suggestedName,
					driver: 'sqlite',
					location: location(),
					path: db.path,
					sshHost: location() === 'ssh' ? sshHost().trim() : undefined,
					sshUser: location() === 'ssh' ? sshUser().trim() || undefined : undefined,
					isProduction: markProd(),
				})
			}
			props.onImported()
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
				<span style="display:inline-flex;align-items:center;gap:8px">
					<IconCompass />
					Auto-Discover SQLite Databases
				</span>
				<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
					<IconClose />
				</button>
			</div>
			<div class="modal-body">
				<div class="field-row">
					<div class="field-group">
						<label class="field-label" for="disc-loc">
							Target Machine
						</label>
						<select
							id="disc-loc"
							class="select"
							value={location()}
							onChange={(e) => {
								const next = e.currentTarget.value as 'local' | 'ssh'
								setLocation(next)
								setRoots(next === 'ssh' ? '~, /var/lib' : '~/projects')
								setMarkProd(next === 'ssh')
							}}
						>
							<option value="ssh">Remote SSH Host</option>
							<option value="local">Local Machine</option>
						</select>
					</div>

					<Show when={location() === 'ssh'}>
						<div class="field-group">
							<label class="field-label" for="disc-host">
								SSH Host
							</label>
							<input
								id="disc-host"
								class="input mono"
								placeholder="db.example.com"
								value={sshHost()}
								onInput={(e) => setSshHost(e.currentTarget.value)}
							/>
						</div>
					</Show>
				</div>

				<div class="field-row">
					<div class="field-group">
						<label class="field-label" for="disc-roots">
							Search Roots (comma-separated)
						</label>
						<input
							id="disc-roots"
							class="input mono"
							value={roots()}
							onInput={(e) => setRoots(e.currentTarget.value)}
						/>
					</div>
					<div class="field-row">
						<div class="field-group">
							<label class="field-label" for="disc-depth">
								Max Depth (1–6)
							</label>
							<input
								id="disc-depth"
								class="input mono"
								inputmode="numeric"
								value={maxDepth()}
								onInput={(e) => setMaxDepth(e.currentTarget.value.replace(/\D/g, ''))}
							/>
						</div>
						<Show when={location() === 'ssh'}>
							<div class="field-group">
								<label class="field-label" for="disc-user">
									SSH User (optional)
								</label>
								<input
									id="disc-user"
									class="input mono"
									value={sshUser()}
									onInput={(e) => setSshUser(e.currentTarget.value)}
								/>
							</div>
						</Show>
					</div>
				</div>

				<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
					<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px">
						<input type="checkbox" checked={markProd()} onChange={(e) => setMarkProd(e.currentTarget.checked)} />
						Mark imported databases as Production
					</label>
					<button class="btn primary" type="button" disabled={scanning()} onClick={runScan}>
						{scanning() ? 'Scanning…' : 'Scan for Databases'}
					</button>
				</div>

				<Show when={error()}>
					{(msg) => (
						<div class="error-box" style="margin:0">
							{msg()}
						</div>
					)}
				</Show>

				<Show when={found().length > 0}>
					<div style="border:1px solid var(--border-strong);border-radius:var(--radius);max-height:260px;overflow-y:auto">
						<For each={found()}>
							{(db) => (
								<label
									style={{
										display: 'flex',
										'align-items': 'center',
										gap: '10px',
										padding: '7px 10px',
										'border-bottom': '1px solid var(--border-subtle)',
										cursor: db.alreadySaved ? 'default' : 'pointer',
										opacity: db.alreadySaved ? 0.55 : 1,
									}}
								>
									<input
										type="checkbox"
										disabled={db.alreadySaved}
										checked={selected().has(db.path)}
										onChange={() => togglePath(db.path)}
									/>
									<div style="flex:1;min-width:0">
										<div style="font-weight:500;font-size:12.5px">{db.suggestedName}</div>
										<div
											class="mono"
											style="font-size:11px;color:var(--ink-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
										>
											{db.path}
										</div>
									</div>
									<span class="tag">{formatBytes(db.sizeBytes)}</span>
									<span class="mono" style="font-size:11px;color:var(--ink-muted)">
										{db.alreadySaved ? 'Saved' : formatIsoShort(db.modifiedAt).slice(0, 10)}
									</span>
								</label>
							)}
						</For>
					</div>
				</Show>
			</div>
			<div class="modal-foot">
				<button class="btn" type="button" onClick={() => props.onClose()}>
					Close
				</button>
				<button
					class="btn primary"
					type="button"
					disabled={importing() || selected().size === 0}
					onClick={importSelected}
				>
					{importing() ? 'Importing…' : `Import Selected (${selected().size})`}
				</button>
			</div>
		</dialog>
	)
}

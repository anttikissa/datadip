// Native <dialog> modal for creating or editing a saved database connection with SSH alias picker, workspace grouping, and live testing.
import { createEffect, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { IconAlert, IconClose, IconLock } from '../lib/icons.tsx'
import type { ConnectionColor, ConnectionConfig, DriverKind, LocationKind, SshHostOption } from '../shared/types.ts'

const COLOR_OPTIONS: { value: ConnectionColor; hex: string; label: string }[] = [
	{ value: 'blue', hex: '#2563eb', label: 'Blue' },
	{ value: 'green', hex: '#16a34a', label: 'Green' },
	{ value: 'amber', hex: '#d97706', label: 'Amber' },
	{ value: 'purple', hex: '#7c3aed', label: 'Purple' },
	{ value: 'rose', hex: '#e11d48', label: 'Rose' },
	{ value: 'slate', hex: '#64748b', label: 'Slate' },
]

export function ConnectionModal(props: {
	open: boolean
	editing: ConnectionConfig | null
	existingGroups?: string[]
	onClose: () => void
	onSaved: (conn: ConnectionConfig) => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	let nameInput: HTMLInputElement | undefined

	const [name, setName] = createSignal('')
	const [driver, setDriver] = createSignal<DriverKind>('sqlite')
	const [location, setLocation] = createSignal<LocationKind>('local')
	const [path, setPath] = createSignal('')
	const [sshHost, setSshHost] = createSignal('')
	const [sshUser, setSshUser] = createSignal('')
	const [sshPort, setSshPort] = createSignal('22')
	const [isProduction, setIsProduction] = createSignal(false)
	const [alwaysReadOnly, setAlwaysReadOnly] = createSignal(false)
	const [group, setGroup] = createSignal('')
	const [tagsRaw, setTagsRaw] = createSignal('')
	const [color, setColor] = createSignal<ConnectionColor | undefined>(undefined)
	const [sshHosts, setSshHosts] = createSignal<SshHostOption[]>([])

	const [error, setError] = createSignal<string | null>(null)
	const [testMsg, setTestMsg] = createSignal<{ ok: boolean; text: string } | null>(null)
	const [testing, setTesting] = createSignal(false)
	const [saving, setSaving] = createSignal(false)

	createEffect(
		() => [props.open, props.editing] as const,
		([open, editing]) => {
			if (!dialogEl) return
			if (open) {
				setName(editing?.name ?? '')
				setDriver(editing?.driver ?? 'sqlite')
				setLocation(editing?.location ?? 'local')
				setPath(editing?.path ?? '')
				setSshHost(editing?.sshHost ?? '')
				setSshUser(editing?.sshUser ?? '')
				setSshPort(editing?.sshPort ? String(editing.sshPort) : '22')
				setIsProduction(editing?.isProduction ?? false)
				setAlwaysReadOnly(Boolean(editing?.alwaysReadOnly))
				setGroup(editing?.group ?? '')
				setTagsRaw((editing?.tags ?? []).join(', '))
				setColor(editing?.color)
				setError(null)
				setTestMsg(null)
				void api
					.listSshHosts()
					.then((res) => setSshHosts(res.hosts))
					.catch(() => setSshHosts([]))
				if (!dialogEl.open) dialogEl.showModal()
				queueMicrotask(() => nameInput?.focus())
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	function buildDraft(): Omit<ConnectionConfig, 'id' | 'createdAt'> {
		const portNum = Number(sshPort().trim())
		const tags = tagsRaw()
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
		return {
			name: name().trim(),
			driver: driver(),
			location: location(),
			path: path().trim(),
			sshHost: location() === 'ssh' ? sshHost().trim() || undefined : undefined,
			sshUser: location() === 'ssh' ? sshUser().trim() || undefined : undefined,
			sshPort: location() === 'ssh' && Number.isFinite(portNum) && portNum > 0 ? portNum : undefined,
			isProduction: isProduction(),
			alwaysReadOnly: alwaysReadOnly() || undefined,
			group: group().trim() || undefined,
			tags: tags.length > 0 ? tags : undefined,
			color: color(),
			pinned: props.editing?.pinned,
		}
	}

	function handlePathInput(val: string) {
		setPath(val)
		const trimmed = val.trim()
		// Auto-detect pasted PostgreSQL DATABASE_URL and suggest a clean name
		if (/^postgres(?:ql)?:\/\//i.test(trimmed)) {
			if (driver() !== 'postgres') setDriver('postgres')
			if (!name().trim()) {
				try {
					const u = new URL(trimmed)
					const db = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'postgres'
					const host = u.hostname && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' ? u.hostname : ''
					setName(host ? `${db} · ${host}` : db)
				} catch {}
			}
		}
	}

	async function handleTest() {
		setError(null)
		setTestMsg(null)
		const draft = buildDraft()
		if (!draft.path) {
			setError(
				draft.driver === 'postgres' ? 'Enter a PostgreSQL connection URL first.' : 'Enter a database file path first.',
			)
			return
		}
		if (draft.location === 'ssh' && !draft.sshHost) {
			setError('Enter an SSH host first.')
			return
		}
		setTesting(true)
		try {
			const res = await api.testConnection(draft)
			const engineLabel = draft.driver === 'postgres' ? 'PostgreSQL' : 'SQLite'
			setTestMsg({
				ok: true,
				text: `Connected (${res.latencyMs} ms) — ${engineLabel} ${res.version ?? ''}, ${res.tableCount} tables/views.`,
			})
		} catch (err) {
			setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
		} finally {
			setTesting(false)
		}
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault()
		setError(null)
		const draft = buildDraft()
		if (!draft.name) {
			setError('Connection name is required.')
			return
		}
		if (!draft.path) {
			setError(draft.driver === 'postgres' ? 'PostgreSQL connection URL is required.' : 'Database path is required.')
			return
		}
		if (draft.location === 'ssh' && !draft.sshHost) {
			setError('SSH host is required.')
			return
		}
		setSaving(true)
		try {
			const res = props.editing ? await api.updateConnection(props.editing.id, draft) : await api.addConnection(draft)
			props.onSaved(res.connection)
			props.onClose()
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSaving(false)
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
				<span>{props.editing ? 'Edit Connection' : 'New Database Connection'}</span>
				<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
					<IconClose />
				</button>
			</div>
			<form novalidate onSubmit={handleSubmit}>
				<div class="modal-body">
					<div class="field-group">
						<label class="field-label" for="conn-name">
							Connection Name
						</label>
						<input
							id="conn-name"
							ref={(el) => (nameInput = el)}
							class="input"
							placeholder="e.g. prod-app / local-dev"
							value={name()}
							onInput={(e) => setName(e.currentTarget.value)}
						/>
					</div>

					<div class="field-row">
						<div class="field-group">
							<label class="field-label" for="conn-driver">
								Database Engine
							</label>
							<select
								id="conn-driver"
								class="select"
								value={driver()}
								onChange={(e) => setDriver(e.currentTarget.value as DriverKind)}
							>
								<option value="sqlite">SQLite</option>
								<option value="postgres">PostgreSQL</option>
							</select>
						</div>

						<div class="field-group">
							<label class="field-label" for="conn-location">
								Access Method
							</label>
							<select
								id="conn-location"
								class="select"
								value={location()}
								onChange={(e) => setLocation(e.currentTarget.value as LocationKind)}
							>
								<option value="local">{driver() === 'postgres' ? 'Direct (TCP / TLS)' : 'Local machine'}</option>
								<option value="ssh">
									{driver() === 'postgres' ? 'SSH tunnel (TCP port forward)' : 'Remote over SSH (multiplexed)'}
								</option>
							</select>
						</div>
					</div>

					<Show when={location() === 'ssh'}>
						<Show when={sshHosts().length > 0}>
							<div class="field-group">
								<label class="field-label" for="conn-ssh-preset">
									Pick from ~/.ssh/config
								</label>
								<select
									id="conn-ssh-preset"
									class="select mono"
									onChange={(e) => {
										const alias = e.currentTarget.value
										if (!alias) return
										const picked = sshHosts().find((h) => h.alias === alias)
										if (picked) {
											setSshHost(picked.alias)
											if (picked.user) setSshUser(picked.user)
											if (picked.port) setSshPort(String(picked.port))
										}
										e.currentTarget.value = ''
									}}
								>
									<option value="">Choose an SSH host alias…</option>
									<For each={sshHosts()}>
										{(h) => (
											<option value={h.alias}>
												{h.alias}
												{h.hostName && h.hostName !== h.alias ? ` (${h.hostName})` : ''}
												{h.user ? ` · ${h.user}` : ''}
											</option>
										)}
									</For>
								</select>
							</div>
						</Show>
						<div class="field-row">
							<div class="field-group">
								<label class="field-label" for="conn-ssh-host">
									SSH Host / Alias
								</label>
								<input
									id="conn-ssh-host"
									class="input mono"
									placeholder="db.example.com"
									value={sshHost()}
									onInput={(e) => setSshHost(e.currentTarget.value)}
								/>
							</div>
							<div class="field-row">
								<div class="field-group">
									<label class="field-label" for="conn-ssh-user">
										SSH User (optional)
									</label>
									<input
										id="conn-ssh-user"
										class="input mono"
										placeholder="from ~/.ssh/config"
										value={sshUser()}
										onInput={(e) => setSshUser(e.currentTarget.value)}
									/>
								</div>
								<div class="field-group">
									<label class="field-label" for="conn-ssh-port">
										Port
									</label>
									<input
										id="conn-ssh-port"
										class="input mono"
										inputmode="numeric"
										value={sshPort()}
										onInput={(e) => setSshPort(e.currentTarget.value.replace(/\D/g, ''))}
									/>
								</div>
							</div>
						</div>
					</Show>

					<div class="field-group">
						<label class="field-label" for="conn-path">
							{driver() === 'postgres'
								? 'PostgreSQL Connection URL (paste DATABASE_URL)'
								: 'SQLite File Path (or paste postgres:// URL)'}
						</label>
						<input
							id="conn-path"
							class="input mono"
							placeholder={
								driver() === 'postgres'
									? location() === 'ssh'
										? 'postgres://user:pass@127.0.0.1:5432/mydb'
										: 'postgres://user:pass@db.example.com:5432/mydb?sslmode=require'
									: location() === 'ssh'
										? '/srv/app/data/app.sqlite'
										: '~/projects/app/data/app.sqlite'
							}
							value={path()}
							onInput={(e) => handlePathInput(e.currentTarget.value)}
						/>
						<Show when={driver() === 'postgres' && location() === 'ssh'}>
							<div style="font-size:11.5px;color:var(--ink-muted);margin-top:4px">
								Forwards a local port via OpenSSH (<span class="mono">ssh -N -L</span>) to the host and port in the URL
								above — no remote Bun required.
							</div>
						</Show>
					</div>

					<div class="field-row">
						<div class="field-group">
							<label class="field-label" for="conn-group">
								Workspace / Folder (optional)
							</label>
							<input
								id="conn-group"
								class="input"
								list="conn-groups-list"
								placeholder="e.g. Client A / Billing"
								value={group()}
								onInput={(e) => setGroup(e.currentTarget.value)}
							/>
							<datalist id="conn-groups-list">
								<For each={props.existingGroups ?? []}>{(g) => <option value={g} />}</For>
							</datalist>
						</div>
						<div class="field-group">
							<label class="field-label" for="conn-tags">
								Tags (comma-separated)
							</label>
							<input
								id="conn-tags"
								class="input mono"
								placeholder="eu-west, replica, analytics"
								value={tagsRaw()}
								onInput={(e) => setTagsRaw(e.currentTarget.value)}
							/>
						</div>
					</div>

					<div class="field-group">
						<span class="field-label">Color Tag (optional)</span>
						<div class="color-swatches">
							<button
								type="button"
								class={['color-swatch none', { active: !color() }]}
								title="None"
								aria-label="No color"
								onClick={() => setColor(undefined)}
							>
								×
							</button>
							<For each={COLOR_OPTIONS}>
								{(opt) => (
									<button
										type="button"
										class={['color-swatch', { active: color() === opt.value }]}
										style={`background:${opt.hex}`}
										title={opt.label}
										aria-label={opt.label}
										onClick={() => setColor(opt.value)}
									/>
								)}
							</For>
						</div>
					</div>

					<label class={['checkbox-card', { prod: isProduction() }]}>
						<input
							type="checkbox"
							checked={isProduction()}
							onChange={(e) => setIsProduction(e.currentTarget.checked)}
						/>
						<div>
							<div style="font-weight:600;display:flex;align-items:center;gap:6px">
								<IconAlert />
								This is a Production database
							</div>
							<div style="font-size:12px;color:var(--ink-secondary);margin-top:2px">
								Displays a persistent crimson banner, requires typing the DB name to unlock writes, and auto-relocks
								Read-Write after 10 minutes idle or when switching DBs.
							</div>
						</div>
					</label>

					<label class="checkbox-card">
						<input
							type="checkbox"
							checked={alwaysReadOnly()}
							onChange={(e) => setAlwaysReadOnly(e.currentTarget.checked)}
						/>
						<div>
							<div style="font-weight:600;display:flex;align-items:center;gap:6px">
								<IconLock />
								Lock permanently Read-Only
							</div>
							<div style="font-size:12px;color:var(--ink-secondary);margin-top:2px">
								Hides Write controls completely and blocks Read-Write arming on the server (ideal for prod read
								replicas).
							</div>
						</div>
					</label>

					<Show when={error()}>{(msg) => <div class="field-error">{msg()}</div>}</Show>

					<Show when={testMsg()}>
						{(res) => (
							<div
								style={{
									padding: '8px 10px',
									border: `1px solid ${res().ok ? 'var(--ok)' : 'var(--prod-border)'}`,
									background: res().ok ? 'var(--ok-bg)' : 'var(--prod-bg)',
									'font-size': '12px',
								}}
								class="mono"
							>
								{res().text}
							</div>
						)}
					</Show>
				</div>

				<div class="modal-foot" style="justify-content:space-between">
					<button class="btn" type="button" disabled={testing()} onClick={handleTest}>
						{testing() ? 'Testing…' : 'Test Connection'}
					</button>
					<div style="display:flex;gap:8px">
						<button class="btn" type="button" onClick={() => props.onClose()}>
							Cancel
						</button>
						<button class="btn primary" type="submit" disabled={saving()}>
							{saving() ? 'Saving…' : props.editing ? 'Save Changes' : 'Add Connection'}
						</button>
					</div>
				</div>
			</form>
		</dialog>
	)
}

// Native <dialog> modal for creating or editing a saved database connection with live connection testing.
import { createEffect, createSignal, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { IconAlert, IconClose } from '../lib/icons.tsx'
import type { ConnectionConfig, DriverKind, LocationKind } from '../shared/types.ts'

export function ConnectionModal(props: {
	open: boolean
	editing: ConnectionConfig | null
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
				setError(null)
				setTestMsg(null)
				if (!dialogEl.open) dialogEl.showModal()
				queueMicrotask(() => nameInput?.focus())
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	function buildDraft(): Omit<ConnectionConfig, 'id' | 'createdAt'> {
		const portNum = Number(sshPort().trim())
		return {
			name: name().trim(),
			driver: driver(),
			location: location(),
			path: path().trim(),
			sshHost: location() === 'ssh' ? sshHost().trim() || undefined : undefined,
			sshUser: location() === 'ssh' ? sshUser().trim() || undefined : undefined,
			sshPort: location() === 'ssh' && Number.isFinite(portNum) && portNum > 0 ? portNum : undefined,
			isProduction: isProduction(),
			pinned: props.editing?.pinned,
		}
	}

	async function handleTest() {
		setError(null)
		setTestMsg(null)
		const draft = buildDraft()
		if (!draft.path) {
			setError('Enter a database file path first.')
			return
		}
		if (draft.location === 'ssh' && !draft.sshHost) {
			setError('Enter an SSH host first.')
			return
		}
		setTesting(true)
		try {
			const res = await api.testConnection(draft)
			setTestMsg({
				ok: true,
				text: `Connected (${res.latencyMs} ms) — SQLite ${res.version ?? ''}, ${res.tableCount} tables/views.`,
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
			setError('Database path is required.')
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
								<option value="postgres">PostgreSQL (coming in v1.1)</option>
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
								<option value="local">Local machine</option>
								<option value="ssh">Remote over SSH (multiplexed)</option>
							</select>
						</div>
					</div>

					<Show when={location() === 'ssh'}>
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
							SQLite File Path
						</label>
						<input
							id="conn-path"
							class="input mono"
							placeholder={location() === 'ssh' ? '/srv/app/data/app.sqlite' : '~/projects/app/data/app.sqlite'}
							value={path()}
							onInput={(e) => setPath(e.currentTarget.value)}
						/>
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
								Displays a persistent crimson production banner &amp; badge and auto-relocks Read-Write mode after 10
								minutes of inactivity.
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

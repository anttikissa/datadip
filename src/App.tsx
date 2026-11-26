// Root DataDip application: URL history router, Production chrome, Read-Only/Read-Write switch, sidebar, FK trail, and modals.
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { ConfirmDialog, type ConfirmState } from './components/ConfirmDialog.tsx'
import { ConnectionModal } from './components/ConnectionModal.tsx'
import { DiscoverModal } from './components/DiscoverModal.tsx'
import { HomeView } from './components/HomeView.tsx'
import { Omnibar } from './components/Omnibar.tsx'
import { RecentModal } from './components/RecentModal.tsx'
import { ScratchpadView } from './components/ScratchpadView.tsx'
import { SshPromptModal } from './components/SshPromptModal.tsx'
import { TableView } from './components/TableView.tsx'
import { api } from './lib/api.ts'
import { clearConsoleRun, getConsoleRun } from './lib/console-runs.ts'
import { copyToClipboard, formatCountdown } from './lib/format.ts'
import {
	IconAlert,
	IconBack,
	IconBrand,
	IconClose,
	IconCopy,
	IconForward,
	IconLock,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconSidebar,
	IconSql,
	IconTable,
	IconTheme,
	IconUnlock,
	IconView,
} from './lib/icons.tsx'
import { parse as parseAson } from './shared/ason.ts'
import { tid } from './shared/tid.ts'
import type {
	ConnectionConfig,
	ConnectionsPayload,
	ConnectionWithStatus,
	DatabaseSchema,
	RecentTable,
	Scratchpad,
	SshPromptRequest,
} from './shared/types.ts'
import { type AppRoute, formatRoute, parseRoute } from './shared/url.ts'

interface TrailStep {
	label: string
	url: string
}

interface Toast {
	id: string
	text: string
	kind: 'info' | 'ok' | 'error'
}

export function App() {
	const [route, setRoute] = createSignal<AppRoute>(parseRoute(window.location.pathname, window.location.search))
	const [connections, setConnections] = createSignal<ConnectionWithStatus[]>([])
	const [configError, setConfigError] = createSignal<string | null>(null)
	const [serverOnline, setServerOnline] = createSignal(true)
	const [reconnectTick, setReconnectTick] = createSignal(0)
	const [recents, setRecents] = createSignal<RecentTable[]>([])
	const [schema, setSchema] = createSignal<DatabaseSchema | null>(null)
	const [schemaLoading, setSchemaLoading] = createSignal(false)
	const [schemaError, setSchemaError] = createSignal<string | null>(null)
	const [scratchpads, setScratchpads] = createSignal<Scratchpad[]>([])
	const [consoleFocusTick, setConsoleFocusTick] = createSignal(0)
	const [splitPadId, setSplitPadId] = createSignal<string | null>(null)
	let connSelectEl: HTMLSelectElement | undefined

	const [sidebarOpen, setSidebarOpen] = createSignal(true)
	const [tableFilter, setTableFilter] = createSignal('')
	const [dark, setDark] = createSignal(false)
	const [nowMs, setNowMs] = createSignal(Date.now())

	// Modals
	const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null)
	const [sshPrompts, setSshPrompts] = createSignal<SshPromptRequest[]>([])
	const [connModalOpen, setConnModalOpen] = createSignal(false)
	const [editingConn, setEditingConn] = createSignal<ConnectionConfig | null>(null)
	const [discoverOpen, setDiscoverOpen] = createSignal(false)
	const [omnibarOpen, setOmnibarOpen] = createSignal(false)
	const [recentModalOpen, setRecentModalOpen] = createSignal(false)

	// FK navigation trail & toasts
	const [trail, setTrail] = createSignal<TrailStep[]>([])
	const [toasts, setToasts] = createSignal<Toast[]>([])

	const activeConnId = createMemo(() => (route().kind === 'home' ? null : (route() as { connId: string }).connId))
	const activeConn = createMemo(() => connections().find((c) => c.id === activeConnId()) ?? null)
	const isProd = createMemo(() => Boolean(activeConn()?.isProduction))
	const rwArmed = createMemo(() => {
		const c = activeConn()
		if (!c || !c.rwArmed) return false
		if (c.rwArmedUntil !== null && nowMs() >= c.rwArmedUntil) return false
		return true
	})

	function notify(text: string, kind: 'info' | 'ok' | 'error' = 'info') {
		const id = tid('t')
		setToasts((prev) => [...prev.slice(-3), { id, text, kind }])
		setTimeout(() => {
			setToasts((prev) => prev.filter((t) => t.id !== id))
		}, 3400)
	}

	function navigate(next: AppRoute, options?: { replace?: boolean; trailLabel?: string }) {
		const url = formatRoute(next)
		if (options?.replace) {
			window.history.replaceState(null, '', url)
		} else if (url !== window.location.pathname + window.location.search) {
			window.history.pushState(null, '', url)
		}
		if (options?.trailLabel) {
			setTrail((prev) => [...prev.slice(-5), { label: options.trailLabel!, url }])
		} else if (next.kind === 'home' || next.kind === 'connection' || next.kind === 'sql') {
			setTrail([])
		} else if (next.kind === 'table' && next.filters.length === 0) {
			setTrail([{ label: next.table, url }])
		}
		setRoute(next)
	}

	async function refreshConnections() {
		try {
			const [cRes, rRes] = await Promise.all([api.listConnections(), api.listRecents()])
			setConnections(cRes.connections)
			setConfigError(cRes.configError ?? null)
			setRecents(rRes.recents)
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	async function restoreOrphaned(conn: ConnectionWithStatus) {
		try {
			await api.restoreConnection(conn.id)
			await refreshConnections()
			notify(`Re-saved "${conn.name}" to connections.ason`, 'ok')
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	async function closeOrphaned(conn: ConnectionWithStatus) {
		try {
			await api.deleteConnection(conn.id)
			if (activeConnId() === conn.id) navigate({ kind: 'home' })
			await refreshConnections()
			notify(`Closed orphaned connection "${conn.name}"`, 'info')
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	async function loadConnectionData(connId: string) {
		setSchemaLoading(true)
		setSchemaError(null)
		try {
			const [sRes, pRes] = await Promise.all([api.getSchema(connId), api.listScratchpads(connId)])
			if (activeConnId() !== connId) return
			setSchema(sRes)
			setScratchpads(pRes.scratchpads)
			// If on /c/:id with no table/sql chosen, jump to first table or scratchpad
			const cur = route()
			if (cur.kind === 'connection' && cur.connId === connId) {
				if (sRes.tables.length > 0) {
					navigate(
						{
							kind: 'table',
							connId,
							table: sRes.tables[0]!.name,
							tab: 'data',
							fields: [],
							filters: [],
							order: [],
							limit: 100,
							start: null,
							direction: 'next',
							offset: null,
							search: '',
							selectedRow: null,
						},
						{ replace: true },
					)
				} else {
					await openOrCreateScratchpad(connId)
				}
			} else if (cur.kind === 'sql' && cur.connId === connId) {
				if (pRes.scratchpads.length === 0) {
					const created = await api.createScratchpad(
						connId,
						'Console 1',
						'-- Press Cmd+Enter to run the highlighted statement\n',
					)
					setScratchpads([created.scratchpad])
					navigate({ kind: 'sql', connId, padId: created.scratchpad.id }, { replace: true })
				} else if (!cur.padId || !pRes.scratchpads.some((p) => p.id === cur.padId)) {
					navigate({ kind: 'sql', connId, padId: pRes.scratchpads[0]!.id }, { replace: true })
				}
			}
		} catch (err) {
			if (activeConnId() !== connId) return
			setSchemaError(err instanceof Error ? err.message : String(err))
			setSchema(null)
		} finally {
			if (activeConnId() === connId) setSchemaLoading(false)
		}
	}

	function nextConsoleTitle(pads: Scratchpad[]): string {
		const used = new Set(pads.map((p) => p.title.trim().toLowerCase()))
		let n = 1
		while (used.has(`console ${n}`)) n++
		return `Console ${n}`
	}

	function isConsoleTrivial(pad: Scratchpad): boolean {
		const nonCommentLines = pad.sql
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith('--'))
		return nonCommentLines.length === 0
	}

	async function deleteConsoleImmediate(pad: Scratchpad) {
		const run = getConsoleRun(pad.id)
		if (run.running && run.queryId) {
			void api.cancelQuery(pad.connectionId, run.queryId).catch(() => {})
		}
		try {
			await api.deleteScratchpad(pad.id)
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
			return
		}
		clearConsoleRun(pad.id)
		const rest = scratchpads().filter((p) => p.id !== pad.id)
		setScratchpads(rest)
		if (splitPadId() === pad.id) {
			setSplitPadId(null)
		}
		const cur = route()
		if (cur.kind === 'sql' && cur.padId === pad.id) {
			const nextPad = rest.find((p) => p.id !== splitPadId()) ?? rest[0]
			if (nextPad) {
				if (splitPadId() === nextPad.id) setSplitPadId(null)
				navigate({ kind: 'sql', connId: cur.connId, padId: nextPad.id }, { replace: true })
			} else {
				navigate({ kind: 'connection', connId: cur.connId }, { replace: true })
			}
		}
	}

	function requestCloseConsole(pad: Scratchpad) {
		const run = getConsoleRun(pad.id)
		if (isConsoleTrivial(pad) && !run.running) {
			void deleteConsoleImmediate(pad)
			return
		}
		setConfirmState({
			title: `Close "${pad.title}"?`,
			message: run.running
				? 'This console has a running query. Closing will cancel the query and delete this console.'
				: 'Closing deletes this console and its SQL text.',
			confirmLabel: 'Close Console',
			danger: true,
			onConfirm: () => deleteConsoleImmediate(pad),
		})
	}

	async function createNewConsole(
		connId: string,
		initialSql = '-- Press Cmd+Enter to run the highlighted statement\n',
	): Promise<Scratchpad | null> {
		try {
			const title = nextConsoleTitle(scratchpads())
			const res = await api.createScratchpad(connId, title, initialSql)
			setScratchpads((prev) => [...prev, res.scratchpad])
			return res.scratchpad
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
			return null
		}
	}

	async function openOrCreateScratchpad(connId: string, initialSql?: string) {
		if (initialSql !== undefined) {
			const pad = await createNewConsole(connId, initialSql)
			if (pad) navigate({ kind: 'sql', connId, padId: pad.id })
			return
		}
		const existing = orderedConsoles()
		if (existing.length > 0) {
			navigate({ kind: 'sql', connId, padId: existing[0]!.id })
			return
		}
		const pad = await createNewConsole(connId)
		if (pad) navigate({ kind: 'sql', connId, padId: pad.id })
	}

	async function toggleSplitConsole() {
		const id = activeConnId()
		if (!id) return
		if (splitPadId()) {
			setSplitPadId(null)
			return
		}
		const primary = activePad()
		const existingOther = orderedConsoles().find((p) => p.id !== primary?.id)
		if (existingOther) {
			setSplitPadId(existingOther.id)
			return
		}
		const created = await createNewConsole(id)
		if (created) setSplitPadId(created.id)
	}

	async function setRw(armed: boolean) {
		const conn = activeConn()
		if (!conn) return
		const apply = async () => {
			try {
				const res = await api.setRwMode(conn.id, armed)
				setConnections((prev) =>
					prev.map((c) => (c.id === conn.id ? { ...c, rwArmed: res.armed, rwArmedUntil: res.until } : c)),
				)
				notify(
					armed
						? conn.isProduction
							? 'Read-Write ARMED on PRODUCTION (auto-relocks in 10 min)'
							: 'Read-Write mode enabled'
						: 'Locked back to Read-Only mode',
					armed ? 'info' : 'ok',
				)
			} catch (err) {
				notify(err instanceof Error ? err.message : String(err), 'error')
			}
		}

		if (armed && conn.isProduction) {
			setConfirmState({
				title: `Enable Read-Write on PRODUCTION (${conn.name})?`,
				message:
					'You are about to unlock write access on a Production database. It will automatically relock to Read-Only after 10 minutes of inactivity.',
				confirmLabel: 'Arm Read-Write (10 min)',
				danger: true,
				onConfirm: apply,
			})
		} else {
			await apply()
		}
	}

	function toggleTheme() {
		const next = !dark()
		setDark(next)
		document.documentElement.dataset.theme = next ? 'dark' : 'light'
		void api.setPreference('theme', next ? 'dark' : 'light')
	}

	// Boot: load connections, prefs, popstate listener, clock tick, global hotkeys
	onSettled(() => {
		void refreshConnections()
		void api.getPreferences().then((res) => {
			const isDark = res.preferences.theme === 'dark'
			setDark(isDark)
			document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
		})

		const onPop = () => {
			setRoute(parseRoute(window.location.pathname, window.location.search))
		}
		window.addEventListener('popstate', onPop)

		const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform)

		const onKey = (e: KeyboardEvent) => {
			const key = e.key.toLowerCase()
			const primaryMod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
			if (e.ctrlKey && !e.metaKey && !e.altKey && key === 'r') {
				e.preventDefault()
				setOmnibarOpen(false)
				setRecentModalOpen((v) => !v)
				void refreshConnections()
			} else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'k') {
				e.preventDefault()
				setRecentModalOpen(false)
				setOmnibarOpen((v) => !v)
			} else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'b') {
				e.preventDefault()
				setSidebarOpen((v) => !v)
			} else if (e.metaKey && e.key === '[') {
				e.preventDefault()
				window.history.back()
			} else if (e.metaKey && e.key === ']') {
				e.preventDefault()
				window.history.forward()
			} else if (primaryMod && !e.altKey && ((e.shiftKey && key === 'l') || (!e.shiftKey && key === 'e'))) {
				e.preventDefault()
				setOmnibarOpen(false)
				setRecentModalOpen(false)
				const id = activeConnId()
				if (!id) {
					notify('Select a database first', 'info')
					return
				}
				if (route().kind === 'sql') {
					setConsoleFocusTick((n) => n + 1)
				} else {
					void openOrCreateScratchpad(id).then(() => setConsoleFocusTick((n) => n + 1))
				}
			} else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'l') {
				e.preventDefault()
				void copyToClipboard(window.location.href).then((ok) => {
					if (ok) notify('Copied current URL', 'ok')
				})
			}
		}
		window.addEventListener('keydown', onKey, true)

		const DIALOG_FOCUSABLE =
			'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
		const onModalTab = (e: KeyboardEvent) => {
			if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
			const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog:modal')
			const dlg = dialogs[dialogs.length - 1]
			if (!dlg) return
			const focusables = Array.from(dlg.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter(
				(el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
			)
			e.preventDefault()
			if (focusables.length === 0) return
			const idx = focusables.indexOf(document.activeElement as HTMLElement)
			const next =
				idx === -1
					? focusables[e.shiftKey ? focusables.length - 1 : 0]!
					: focusables[(idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]!
			next.focus()
		}
		window.addEventListener('keydown', onModalTab)

		// Live sync & server-liveness monitor via SSE /api/events (auto-reconnects & nudges DataDip.app to restart if stopped)
		let initialEvent = true
		let disposed = false
		let es: EventSource | null = null
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null

		const nudgeNativeRestart = () => {
			try {
				const w = window as unknown as {
					webkit?: { messageHandlers?: { datadip?: { postMessage: (msg: string) => void } } }
				}
				w.webkit?.messageHandlers?.datadip?.postMessage('ensureServer')
			} catch {}
		}

		const connectEvents = () => {
			if (disposed) return
			if (es) {
				es.close()
				es = null
			}
			const source = new EventSource('/api/events')
			es = source

			source.onopen = () => {
				const wasOffline = !serverOnline()
				setServerOnline(true)
				if (wasOffline) {
					setReconnectTick((n) => n + 1)
					void refreshConnections()
					const id = activeConnId()
					if (id) void loadConnectionData(id)
					notify('Reconnected to DataDip server', 'ok')
				}
			}

			source.addEventListener('connections', (ev) => {
				try {
					const payload = parseAson((ev as MessageEvent).data) as unknown as ConnectionsPayload
					const prev = connections()
					const next = payload.connections ?? []
					setConnections(next)
					setConfigError(payload.configError ?? null)
					if (!initialEvent) {
						const activeId = activeConnId()
						const wasOrphaned = prev.find((c) => c.id === activeId)?.orphaned
						const nowOrphaned = next.find((c) => c.id === activeId)?.orphaned
						if (nowOrphaned && !wasOrphaned) {
							notify('Active connection removed from connections.ason (kept open as orphaned)', 'info')
						} else if (activeId && !next.some((c) => c.id === activeId) && prev.some((c) => c.id === activeId)) {
							navigate({ kind: 'home' })
						}
						void api
							.listRecents()
							.then((r) => setRecents(r.recents))
							.catch(() => {})
					}
					initialEvent = false
				} catch {}
			})

			source.addEventListener('ssh-prompts', (ev) => {
				try {
					const payload = parseAson((ev as MessageEvent).data) as { prompts?: SshPromptRequest[] }
					setSshPrompts(payload.prompts ?? [])
				} catch {}
			})

			source.onerror = () => {
				if (disposed) return
				setServerOnline(false)
				nudgeNativeRestart()
				source.close()
				if (es === source) es = null
				if (reconnectTimer) clearTimeout(reconnectTimer)
				reconnectTimer = setTimeout(connectEvents, 1200)
			}
		}

		connectEvents()

		const timer = setInterval(() => setNowMs(Date.now()), 1000)

		return () => {
			disposed = true
			window.removeEventListener('popstate', onPop)
			window.removeEventListener('keydown', onKey, true)
			window.removeEventListener('keydown', onModalTab)
			if (reconnectTimer) clearTimeout(reconnectTimer)
			es?.close()
			clearInterval(timer)
		}
	})

	// Reload schema & scratchpads when active connection changes
	createEffect(
		() => activeConnId(),
		(connId) => {
			setTableFilter('')
			setSplitPadId(null)
			if (!connId) {
				setSchema(null)
				setScratchpads([])
				setSchemaError(null)
				return
			}
			void loadConnectionData(connId)
		},
	)

	// Keep the controlled <select> synced whenever dynamic <option>/<optgroup> children change.
	createEffect(
		() => [activeConnId(), connections()] as const,
		([connId]) => {
			if (connSelectEl) connSelectEl.value = connId ?? ''
		},
	)

	const filteredTables = createMemo(() => {
		const q = tableFilter().trim().toLowerCase()
		const list = schema()?.tables ?? []
		return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list
	})

	// Stable left-to-right console order (by createdAt ASC) so tabs never jump around on edit/save.
	const orderedConsoles = createMemo(() =>
		[...scratchpads()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
	)

	const activePad = createMemo(() => {
		const r = route()
		if (r.kind !== 'sql') return null
		const list = orderedConsoles()
		if (r.padId) return list.find((p) => p.id === r.padId) ?? list[0] ?? null
		return list[0] ?? null
	})

	const splitPad = createMemo(() => {
		const sid = splitPadId()
		if (!sid || route().kind !== 'sql') return null
		const pad = orderedConsoles().find((p) => p.id === sid)
		if (!pad || pad.id === activePad()?.id) return null
		return pad
	})

	// Keep browser & DataDip.app window title prominently showing the active DB and view.
	createEffect(
		() => [activeConn(), route(), activePad()?.title, splitPad()?.title] as const,
		([conn, r, p1, p2]) => {
			if (r.kind === 'home' || !conn) {
				document.title = 'DataDip'
				return
			}
			const prodPrefix = conn.isProduction ? '[PROD] ' : ''
			if (r.kind === 'table') {
				document.title = `${prodPrefix}${r.table} · ${conn.name} — DataDip`
			} else if (r.kind === 'sql') {
				const consoleLabel = p2 ? `${p1 ?? 'Console'} | ${p2}` : (p1 ?? 'Console')
				document.title = `${prodPrefix}${consoleLabel} · ${conn.name} — DataDip`
			} else {
				document.title = `${prodPrefix}${conn.name} — DataDip`
			}
		},
	)

	const defaultSshHost = createMemo(() => connections().find((c) => c.location === 'ssh' && c.sshHost)?.sshHost)
	const activeConnections = createMemo(() => connections().filter((c) => c.connected))
	const inactiveConnections = createMemo(() => connections().filter((c) => !c.connected))

	async function disconnectConnection(conn: ConnectionWithStatus) {
		try {
			await api.disconnectConnection(conn.id)
			await refreshConnections()
			if (activeConnId() === conn.id) {
				navigate({ kind: 'home' })
			}
			notify(conn.orphaned ? `Closed orphaned connection "${conn.name}"` : `Disconnected "${conn.name}"`, 'ok')
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	const activeTableRoute = createMemo(() => {
		const r = route()
		return r.kind === 'table' && !schemaError() ? r : null
	})

	const activeSqlRoute = createMemo(() => {
		const r = route()
		return r.kind === 'sql' && !schemaError() ? r : null
	})

	return (
		<div class="app-shell">
			{/* Unmistakable crimson top strip on Production databases */}
			<Show when={isProd()}>
				<div class="prod-strip" />
			</Show>

			{/* Top Command Bar */}
			<header class={['topbar', { 'is-prod': isProd() }]}>
				<button type="button" class="brand-btn" onClick={() => navigate({ kind: 'home' })} aria-label="DataDip Home">
					<IconBrand />
					<span>DataDip</span>
				</button>

				<Show when={activeConnId()}>
					<button
						type="button"
						class="icon-btn ghost"
						onClick={() => setSidebarOpen((v) => !v)}
						aria-label="Toggle sidebar (Cmd+B)"
					>
						<IconSidebar />
					</button>
				</Show>

				<div class="nav-arrows">
					<button type="button" onClick={() => window.history.back()} aria-label="Back (Cmd+[)">
						<IconBack />
					</button>
					<button type="button" onClick={() => window.history.forward()} aria-label="Forward (Cmd+])">
						<IconForward />
					</button>
				</div>

				<select
					ref={connSelectEl}
					class="conn-select"
					aria-label="Active database connection"
					value={activeConnId() ?? ''}
					onChange={(e) => {
						const nextId = e.currentTarget.value
						if (!nextId) navigate({ kind: 'home' })
						else navigate({ kind: 'connection', connId: nextId })
					}}
				>
					<option value="" selected={!activeConnId()}>
						All Connections…
					</option>
					<Show
						when={activeConnections().length > 0}
						fallback={
							<For each={connections()}>
								{(c) => (
									<option value={c.id} selected={c.id === activeConnId()}>
										{c.isProduction ? '[PROD] ' : ''}
										{c.name}
									</option>
								)}
							</For>
						}
					>
						<optgroup label={`Active (${activeConnections().length})`}>
							<For each={activeConnections()}>
								{(c) => (
									<option value={c.id} selected={c.id === activeConnId()}>
										● {c.orphaned ? '[ORPHANED] ' : ''}
										{c.rwArmed ? '[RW] ' : ''}
										{c.isProduction ? '[PROD] ' : ''}
										{c.name}
									</option>
								)}
							</For>
						</optgroup>
						<Show when={inactiveConnections().length > 0}>
							<optgroup label="Saved">
								<For each={inactiveConnections()}>
									{(c) => (
										<option value={c.id} selected={c.id === activeConnId()}>
											{c.isProduction ? '[PROD] ' : ''}
											{c.name}
										</option>
									)}
								</For>
							</optgroup>
						</Show>
					</Show>
				</select>

				<Show when={activeConn()?.orphaned}>
					<span class="tag orphan">ORPHANED</span>
				</Show>

				<Show when={isProd()}>
					<span class="prod-badge">
						<IconAlert />
						PRODUCTION
					</span>
				</Show>

				{/* FK Trail Breadcrumb */}
				<div class="breadcrumb-bar">
					<Show when={trail().length > 0}>
						<For each={trail()}>
							{(step, idx) => (
								<>
									<Show when={idx() > 0}>
										<span class="crumb-sep">→</span>
									</Show>
									<button
										type="button"
										class={['crumb-btn mono', { active: idx() === trail().length - 1 }]}
										onClick={() => {
											const u = new URL(step.url, window.location.origin)
											navigate(parseRoute(u.pathname, u.search))
										}}
									>
										{step.label}
									</button>
								</>
							)}
						</For>
					</Show>
				</div>

				<Show when={activeConnId()}>
					<button
						type="button"
						class="icon-btn ghost"
						aria-label="Copy location URL (Cmd+L)"
						onClick={async () => {
							if (await copyToClipboard(window.location.href)) notify('Copied URL to clipboard', 'ok')
						}}
					>
						<IconCopy />
					</button>
				</Show>

				<button
					type="button"
					class="omnibar-trigger"
					onClick={() => {
						setRecentModalOpen(true)
						void refreshConnections()
					}}
					aria-label="Open recent databases and tables (Ctrl+R)"
				>
					<span>Recent</span>
					<span class="kbd">^R</span>
				</button>

				<button type="button" class="omnibar-trigger" onClick={() => setOmnibarOpen(true)}>
					<IconSearch />
					<span>Jump / Find ID</span>
					<span class="kbd">⌘K</span>
				</button>

				{/* Always-visible Read-Only / Read-Write safety toggle */}
				<Show when={activeConn()}>
					{(conn) => (
						<div class={['rw-switch', { armed: rwArmed(), prod: conn().isProduction }]}>
							<button
								type="button"
								class={['rw-btn', { 'ro-active': !rwArmed() }]}
								onClick={() => {
									if (rwArmed()) void setRw(false)
								}}
							>
								<IconLock />
								READ-ONLY
							</button>
							<button
								type="button"
								class={['rw-btn', { 'rw-active': rwArmed(), prod: conn().isProduction }]}
								onClick={() => {
									if (!rwArmed()) void setRw(true)
								}}
							>
								<IconUnlock />
								{rwArmed()
									? conn().isProduction && conn().rwArmedUntil
										? `WRITE ${formatCountdown(conn().rwArmedUntil, nowMs())}`
										: 'READ-WRITE'
									: 'WRITE'}
							</button>
						</div>
					)}
				</Show>

				<button type="button" class="icon-btn" onClick={toggleTheme} aria-label="Toggle light or dark theme">
					<IconTheme dark={dark()} />
				</button>
			</header>

			{/* Local server offline status banner (driven by SSE /api/events) */}
			<Show when={!serverOnline()}>
				<div class="status-banner offline" role="status" aria-live="polite">
					<span style="display:inline-flex;align-items:center;gap:8px;flex:1;min-width:0">
						<span class="status-pulse" />
						<span>
							<strong>Local DataDip server is offline</strong> —{' '}
							{(window as unknown as { webkit?: { messageHandlers?: { datadip?: unknown } } }).webkit?.messageHandlers
								?.datadip
								? 'restarting server and reconnecting…'
								: 'run `datadip` or `datadip serve` in your terminal. Reconnecting automatically…'}
						</span>
					</span>
					<button
						type="button"
						class="btn sm"
						onClick={() => {
							void refreshConnections()
							const id = activeConnId()
							if (id) void loadConnectionData(id)
						}}
					>
						Retry Now
					</button>
				</div>
			</Show>

			{/* Malformed connections.ason warning banner */}
			<Show when={configError()}>
				{(err) => (
					<div class="status-banner error">
						<span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
							<strong>connections.ason parse error:</strong> {err()}
						</span>
						<span style="font-size:11.5px;color:var(--ink-secondary);flex-shrink:0">
							Fix the file in your editor to resume saving
						</span>
					</div>
				)}
			</Show>

			{/* Orphaned active connection banner */}
			<Show when={activeConn()?.orphaned ? activeConn() : null}>
				{(conn) => (
					<div class="status-banner orphan">
						<span style="flex:1;min-width:0">
							<strong>Orphaned connection:</strong> "{conn().name}" was removed from{' '}
							<span class="mono">connections.ason</span> and is kept active in memory only.
						</span>
						<div style="display:flex;gap:6px;flex-shrink:0">
							<button type="button" class="btn sm primary" onClick={() => void restoreOrphaned(conn())}>
								Re-save to config
							</button>
							<button type="button" class="btn sm" onClick={() => void closeOrphaned(conn())}>
								Close Connection
							</button>
						</div>
					</div>
				)}
			</Show>

			{/* Main workspace */}
			<div class="workspace">
				{/* Left Sidebar (only when connected to a DB) */}
				<Show when={activeConnId() && sidebarOpen()}>
					<aside class="sidebar">
						<div class="sidebar-header">
							<div class="sidebar-conn-row">
								<div style="min-width:0;flex:1">
									<div class="sidebar-db-name" title={activeConn()?.path}>
										<span class="status-dot" />
										<span class="sidebar-db-name-text">{activeConn()?.name ?? 'Database'}</span>
									</div>
									<div class="sidebar-meta mono">
										<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
											{activeConn()?.location === 'ssh' ? `ssh://${activeConn()?.sshHost}` : 'local sqlite'}
										</span>
										<Show when={schema()}>{(s) => <span>· {s().durationMs}ms</span>}</Show>
									</div>
								</div>
								<button
									type="button"
									class="icon-btn ghost"
									style="width:24px;height:24px"
									aria-label="Refresh schema"
									onClick={() => {
										const id = activeConnId()
										if (id) void loadConnectionData(id)
									}}
								>
									<IconRefresh />
								</button>
							</div>
							<input
								class="input"
								style="height:26px;font-size:12px"
								placeholder="Filter tables…"
								value={tableFilter()}
								onInput={(e) => setTableFilter(e.currentTarget.value)}
							/>
						</div>

						<div class="sidebar-scroll">
							{/* Consoles section */}
							<div class="sidebar-section-head">
								<span>Consoles</span>
								<span style="display:inline-flex;align-items:center;gap:4px">
									<span class="kbd" style="text-transform:none" title="Open Console (Cmd+E or Cmd+Shift+L)">
										⌘E
									</span>
									<button
										type="button"
										class="icon-btn ghost"
										style="width:20px;height:20px"
										aria-label="New console"
										title="New Console"
										onClick={() => {
											const id = activeConnId()
											if (id) void openOrCreateScratchpad(id, '-- Write SQL and press Cmd+Enter\n')
										}}
									>
										<IconPlus />
									</button>
								</span>
							</div>

							<Show when={orderedConsoles().length === 0}>
								<button
									type="button"
									class="sidebar-item"
									style="color:var(--ink-muted)"
									onClick={() => {
										const id = activeConnId()
										if (id) void openOrCreateScratchpad(id)
									}}
								>
									<IconSql />
									<span>+ Open Console</span>
								</button>
							</Show>

							<For each={orderedConsoles()}>
								{(pad) => {
									const run = () => getConsoleRun(pad.id)
									const isPrimary = () => route().kind === 'sql' && activePad()?.id === pad.id
									const isSecondary = () => route().kind === 'sql' && splitPad()?.id === pad.id
									return (
										<div class={['sidebar-console-row', { active: isPrimary(), secondary: isSecondary() }]}>
											<button
												type="button"
												class={['sidebar-item', { active: isPrimary() || isSecondary() }]}
												onClick={() => {
													if (splitPadId() === pad.id) setSplitPadId(activePad()?.id ?? null)
													navigate({ kind: 'sql', connId: pad.connectionId, padId: pad.id })
												}}
											>
												<IconSql />
												<span class="sidebar-item-label">{pad.title}</span>
												<Show when={run().running}>
													<span class="sidebar-run-badge mono">
														<span class="status-pulse accent" />
														{Math.max(0, Math.floor((nowMs() - (run().startedAt ?? nowMs())) / 1000))}s
													</span>
												</Show>
											</button>
											<button
												type="button"
												class="sidebar-close-btn"
												aria-label={`Close ${pad.title}`}
												title={`Close ${pad.title}`}
												onClick={(e) => {
													e.stopPropagation()
													requestCloseConsole(pad)
												}}
											>
												<IconClose />
											</button>
										</div>
									)
								}}
							</For>

							{/* Tables & Views section */}
							<div class="sidebar-section-head">
								<span>Tables &amp; Views ({filteredTables().length})</span>
							</div>

							<Show when={schemaLoading() && !schema()}>
								<div style="padding:8px 12px;color:var(--ink-muted);font-size:12px">
									Connecting &amp; loading schema…
								</div>
							</Show>

							<For each={filteredTables()}>
								{(t) => {
									const isActive = () =>
										route().kind === 'table' && (route() as Extract<AppRoute, { kind: 'table' }>).table === t.name
									return (
										<button
											type="button"
											class={['sidebar-item', { active: isActive() }]}
											onClick={() =>
												navigate({
													kind: 'table',
													connId: activeConnId()!,
													table: t.name,
													tab: 'data',
													fields: [],
													filters: [],
													order: [],
													limit: 100,
													start: null,
													direction: 'next',
													offset: null,
													search: '',
													selectedRow: null,
												})
											}
										>
											{t.type === 'view' ? <IconView /> : <IconTable />}
											<span class="sidebar-item-label mono">{t.name}</span>
											<Show when={t.rowCount !== null}>
												<span class="sidebar-count">{t.rowCount!.toLocaleString()}</span>
											</Show>
										</button>
									)
								}}
							</For>
						</div>
					</aside>
				</Show>

				{/* Route body */}
				<Show when={route().kind === 'home'}>
					<HomeView
						connections={connections()}
						recents={recents()}
						onOpenConnection={(id) => navigate({ kind: 'connection', connId: id })}
						onOpenRecent={(connId, tableName) =>
							navigate({
								kind: 'table',
								connId,
								table: tableName,
								tab: 'data',
								fields: [],
								filters: [],
								order: [],
								limit: 100,
								start: null,
								direction: 'next',
								offset: null,
								search: '',
								selectedRow: null,
							})
						}
						onDeleteRecent={async (connId, tableName) => {
							await api.deleteRecent(connId, tableName)
							setRecents((prev) => prev.filter((r) => !(r.connectionId === connId && r.tableName === tableName)))
						}}
						onAddConnection={() => {
							setEditingConn(null)
							setConnModalOpen(true)
						}}
						onEditConnection={(c) => {
							setEditingConn(c)
							setConnModalOpen(true)
						}}
						onDeleteConnection={(c) => {
							const full = connections().find((x) => x.id === c.id)
							if (full?.orphaned) {
								void closeOrphaned(full)
								return
							}
							setConfirmState({
								title: `Remove "${c.name}"?`,
								message: 'Removes this connection from DataDip. The database file itself is not touched.',
								confirmLabel: 'Remove Connection',
								danger: true,
								onConfirm: async () => {
									await api.deleteConnection(c.id)
									await refreshConnections()
									notify(`Removed ${c.name}`, 'ok')
								},
							})
						}}
						onRestoreConnection={(c) => void restoreOrphaned(c)}
						onDisconnectConnection={(c) => void disconnectConnection(c)}
						onOpenDiscover={() => setDiscoverOpen(true)}
					/>
				</Show>

				<Show when={route().kind !== 'home' && schemaError()}>
					<div class="main-pane" style="padding:20px">
						<div class="error-box" style="margin:0">
							<div style="font-weight:600;margin-bottom:6px">
								{serverOnline() ? 'Connection Failed' : 'Local DataDip Server Offline'}
							</div>
							<div>
								{serverOnline()
									? schemaError()
									: 'Waiting for the local DataDip server to come back online. This view will reload automatically.'}
							</div>
							<div style="margin-top:12px;display:flex;gap:8px">
								<button
									type="button"
									class="btn sm primary"
									onClick={() => {
										const id = activeConnId()
										if (id) void loadConnectionData(id)
									}}
								>
									Retry
								</button>
								<button type="button" class="btn sm" onClick={() => navigate({ kind: 'home' })}>
									Back to Connections
								</button>
							</div>
						</div>
					</div>
				</Show>

				<Show when={activeTableRoute()}>
					{(r) => (
						<TableView
							route={r()}
							tableSchema={schema()?.schemas[r().table] ?? null}
							rwArmed={rwArmed()}
							reconnectTick={reconnectTick()}
							onNavigate={(next, opts) => navigate(next, opts)}
							onOpenInSql={(sqlText) => {
								void openOrCreateScratchpad(r().connId, sqlText)
							}}
							onRequestConfirm={(st) => setConfirmState(st)}
							onRequestArmRw={() => void setRw(true)}
							onNotify={notify}
							onSchemaChanged={() => {
								const id = activeConnId()
								if (id) void loadConnectionData(id)
							}}
						/>
					)}
				</Show>

				<Show when={activeSqlRoute()}>
					{(r) => (
						<div class="console-workspace">
							{/* DataGrip-style Console Tab Bar */}
							<div class="console-tabs-bar" role="tablist" aria-label="SQL Consoles">
								<div class="console-tabs-scroll">
									<For each={orderedConsoles()}>
										{(pad) => {
											const run = () => getConsoleRun(pad.id)
											const isActive = () => activePad()?.id === pad.id
											const isSplit = () => splitPad()?.id === pad.id
											return (
												<div
													class={['console-tab', { active: isActive(), split: isSplit() }]}
													onAuxClick={(e) => {
														if (e.button === 1) {
															e.preventDefault()
															requestCloseConsole(pad)
														}
													}}
												>
													<button
														type="button"
														role="tab"
														aria-selected={isActive() ? 'true' : 'false'}
														class="console-tab-btn"
														onClick={() => {
															if (splitPadId() === pad.id) setSplitPadId(activePad()?.id ?? null)
															navigate({ kind: 'sql', connId: r().connId, padId: pad.id })
														}}
													>
														<IconSql />
														<span>{pad.title}</span>
														<Show when={run().running}>
															<span class="sidebar-run-badge mono">
																<span class="status-pulse accent" />
																{Math.max(0, Math.floor((nowMs() - (run().startedAt ?? nowMs())) / 1000))}s
															</span>
														</Show>
													</button>
													<button
														type="button"
														class="console-tab-close"
														aria-label={`Close ${pad.title}`}
														title={`Close ${pad.title}`}
														onClick={(e) => {
															e.stopPropagation()
															requestCloseConsole(pad)
														}}
													>
														<IconClose />
													</button>
												</div>
											)
										}}
									</For>
									<button
										type="button"
										class="console-tab-add"
										aria-label="New console"
										title="New Console"
										onClick={() => void openOrCreateScratchpad(r().connId, '-- Write SQL and press Cmd+Enter\n')}
									>
										<IconPlus />
									</button>
								</div>
							</div>

							<div class="consoles-split-grid">
								<div class="console-pane">
									<ScratchpadView
										connId={r().connId}
										connName={activeConn()?.name}
										isProduction={activeConn()?.isProduction}
										scratchpad={activePad()}
										schema={schema()}
										dark={dark()}
										nowMs={nowMs()}
										focusTick={consoleFocusTick()}
										splitOpen={Boolean(splitPad())}
										onToggleSplit={() => void toggleSplitConsole()}
										onScratchpadUpdated={(pad) =>
											setScratchpads((prev) => prev.map((p) => (p.id === pad.id ? pad : p)))
										}
										onScratchpadDeleted={(padId) => {
											const rest = scratchpads().filter((p) => p.id !== padId)
											setScratchpads(rest)
											if (splitPadId() === padId) setSplitPadId(null)
											if (rest.length > 0)
												navigate({ kind: 'sql', connId: r().connId, padId: rest[0]!.id }, { replace: true })
											else navigate({ kind: 'connection', connId: r().connId }, { replace: true })
										}}
										onFollowFk={(targetTable, targetColumn, value) =>
											navigate(
												{
													kind: 'table',
													connId: r().connId,
													table: targetTable,
													tab: 'data',
													fields: [],
													filters: [{ column: targetColumn, op: 'eq', value: String(value) }],
													order: [],
													limit: 100,
													start: null,
													direction: 'next',
													offset: null,
													search: '',
													selectedRow: null,
												},
												{ trailLabel: `${targetTable}.${targetColumn}=${String(value)}` },
											)
										}
										onOpenTable={(table) =>
											navigate({
												kind: 'table',
												connId: r().connId,
												table,
												tab: 'data',
												fields: [],
												filters: [],
												order: [],
												limit: 100,
												start: null,
												direction: 'next',
												offset: null,
												search: '',
												selectedRow: null,
											})
										}
										onRequestConfirm={(st) => setConfirmState(st)}
										onNotify={notify}
										onSchemaChanged={() => {
											const id = activeConnId()
											if (id) void loadConnectionData(id)
										}}
										onRwTimerUpdated={(until) => {
											const id = activeConnId()
											if (!id) return
											setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, rwArmedUntil: until } : c)))
										}}
									/>
								</div>

								<Show when={splitPad()}>
									{(sp) => (
										<div class="console-pane split-secondary">
											<ScratchpadView
												connId={r().connId}
												connName={activeConn()?.name}
												isProduction={activeConn()?.isProduction}
												scratchpad={sp()}
												schema={schema()}
												dark={dark()}
												nowMs={nowMs()}
												isSplitPane
												allConsoles={orderedConsoles().filter((p) => p.id !== activePad()?.id)}
												onSelectPad={(pid) => setSplitPadId(pid)}
												onCloseSplit={() => setSplitPadId(null)}
												onScratchpadUpdated={(pad) =>
													setScratchpads((prev) => prev.map((p) => (p.id === pad.id ? pad : p)))
												}
												onScratchpadDeleted={(padId) => {
													setScratchpads((prev) => prev.filter((p) => p.id !== padId))
													if (splitPadId() === padId) setSplitPadId(null)
												}}
												onFollowFk={(targetTable, targetColumn, value) =>
													navigate(
														{
															kind: 'table',
															connId: r().connId,
															table: targetTable,
															tab: 'data',
															fields: [],
															filters: [{ column: targetColumn, op: 'eq', value: String(value) }],
															order: [],
															limit: 100,
															start: null,
															direction: 'next',
															offset: null,
															search: '',
															selectedRow: null,
														},
														{ trailLabel: `${targetTable}.${targetColumn}=${String(value)}` },
													)
												}
												onOpenTable={(table) =>
													navigate({
														kind: 'table',
														connId: r().connId,
														table,
														tab: 'data',
														fields: [],
														filters: [],
														order: [],
														limit: 100,
														start: null,
														direction: 'next',
														offset: null,
														search: '',
														selectedRow: null,
													})
												}
												onRequestConfirm={(st) => setConfirmState(st)}
												onNotify={notify}
												onSchemaChanged={() => {
													const id = activeConnId()
													if (id) void loadConnectionData(id)
												}}
												onRwTimerUpdated={(until) => {
													const id = activeConnId()
													if (!id) return
													setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, rwArmedUntil: until } : c)))
												}}
											/>
										</div>
									)}
								</Show>
							</div>
						</div>
					)}
				</Show>
			</div>

			{/* Modals */}
			<ConfirmDialog state={confirmState()} onClose={() => setConfirmState(null)} />

			<SshPromptModal
				prompt={sshPrompts()[0] ?? null}
				onSubmit={async (id, ans) => {
					try {
						await api.answerSshPrompt(id, { answer: ans })
					} catch (err) {
						notify(err instanceof Error ? err.message : String(err), 'error')
					}
				}}
				onCancel={async (id) => {
					try {
						await api.answerSshPrompt(id, { cancelled: true })
					} catch {}
				}}
			/>

			<ConnectionModal
				open={connModalOpen()}
				editing={editingConn()}
				onClose={() => setConnModalOpen(false)}
				onSaved={async (conn) => {
					await refreshConnections()
					notify(`Saved ${conn.name}`, 'ok')
				}}
			/>

			<DiscoverModal
				open={discoverOpen()}
				defaultSshHost={defaultSshHost()}
				onClose={() => setDiscoverOpen(false)}
				onImported={async () => {
					await refreshConnections()
					notify('Imported discovered databases', 'ok')
				}}
			/>

			<Omnibar
				open={omnibarOpen()}
				activeConnId={activeConnId()}
				connections={connections()}
				schema={schema()}
				scratchpads={scratchpads()}
				onClose={() => setOmnibarOpen(false)}
				onSelectConnection={(id) => navigate({ kind: 'connection', connId: id })}
				onSelectTable={(connId, table, filter) =>
					navigate(
						{
							kind: 'table',
							connId,
							table,
							tab: 'data',
							fields: [],
							filters: filter ? [{ column: filter.column, op: 'eq', value: filter.value }] : [],
							order: [],
							limit: 100,
							start: null,
							direction: 'next',
							offset: null,
							search: '',
							selectedRow: null,
						},
						filter ? { trailLabel: `${table}.${filter.column}=${filter.value}` } : undefined,
					)
				}
				onSelectScratchpad={(connId, padId) => navigate({ kind: 'sql', connId, padId })}
				onNewScratchpad={() => {
					const id = activeConnId()
					if (id) void openOrCreateScratchpad(id, '-- New console\n')
				}}
				onToggleTheme={toggleTheme}
				onToggleRw={() => void setRw(!rwArmed())}
				onOpenDiscover={() => setDiscoverOpen(true)}
			/>

			<RecentModal
				open={recentModalOpen()}
				activeConnId={activeConnId()}
				connections={connections()}
				recents={recents()}
				onClose={() => setRecentModalOpen(false)}
				onOpenConnection={(id) => navigate({ kind: 'connection', connId: id })}
				onOpenTable={(connId, tableName) =>
					navigate({
						kind: 'table',
						connId,
						table: tableName,
						tab: 'data',
						fields: [],
						filters: [],
						order: [],
						limit: 100,
						start: null,
						direction: 'next',
						offset: null,
						search: '',
						selectedRow: null,
					})
				}
				onDeleteRecent={async (connId, tableName) => {
					await api.deleteRecent(connId, tableName)
					setRecents((prev) => prev.filter((r) => !(r.connectionId === connId && r.tableName === tableName)))
				}}
			/>

			{/* Toasts */}
			<div class="toast-stack" aria-live="polite">
				<For each={toasts()}>{(t) => <div class={['toast', t.kind]}>{t.text}</div>}</For>
			</div>
		</div>
	)
}

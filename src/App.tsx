// Root DataDip application: URL history router, Production chrome, Read-Only/Read-Write switch, sidebar, FK trail, and modals.
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { ChangelogModal } from './components/ChangelogModal.tsx'
import { ConfirmDialog, type ConfirmState } from './components/ConfirmDialog.tsx'
import { ConnectionModal } from './components/ConnectionModal.tsx'
import { DbInfoModal } from './components/DbInfoModal.tsx'
import { DiscoverModal } from './components/DiscoverModal.tsx'
import { ErDiagramView } from './components/ErDiagramView.tsx'
import { HomeView } from './components/HomeView.tsx'
import { Omnibar } from './components/Omnibar.tsx'
import { RecentModal } from './components/RecentModal.tsx'
import { ConsoleView } from './components/ConsoleView.tsx'
import { SshPromptModal } from './components/SshPromptModal.tsx'
import { TableView } from './components/TableView.tsx'
import { api } from './lib/api.ts'
import { clearConsoleRun, getConsoleRun } from './lib/console-runs.ts'
import { copyToClipboard, formatCountdown, formatRowCount } from './lib/format.ts'
import { isEditableTarget, isMac, isNativeApp, isPrimaryMod, modKeyLabel, recentsKeyLabel } from './lib/shortcuts.ts'
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
import { APP_VERSION } from './shared/changelog.ts'
import { tid } from './shared/tid.ts'
import type {
	ConnectionConfig,
	ConnectionsPayload,
	ConnectionWithStatus,
	DatabaseSchema,
	RecentTable,
	Console,
	SshPromptRequest,
} from './shared/types.ts'
import {
	type AppRoute,
	buildTeammateRouteUrl,
	formatRoute,
	maskConnectionPath,
	parseRoute,
	resolveConnectionRef,
} from './shared/url.ts'

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
	const [dbChangeTick, setDbChangeTick] = createSignal(0)
	const [recents, setRecents] = createSignal<RecentTable[]>([])
	const [schema, setSchema] = createSignal<DatabaseSchema | null>(null)
	const [schemaLoading, setSchemaLoading] = createSignal(false)
	const [schemaError, setSchemaError] = createSignal<string | null>(null)
	const [consoles, setConsoles] = createSignal<Console[]>([])
	const [consoleFocusTick, setConsoleFocusTick] = createSignal(0)
	const [splitConsoleId, setSplitConsoleId] = createSignal<string | null>(null)
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
	const [dbInfoOpen, setDbInfoOpen] = createSignal(false)
	const [changelogOpen, setChangelogOpen] = createSignal(false)
	const [hasUnseenChangelog, setHasUnseenChangelog] = createSignal(false)
	const [availableUpdate, setAvailableUpdate] = createSignal<{ version: string; releaseUrl?: string } | null>(
		(window as unknown as { __datadipAvailableUpdate?: { version: string; releaseUrl?: string } })
			.__datadipAvailableUpdate ?? null,
	)
	const [showInternalTables, setShowInternalTables] = createSignal(false)
	const [omnibarOpen, setOmnibarOpen] = createSignal(false)
	const [recentModalOpen, setRecentModalOpen] = createSignal(false)

	// FK navigation trail & toasts
	const [trail, setTrail] = createSignal<TrailStep[]>([])
	const [toasts, setToasts] = createSignal<Toast[]>([])

	const routeConnRef = createMemo(() => (route().kind === 'home' ? null : (route() as { connId: string }).connId))
	const activeConn = createMemo(() => {
		const ref = routeConnRef()
		if (!ref) return null
		return resolveConnectionRef(ref, connections())
	})
	const activeConnId = createMemo(() => activeConn()?.id ?? routeConnRef())
	const isProd = createMemo(() => Boolean(activeConn()?.isProduction))
	const isAlwaysReadOnly = createMemo(() => Boolean(activeConn()?.alwaysReadOnly))
	const rwArmed = createMemo(() => {
		const c = activeConn()
		if (!c || c.alwaysReadOnly || !c.rwArmed) return false
		if (c.rwArmedUntil !== null && nowMs() >= c.rwArmedUntil) return false
		return true
	})

	// Canonicalize teammate slug URLs (/c/my-db-name/...) to the local connection ID once connections load.
	createEffect(
		() => [routeConnRef(), activeConn()] as const,
		([ref, conn]) => {
			if (!ref || !conn || ref === conn.id) return
			const cur = route()
			if (cur.kind === 'home') return
			navigate({ ...cur, connId: conn.id } as AppRoute, { replace: true })
		},
	)

	// Target-bound production safety: auto-relock RW on a Production connection when switching to another DB or Home.
	let prevActiveConnId: string | null = null
	createEffect(
		() => activeConnId(),
		(nextId) => {
			const prevId = prevActiveConnId
			prevActiveConnId = nextId
			if (prevId && prevId !== nextId) {
				const prevConn = connections().find((c) => c.id === prevId)
				if (prevConn?.isProduction && prevConn.rwArmed) {
					void api.setRwMode(prevId, false).catch(() => {})
				}
			}
		},
	)

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
			const [sRes, pRes] = await Promise.all([api.getSchema(connId), api.listConsoles(connId)])
			if (activeConnId() !== connId) return
			setSchema(sRes)
			setConsoles(pRes.consoles)
			// If on /c/:id with no table/sql chosen, jump to first table or console
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
					await openOrCreateConsole(connId)
				}
			} else if (cur.kind === 'sql' && cur.connId === connId) {
				if (pRes.consoles.length === 0) {
					const created = await api.createConsole(
						connId,
						'Console 1',
						'-- Press Cmd+Enter to run the highlighted statement\n',
					)
					setConsoles([created.console])
					navigate({ kind: 'sql', connId, consoleId: created.console.id }, { replace: true })
				} else if (!cur.consoleId || !pRes.consoles.some((p) => p.id === cur.consoleId)) {
					navigate({ kind: 'sql', connId, consoleId: pRes.consoles[0]!.id }, { replace: true })
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

	function nextConsoleTitle(consoleList: Console[]): string {
		const used = new Set(consoleList.map((p) => p.title.trim().toLowerCase()))
		let n = 1
		while (used.has(`console ${n}`)) n++
		return `Console ${n}`
	}

	function isConsoleTrivial(sqlConsole: Console): boolean {
		const nonCommentLines = sqlConsole.sql
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith('--'))
		return nonCommentLines.length === 0
	}

	async function deleteConsoleImmediate(sqlConsole: Console) {
		const run = getConsoleRun(sqlConsole.id)
		if (run.running && run.queryId) {
			void api.cancelQuery(sqlConsole.connectionId, run.queryId).catch(() => {})
		}
		try {
			await api.deleteConsole(sqlConsole.id)
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
			return
		}
		clearConsoleRun(sqlConsole.id)
		const rest = consoles().filter((p) => p.id !== sqlConsole.id)
		setConsoles(rest)
		if (splitConsoleId() === sqlConsole.id) {
			setSplitConsoleId(null)
		}
		const cur = route()
		if (cur.kind === 'sql' && cur.consoleId === sqlConsole.id) {
			const nextConsole = rest.find((p) => p.id !== splitConsoleId()) ?? rest[0]
			if (nextConsole) {
				if (splitConsoleId() === nextConsole.id) setSplitConsoleId(null)
				navigate({ kind: 'sql', connId: cur.connId, consoleId: nextConsole.id }, { replace: true })
			} else {
				navigate({ kind: 'connection', connId: cur.connId }, { replace: true })
			}
		}
	}

	function requestCloseConsole(sqlConsole: Console) {
		const run = getConsoleRun(sqlConsole.id)
		if (isConsoleTrivial(sqlConsole) && !run.running) {
			void deleteConsoleImmediate(sqlConsole)
			return
		}
		setConfirmState({
			title: `Close "${sqlConsole.title}"?`,
			message: run.running
				? 'This console has a running query. Closing will cancel the query and delete this console.'
				: 'Closing deletes this console and its SQL text.',
			confirmLabel: 'Close Console',
			danger: true,
			onConfirm: () => deleteConsoleImmediate(sqlConsole),
		})
	}

	async function createNewConsole(
		connId: string,
		initialSql = '-- Press Cmd+Enter to run the highlighted statement\n',
	): Promise<Console | null> {
		try {
			const title = nextConsoleTitle(consoles())
			const res = await api.createConsole(connId, title, initialSql)
			setConsoles((prev) => [...prev, res.console])
			return res.console
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
			return null
		}
	}

	async function openOrCreateConsole(connId: string, initialSql?: string) {
		if (initialSql !== undefined) {
			const sqlConsole = await createNewConsole(connId, initialSql)
			if (sqlConsole) navigate({ kind: 'sql', connId, consoleId: sqlConsole.id })
			return
		}
		const existing = orderedConsoles()
		if (existing.length > 0) {
			navigate({ kind: 'sql', connId, consoleId: existing[0]!.id })
			return
		}
		const sqlConsole = await createNewConsole(connId)
		if (sqlConsole) navigate({ kind: 'sql', connId, consoleId: sqlConsole.id })
	}

	async function toggleSplitConsole() {
		const id = activeConnId()
		if (!id) return
		if (splitConsoleId()) {
			setSplitConsoleId(null)
			return
		}
		const primary = activeConsole()
		const existingOther = orderedConsoles().find((p) => p.id !== primary?.id)
		if (existingOther) {
			setSplitConsoleId(existingOther.id)
			return
		}
		const created = await createNewConsole(id)
		if (created) setSplitConsoleId(created.id)
	}

	function cycleConsoleTab(delta: 1 | -1) {
		const r = route()
		if (r.kind !== 'sql') return
		const list = orderedConsoles()
		if (list.length <= 1) return
		const curId = activeConsole()?.id
		const idx = Math.max(
			0,
			list.findIndex((c) => c.id === curId),
		)
		const next = list[(idx + delta + list.length) % list.length]!
		if (splitConsoleId() === next.id) setSplitConsoleId(curId ?? null)
		navigate({ kind: 'sql', connId: r.connId, consoleId: next.id })
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

		if (armed && conn.alwaysReadOnly) {
			notify(`"${conn.name}" is locked permanently Read-Only`, 'error')
			return
		}
		if (armed && conn.isProduction) {
			setConfirmState({
				title: `Enable Read-Write on PRODUCTION (${conn.name})?`,
				message:
					'You are about to unlock write access on a Production database. It auto-relocks after 10 minutes of inactivity or when switching databases.',
				confirmLabel: 'Arm Read-Write (10 min)',
				danger: true,
				requireConfirmText: conn.name,
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

	function openChangelog() {
		setChangelogOpen(true)
		if (hasUnseenChangelog()) {
			setHasUnseenChangelog(false)
			void api.setPreference('lastSeenVersion', APP_VERSION)
		}
	}

	// Boot: load connections, prefs, popstate listener, clock tick, global hotkeys
	onSettled(() => {
		void refreshConnections()
		void api.getPreferences().then((res) => {
			const pref = res.preferences.theme
			const isDark =
				pref === 'dark' || (pref !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
			setDark(isDark)
			document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
			if (res.preferences.lastSeenVersion !== APP_VERSION) {
				setHasUnseenChangelog(true)
			}
		})

		const onPop = () => {
			setRoute(parseRoute(window.location.pathname, window.location.search))
		}
		window.addEventListener('popstate', onPop)

		const onKey = (e: KeyboardEvent) => {
			const key = e.key.toLowerCase()
			const primaryMod = isPrimaryMod(e)
			const modalOpen = Boolean(document.querySelector('dialog[open]'))
			const isRecentsKey = isMac
				? e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === 'r'
				: e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'r'

			if (isRecentsKey) {
				e.preventDefault()
				setOmnibarOpen(false)
				setRecentModalOpen((v) => !v)
				void refreshConnections()
			} else if (primaryMod && !e.altKey && !e.shiftKey && (key === 'k' || key === 'p')) {
				e.preventDefault()
				setRecentModalOpen(false)
				setOmnibarOpen((v) => !v)
			} else if (primaryMod && !e.altKey && !e.shiftKey && key === 'b') {
				e.preventDefault()
				setSidebarOpen((v) => !v)
			} else if (route().kind === 'sql' && !modalOpen && e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
				e.preventDefault()
				cycleConsoleTab(e.shiftKey ? -1 : 1)
			} else if (
				route().kind === 'sql' &&
				!modalOpen &&
				primaryMod &&
				e.shiftKey &&
				!e.altKey &&
				(e.key === '{' || e.key === '[' || e.code === 'BracketLeft')
			) {
				e.preventDefault()
				cycleConsoleTab(-1)
			} else if (
				route().kind === 'sql' &&
				!modalOpen &&
				primaryMod &&
				e.shiftKey &&
				!e.altKey &&
				(e.key === '}' || e.key === ']' || e.code === 'BracketRight')
			) {
				e.preventDefault()
				cycleConsoleTab(1)
			} else if (primaryMod && !e.altKey && !e.shiftKey && e.key === '[' && !isEditableTarget(e.target)) {
				e.preventDefault()
				window.history.back()
			} else if (primaryMod && !e.altKey && !e.shiftKey && e.key === ']' && !isEditableTarget(e.target)) {
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
					void openOrCreateConsole(id).then(() => setConsoleFocusTick((n) => n + 1))
				}
			} else if (isNativeApp() && primaryMod && !e.altKey && !e.shiftKey && key === 'l') {
				e.preventDefault()
				void copyToClipboard(window.location.href).then((ok) => {
					if (ok) notify('Copied current URL', 'ok')
				})
			} else if (isNativeApp() && primaryMod && !e.altKey && !e.shiftKey && key === 'r') {
				e.preventDefault()
				window.dispatchEvent(new CustomEvent('datadip:refresh'))
			}
		}
		window.addEventListener('keydown', onKey, true)

		const onRefresh = () => {
			const id = activeConnId()
			if (id) void loadConnectionData(id)
			else void refreshConnections()
		}
		const onNewTab = () => {
			const id = activeConnId()
			if (!id) {
				notify('Select a database first', 'info')
				return
			}
			void openOrCreateConsole(id, '-- Press Cmd+Enter to run the highlighted statement\n').then(() =>
				setConsoleFocusTick((n) => n + 1),
			)
		}
		const onCloseTab = (e: Event) => {
			if (route().kind !== 'sql') return
			const cur = activeConsole()
			if (!cur) return
			e.preventDefault()
			if (!confirmState()) requestCloseConsole(cur)
		}
		const onChangelog = () => openChangelog()
		const onUpdateAvailable = (e: Event) => {
			const detail = (e as CustomEvent<{ version?: string; releaseUrl?: string }>).detail
			if (detail?.version) {
				setAvailableUpdate({ version: detail.version, releaseUrl: detail.releaseUrl })
			}
		}
		window.addEventListener('datadip:refresh', onRefresh)
		window.addEventListener('datadip:new-tab', onNewTab)
		window.addEventListener('datadip:close-tab', onCloseTab)
		window.addEventListener('datadip:changelog', onChangelog)
		window.addEventListener('datadip:update-available', onUpdateAvailable)

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
						const prevActive = prev.find((c) => c.id === activeId)
						const nextActive = next.find((c) => c.id === activeId)
						const wasOrphaned = prevActive?.orphaned
						const nowOrphaned = nextActive?.orphaned
						if (nowOrphaned && !wasOrphaned) {
							notify('Active connection removed from connections.ason (kept open as orphaned)', 'info')
						} else if (activeId && !nextActive && prevActive) {
							navigate({ kind: 'home' })
						} else if (
							activeId &&
							nextActive &&
							(JSON.stringify(prevActive?.virtualForeignKeys ?? []) !==
								JSON.stringify(nextActive.virtualForeignKeys ?? []) ||
								JSON.stringify(prevActive?.ignoredForeignKeys ?? []) !==
									JSON.stringify(nextActive.ignoredForeignKeys ?? []))
						) {
							void api
								.getSchema(activeId)
								.then((sRes) => {
									if (activeConnId() === activeId) setSchema(sRes)
								})
								.catch(() => {})
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

			source.addEventListener('db-changed', (ev) => {
				try {
					const payload = parseAson((ev as MessageEvent).data) as { connectionId?: string }
					if (payload.connectionId && payload.connectionId === activeConnId()) {
						setDbChangeTick((n) => n + 1)
					}
				} catch {}
			})

			source.addEventListener('schema-changed', (ev) => {
				try {
					const payload = parseAson((ev as MessageEvent).data) as { connectionId?: string }
					const activeId = activeConnId()
					if (payload.connectionId && payload.connectionId === activeId) {
						void api
							.getSchema(activeId)
							.then((sRes) => {
								if (activeConnId() === activeId) setSchema(sRes)
							})
							.catch(() => {})
					}
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
			window.removeEventListener('datadip:refresh', onRefresh)
			window.removeEventListener('datadip:new-tab', onNewTab)
			window.removeEventListener('datadip:close-tab', onCloseTab)
			window.removeEventListener('datadip:changelog', onChangelog)
			window.removeEventListener('datadip:update-available', onUpdateAvailable)
			if (reconnectTimer) clearTimeout(reconnectTimer)
			es?.close()
			clearInterval(timer)
		}
	})

	// Reload schema & consoles when active connection changes
	createEffect(
		() => activeConnId(),
		(connId) => {
			setTableFilter('')
			setSplitConsoleId(null)
			if (!connId) {
				setSchema(null)
				setConsoles([])
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

	const primaryTables = createMemo(() => filteredTables().filter((t) => !t.isInternal))
	const internalTables = createMemo(() => filteredTables().filter((t) => Boolean(t.isInternal)))
	const existingGroups = createMemo(() =>
		Array.from(
			new Set(
				connections()
					.map((c) => c.group?.trim())
					.filter((g): g is string => Boolean(g)),
			),
		).sort(),
	)

	async function copyTeammateLink() {
		const conn = activeConn()
		if (!conn) return
		const url = buildTeammateRouteUrl(route(), conn.name, window.location.origin)
		if (await copyToClipboard(url)) {
			notify(`Copied teammate link (${conn.name})`, 'ok')
		}
	}

	// Stable left-to-right console order (by createdAt ASC) so tabs never jump around on edit/save.
	const orderedConsoles = createMemo(() =>
		[...consoles()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
	)

	const activeConsole = createMemo(() => {
		const r = route()
		if (r.kind !== 'sql') return null
		const list = orderedConsoles()
		if (r.consoleId) return list.find((p) => p.id === r.consoleId) ?? list[0] ?? null
		return list[0] ?? null
	})

	const splitConsole = createMemo(() => {
		const sid = splitConsoleId()
		if (!sid || route().kind !== 'sql') return null
		const sqlConsole = orderedConsoles().find((p) => p.id === sid)
		if (!sqlConsole || sqlConsole.id === activeConsole()?.id) return null
		return sqlConsole
	})

	// Keep browser & DataDip.app window title prominently showing the active DB and view.
	createEffect(
		() => [activeConn(), route(), activeConsole()?.title, splitConsole()?.title] as const,
		([conn, r, p1, p2]) => {
			if (r.kind === 'home' || !conn) {
				document.title = 'DataDip'
				return
			}
			const prodPrefix = conn.isProduction ? '[PROD] ' : ''
			const connLabel = conn.group ? `${conn.group} / ${conn.name}` : conn.name
			if (r.kind === 'table') {
				document.title = `${prodPrefix}${r.table} · ${connLabel} — DataDip`
			} else if (r.kind === 'sql') {
				const consoleLabel = p2 ? `${p1 ?? 'Console'} | ${p2}` : (p1 ?? 'Console')
				document.title = `${prodPrefix}${consoleLabel} · ${connLabel} — DataDip`
			} else if (r.kind === 'er') {
				document.title = `${prodPrefix}ER Diagram · ${connLabel} — DataDip`
			} else {
				document.title = `${prodPrefix}${connLabel} — DataDip`
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

	const activeErRoute = createMemo(() => {
		const r = route()
		return r.kind === 'er' && !schemaError() ? r : null
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

				<button
					type="button"
					class={['version-badge-btn mono', { unseen: hasUnseenChangelog() }]}
					title={`What's New in DataDip v${APP_VERSION}`}
					aria-label={`What's New in DataDip v${APP_VERSION}`}
					onClick={openChangelog}
				>
					<Show when={hasUnseenChangelog()}>
						<span class="unseen-dot" aria-hidden="true" />
					</Show>
					v{APP_VERSION}
				</button>

				<Show when={availableUpdate()}>
					{(u) => (
						<button
							type="button"
							class="version-badge-btn update-badge-btn mono"
							title={`Update DataDip to v${u().version}`}
							aria-label={`Update available: DataDip v${u().version}`}
							onClick={() => {
								try {
									const w = window as unknown as {
										webkit?: { messageHandlers?: { datadip?: { postMessage: (msg: string) => void } } }
									}
									w.webkit?.messageHandlers?.datadip?.postMessage('installUpdate')
								} catch {}
							}}
						>
							<span class="update-dot" aria-hidden="true" />
							Update v{u().version}
						</button>
					)}
				</Show>

				<Show when={activeConnId()}>
					<button
						type="button"
						class="icon-btn ghost"
						onClick={() => setSidebarOpen((v) => !v)}
						aria-label={`Toggle sidebar (${modKeyLabel('B')})`}
						title={`Toggle sidebar (${modKeyLabel('B')})`}
					>
						<IconSidebar />
					</button>
				</Show>

				<div class="nav-arrows">
					<button
						type="button"
						onClick={() => window.history.back()}
						aria-label={`Back (${modKeyLabel('[')})`}
						title={`Back (${modKeyLabel('[')})`}
					>
						<IconBack />
					</button>
					<button
						type="button"
						onClick={() => window.history.forward()}
						aria-label={`Forward (${modKeyLabel(']')})`}
						title={`Forward (${modKeyLabel(']')})`}
					>
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
										{c.group ? `${c.group} / ` : ''}
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
										{c.group ? `${c.group} / ` : ''}
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
											{c.group ? `${c.group} / ` : ''}
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
						aria-label={isNativeApp() ? `Copy location URL (${modKeyLabel('L')})` : 'Copy location URL'}
						title={isNativeApp() ? `Copy location URL (${modKeyLabel('L')})` : 'Copy location URL'}
						onClick={async () => {
							if (await copyToClipboard(window.location.href)) notify('Copied URL to clipboard', 'ok')
						}}
					>
						<IconCopy />
					</button>
					<button
						type="button"
						class="btn sm"
						style="height:26px;padding:0 8px;font-size:11.5px"
						title="Copy teammate-shareable link using the database name instead of your local connection ID"
						onClick={() => void copyTeammateLink()}
					>
						Share
					</button>
				</Show>

				<button
					type="button"
					class="omnibar-trigger"
					onClick={() => {
						setRecentModalOpen(true)
						void refreshConnections()
					}}
					aria-label={`Open recent databases and tables (${recentsKeyLabel()})`}
					title={`Open recent databases and tables (${recentsKeyLabel()})`}
				>
					<span>Recent</span>
					<span class="kbd">{recentsKeyLabel()}</span>
				</button>

				<button
					type="button"
					class="omnibar-trigger"
					onClick={() => setOmnibarOpen(true)}
					title={`Jump to table, column, console, or ID (${modKeyLabel('K')} or ${modKeyLabel('P')})`}
				>
					<IconSearch />
					<span>Jump / Find ID</span>
					<span class="kbd">{modKeyLabel('K')}</span>
				</button>

				{/* Always-visible Read-Only / Read-Write safety toggle (or permanent LOCKED RO badge) */}
				<Show when={activeConn()}>
					{(conn) => (
						<Show
							when={!conn().alwaysReadOnly}
							fallback={
								<span
									class="locked-ro-pill"
									title="This connection is locked permanently Read-Only in connection settings"
								>
									<IconLock />
									LOCKED RO
								</span>
							}
						>
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
						</Show>
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
									<div class="sidebar-db-name" title={maskConnectionPath(activeConn()?.path ?? '')}>
										<span class="status-dot" />
										<span class="sidebar-db-name-text">{activeConn()?.name ?? 'Database'}</span>
									</div>
									<div class="sidebar-meta mono">
										<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
											{activeConn()?.location === 'ssh'
												? `ssh://${activeConn()?.sshHost}${activeConn()?.driver === 'postgres' ? ' · pg' : activeConn()?.sshResolvedRuntime ? ` · ${activeConn()?.sshResolvedRuntime}` : ''}`
												: activeConn()?.location === 'turso'
													? 'turso · libSQL'
													: activeConn()?.location === 'd1'
														? 'cloudflare d1'
														: activeConn()?.driver === 'postgres'
															? 'postgresql'
															: 'local sqlite'}
										</span>
										<Show when={schema()}>{(s) => <span>· {s().durationMs}ms</span>}</Show>
									</div>
								</div>
								<button
									type="button"
									class="btn sm"
									style="height:22px;padding:0 6px;font-size:11px"
									title="Database Info, PRAGMA & WAL Inspector"
									onClick={() => setDbInfoOpen(true)}
								>
									Info
								</button>
								<button
									type="button"
									class="icon-btn ghost"
									style="width:24px;height:24px"
									aria-label="Refresh schema"
									title={isNativeApp() ? `Refresh schema (${modKeyLabel('R')})` : 'Refresh schema'}
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
									<span
										class="kbd"
										style="text-transform:none"
										title={`Open Console (${modKeyLabel('E')} or ${modKeyLabel('L', true)})`}
									>
										{modKeyLabel('E')}
									</span>
									<button
										type="button"
										class="icon-btn ghost"
										style="width:20px;height:20px"
										aria-label="New console"
										title={isNativeApp() ? `New Console (${modKeyLabel('T')})` : 'New Console'}
										onClick={() => {
											const id = activeConnId()
											if (id) void openOrCreateConsole(id, '-- Write SQL and press Cmd+Enter\n')
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
										if (id) void openOrCreateConsole(id)
									}}
								>
									<IconSql />
									<span>+ Open Console</span>
								</button>
							</Show>

							<For each={orderedConsoles()}>
								{(sqlConsole) => {
									const run = () => getConsoleRun(sqlConsole.id)
									const isPrimary = () => route().kind === 'sql' && activeConsole()?.id === sqlConsole.id
									const isSecondary = () => route().kind === 'sql' && splitConsole()?.id === sqlConsole.id
									return (
										<div class={['sidebar-console-row', { active: isPrimary(), secondary: isSecondary() }]}>
											<button
												type="button"
												class={['sidebar-item', { active: isPrimary() || isSecondary() }]}
												onClick={() => {
													if (splitConsoleId() === sqlConsole.id) setSplitConsoleId(activeConsole()?.id ?? null)
													navigate({ kind: 'sql', connId: sqlConsole.connectionId, consoleId: sqlConsole.id })
												}}
											>
												<IconSql />
												<span class="sidebar-item-label">{sqlConsole.title}</span>
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
												aria-label={`Close ${sqlConsole.title}`}
												title={`Close ${sqlConsole.title}`}
												onClick={(e) => {
													e.stopPropagation()
													requestCloseConsole(sqlConsole)
												}}
											>
												<IconClose />
											</button>
										</div>
									)
								}}
							</For>

							{/* Schema / ER Diagram quick button */}
							<button
								type="button"
								class={['sidebar-item', { active: route().kind === 'er' }]}
								onClick={() => {
									const id = activeConnId()
									if (id) navigate({ kind: 'er', connId: id })
								}}
							>
								<IconView />
								<span class="sidebar-item-label">ER Diagram</span>
								<Show when={schema()}>
									{(s) => <span class="sidebar-count">{s().tables.filter((t) => !t.isInternal).length}</span>}
								</Show>
							</button>

							{/* Tables & Views section */}
							<div class="sidebar-section-head">
								<span>Tables &amp; Views ({primaryTables().length})</span>
							</div>

							<Show when={schemaLoading() && !schema()}>
								<div style="padding:8px 12px;color:var(--ink-muted);font-size:12px">
									Connecting &amp; loading schema…
								</div>
							</Show>

							<For each={primaryTables()}>
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
												<span
													class="sidebar-count"
													title={t.rowCountEstimated ? 'Estimated row count from PostgreSQL stats' : undefined}
												>
													{formatRowCount(t.rowCount, t.rowCountEstimated)}
												</span>
											</Show>
										</button>
									)
								}}
							</For>

							{/* Collapsible FTS5 / RTree internal shadow tables */}
							<Show when={internalTables().length > 0}>
								<button type="button" class="sidebar-section-toggle" onClick={() => setShowInternalTables((v) => !v)}>
									<span>
										{showInternalTables() || tableFilter().trim() ? '▾' : '▸'} Internal / FTS5 (
										{internalTables().length})
									</span>
								</button>
								<Show when={showInternalTables() || Boolean(tableFilter().trim())}>
									<For each={internalTables()}>
										{(t) => {
											const isActive = () =>
												route().kind === 'table' && (route() as Extract<AppRoute, { kind: 'table' }>).table === t.name
											return (
												<button
													type="button"
													class={['sidebar-item', { active: isActive() }]}
													style="opacity:0.78"
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
													<IconTable />
													<span class="sidebar-item-label mono">{t.name}</span>
													<Show when={t.rowCount !== null}>
														<span
															class="sidebar-count"
															title={t.rowCountEstimated ? 'Estimated row count from PostgreSQL stats' : undefined}
														>
															{formatRowCount(t.rowCount, t.rowCountEstimated)}
														</span>
													</Show>
												</button>
											)
										}}
									</For>
								</Show>
							</Show>
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
							schema={schema()}
							tableSchema={schema()?.schemas[r().table] ?? null}
							rwArmed={rwArmed()}
							reconnectTick={reconnectTick()}
							dbChangeTick={dbChangeTick()}
							isLocalSqlite={activeConn()?.driver === 'sqlite' && activeConn()?.location === 'local'}
							onNavigate={(next, opts) => navigate(next, opts)}
							onOpenInSql={(sqlText) => {
								void openOrCreateConsole(r().connId, sqlText)
							}}
							onRequestConfirm={(st) => setConfirmState(st)}
							onRequestArmRw={() => void setRw(true)}
							onNotify={notify}
							onSchemaChanged={() => {
								const id = activeConnId()
								if (id) void loadConnectionData(id)
							}}
							onExactRowCount={(tableName, count) => {
								setSchema((prev) => {
									if (!prev) return prev
									let changed = false
									const tables = prev.tables.map((t) => {
										if (t.name !== tableName) return t
										if (t.rowCount === count && !t.rowCountEstimated) return t
										changed = true
										return { ...t, rowCount: count, rowCountEstimated: false }
									})
									return changed ? { ...prev, tables } : prev
								})
							}}
						/>
					)}
				</Show>

				<Show when={activeErRoute()}>
					{(r) => (
						<ErDiagramView
							schema={schema()}
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
										{(sqlConsole) => {
											const run = () => getConsoleRun(sqlConsole.id)
											const isActive = () => activeConsole()?.id === sqlConsole.id
											const isSplit = () => splitConsole()?.id === sqlConsole.id
											return (
												<div
													class={['console-tab', { active: isActive(), split: isSplit() }]}
													onAuxClick={(e) => {
														if (e.button === 1) {
															e.preventDefault()
															requestCloseConsole(sqlConsole)
														}
													}}
												>
													<button
														type="button"
														role="tab"
														aria-selected={isActive() ? 'true' : 'false'}
														class="console-tab-btn"
														onClick={() => {
															if (splitConsoleId() === sqlConsole.id) setSplitConsoleId(activeConsole()?.id ?? null)
															navigate({ kind: 'sql', connId: r().connId, consoleId: sqlConsole.id })
														}}
													>
														<IconSql />
														<span>{sqlConsole.title}</span>
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
														aria-label={`Close ${sqlConsole.title}`}
														title={
															isNativeApp()
																? `Close ${sqlConsole.title} (${modKeyLabel('W')})`
																: `Close ${sqlConsole.title}`
														}
														onClick={(e) => {
															e.stopPropagation()
															requestCloseConsole(sqlConsole)
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
										title={isNativeApp() ? `New Console (${modKeyLabel('T')})` : 'New Console'}
										onClick={() => void openOrCreateConsole(r().connId, '-- Write SQL and press Cmd+Enter\n')}
									>
										<IconPlus />
									</button>
								</div>
							</div>

							<div class="consoles-split-grid">
								<div class="console-pane">
									<ConsoleView
										connId={r().connId}
										connName={activeConn()?.name}
										driver={activeConn()?.driver}
										isProduction={activeConn()?.isProduction}
										console={activeConsole()}
										schema={schema()}
										dark={dark()}
										nowMs={nowMs()}
										focusTick={consoleFocusTick()}
										splitOpen={Boolean(splitConsole())}
										onToggleSplit={() => void toggleSplitConsole()}
										onConsoleUpdated={(sqlConsole) =>
											setConsoles((prev) => prev.map((p) => (p.id === sqlConsole.id ? sqlConsole : p)))
										}
										onConsoleDeleted={(consoleId) => {
											const rest = consoles().filter((p) => p.id !== consoleId)
											setConsoles(rest)
											if (splitConsoleId() === consoleId) setSplitConsoleId(null)
											if (rest.length > 0)
												navigate({ kind: 'sql', connId: r().connId, consoleId: rest[0]!.id }, { replace: true })
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

								<Show when={splitConsole()}>
									{(sp) => (
										<div class="console-pane split-secondary">
											<ConsoleView
												connId={r().connId}
												connName={activeConn()?.name}
												driver={activeConn()?.driver}
												isProduction={activeConn()?.isProduction}
												console={sp()}
												schema={schema()}
												dark={dark()}
												nowMs={nowMs()}
												isSplitPane
												allConsoles={orderedConsoles().filter((p) => p.id !== activeConsole()?.id)}
												onSelectConsole={(pid) => setSplitConsoleId(pid)}
												onCloseSplit={() => setSplitConsoleId(null)}
												onConsoleUpdated={(sqlConsole) =>
													setConsoles((prev) => prev.map((p) => (p.id === sqlConsole.id ? sqlConsole : p)))
												}
												onConsoleDeleted={(consoleId) => {
													setConsoles((prev) => prev.filter((p) => p.id !== consoleId))
													if (splitConsoleId() === consoleId) setSplitConsoleId(null)
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
				existingGroups={existingGroups()}
				onClose={() => setConnModalOpen(false)}
				onSaved={async (conn) => {
					await refreshConnections()
					notify(`Saved ${conn.name}`, 'ok')
				}}
			/>

			<DbInfoModal
				open={dbInfoOpen()}
				connId={activeConnId()}
				connName={activeConn()?.name ?? 'Database'}
				rwArmed={rwArmed()}
				onClose={() => setDbInfoOpen(false)}
				onRequestConfirm={(st) => setConfirmState(st)}
				onNotify={notify}
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
				consoles={consoles()}
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
				onSelectConsole={(connId, consoleId) => navigate({ kind: 'sql', connId, consoleId })}
				onNewConsole={() => {
					const id = activeConnId()
					if (id) void openOrCreateConsole(id, '-- New console\n')
				}}
				onOpenErDiagram={() => {
					const id = activeConnId()
					if (id) navigate({ kind: 'er', connId: id })
				}}
				onOpenDbInfo={() => setDbInfoOpen(true)}
				onCopyTeammateLink={() => void copyTeammateLink()}
				canToggleRw={!isAlwaysReadOnly()}
				onOpenChangelog={openChangelog}
				onToggleTheme={toggleTheme}
				onToggleRw={() => void setRw(!rwArmed())}
				onOpenDiscover={() => setDiscoverOpen(true)}
			/>

			<ChangelogModal open={changelogOpen()} onClose={() => setChangelogOpen(false)} />

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

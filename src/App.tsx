// Root DataDip application: URL history router, Production chrome, Read-Only/Read-Write switch, sidebar, FK trail, and modals.
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { ConfirmDialog, type ConfirmState } from './components/ConfirmDialog.tsx'
import { ConnectionModal } from './components/ConnectionModal.tsx'
import { DiscoverModal } from './components/DiscoverModal.tsx'
import { HomeView } from './components/HomeView.tsx'
import { Omnibar } from './components/Omnibar.tsx'
import { ScratchpadView } from './components/ScratchpadView.tsx'
import { TableView } from './components/TableView.tsx'
import { api } from './lib/api.ts'
import { copyToClipboard, formatCountdown } from './lib/format.ts'
import {
	IconAlert,
	IconBack,
	IconBrand,
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
import { tid } from './shared/tid.ts'
import type { ConnectionConfig, ConnectionWithStatus, DatabaseSchema, RecentTable, Scratchpad } from './shared/types.ts'
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
	const [recents, setRecents] = createSignal<RecentTable[]>([])
	const [schema, setSchema] = createSignal<DatabaseSchema | null>(null)
	const [schemaLoading, setSchemaLoading] = createSignal(false)
	const [schemaError, setSchemaError] = createSignal<string | null>(null)
	const [scratchpads, setScratchpads] = createSignal<Scratchpad[]>([])

	const [sidebarOpen, setSidebarOpen] = createSignal(true)
	const [tableFilter, setTableFilter] = createSignal('')
	const [dark, setDark] = createSignal(false)
	const [nowMs, setNowMs] = createSignal(Date.now())

	// Modals
	const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null)
	const [connModalOpen, setConnModalOpen] = createSignal(false)
	const [editingConn, setEditingConn] = createSignal<ConnectionConfig | null>(null)
	const [discoverOpen, setDiscoverOpen] = createSignal(false)
	const [omnibarOpen, setOmnibarOpen] = createSignal(false)

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
		} else if (next.kind === 'home' || next.kind === 'connection') {
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
			setRecents(rRes.recents)
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
			}
		} catch (err) {
			if (activeConnId() !== connId) return
			setSchemaError(err instanceof Error ? err.message : String(err))
			setSchema(null)
		} finally {
			if (activeConnId() === connId) setSchemaLoading(false)
		}
	}

	async function openOrCreateScratchpad(connId: string, initialSql?: string) {
		try {
			if (initialSql !== undefined) {
				const res = await api.createScratchpad(connId, `Query ${scratchpads().length + 1}`, initialSql)
				setScratchpads((prev) => [res.scratchpad, ...prev])
				navigate({ kind: 'sql', connId, padId: res.scratchpad.id })
				return
			}
			const existing = scratchpads()
			if (existing.length > 0) {
				navigate({ kind: 'sql', connId, padId: existing[0]!.id })
				return
			}
			const res = await api.createScratchpad(connId, 'Scratchpad 1', '-- Press Cmd+Enter to run statement\n')
			setScratchpads([res.scratchpad])
			navigate({ kind: 'sql', connId, padId: res.scratchpad.id })
		} catch (err) {
			notify(err instanceof Error ? err.message : String(err), 'error')
		}
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

		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				setOmnibarOpen((v) => !v)
			} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
				e.preventDefault()
				setSidebarOpen((v) => !v)
			} else if (e.metaKey && e.key === '[') {
				e.preventDefault()
				window.history.back()
			} else if (e.metaKey && e.key === ']') {
				e.preventDefault()
				window.history.forward()
			} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
				e.preventDefault()
				void copyToClipboard(window.location.href).then((ok) => {
					if (ok) notify('Copied current URL', 'ok')
				})
			}
		}
		window.addEventListener('keydown', onKey)

		const timer = setInterval(() => setNowMs(Date.now()), 1000)

		return () => {
			window.removeEventListener('popstate', onPop)
			window.removeEventListener('keydown', onKey)
			clearInterval(timer)
		}
	})

	// Reload schema & scratchpads when active connection changes
	createEffect(
		() => activeConnId(),
		(connId) => {
			setTableFilter('')
			if (!connId) {
				setSchema(null)
				setScratchpads([])
				setSchemaError(null)
				return
			}
			void loadConnectionData(connId)
		},
	)

	// Keep page title crisp & informative
	createEffect(
		() => [activeConn()?.name, route()] as const,
		([connName, r]) => {
			const prodPrefix = activeConn()?.isProduction ? '[PROD] ' : ''
			if (r.kind === 'table') document.title = `${prodPrefix}${r.table} · ${connName ?? 'DataDip'}`
			else if (r.kind === 'sql') document.title = `${prodPrefix}SQL · ${connName ?? 'DataDip'}`
			else document.title = 'DataDip'
		},
	)

	const filteredTables = createMemo(() => {
		const q = tableFilter().trim().toLowerCase()
		const list = schema()?.tables ?? []
		return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list
	})

	const activePad = createMemo(() => {
		const r = route()
		if (r.kind !== 'sql') return null
		const list = scratchpads()
		if (r.padId) return list.find((p) => p.id === r.padId) ?? list[0] ?? null
		return list[0] ?? null
	})

	const defaultSshHost = createMemo(() => connections().find((c) => c.location === 'ssh' && c.sshHost)?.sshHost)

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
					class="conn-select"
					aria-label="Active database connection"
					value={activeConnId() ?? ''}
					onChange={(e) => {
						const nextId = e.currentTarget.value
						if (!nextId) navigate({ kind: 'home' })
						else navigate({ kind: 'connection', connId: nextId })
					}}
				>
					<option value="">All Connections…</option>
					<For each={connections()}>
						{(c) => (
							<option value={c.id}>
								{c.isProduction ? '[PROD] ' : ''}
								{c.name}
							</option>
						)}
					</For>
				</select>

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

			{/* Main workspace */}
			<div class="workspace">
				{/* Left Sidebar (only when connected to a DB) */}
				<Show when={activeConnId() && sidebarOpen()}>
					<aside class="sidebar">
						<div class="sidebar-header">
							<div class="sidebar-conn-row">
								<div class="sidebar-meta mono">
									<span class="status-dot" />
									<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
										{activeConn()?.location === 'ssh' ? `ssh://${activeConn()?.sshHost}` : 'local sqlite'}
									</span>
									<Show when={schema()}>{(s) => <span>· {s().durationMs}ms</span>}</Show>
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
							{/* Scratchpads section */}
							<div class="sidebar-section-head">
								<span>SQL Scratchpads</span>
								<button
									type="button"
									class="icon-btn ghost"
									style="width:20px;height:20px"
									aria-label="New scratchpad"
									onClick={() => {
										const id = activeConnId()
										if (id) void openOrCreateScratchpad(id, '-- Write SQL and press Cmd+Enter\n')
									}}
								>
									<IconPlus />
								</button>
							</div>

							<Show when={scratchpads().length === 0}>
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
									<span>+ Open SQL Scratchpad</span>
								</button>
							</Show>

							<For each={scratchpads()}>
								{(pad) => (
									<button
										type="button"
										class={[
											'sidebar-item',
											{
												active:
													route().kind === 'sql' && (route() as Extract<AppRoute, { kind: 'sql' }>).padId === pad.id,
											},
										]}
										onClick={() => navigate({ kind: 'sql', connId: pad.connectionId, padId: pad.id })}
									>
										<IconSql />
										<span class="sidebar-item-label">{pad.title}</span>
									</button>
								)}
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
						onDeleteConnection={(c) =>
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
						}
						onOpenDiscover={() => setDiscoverOpen(true)}
					/>
				</Show>

				<Show when={route().kind !== 'home' && schemaError()}>
					<div class="main-pane" style="padding:20px">
						<div class="error-box" style="margin:0">
							<div style="font-weight:600;margin-bottom:6px">Connection Failed</div>
							<div>{schemaError()}</div>
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
							onNavigate={(next, opts) => navigate(next, opts)}
							onOpenInSql={(sqlText) => {
								void openOrCreateScratchpad(r().connId, sqlText)
							}}
							onRequestConfirm={(st) => setConfirmState(st)}
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
						<ScratchpadView
							connId={r().connId}
							scratchpad={activePad()}
							schema={schema()}
							dark={dark()}
							onScratchpadUpdated={(pad) => setScratchpads((prev) => prev.map((p) => (p.id === pad.id ? pad : p)))}
							onScratchpadDeleted={(padId) => {
								const rest = scratchpads().filter((p) => p.id !== padId)
								setScratchpads(rest)
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
					)}
				</Show>
			</div>

			{/* Modals */}
			<ConfirmDialog state={confirmState()} onClose={() => setConfirmState(null)} />

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
					if (id) void openOrCreateScratchpad(id, '-- New scratchpad\n')
				}}
				onToggleTheme={toggleTheme}
				onToggleRw={() => void setRw(!rwArmed())}
				onOpenDiscover={() => setDiscoverOpen(true)}
			/>

			{/* Toasts */}
			<div class="toast-stack" aria-live="polite">
				<For each={toasts()}>{(t) => <div class={['toast', t.kind]}>{t.text}</div>}</For>
			</div>
		</div>
	)
}

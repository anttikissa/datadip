// Connections & Recents home screen with quick filtering, add/edit/delete, production badges, and auto-discover wizard launch.
import { createMemo, createSignal, For, Show } from 'solid-js'
import { formatIsoShort, formatRelative } from '../lib/format.ts'
import {
	IconAlert,
	IconCompass,
	IconDisk,
	IconPlus,
	IconSearch,
	IconServer,
	IconTable,
	IconTrash,
} from '../lib/icons.tsx'
import type { ConnectionConfig, ConnectionWithStatus, RecentTable } from '../shared/types.ts'
import { maskConnectionPath } from '../shared/url.ts'

type ScopeFilter = 'all' | 'prod' | 'ssh' | 'local'

export function HomeView(props: {
	connections: ConnectionWithStatus[]
	recents: RecentTable[]
	onOpenConnection: (connId: string) => void
	onOpenRecent: (connId: string, tableName: string) => void
	onDeleteRecent: (connId: string, tableName: string) => void
	onAddConnection: () => void
	onEditConnection: (conn: ConnectionConfig) => void
	onDeleteConnection: (conn: ConnectionConfig) => void
	onRestoreConnection: (conn: ConnectionWithStatus) => void
	onDisconnectConnection: (conn: ConnectionWithStatus) => void
	onOpenDiscover: () => void
}) {
	const [query, setQuery] = createSignal('')
	const [scope, setScope] = createSignal<ScopeFilter>('all')

	const activeConnections = createMemo(() => props.connections.filter((c) => c.connected))

	const filteredConnections = createMemo(() => {
		const q = query().trim().toLowerCase()
		const sc = scope()
		return props.connections.filter((c) => {
			if (sc === 'prod' && !c.isProduction) return false
			if (sc === 'ssh' && c.location !== 'ssh') return false
			if (sc === 'local' && c.location !== 'local') return false
			if (!q) return true
			return (
				c.name.toLowerCase().includes(q) ||
				c.path.toLowerCase().includes(q) ||
				(c.sshHost?.toLowerCase().includes(q) ?? false)
			)
		})
	})

	return (
		<div class="home-view">
			<div class="home-head">
				<div>
					<h1 class="home-title">Databases</h1>
					<p class="home-sub">
						SQLite and PostgreSQL — local, direct, or over SSH. Every database opens Read-Only by default.
					</p>
				</div>
				<div class="home-actions">
					<button type="button" class="btn" onClick={() => props.onOpenDiscover()}>
						<IconCompass />
						Auto-Discover
					</button>
					<button type="button" class="btn primary" onClick={() => props.onAddConnection()}>
						<IconPlus />
						Add Connection
					</button>
				</div>
			</div>

			<Show when={activeConnections().length > 0}>
				<div class="active-section">
					<div class="section-label active-section-label">
						<span class="status-dot" />
						<span>Active Connections ({activeConnections().length})</span>
					</div>
					<div class="recents-list active-list">
						<For each={activeConnections()}>
							{(conn) => (
								<div class={['recent-row active-row', { 'is-orphan': conn.orphaned }]}>
									<button type="button" class="recent-main active-main" onClick={() => props.onOpenConnection(conn.id)}>
										<span class="status-dot" />
										<span class="active-name">{conn.name}</span>
										<span class="mono active-path">{maskConnectionPath(conn.path)}</span>
										<Show when={conn.driver === 'postgres'}>
											<span class="tag">PG</span>
										</Show>
										<Show when={conn.orphaned}>
											<span class="tag orphan">ORPHANED</span>
										</Show>
										<Show when={conn.rwArmed}>
											<span class="tag rw">RW</span>
										</Show>
										<Show when={conn.isProduction}>
											<span class="tag prod">
												<IconAlert />
												PROD
											</span>
										</Show>
										<span class={['tag', { ssh: conn.location === 'ssh' }]}>
											{conn.location === 'ssh' ? <IconServer /> : <IconDisk />}
											{conn.location === 'ssh' ? conn.sshHost : 'local'}
										</span>
									</button>
									<div class="active-row-actions">
										<Show when={conn.orphaned}>
											<button type="button" class="btn sm primary" onClick={() => props.onRestoreConnection(conn)}>
												Re-save
											</button>
										</Show>
										<button type="button" class="btn sm" onClick={() => props.onDisconnectConnection(conn)}>
											{conn.orphaned ? 'Close' : 'Disconnect'}
										</button>
									</div>
								</div>
							)}
						</For>
					</div>
				</div>
			</Show>

			<Show
				when={props.connections.length > 0}
				fallback={
					<div class="empty-state home-empty-card">
						<div style="font-weight:600;margin-bottom:6px;color:var(--ink-primary)">No saved connections yet</div>
						<p style="margin:0 0 14px">Add a local SQLite file or scan an SSH server with Auto-Discover.</p>
						<div style="display:inline-flex;gap:8px">
							<button type="button" class="btn" onClick={() => props.onOpenDiscover()}>
								<IconCompass />
								Auto-Discover
							</button>
							<button type="button" class="btn primary" onClick={() => props.onAddConnection()}>
								<IconPlus />
								Add Connection
							</button>
						</div>
					</div>
				}
			>
				<div class="home-filter-bar">
					<div class="home-search-wrap">
						<IconSearch />
						<input
							class="home-search-input"
							placeholder="Filter databases by name, host, or path…"
							value={query()}
							onInput={(e) => setQuery(e.currentTarget.value)}
						/>
					</div>
					<div class="pill-tabs" role="tablist" aria-label="Filter connections">
						{(
							[
								['all', `All (${props.connections.length})`],
								['prod', `Prod (${props.connections.filter((c) => c.isProduction).length})`],
								['ssh', `SSH (${props.connections.filter((c) => c.location === 'ssh').length})`],
								['local', `Local (${props.connections.filter((c) => c.location === 'local').length})`],
							] as const
						).map(([id, label]) => (
							<button
								type="button"
								role="tab"
								aria-selected={scope() === id ? 'true' : 'false'}
								class={['pill-tab', { active: scope() === id }]}
								onClick={() => setScope(id)}
							>
								{label}
							</button>
						))}
					</div>
				</div>

				<Show
					when={filteredConnections().length > 0}
					fallback={
						<div class="empty-state" style="padding:28px">
							No databases match "{query()}".
						</div>
					}
				>
					<div class="conn-grid">
						<For each={filteredConnections()}>
							{(conn) => (
								<div
									class={[
										'conn-card',
										{ 'is-prod': conn.isProduction, 'is-orphan': conn.orphaned, 'is-connected': conn.connected },
									]}
									role="button"
									tabindex={0}
									onClick={() => props.onOpenConnection(conn.id)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											props.onOpenConnection(conn.id)
										}
									}}
								>
									<div class="conn-card-top">
										<span class="conn-card-name">
											<Show when={conn.connected}>
												<span class="status-dot" title="Active connection" />
											</Show>
											<span class="conn-card-name-text">{conn.name}</span>
										</span>
										<div class="conn-card-tags">
											<Show when={conn.orphaned}>
												<span class="tag orphan">ORPHANED</span>
											</Show>
											<Show when={conn.rwArmed}>
												<span class="tag rw">RW</span>
											</Show>
											<Show when={conn.isProduction}>
												<span class="tag prod">
													<IconAlert />
													PROD
												</span>
											</Show>
											<Show when={conn.driver === 'postgres'}>
												<span class="tag">PG</span>
											</Show>
											<span class={['tag', { ssh: conn.location === 'ssh' }]}>
												{conn.location === 'ssh' ? <IconServer /> : <IconDisk />}
												{conn.location === 'ssh' ? conn.sshHost : conn.driver === 'postgres' ? 'direct' : 'local'}
											</span>
										</div>
									</div>

									<div class="conn-card-path">{maskConnectionPath(conn.path)}</div>

									<div class="conn-card-foot">
										<span class="mono">
											{conn.orphaned
												? 'Removed from connections.ason (active)'
												: conn.lastVisitedAt
													? `${formatRelative(conn.lastVisitedAt)} · ${formatIsoShort(conn.lastVisitedAt).slice(0, 16)}Z`
													: 'Not opened yet'}
										</span>
										<div class="conn-card-actions">
											<Show
												when={!conn.orphaned}
												fallback={
													<>
														<button
															type="button"
															class="btn sm primary"
															onClick={(e) => {
																e.stopPropagation()
																props.onRestoreConnection(conn)
															}}
														>
															Re-save
														</button>
														<button
															type="button"
															class="btn sm"
															onClick={(e) => {
																e.stopPropagation()
																props.onDisconnectConnection(conn)
															}}
														>
															Close
														</button>
													</>
												}
											>
												<Show when={conn.connected}>
													<button
														type="button"
														class="btn sm ghost-btn"
														onClick={(e) => {
															e.stopPropagation()
															props.onDisconnectConnection(conn)
														}}
													>
														Disconnect
													</button>
												</Show>
												<button
													type="button"
													class="btn sm ghost-btn"
													onClick={(e) => {
														e.stopPropagation()
														props.onEditConnection(conn)
													}}
												>
													Edit
												</button>
												<button
													type="button"
													class="icon-btn ghost"
													style="height:24px;width:24px"
													aria-label={`Delete ${conn.name}`}
													onClick={(e) => {
														e.stopPropagation()
														props.onDeleteConnection(conn)
													}}
												>
													<IconTrash />
												</button>
											</Show>
										</div>
									</div>
								</div>
							)}
						</For>
					</div>
				</Show>
			</Show>

			<Show when={props.recents.length > 0}>
				<div class="section-label">Recently Visited Tables</div>
				<div class="recents-list">
					<For each={props.recents}>
						{(rec) => (
							<div class="recent-row">
								<button
									type="button"
									class="recent-main"
									onClick={() => props.onOpenRecent(rec.connectionId, rec.tableName)}
								>
									<IconTable />
									<span class="mono" style="font-weight:500">
										{rec.tableName}
									</span>
									<span style="color:var(--ink-muted)">in</span>
									<span style="color:var(--ink-secondary)">{rec.connectionName}</span>
									<Show when={rec.isProduction}>
										<span class="tag prod">PROD</span>
									</Show>
									<span style="flex:1" />
									<span class="mono" style="font-size:11px;color:var(--ink-muted)">
										{formatIsoShort(rec.visitedAt)}
									</span>
								</button>
								<button
									type="button"
									class="icon-btn ghost"
									style="height:24px;width:24px"
									aria-label={`Remove ${rec.tableName} from recents`}
									onClick={() => props.onDeleteRecent(rec.connectionId, rec.tableName)}
								>
									<IconTrash />
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	)
}

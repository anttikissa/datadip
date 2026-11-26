// Connections & Recents home screen with add/edit/delete, production badges, and auto-discover wizard launch.
import { For, Show } from 'solid-js'
import { formatIsoShort, formatRelative } from '../lib/format.ts'
import { IconAlert, IconCompass, IconDisk, IconPlus, IconServer, IconTable, IconTrash } from '../lib/icons.tsx'
import type { ConnectionConfig, ConnectionWithStatus, RecentTable } from '../shared/types.ts'

export function HomeView(props: {
	connections: ConnectionWithStatus[]
	recents: RecentTable[]
	onOpenConnection: (connId: string) => void
	onOpenRecent: (connId: string, tableName: string) => void
	onDeleteRecent: (connId: string, tableName: string) => void
	onAddConnection: () => void
	onEditConnection: (conn: ConnectionConfig) => void
	onDeleteConnection: (conn: ConnectionConfig) => void
	onOpenDiscover: () => void
}) {
	return (
		<div class="home-view">
			<div class="home-head">
				<div>
					<h1 class="home-title">Connections</h1>
					<p class="home-sub">
						Connect to local SQLite databases or remote servers over multiplexed SSH. Every database opens in Read-Only
						mode by default.
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

			<Show
				when={props.connections.length > 0}
				fallback={
					<div
						class="empty-state"
						style="border:1px dashed var(--border-strong);background:var(--bg-surface);border-radius:var(--radius)"
					>
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
				<div class="section-label">Saved Databases ({props.connections.length})</div>
				<div class="conn-grid">
					<For each={props.connections}>
						{(conn) => (
							<div
								class={['conn-card', { 'is-prod': conn.isProduction }]}
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
									<span class="conn-card-name">{conn.name}</span>
									<div style="display:flex;align-items:center;gap:5px;flex-shrink:0">
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
									</div>
								</div>

								<div class="conn-card-path">{conn.path}</div>

								<div class="conn-card-foot">
									<span class="mono">
										{conn.lastVisitedAt
											? `Visited ${formatRelative(conn.lastVisitedAt)} (${formatIsoShort(conn.lastVisitedAt).slice(0, 16)}Z)`
											: 'Never opened'}
									</span>
									<div style="display:flex;gap:4px">
										<button
											type="button"
											class="btn sm"
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
									</div>
								</div>
							</div>
						)}
					</For>
				</div>
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
									<span class="mono" style="font-weight:600">
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

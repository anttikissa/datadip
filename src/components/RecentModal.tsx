// Ctrl+R "Open Recent" dialog (WebStorm/IDEA style) listing recent databases/connections and recent tables with fuzzy filtering.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { formatRelative } from '../lib/format.ts'
import { IconAlert, IconDisk, IconSearch, IconServer, IconTable, IconTrash } from '../lib/icons.tsx'
import type { ConnectionWithStatus, RecentTable } from '../shared/types.ts'

type RecentEntry =
	| {
			kind: 'connection'
			id: string
			conn: ConnectionWithStatus
			sortTime: string
	  }
	| {
			kind: 'table'
			id: string
			recent: RecentTable
			sortTime: string
	  }

export function RecentModal(props: {
	open: boolean
	activeConnId: string | null
	connections: ConnectionWithStatus[]
	recents: RecentTable[]
	onClose: () => void
	onOpenConnection: (connId: string) => void
	onOpenTable: (connId: string, tableName: string) => void
	onDeleteRecent: (connId: string, tableName: string) => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	let inputEl: HTMLInputElement | undefined

	const [query, setQuery] = createSignal('')
	const [activeIdx, setActiveIdx] = createSignal(0)

	createEffect(
		() => props.open,
		(open) => {
			if (!dialogEl) return
			if (open) {
				setQuery('')
				setActiveIdx(0)
				if (!dialogEl.open) dialogEl.showModal()
				queueMicrotask(() => inputEl?.focus())
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	const entries = createMemo<RecentEntry[]>(() => {
		const q = query().trim().toLowerCase()

		const sortedConns = [...props.connections].sort((a, b) => {
			// Most recently visited first, then pinned, then alphabetical
			if (a.lastVisitedAt && b.lastVisitedAt) return b.lastVisitedAt.localeCompare(a.lastVisitedAt)
			if (a.lastVisitedAt) return -1
			if (b.lastVisitedAt) return 1
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
			return a.name.localeCompare(b.name)
		})

		const out: RecentEntry[] = []

		for (const conn of sortedConns) {
			if (
				!q ||
				conn.name.toLowerCase().includes(q) ||
				conn.path.toLowerCase().includes(q) ||
				(conn.sshHost ?? '').toLowerCase().includes(q)
			) {
				out.push({
					kind: 'connection',
					id: `conn:${conn.id}`,
					conn,
					sortTime: conn.lastVisitedAt ?? '',
				})
			}
		}

		for (const rec of props.recents) {
			if (!q || rec.tableName.toLowerCase().includes(q) || (rec.connectionName ?? '').toLowerCase().includes(q)) {
				out.push({
					kind: 'table',
					id: `tbl:${rec.connectionId}:${rec.tableName}`,
					recent: rec,
					sortTime: rec.visitedAt,
				})
			}
		}

		return out
	})

	function activate(entry: RecentEntry) {
		if (entry.kind === 'connection') {
			props.onOpenConnection(entry.conn.id)
		} else {
			props.onOpenTable(entry.recent.connectionId, entry.recent.tableName)
		}
		props.onClose()
	}

	function handleKeyDown(e: KeyboardEvent) {
		const list = entries()
		if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
			e.preventDefault()
			setActiveIdx((i) => (list.length === 0 ? 0 : (i + 1) % list.length))
		} else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
			e.preventDefault()
			setActiveIdx((i) => (list.length === 0 ? 0 : (i - 1 + list.length) % list.length))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			const item = list[activeIdx()]
			if (item) activate(item)
		}
	}

	const connCount = createMemo(() => entries().filter((e) => e.kind === 'connection').length)
	const tableCount = createMemo(() => entries().filter((e) => e.kind === 'table').length)

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="omnibar-dialog"
			aria-label="Open Recent Databases and Tables"
			onCancel={(e) => {
				e.preventDefault()
				props.onClose()
			}}
			onClick={(e) => {
				if (e.target === dialogEl) props.onClose()
			}}
		>
			<div class="omnibar-input-row">
				<IconSearch />
				<input
					ref={(el) => (inputEl = el)}
					class="omnibar-input"
					placeholder="Open recent database, connection, or table…"
					value={query()}
					onInput={(e) => {
						setQuery(e.currentTarget.value)
						setActiveIdx(0)
					}}
					onKeyDown={handleKeyDown}
				/>
				<span class="kbd">⌃R</span>
				<span class="kbd">ESC</span>
			</div>

			<div class="omnibar-list">
				<Show when={entries().length === 0}>
					<div class="empty-state" style="padding:20px">
						No matching recent databases or tables.
					</div>
				</Show>

				<For each={entries()}>
					{(entry, idx) => (
						<>
							<Show when={idx() === 0 && connCount() > 0}>
								<div class="sidebar-section-head" style="padding:4px 10px">
									<span>Databases &amp; Connections ({connCount()})</span>
								</div>
							</Show>
							<Show when={idx() === connCount() && tableCount() > 0}>
								<div class="sidebar-section-head" style="padding:8px 10px 4px">
									<span>Recent Tables ({tableCount()})</span>
								</div>
							</Show>

							<Show
								when={entry.kind === 'connection'}
								fallback={(() => {
									const rec = (entry as Extract<RecentEntry, { kind: 'table' }>).recent
									return (
										<div
											class={['omnibar-item', { active: activeIdx() === idx() }]}
											role="option"
											aria-selected={activeIdx() === idx() ? 'true' : 'false'}
											onMouseEnter={() => setActiveIdx(idx())}
											onClick={() => activate(entry)}
										>
											<span style="display:flex;align-items:center;gap:8px;min-width:0">
												<IconTable />
												<span class="mono" style="font-weight:600">
													{rec.tableName}
												</span>
												<span style="color:var(--ink-muted);font-size:12px">in {rec.connectionName}</span>
												<Show when={rec.isProduction}>
													<span class="tag prod">PROD</span>
												</Show>
											</span>
											<span style="display:inline-flex;align-items:center;gap:8px;flex-shrink:0">
												<span class="mono" style="font-size:11px;color:var(--ink-muted)">
													{formatRelative(rec.visitedAt)}
												</span>
												<button
													type="button"
													class="icon-btn ghost"
													style="width:22px;height:22px"
													aria-label={`Remove ${rec.tableName} from recents`}
													onClick={(e) => {
														e.stopPropagation()
														props.onDeleteRecent(rec.connectionId, rec.tableName)
													}}
												>
													<IconTrash />
												</button>
											</span>
										</div>
									)
								})()}
							>
								{(() => {
									const c = (entry as Extract<RecentEntry, { kind: 'connection' }>).conn
									const isCurrent = () => c.id === props.activeConnId
									return (
										<button
											type="button"
											class={['omnibar-item', { active: activeIdx() === idx() }]}
											onMouseEnter={() => setActiveIdx(idx())}
											onClick={() => activate(entry)}
										>
											<span style="display:flex;align-items:center;gap:8px;min-width:0">
												{c.location === 'ssh' ? <IconServer /> : <IconDisk />}
												<span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
													{c.name}
												</span>
												<Show when={c.isProduction}>
													<span class="tag prod">
														<IconAlert />
														PROD
													</span>
												</Show>
												<Show when={c.orphaned}>
													<span
														class="tag"
														style="border-color:var(--rw-border);color:var(--rw);background:var(--rw-bg)"
													>
														ORPHANED
													</span>
												</Show>
												<Show when={isCurrent()}>
													<span class="tag">CURRENT</span>
												</Show>
											</span>
											<span
												class="mono"
												style="font-size:11px;color:var(--ink-muted);max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
											>
												{c.lastVisitedAt ? formatRelative(c.lastVisitedAt) : c.path}
											</span>
										</button>
									)
								})()}
							</Show>
						</>
					)}
				</For>
			</div>
		</dialog>
	)
}

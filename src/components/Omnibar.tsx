// Cmd+K / Cmd+P Omnibar for jumping to tables, columns, consoles, connections, actions, or searching an ID across tables.
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import { formatCellText, formatRowCount } from '../lib/format.ts'
import { IconSearch } from '../lib/icons.tsx'
import type { ConnectionWithStatus, Console, DatabaseSchema, IdMatch } from '../shared/types.ts'
import { maskConnectionPath } from '../shared/url.ts'

interface OmniItem {
	id: string
	kind: string
	label: string
	detail: string
	run: () => void
}

export function Omnibar(props: {
	open: boolean
	activeConnId: string | null
	connections: ConnectionWithStatus[]
	schema: DatabaseSchema | null
	consoles: Console[]
	onClose: () => void
	onSelectConnection: (connId: string) => void
	onSelectTable: (connId: string, table: string, filter?: { column: string; value: string }) => void
	onSelectConsole: (connId: string, consoleId: string) => void
	onNewConsole: () => void
	onOpenErDiagram?: () => void
	onOpenDbInfo?: () => void
	onCopyTeammateLink?: () => void
	onOpenChangelog?: () => void
	canToggleRw?: boolean
	onToggleTheme: () => void
	onToggleRw: () => void
	onOpenDiscover: () => void
}) {
	let dialogEl: HTMLDialogElement | undefined
	let inputEl: HTMLInputElement | undefined

	const [query, setQuery] = createSignal('')
	const [activeIdx, setActiveIdx] = createSignal(0)
	const [idMatches, setIdMatches] = createSignal<IdMatch[]>([])
	const [searchingId, setSearchingId] = createSignal(false)

	createEffect(
		() => props.open,
		(open) => {
			if (!dialogEl) return
			if (open) {
				setQuery('')
				setActiveIdx(0)
				setIdMatches([])
				if (!dialogEl.open) dialogEl.showModal()
				queueMicrotask(() => inputEl?.focus())
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	const items = createMemo<OmniItem[]>(() => {
		const q = query().trim().toLowerCase()
		const list: OmniItem[] = []
		const connId = props.activeConnId

		// Cross-table ID matches come first when present
		if (connId) {
			for (const m of idMatches()) {
				const preview = Object.entries(m.row)
					.slice(0, 3)
					.map(([k, v]) => `${k}=${formatCellText(v)}`)
					.join(', ')
				list.push({
					id: `id:${m.table}:${m.column}`,
					kind: m.isPrimaryKey ? 'PK MATCH' : 'FK MATCH',
					label: `${m.table}.${m.column} = ${query().trim()}`,
					detail: preview,
					run: () => {
						props.onSelectTable(connId, m.table, { column: m.column, value: query().trim() })
						props.onClose()
					},
				})
			}
		}

		// Tables & views
		if (connId && props.schema) {
			for (const t of props.schema.tables) {
				if (!q || t.name.toLowerCase().includes(q)) {
					list.push({
						id: `t:${t.name}`,
						kind: t.type === 'view' ? 'VIEW' : 'TABLE',
						label: t.name,
						detail: t.rowCount !== null ? `${formatRowCount(t.rowCount, t.rowCountEstimated)} rows` : '',
						run: () => {
							props.onSelectTable(connId, t.name)
							props.onClose()
						},
					})
				}
			}

			// Matching columns when user typed at least 2 chars
			if (q.length >= 2) {
				for (const ts of Object.values(props.schema.schemas)) {
					for (const col of ts.columns) {
						if (col.name.toLowerCase().includes(q)) {
							list.push({
								id: `col:${ts.name}.${col.name}`,
								kind: 'COLUMN',
								label: `${ts.name}.${col.name}`,
								detail: col.type,
								run: () => {
									props.onSelectTable(connId, ts.name)
									props.onClose()
								},
							})
						}
					}
				}
			}

			// Consoles
			for (const sqlConsole of props.consoles) {
				if (!q || sqlConsole.title.toLowerCase().includes(q) || sqlConsole.sql.toLowerCase().includes(q)) {
					list.push({
						id: `sqlConsole:${sqlConsole.id}`,
						kind: 'CONSOLE',
						label: sqlConsole.title,
						detail: sqlConsole.sql.trim().slice(0, 50),
						run: () => {
							props.onSelectConsole(connId, sqlConsole.id)
							props.onClose()
						},
					})
				}
			}
		}

		// Connections
		for (const c of props.connections) {
			const displayPath = maskConnectionPath(c.path)
			const matchesGroup = c.group?.toLowerCase().includes(q) ?? false
			const matchesTag = c.tags?.some((t) => t.toLowerCase().includes(q)) ?? false
			if (
				!q ||
				c.name.toLowerCase().includes(q) ||
				displayPath.toLowerCase().includes(q) ||
				matchesGroup ||
				matchesTag
			) {
				const tagText = c.tags?.length ? ` · ${c.tags.map((t) => `#${t}`).join(' ')}` : ''
				list.push({
					id: `c:${c.id}`,
					kind: c.isProduction ? 'PROD DB' : 'DB',
					label: c.group ? `${c.group} / ${c.name}` : c.name,
					detail: (c.location === 'ssh' ? `${c.sshHost}:${displayPath}` : displayPath) + tagText,
					run: () => {
						props.onSelectConnection(c.id)
						props.onClose()
					},
				})
			}
		}

		// Quick actions
		const actions: OmniItem[] = [
			...(connId
				? [
						{
							id: 'act:new-sql',
							kind: 'ACTION',
							label: 'New SQL Console',
							detail: 'Open fresh query console',
							run: () => {
								props.onNewConsole()
								props.onClose()
							},
						},
						...(props.onOpenErDiagram
							? [
									{
										id: 'act:er',
										kind: 'ACTION',
										label: 'Open Schema / ER Diagram',
										detail: 'Visual table & foreign-key graph',
										run: () => {
											props.onOpenErDiagram?.()
											props.onClose()
										},
									},
								]
							: []),
						...(props.onOpenDbInfo
							? [
									{
										id: 'act:info',
										kind: 'ACTION',
										label: 'Database Info & PRAGMA / WAL Inspector',
										detail: 'Version, sizes, user_version, checkpoint',
										run: () => {
											props.onOpenDbInfo?.()
											props.onClose()
										},
									},
								]
							: []),
						...(props.onCopyTeammateLink
							? [
									{
										id: 'act:share-link',
										kind: 'ACTION',
										label: 'Copy Link for Teammate (by DB name)',
										detail: 'Shareable slug URL',
										run: () => {
											props.onCopyTeammateLink?.()
											props.onClose()
										},
									},
								]
							: []),
						...(props.canToggleRw !== false
							? [
									{
										id: 'act:toggle-rw',
										kind: 'ACTION',
										label: 'Toggle Read-Only / Read-Write Mode',
										detail: 'Safety switch',
										run: () => {
											props.onToggleRw()
											props.onClose()
										},
									},
								]
							: []),
					]
				: []),
			{
				id: 'act:discover',
				kind: 'ACTION',
				label: 'Auto-Discover SQLite Databases',
				detail: 'Scan local, iOS Simulators, or SSH host',
				run: () => {
					props.onOpenDiscover()
					props.onClose()
				},
			},
			...(props.onOpenChangelog
				? [
						{
							id: 'act:changelog',
							kind: 'ACTION',
							label: "What's New / Changelog",
							detail: 'View release notes & new features',
							run: () => {
								props.onOpenChangelog?.()
								props.onClose()
							},
						},
					]
				: []),
			{
				id: 'act:theme',
				kind: 'ACTION',
				label: 'Toggle Light / Dark Theme',
				detail: 'Appearance',
				run: () => {
					props.onToggleTheme()
					props.onClose()
				},
			},
		]
		for (const a of actions) {
			if (!q || a.label.toLowerCase().includes(q) || a.detail.toLowerCase().includes(q)) {
				list.push(a)
			}
		}

		return list.slice(0, 40)
	})

	async function searchAcrossTables() {
		if (!props.activeConnId || !query().trim()) return
		setSearchingId(true)
		try {
			const res = await api.searchId(props.activeConnId, query().trim())
			setIdMatches(res.matches)
			setActiveIdx(0)
		} catch {
			setIdMatches([])
		} finally {
			setSearchingId(false)
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		const list = items()
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setActiveIdx((i) => Math.min(Math.max(0, list.length - 1), i + 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setActiveIdx((i) => Math.max(0, i - 1))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			const item = list[activeIdx()]
			if (item) item.run()
			else if (props.activeConnId && query().trim()) void searchAcrossTables()
		}
	}

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="omnibar-dialog"
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
					placeholder="Jump to table, column, console, connection, or paste an ID…"
					value={query()}
					onInput={(e) => {
						setQuery(e.currentTarget.value)
						setActiveIdx(0)
						setIdMatches([])
					}}
					onKeyDown={handleKeyDown}
				/>
				<Show when={props.activeConnId && query().trim().length >= 1}>
					<button class="btn sm" type="button" disabled={searchingId()} onClick={searchAcrossTables}>
						{searchingId() ? 'Finding…' : 'Find ID in DB'}
					</button>
				</Show>
				<span class="kbd">ESC</span>
			</div>
			<div class="omnibar-list">
				<Show when={items().length === 0}>
					<div class="empty-state" style="padding:20px">
						No direct matches.{' '}
						<Show when={props.activeConnId}>
							Press <strong>Find ID in DB</strong> to search primary &amp; foreign keys across all tables.
						</Show>
					</div>
				</Show>
				<For each={items()}>
					{(item, idx) => (
						<button
							type="button"
							class={['omnibar-item', { active: activeIdx() === idx() }]}
							onMouseEnter={() => setActiveIdx(idx())}
							onClick={() => item.run()}
						>
							<span style="display:flex;align-items:center;gap:8px;min-width:0">
								<span class={['tag', { prod: item.kind === 'PROD DB' }]}>{item.kind}</span>
								<span class="mono" style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
									{item.label}
								</span>
							</span>
							<span
								class="mono"
								style="font-size:11px;color:var(--ink-muted);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
							>
								{item.detail}
							</span>
						</button>
					)}
				</For>
			</div>
		</dialog>
	)
}

// URL-driven Table Browser (data grid, FK click & hover peek, filters, column picker, multi-sort, staged inline edits, schema view).
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import { api } from '../lib/api.ts'
import {
	copyToClipboard,
	exportRowsCsv,
	exportRowsJson,
	exportRowsSqlInsert,
	exportRowsTsv,
	formatCellText,
} from '../lib/format.ts'
import {
	IconArrowRight,
	IconClose,
	IconColumns,
	IconCopy,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconSql,
} from '../lib/icons.tsx'
import { hasTextSelection, isEditableTarget, isNativeApp, isPrimaryMod, modKeyLabel } from '../lib/shortcuts.ts'
import type {
	BrowseResult,
	FilterOp,
	FilterSpec,
	ForeignKeyInfo,
	OrderSpec,
	PendingUpdate,
	TableSchema,
} from '../shared/types.ts'
import type { AppRoute } from '../shared/url.ts'
import type { ConfirmState } from './ConfirmDialog.tsx'
import { CellViewer, type CellViewerState } from './CellViewer.tsx'
import { FkPeekCard, type FkPeekState } from './FkPeekCard.tsx'
import { RowInspector } from './RowInspector.tsx'

type TableRoute = Extract<AppRoute, { kind: 'table' }>

const FILTER_OPS: { value: FilterOp; label: string }[] = [
	{ value: 'eq', label: '=' },
	{ value: 'neq', label: '!=' },
	{ value: 'like', label: 'LIKE' },
	{ value: 'gt', label: '>' },
	{ value: 'gte', label: '>=' },
	{ value: 'lt', label: '<' },
	{ value: 'lte', label: '<=' },
	{ value: 'in', label: 'IN' },
	{ value: 'isnull', label: 'IS NULL' },
	{ value: 'notnull', label: 'NOT NULL' },
]

export function TableView(props: {
	route: TableRoute
	tableSchema: TableSchema | null
	rwArmed: boolean
	reconnectTick?: number
	dbChangeTick?: number
	isLocalSqlite?: boolean
	onNavigate: (next: TableRoute, options?: { replace?: boolean; trailLabel?: string }) => void
	onOpenInSql: (sql: string) => void
	onRequestConfirm: (state: ConfirmState) => void
	onRequestArmRw?: () => void
	onNotify: (msg: string, kind?: 'info' | 'ok' | 'error') => void
	onSchemaChanged: () => void
}) {
	const [data, setData] = createSignal<BrowseResult | null>(null)
	const [loading, setLoading] = createSignal(false)
	const [error, setError] = createSignal<string | null>(null)
	const [reloadTick, setReloadTick] = createSignal(0)

	// UI state
	const [showSql, setShowSql] = createSignal(false)
	const [showColPicker, setShowColPicker] = createSignal(false)
	const [showExport, setShowExport] = createSignal(false)
	const [showAddFilter, setShowAddFilter] = createSignal(false)
	const [searchDraft, setSearchDraft] = createSignal('')
	const [filterCol, setFilterCol] = createSignal('')
	const [filterOp, setFilterOp] = createSignal<FilterOp>('eq')
	const [filterVal, setFilterVal] = createSignal('')

	// Cell cursor, inspector, cell viewer, wrap, column resize, and hover preview
	const [activeCell, setActiveCell] = createSignal<{ row: number; col: number } | null>(null)
	const [inspectorRowIdx, setInspectorRowIdx] = createSignal<number | null>(null)
	const [cellViewer, setCellViewer] = createSignal<CellViewerState | null>(null)
	const [wrapRows, setWrapRows] = createSignal(false)
	const [freezeFirst, setFreezeFirst] = createSignal(false)
	const [liveWatch, setLiveWatch] = createSignal(true)
	const [colWidths, setColWidths] = createSignal<Record<string, number>>({})
	const [hoverPeek, setHoverPeek] = createSignal<{
		x: number
		y: number
		colName: string
		text: string
		truncated: boolean
	} | null>(null)
	let hoverTimer: ReturnType<typeof setTimeout> | null = null
	let gridScrollEl: HTMLDivElement | undefined

	// Staged inline edits: rowKey -> { pk, changes }
	const [staged, setStaged] = createSignal<Map<string, PendingUpdate>>(new Map())
	const [editingCell, setEditingCell] = createSignal<{ row: number; colName: string; draft: string } | null>(null)

	// Insert row modal
	const [insertOpen, setInsertOpen] = createSignal(false)
	const [insertDraft, setInsertDraft] = createSignal<Record<string, string>>({})
	let insertDialogEl: HTMLDialogElement | undefined
	let searchInputEl: HTMLInputElement | undefined

	// FK hover peek
	const [peek, setPeek] = createSignal<FkPeekState | null>(null)
	const peekCache = new Map<string, Record<string, unknown> | null>()
	let peekTimer: ReturnType<typeof setTimeout> | null = null

	const fkByCol = createMemo(() => {
		const map = new Map<string, ForeignKeyInfo>()
		for (const fk of props.tableSchema?.foreignKeys ?? []) {
			map.set(fk.fromColumn, fk)
		}
		return map
	})

	const pkCols = createMemo(() => props.tableSchema?.primaryKeyColumns ?? [])

	function rowPk(row: Record<string, unknown>): Record<string, unknown> | null {
		const pks = pkCols()
		if (pks.length === 0) return null
		const out: Record<string, unknown> = {}
		for (const c of pks) out[c] = row[c]
		return out
	}

	function rowKey(row: Record<string, unknown>, idx: number): string {
		const pk = rowPk(row)
		return pk ? JSON.stringify(pk) : `__idx_${idx}`
	}

	// Sync search input with URL route
	createEffect(
		() => props.route.search,
		(s) => {
			setSearchDraft(s)
		},
	)

	// Sync insert dialog element
	createEffect(
		() => insertOpen(),
		(open) => {
			if (!insertDialogEl) return
			if (open && !insertDialogEl.open) insertDialogEl.showModal()
			else if (!open && insertDialogEl.open) insertDialogEl.close()
		},
	)

	// Fetch table rows whenever URL browse state changes
	createEffect(
		() =>
			[
				props.route.connId,
				props.route.table,
				props.route.tab,
				props.route.fields.join(','),
				JSON.stringify(props.route.filters),
				JSON.stringify(props.route.order),
				props.route.limit,
				props.route.start,
				props.route.direction,
				props.route.offset,
				props.route.search,
				reloadTick(),
				props.reconnectTick ?? 0,
			] as const,
		([connId, table, tab]) => {
			if (tab !== 'data') return
			let cancelled = false
			setLoading(true)
			setError(null)
			setEditingCell(null)
			setCellViewer(null)
			setPeek(null)
			setHoverPeek(null)

			api
				.browseTable(connId, {
					table,
					fields: props.route.fields.length > 0 ? props.route.fields : undefined,
					filters: props.route.filters,
					order: props.route.order,
					limit: props.route.limit,
					start: props.route.start ?? undefined,
					direction: props.route.direction,
					offset: props.route.offset ?? undefined,
					search: props.route.search || undefined,
				})
				.then((res) => {
					if (cancelled) return
					setData(res)
					setActiveCell((prev) => {
						if (res.rows.length === 0 || res.columns.length === 0) return null
						if (!prev) return { row: 0, col: 0 }
						return {
							row: Math.min(prev.row, res.rows.length - 1),
							col: Math.min(prev.col, res.columns.length - 1),
						}
					})
					setInspectorRowIdx((prev) => (prev !== null && prev < res.rows.length ? prev : null))
				})
				.catch((err) => {
					if (cancelled) return
					setError(err instanceof Error ? err.message : String(err))
				})
				.finally(() => {
					if (!cancelled) setLoading(false)
				})

			return () => {
				cancelled = true
			}
		},
	)

	// Auto-refresh when the local SQLite .db/-wal file changes externally (only when no unsaved edits/editors are active).
	createEffect(
		() => props.dbChangeTick ?? 0,
		(tick) => {
			if (!tick || !props.isLocalSqlite || !liveWatch()) return
			if (props.route.tab !== 'data') return
			if (stagedCount() > 0 || editingCell() || insertOpen()) return
			setReloadTick((n) => n + 1)
		},
	)

	// Clear staged edits, active cursor, and custom column widths when switching tables
	createEffect(
		() => [props.route.connId, props.route.table] as const,
		() => {
			setStaged(new Map())
			setEditingCell(null)
			setCellViewer(null)
			setActiveCell(null)
			setInspectorRowIdx(null)
			setColWidths({})
			peekCache.clear()
		},
	)

	function scrollActiveCellIntoView(row: number, col: number) {
		gridScrollEl
			?.querySelector<HTMLElement>(`td[data-r="${row}"][data-c="${col}"]`)
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}

	function copyActiveCell(e?: ClipboardEvent) {
		const res = data()
		const cur = activeCell()
		if (!res || !cur) return
		const colName = res.columns[cur.col]
		const row = res.rows[cur.row]
		if (!colName || !row) return
		const text = formatCellText(getEffectiveValue(row, cur.row, colName))
		if (e?.clipboardData) {
			e.preventDefault()
			e.clipboardData.setData('text/plain', text)
			props.onNotify(`Copied ${colName}`)
			return
		}
		void copyToClipboard(text).then((ok) => {
			if (ok) props.onNotify(`Copied ${colName}`)
		})
	}

	function copyActiveRowTsv() {
		const res = data()
		const cur = activeCell()
		if (!res || !cur) return
		const row = res.rows[cur.row]
		if (!row) return
		const effectiveRow: Record<string, unknown> = {}
		for (const c of res.columns) effectiveRow[c] = getEffectiveValue(row, cur.row, c)
		void copyToClipboard(exportRowsTsv(res.columns, [effectiveRow])).then((ok) => {
			if (ok) props.onNotify(`Copied row ${cur.row + 1} with headers (TSV)`)
		})
	}

	// Keyboard navigation, copy, refresh, and view switching inside TableView
	onSettled(() => {
		const onRefresh = () => {
			setReloadTick((n) => n + 1)
		}

		const onCopy = (e: ClipboardEvent) => {
			if (props.route.tab !== 'data') return
			if (isEditableTarget(e.target) || document.querySelector('dialog[open]') || cellViewer()) return
			if (hasTextSelection(e.target)) return
			copyActiveCell(e)
		}

		const onKey = (e: KeyboardEvent) => {
			if (document.querySelector('dialog[open]')) return
			const key = e.key.toLowerCase()
			const primaryMod = isPrimaryMod(e)
			const target = e.target as HTMLElement | null

			// Cmd+S commits staged inline edits (and prevents browser Save Page)
			if (primaryMod && !e.altKey && !e.shiftKey && key === 's') {
				e.preventDefault()
				if (editingCell()) commitCellDraft(false)
				if (stagedCount() > 0) void commitStagedEdits()
				return
			}

			// Cmd+1 / Cmd+2 switches between Data and Schema tabs
			if (primaryMod && !e.altKey && !e.shiftKey && (e.key === '1' || e.key === '2') && !isEditableTarget(target)) {
				e.preventDefault()
				updateRoute({ tab: e.key === '1' ? 'data' : 'schema' }, false)
				return
			}

			// Cmd+F focuses quick-search input on Data tab (when not in CodeMirror, CellViewer, or inline cell editor)
			if (
				props.route.tab === 'data' &&
				primaryMod &&
				!e.altKey &&
				!e.shiftKey &&
				key === 'f' &&
				!cellViewer() &&
				!editingCell() &&
				!target?.closest('.cm-editor')
			) {
				e.preventDefault()
				searchInputEl?.focus()
				searchInputEl?.select()
				return
			}

			if (isEditableTarget(target)) return

			// Bare `r` refreshes table rows & schema
			if (key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
				e.preventDefault()
				if (props.route.tab === 'data') setReloadTick((n) => n + 1)
				props.onSchemaChanged()
				return
			}

			if (props.route.tab !== 'data' || cellViewer()) return

			const res = data()
			if (!res) return

			if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault()
				searchInputEl?.focus()
				return
			}
			if (key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
				e.preventDefault()
				setShowColPicker((v) => !v)
				return
			}

			const cur = activeCell()
			if (!cur || res.rows.length === 0) return

			// Consistent FK-follow shortcut in both Read-Only and Read-Write modes
			if (primaryMod && !e.altKey && !e.shiftKey && (e.key === 'Enter' || e.key === 'ArrowDown')) {
				const colName = res.columns[cur.col]
				const row = res.rows[cur.row]
				if (colName && row) {
					const fk = fkByCol().get(colName)
					const val = getEffectiveValue(row, cur.row, colName)
					if (fk && val !== null && val !== undefined) {
						e.preventDefault()
						followFk(fk.toTable, fk.toColumn, val)
						return
					}
				}
			}

			// Cmd+Shift+C copies focused row with column headers as TSV
			if (primaryMod && e.shiftKey && !e.altKey && key === 'c') {
				e.preventDefault()
				copyActiveRowTsv()
				return
			}

			// Cmd+C copies focused cell value when there is no active text selection
			if (primaryMod && !e.shiftKey && !e.altKey && key === 'c') {
				if (!hasTextSelection(target)) {
					e.preventDefault()
					copyActiveCell()
				}
				return
			}

			const noMods = !e.metaKey && !e.ctrlKey && !e.altKey
			if (noMods && (e.key === 'ArrowDown' || e.key === 'j')) {
				e.preventDefault()
				const next = { row: Math.min(res.rows.length - 1, cur.row + 1), col: cur.col }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && (e.key === 'ArrowUp' || e.key === 'k')) {
				e.preventDefault()
				const next = { row: Math.max(0, cur.row - 1), col: cur.col }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && (e.key === 'ArrowRight' || e.key === 'l')) {
				e.preventDefault()
				const next = { row: cur.row, col: Math.min(res.columns.length - 1, cur.col + 1) }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && (e.key === 'ArrowLeft' || e.key === 'h')) {
				e.preventDefault()
				const next = { row: cur.row, col: Math.max(0, cur.col - 1) }
				setActiveCell(next)
				scrollActiveCellIntoView(next.row, next.col)
			} else if (noMods && e.key === ' ') {
				e.preventDefault()
				setInspectorRowIdx((prev) => (prev === cur.row ? null : cur.row))
			} else if (noMods && !e.shiftKey && key === 'c') {
				copyActiveCell()
			} else if (noMods && e.key === 'Enter') {
				const colName = res.columns[cur.col]
				const row = res.rows[cur.row]
				if (!colName || !row) return
				const fk = fkByCol().get(colName)
				const val = getEffectiveValue(row, cur.row, colName)
				if (!props.rwArmed && fk && val !== null && val !== undefined) {
					e.preventDefault()
					followFk(fk.toTable, fk.toColumn, val)
				} else {
					e.preventDefault()
					const td = gridScrollEl?.querySelector<HTMLElement>(`td[data-r="${cur.row}"][data-c="${cur.col}"]`)
					openCellAction(cur.row, colName, val, td ?? undefined)
				}
			} else if (e.key === 'Escape') {
				setCellViewer(null)
				setInspectorRowIdx(null)
				setShowColPicker(false)
				setShowExport(false)
				setShowAddFilter(false)
			}
		}

		window.addEventListener('datadip:refresh', onRefresh)
		window.addEventListener('copy', onCopy)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('datadip:refresh', onRefresh)
			window.removeEventListener('copy', onCopy)
			window.removeEventListener('keydown', onKey)
		}
	})

	function updateRoute(patch: Partial<TableRoute>, resetPage = true) {
		const next: TableRoute = {
			...props.route,
			...patch,
			...(resetPage ? { start: null, direction: 'next' as const, offset: null } : {}),
		}
		props.onNavigate(next)
	}

	function followFk(targetTable: string, targetColumn: string, value: unknown) {
		setPeek(null)
		props.onNavigate(
			{
				kind: 'table',
				connId: props.route.connId,
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

	function handleSortClick(colName: string, shiftKey: boolean) {
		const existing = props.route.order
		const found = existing.find((o) => o.column === colName)
		let nextOrder: OrderSpec[]
		if (shiftKey) {
			if (!found) nextOrder = [...existing, { column: colName, dir: 'asc' }]
			else if (found.dir === 'asc')
				nextOrder = existing.map((o) => (o.column === colName ? { ...o, dir: 'desc' as const } : o))
			else nextOrder = existing.filter((o) => o.column !== colName)
		} else {
			if (!found) nextOrder = [{ column: colName, dir: 'asc' }]
			else if (found.dir === 'asc') nextOrder = [{ column: colName, dir: 'desc' }]
			else nextOrder = []
		}
		updateRoute({ order: nextOrder })
	}

	function addFilter() {
		const col = filterCol() || props.tableSchema?.columns[0]?.name || ''
		if (!col) return
		const op = filterOp()
		const val = filterVal().trim()
		if (op !== 'isnull' && op !== 'notnull' && !val) return
		updateRoute({ filters: [...props.route.filters, { column: col, op, value: val }] })
		setFilterVal('')
		setShowAddFilter(false)
	}

	function removeFilter(index: number) {
		updateRoute({ filters: props.route.filters.filter((_, i) => i !== index) })
	}

	function toggleField(colName: string) {
		const allCols = props.tableSchema?.columns.map((c) => c.name) ?? []
		const current = props.route.fields.length > 0 ? [...props.route.fields] : [...allCols]
		const idx = current.indexOf(colName)
		if (idx >= 0) {
			if (current.length <= 1) return
			current.splice(idx, 1)
		} else {
			current.push(colName)
		}
		const sameAsAll = current.length === allCols.length && allCols.every((c) => current.includes(c))
		updateRoute({ fields: sameAsAll ? [] : current }, false)
	}

	function getEffectiveValue(row: Record<string, unknown>, idx: number, colName: string): unknown {
		const entry = staged().get(rowKey(row, idx))
		if (entry && colName in entry.changes) return entry.changes[colName]
		return row[colName]
	}

	function isCellDirty(row: Record<string, unknown>, idx: number, colName: string): boolean {
		const entry = staged().get(rowKey(row, idx))
		return Boolean(entry && colName in entry.changes)
	}

	function anchorFromEl(el?: HTMLElement) {
		if (el) {
			const r = el.getBoundingClientRect()
			return { left: r.left, top: r.top, bottom: r.bottom, right: r.right }
		}
		return {
			left: Math.round(window.innerWidth / 2 - 240),
			top: 180,
			bottom: 210,
			right: Math.round(window.innerWidth / 2 + 240),
		}
	}

	function canEditTable(): boolean {
		return props.tableSchema?.type === 'table' && pkCols().length > 0
	}

	function openCellAction(rowIdx: number, colName: string, currentVal: unknown, el?: HTMLElement) {
		cancelHoverPeek()
		const colType = data()?.columnTypes[colName] ?? ''
		const text = currentVal === null || currentVal === undefined ? '' : String(currentVal)
		// In Read-Only mode (or on views / tables without PK), double-click opens the Cell Viewer instead of erroring.
		if (!props.rwArmed || !canEditTable()) {
			setCellViewer({
				rowIdx,
				colName,
				colType,
				value: currentVal,
				mode: 'view',
				anchor: anchorFromEl(el),
			})
			return
		}
		// In Read-Write mode, use the multi-line popover editor for long or multi-line values; inline input for short values.
		if (text.length > 80 || text.includes('\n')) {
			setCellViewer({
				rowIdx,
				colName,
				colType,
				value: currentVal,
				mode: 'edit',
				anchor: anchorFromEl(el),
			})
			return
		}
		setEditingCell({ row: rowIdx, colName, draft: text })
	}

	function stageCellValue(rowIdx: number, colName: string, draft: string, setNull: boolean) {
		const res = data()
		if (!res) return
		const row = res.rows[rowIdx]
		if (!row) return
		const pk = rowPk(row)
		if (!pk) return

		const orig = row[colName]
		const colType = (res.columnTypes[colName] ?? '').toUpperCase()
		let nextVal: unknown = setNull ? null : draft
		if (!setNull && draft !== '' && (colType.includes('INT') || colType.includes('REAL') || colType.includes('NUM'))) {
			if (/^-?\d+(\.\d+)?$/.test(draft.trim())) nextVal = Number(draft.trim())
		}

		const nextMap = new Map(staged())
		const key = rowKey(row, rowIdx)
		const existing = nextMap.get(key) ?? { pk, changes: {} }
		const changes = { ...existing.changes }
		if (nextVal === orig || (nextVal === null && orig === null)) {
			delete changes[colName]
		} else {
			changes[colName] = nextVal
		}
		if (Object.keys(changes).length === 0) nextMap.delete(key)
		else nextMap.set(key, { pk, changes })

		setStaged(nextMap)
		setEditingCell(null)
		setCellViewer(null)
	}

	function commitCellDraft(setNull = false) {
		const ed = editingCell()
		if (!ed) return
		stageCellValue(ed.row, ed.colName, ed.draft, setNull)
	}

	function startColResize(e: MouseEvent, colName: string) {
		e.preventDefault()
		e.stopPropagation()
		const th = (e.currentTarget as HTMLElement).parentElement
		if (!th) return
		const startX = e.clientX
		const startW = th.getBoundingClientRect().width
		const onMove = (ev: MouseEvent) => {
			const nextW = Math.max(64, Math.min(1400, Math.round(startW + (ev.clientX - startX))))
			setColWidths((prev) => ({ ...prev, [colName]: nextW }))
		}
		const onUp = () => {
			window.removeEventListener('mousemove', onMove)
			window.removeEventListener('mouseup', onUp)
		}
		window.addEventListener('mousemove', onMove)
		window.addEventListener('mouseup', onUp)
	}

	function autoFitColumn(e: MouseEvent, colName: string) {
		e.preventDefault()
		e.stopPropagation()
		const res = data()
		if (!res) return
		// Approximate monospace char width (~7.4px at 12px) plus padding, capped at 720px.
		let maxChars = colName.length + 6
		for (const row of res.rows) {
			const firstLine = formatCellText(row[colName]).split('\n')[0] ?? ''
			if (firstLine.length > maxChars) maxChars = firstLine.length
		}
		const fitted = Math.max(96, Math.min(720, Math.round(maxChars * 7.6 + 28)))
		setColWidths((prev) => ({ ...prev, [colName]: fitted }))
	}

	function colWidthStyle(colName: string): string | undefined {
		const w = colWidths()[colName]
		return w ? `width:${w}px;min-width:${w}px;max-width:${w}px` : undefined
	}

	function startHoverPeek(e: MouseEvent, colName: string, value: unknown) {
		if (wrapRows() || cellViewer() || editingCell()) return
		if (value === null || value === undefined) return
		const td = e.currentTarget as HTMLElement
		if (td.scrollWidth <= td.clientWidth + 1) return
		if (hoverTimer) clearTimeout(hoverTimer)
		const x = e.clientX
		const y = e.clientY
		const full = formatCellText(value)
		hoverTimer = setTimeout(() => {
			setHoverPeek({
				x,
				y,
				colName,
				text: full.length > 600 ? full.slice(0, 600) + '…' : full,
				truncated: full.length > 600,
			})
		}, 320)
	}

	function cancelHoverPeek() {
		if (hoverTimer) clearTimeout(hoverTimer)
		hoverTimer = null
		setHoverPeek(null)
	}

	function buildPendingSqlPreview(): string[] {
		const q = (s: string) => `"${s.replaceAll('"', '""')}"`
		const lit = (v: unknown) =>
			v === null || v === undefined
				? 'NULL'
				: typeof v === 'number'
					? String(v)
					: `'${String(v).replaceAll("'", "''")}'`
		const out: string[] = []
		for (const upd of staged().values()) {
			const sets = Object.entries(upd.changes)
				.map(([c, v]) => `${q(c)} = ${lit(v)}`)
				.join(', ')
			const wheres = Object.entries(upd.pk)
				.map(([c, v]) => (v === null ? `${q(c)} IS NULL` : `${q(c)} = ${lit(v)}`))
				.join(' AND ')
			out.push(`UPDATE ${q(props.route.table)} SET ${sets} WHERE ${wheres};`)
		}
		return out
	}

	async function commitStagedEdits() {
		const updates = Array.from(staged().values())
		if (updates.length === 0) return
		try {
			const res = await api.mutateTable(props.route.connId, {
				table: props.route.table,
				updates,
			})
			setStaged(new Map())
			setReloadTick((n) => n + 1)
			props.onNotify(`Committed ${res.applied} update(s) in ${res.durationMs} ms`, 'ok')
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	function requestDeleteRow(row: Record<string, unknown>) {
		const pk = rowPk(row)
		if (!pk) {
			props.onNotify('Cannot delete row without a primary key', 'error')
			return
		}
		const pkText = Object.entries(pk)
			.map(([k, v]) => `${k} = ${formatCellText(v)}`)
			.join(' AND ')
		props.onRequestConfirm({
			title: `Delete row from ${props.route.table}?`,
			message: `This permanently deletes the row where ${pkText}.`,
			confirmLabel: 'Delete Row',
			danger: true,
			onConfirm: async () => {
				try {
					await api.mutateTable(props.route.connId, {
						table: props.route.table,
						deletes: [pk],
						confirmedDestructive: true,
					})
					setInspectorRowIdx(null)
					setReloadTick((n) => n + 1)
					props.onSchemaChanged()
					props.onNotify('Row deleted', 'ok')
				} catch (err) {
					props.onNotify(err instanceof Error ? err.message : String(err), 'error')
				}
			},
		})
	}

	async function handleInsertRow(e: SubmitEvent) {
		e.preventDefault()
		const payload: Record<string, unknown> = {}
		for (const col of props.tableSchema?.columns ?? []) {
			const raw = insertDraft()[col.name]
			if (raw === undefined || raw === '') continue
			const t = col.type.toUpperCase()
			if ((t.includes('INT') || t.includes('REAL') || t.includes('NUM')) && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
				payload[col.name] = Number(raw.trim())
			} else {
				payload[col.name] = raw
			}
		}
		try {
			await api.mutateTable(props.route.connId, {
				table: props.route.table,
				inserts: [payload],
			})
			setInsertOpen(false)
			setInsertDraft({})
			setReloadTick((n) => n + 1)
			props.onSchemaChanged()
			props.onNotify('Row inserted', 'ok')
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	function startFkPeek(e: MouseEvent, fk: ForeignKeyInfo, value: unknown) {
		if (value === null || value === undefined) return
		if (peekTimer) clearTimeout(peekTimer)
		const x = e.clientX
		const y = e.clientY
		const cacheKey = `${fk.toTable}.${fk.toColumn}=${String(value)}`
		peekTimer = setTimeout(() => {
			if (peekCache.has(cacheKey)) {
				setPeek({
					x,
					y,
					targetTable: fk.toTable,
					targetColumn: fk.toColumn,
					value,
					loading: false,
					row: peekCache.get(cacheKey) ?? null,
				})
				return
			}
			setPeek({
				x,
				y,
				targetTable: fk.toTable,
				targetColumn: fk.toColumn,
				value,
				loading: true,
				row: null,
			})
			api
				.peekRow(props.route.connId, fk.toTable, fk.toColumn, value)
				.then((res) => {
					peekCache.set(cacheKey, res.row)
					setPeek((cur) =>
						cur && cur.targetTable === fk.toTable && cur.value === value
							? { ...cur, loading: false, row: res.row }
							: cur,
					)
				})
				.catch(() => {
					setPeek((cur) => (cur ? { ...cur, loading: false, row: null } : null))
				})
		}, 180)
	}

	function cancelFkPeek() {
		if (peekTimer) clearTimeout(peekTimer)
		peekTimer = null
		setPeek(null)
	}

	async function doExport(kind: 'csv' | 'tsv' | 'json' | 'sql') {
		const res = data()
		if (!res) return
		const text =
			kind === 'csv'
				? exportRowsCsv(res.columns, res.rows)
				: kind === 'tsv'
					? exportRowsTsv(res.columns, res.rows)
					: kind === 'json'
						? exportRowsJson(res.rows)
						: exportRowsSqlInsert(res.table, res.columns, res.rows)
		setShowExport(false)
		if (await copyToClipboard(text)) {
			props.onNotify(`Copied ${res.rows.length} rows as ${kind.toUpperCase()}`, 'ok')
		}
	}

	async function doDownloadExport(format: 'csv' | 'tsv' | 'json' | 'markdown' | 'sql') {
		setShowExport(false)
		try {
			const res = await api.exportToFile(props.route.connId, {
				mode: 'table',
				format,
				browse: {
					table: props.route.table,
					fields: props.route.fields,
					filters: props.route.filters,
					order: props.route.order,
					limit: props.route.limit,
					search: props.route.search,
				},
			})
			props.onNotify(
				`Downloaded ${res.filename} (${res.rowCount.toLocaleString()} rows${res.truncated ? ', capped at 100k' : ''})`,
				'ok',
			)
		} catch (err) {
			props.onNotify(err instanceof Error ? err.message : String(err), 'error')
		}
	}

	const stagedCount = createMemo(() => {
		let count = 0
		for (const u of staged().values()) count += Object.keys(u.changes).length
		return count
	})

	return (
		<div class="main-pane">
			{/* Top mode toolbar */}
			<div class="view-toolbar">
				<div class="tab-group">
					<button
						type="button"
						class={['tab-btn', { active: props.route.tab === 'data' }]}
						title={`Data view (${modKeyLabel('1')})`}
						onClick={() => updateRoute({ tab: 'data' }, false)}
					>
						Data
					</button>
					<button
						type="button"
						class={['tab-btn', { active: props.route.tab === 'schema' }]}
						title={`Schema view (${modKeyLabel('2')})`}
						onClick={() => updateRoute({ tab: 'schema' }, false)}
					>
						Schema
					</button>
				</div>

				<button
					type="button"
					class="btn sm"
					onClick={() => {
						const sql = data()?.generatedSql || `SELECT * FROM "${props.route.table}" LIMIT 100;`
						props.onOpenInSql(sql)
					}}
				>
					<IconSql />
					Open in Console
				</button>

				<div style="flex:1" />

				<Show when={props.route.tab === 'data'}>
					{/* Quick text search */}
					<div style="position:relative;display:inline-flex;align-items:center">
						<span style="position:absolute;left:8px;color:var(--ink-muted);display:inline-flex;pointer-events:none">
							<IconSearch />
						</span>
						<input
							ref={(el) => (searchInputEl = el)}
							class="input mono"
							style="padding-left:26px;width:190px;height:26px;font-size:12px"
							placeholder={`Search rows (/ · ${modKeyLabel('F')})…`}
							value={searchDraft()}
							onInput={(e) => setSearchDraft(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') updateRoute({ search: searchDraft() })
								else if (e.key === 'Escape') {
									setSearchDraft('')
									updateRoute({ search: '' })
									e.currentTarget.blur()
								}
							}}
						/>
					</div>

					{/* Row wrap toggle */}
					<button
						type="button"
						class={['btn sm', { 'active-toggle': wrapRows() }]}
						aria-pressed={wrapRows() ? 'true' : 'false'}
						onClick={() => {
							cancelHoverPeek()
							setWrapRows((v) => !v)
						}}
					>
						Wrap
					</button>

					{/* Freeze first column toggle */}
					<button
						type="button"
						class={['btn sm', { 'active-toggle': freezeFirst() }]}
						aria-pressed={freezeFirst() ? 'true' : 'false'}
						title="Pin the first data column while scrolling horizontally"
						onClick={() => setFreezeFirst((v) => !v)}
					>
						Freeze 1st
					</button>

					<Show when={props.isLocalSqlite}>
						<button
							type="button"
							class={['btn sm', { 'active-toggle': liveWatch() }]}
							aria-pressed={liveWatch() ? 'true' : 'false'}
							title="Auto-refresh when the local SQLite .db or -wal file changes"
							onClick={() => setLiveWatch((v) => !v)}
						>
							<Show when={liveWatch()}>
								<span class="status-dot" />
							</Show>
							Live
						</button>
					</Show>

					{/* Column picker (fields= in URL) */}
					<div class="popover-anchor">
						<button
							type="button"
							class="btn sm"
							onClick={() => {
								setShowColPicker((v) => !v)
								setShowExport(false)
							}}
						>
							<IconColumns />
							Columns
							<Show when={props.route.fields.length > 0}>
								<span class="tag">{props.route.fields.length}</span>
							</Show>
						</button>
						<Show when={showColPicker() && props.tableSchema}>
							<div class="popover-menu right">
								<div style="display:flex;justify-content:space-between;padding:4px 6px;border-bottom:1px solid var(--border-subtle);margin-bottom:4px">
									<span class="field-label">Visible Fields (URL)</span>
									<button type="button" class="btn sm" onClick={() => updateRoute({ fields: [] }, false)}>
										All
									</button>
								</div>
								<For each={props.tableSchema!.columns}>
									{(col) => {
										const checked = () => props.route.fields.length === 0 || props.route.fields.includes(col.name)
										return (
											<label class="popover-item">
												<input type="checkbox" checked={checked()} onChange={() => toggleField(col.name)} />
												<span class="mono" style="flex:1">
													{col.name}
												</span>
												<span class="th-type">{col.type}</span>
											</label>
										)
									}}
								</For>
							</div>
						</Show>
					</div>

					{/* Limit selector */}
					<select
						class="select mono"
						style="height:26px;font-size:11.5px"
						value={String(props.route.limit)}
						onChange={(e) => updateRoute({ limit: Number(e.currentTarget.value) || 100 })}
						aria-label="Rows per page"
					>
						<option value="50">50 rows</option>
						<option value="100">100 rows</option>
						<option value="250">250 rows</option>
						<option value="500">500 rows</option>
					</select>

					{/* Export menu */}
					<div class="popover-anchor">
						<button
							type="button"
							class="btn sm"
							onClick={() => {
								setShowExport((v) => !v)
								setShowColPicker(false)
							}}
						>
							<IconCopy />
							Export
						</button>
						<Show when={showExport()}>
							<div class="popover-menu right" style="min-width:190px">
								<div class="popover-head" style="padding:4px 8px;font-size:10.5px;color:var(--ink-muted)">
									Download full result
								</div>
								<button type="button" class="popover-item" onClick={() => void doDownloadExport('csv')}>
									Download CSV
								</button>
								<button type="button" class="popover-item" onClick={() => void doDownloadExport('tsv')}>
									Download TSV
								</button>
								<button type="button" class="popover-item" onClick={() => void doDownloadExport('json')}>
									Download JSON
								</button>
								<button type="button" class="popover-item" onClick={() => void doDownloadExport('markdown')}>
									Download Markdown
								</button>
								<button type="button" class="popover-item" onClick={() => void doDownloadExport('sql')}>
									Download SQL INSERT
								</button>
								<div
									class="popover-head"
									style="padding:6px 8px 4px;font-size:10.5px;color:var(--ink-muted);border-top:1px solid var(--border);margin-top:4px"
								>
									Copy current page
								</div>
								<button type="button" class="popover-item" onClick={() => void doExport('csv')}>
									Copy as CSV
								</button>
								<button type="button" class="popover-item" onClick={() => void doExport('tsv')}>
									Copy as TSV
								</button>
								<button type="button" class="popover-item" onClick={() => void doExport('json')}>
									Copy as JSON
								</button>
								<button type="button" class="popover-item" onClick={() => void doExport('sql')}>
									Copy as SQL INSERT
								</button>
							</div>
						</Show>
					</div>

					<Show when={props.rwArmed && props.tableSchema?.type === 'table'}>
						<button
							type="button"
							class="btn sm primary"
							onClick={() => {
								setInsertDraft({})
								setInsertOpen(true)
							}}
						>
							<IconPlus />
							Insert Row
						</button>
					</Show>

					<button
						type="button"
						class="icon-btn"
						style="height:26px;width:26px"
						onClick={() => {
							setReloadTick((n) => n + 1)
							props.onSchemaChanged()
						}}
						aria-label={isNativeApp() ? `Refresh rows (r or ${modKeyLabel('R')})` : 'Refresh rows (r)'}
						title={isNativeApp() ? `Refresh rows (r or ${modKeyLabel('R')})` : 'Refresh rows (r)'}
					>
						<IconRefresh />
					</button>
				</Show>
			</div>

			{/* Data Tab */}
			<Show when={props.route.tab === 'data'}>
				{/* Filter bar */}
				<div class="filter-bar">
					<For each={props.route.filters}>
						{(f, idx) => (
							<span class="filter-chip">
								<span>
									<strong>{f.column}</strong> {f.op}
									{f.op !== 'isnull' && f.op !== 'notnull' ? ` ${f.value}` : ''}
								</span>
								<button type="button" onClick={() => removeFilter(idx())} aria-label="Remove filter">
									<IconClose />
								</button>
							</span>
						)}
					</For>

					<Show when={props.route.search}>
						<span class="filter-chip">
							<span>search ≈ "{props.route.search}"</span>
							<button type="button" onClick={() => updateRoute({ search: '' })} aria-label="Clear search">
								<IconClose />
							</button>
						</span>
					</Show>

					<Show
						when={showAddFilter()}
						fallback={
							<button
								type="button"
								class="btn sm"
								onClick={() => {
									setFilterCol(props.tableSchema?.columns[0]?.name ?? '')
									setShowAddFilter(true)
								}}
							>
								<IconPlus />
								Filter
							</button>
						}
					>
						<div style="display:inline-flex;align-items:center;gap:4px">
							<select
								class="select mono"
								style="height:24px;font-size:11.5px"
								value={filterCol()}
								onChange={(e) => setFilterCol(e.currentTarget.value)}
							>
								<For each={props.tableSchema?.columns ?? []}>
									{(c) => (
										<option value={c.name} selected={c.name === filterCol()}>
											{c.name}
										</option>
									)}
								</For>
							</select>
							<select
								class="select mono"
								style="height:24px;font-size:11.5px"
								value={filterOp()}
								onChange={(e) => setFilterOp(e.currentTarget.value as FilterOp)}
							>
								<For each={FILTER_OPS}>{(op) => <option value={op.value}>{op.label}</option>}</For>
							</select>
							<Show when={filterOp() !== 'isnull' && filterOp() !== 'notnull'}>
								<input
									class="input mono"
									style="height:24px;width:150px;font-size:11.5px"
									placeholder="value"
									value={filterVal()}
									onInput={(e) => setFilterVal(e.currentTarget.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter') addFilter()
										else if (e.key === 'Escape') setShowAddFilter(false)
									}}
								/>
							</Show>
							<button type="button" class="btn sm primary" onClick={addFilter}>
								Apply
							</button>
							<button type="button" class="btn sm" onClick={() => setShowAddFilter(false)}>
								Cancel
							</button>
						</div>
					</Show>

					<Show when={props.route.filters.length > 0 || props.route.search}>
						<button type="button" class="btn sm" onClick={() => updateRoute({ filters: [], search: '' })}>
							Clear All
						</button>
					</Show>

					<div style="flex:1" />
					<span style="font-size:11px;color:var(--ink-muted)">
						<span class="kbd">Space</span> inspect · <span class="kbd">{modKeyLabel('C')}</span> copy ·{' '}
						<span class="kbd">{modKeyLabel('C', true)}</span> row TSV · <span class="kbd">{modKeyLabel('↵')}</span> FK ·{' '}
						<span class="kbd">f</span> columns · <span class="kbd">r</span> refresh
					</span>
				</div>

				{/* Grid + Inspector split */}
				<div class="grid-wrap">
					<div ref={(el) => (gridScrollEl = el)} class="grid-scroll" onScroll={cancelHoverPeek}>
						<Show when={error()}>{(msg) => <div class="error-box">{msg()}</div>}</Show>

						<Show when={data()}>
							{(res) => (
								<table class={['data-table', { 'wrap-rows': wrapRows(), 'freeze-first': freezeFirst() }]}>
									<thead>
										<tr>
											<th style="width:44px;text-align:right;color:var(--ink-muted)">#</th>
											<For each={res().columns}>
												{(colName) => {
													const sortSpec = () => props.route.order.find((o) => o.column === colName)
													const fk = () => fkByCol().get(colName)
													const isPk = () => pkCols().includes(colName)
													return (
														<th style={colWidthStyle(colName)}>
															<button
																type="button"
																class="th-btn"
																onClick={(e) => handleSortClick(colName, e.shiftKey)}
															>
																<span>{colName}</span>
																<span class="th-type">{res().columnTypes[colName]}</span>
																<Show when={isPk()}>
																	<span class="th-badge pk">PK</span>
																</Show>
																<Show when={fk()}>{(f) => <span class="th-badge fk">→ {f().toTable}</span>}</Show>
																<Show when={sortSpec()}>
																	{(s) => <span style="color:var(--accent)">{s().dir === 'asc' ? '▲' : '▼'}</span>}
																</Show>
															</button>
															<span
																class="col-resizer"
																title="Drag to resize · Double-click to auto-fit"
																onMouseDown={(e) => startColResize(e, colName)}
																onDblClick={(e) => autoFitColumn(e, colName)}
															/>
														</th>
													)
												}}
											</For>
										</tr>
									</thead>
									<tbody>
										<Show when={res().rows.length === 0 && !loading()}>
											<tr>
												<td colspan={res().columns.length + 1} class="empty-state">
													No rows match the current filter.
												</td>
											</tr>
										</Show>
										<For each={res().rows}>
											{(row, rIdx) => {
												const isRowSel = () => inspectorRowIdx() === rIdx()
												return (
													<tr class={{ 'row-selected': isRowSel() }}>
														<td
															class="row-num"
															onClick={() => setInspectorRowIdx((prev) => (prev === rIdx() ? null : rIdx()))}
														>
															{(props.route.offset ?? 0) + rIdx() + 1}
														</td>
														<For each={res().columns}>
															{(colName, cIdx) => {
																const val = () => getEffectiveValue(row, rIdx(), colName)
																const fk = () => fkByCol().get(colName)
																const active = () => activeCell()?.row === rIdx() && activeCell()?.col === cIdx()
																const dirty = () => isCellDirty(row, rIdx(), colName)
																const isEd = () => editingCell()?.row === rIdx() && editingCell()?.colName === colName

																return (
																	<td
																		data-r={rIdx()}
																		data-c={cIdx()}
																		style={colWidthStyle(colName)}
																		class={{
																			'cell-active': active(),
																			'cell-dirty': dirty(),
																		}}
																		onClick={() => {
																			cancelHoverPeek()
																			setActiveCell({ row: rIdx(), col: cIdx() })
																		}}
																		onDblClick={(e) => openCellAction(rIdx(), colName, val(), e.currentTarget)}
																		onMouseEnter={(e) => {
																			if (!fk()) startHoverPeek(e, colName, val())
																		}}
																		onMouseLeave={cancelHoverPeek}
																	>
																		<Show
																			when={isEd()}
																			fallback={
																				<Show
																					when={fk() && val() !== null && val() !== undefined}
																					fallback={
																						val() === null || val() === undefined ? (
																							<span class="cell-null">NULL</span>
																						) : (
																							formatCellText(val())
																						)
																					}
																				>
																					<button
																						type="button"
																						class="fk-link"
																						onMouseEnter={(e) => startFkPeek(e, fk()!, val())}
																						onMouseLeave={cancelFkPeek}
																						onClick={(e) => {
																							e.stopPropagation()
																							followFk(fk()!.toTable, fk()!.toColumn, val())
																						}}
																					>
																						<span>{formatCellText(val())}</span>
																						<IconArrowRight />
																					</button>
																				</Show>
																			}
																		>
																			<input
																				class="cell-editor"
																				autofocus
																				value={editingCell()!.draft}
																				onInput={(e) =>
																					setEditingCell((cur) =>
																						cur ? { ...cur, draft: e.currentTarget.value } : null,
																					)
																				}
																				onKeyDown={(e) => {
																					if (e.key === 'Enter') {
																						e.preventDefault()
																						commitCellDraft(false)
																					} else if (e.key === 'Escape') {
																						e.preventDefault()
																						setEditingCell(null)
																					} else if (e.key === 'Backspace' && isPrimaryMod(e)) {
																						e.preventDefault()
																						commitCellDraft(true)
																					}
																				}}
																				onBlur={() => commitCellDraft(false)}
																			/>
																		</Show>
																	</td>
																)
															}}
														</For>
													</tr>
												)
											}}
										</For>
									</tbody>
								</table>
							)}
						</Show>
					</div>

					{/* Slide-over Row Inspector */}
					<Show when={props.tableSchema && inspectorRowIdx() !== null && data()?.rows[inspectorRowIdx()!]}>
						<RowInspector
							connId={props.route.connId}
							tableSchema={props.tableSchema!}
							row={data()!.rows[inspectorRowIdx()!]!}
							rwArmed={props.rwArmed}
							onClose={() => setInspectorRowIdx(null)}
							onFollowFk={followFk}
							onDeleteRow={requestDeleteRow}
							onNotify={(m) => props.onNotify(m)}
						/>
					</Show>
				</div>

				{/* Staged inline edits bar */}
				<Show when={stagedCount() > 0}>
					<div class="pending-bar">
						<span style="font-weight:600;font-size:12px">
							{stagedCount()} pending cell edit{stagedCount() === 1 ? '' : 's'} across {staged().size} row
							{staged().size === 1 ? '' : 's'}
						</span>
						<div style="display:flex;gap:8px">
							<button
								type="button"
								class="btn sm"
								onClick={() =>
									props.onRequestConfirm({
										title: 'Commit Pending Edits',
										message: `Review the parameterized SQL statements for ${props.route.table}:`,
										sqlPreview: buildPendingSqlPreview(),
										confirmLabel: 'Commit Transaction',
										onConfirm: commitStagedEdits,
									})
								}
							>
								Preview SQL
							</button>
							<button type="button" class="btn sm" onClick={() => setStaged(new Map())}>
								Discard
							</button>
							<button type="button" class="btn sm primary" onClick={commitStagedEdits}>
								Commit Changes
								<span class="kbd" style="border-color:rgba(255,255,255,0.35);background:transparent;color:inherit">
									{modKeyLabel('S')}
								</span>
							</button>
						</div>
					</div>
				</Show>

				{/* Generated SQL peek */}
				<Show when={showSql() && data()?.generatedSql}>
					<div class="sql-peek-bar">{data()!.generatedSql}</div>
				</Show>

				{/* Pagination footer */}
				<div class="grid-footer">
					<div style="display:flex;align-items:center;gap:12px" class="mono">
						<span>
							{loading()
								? 'Loading…'
								: `${data()?.rows.length ?? 0} shown` +
									(data()?.totalCount !== null && data()?.totalCount !== undefined
										? ` / ${data()!.totalCount!.toLocaleString()} total`
										: '')}
						</span>
						<Show when={data()}>{(res) => <span>{res().durationMs} ms</span>}</Show>
						<Show when={data()?.keysetColumn}>{(kc) => <span class="tag">keyset:{kc()}</span>}</Show>
						<button type="button" class="btn sm" onClick={() => setShowSql((v) => !v)}>
							{showSql() ? 'Hide SQL' : 'SQL'}
						</button>
					</div>

					<div style="display:flex;align-items:center;gap:6px">
						<button
							type="button"
							class="btn sm"
							disabled={!data()?.hasPrev}
							onClick={() => {
								const res = data()
								if (!res) return
								if (res.keysetColumn && res.prevCursor !== null) {
									updateRoute({ start: res.prevCursor, direction: 'prev', offset: null }, false)
								} else {
									const nextOff = Math.max(0, (props.route.offset ?? 0) - props.route.limit)
									updateRoute({ offset: nextOff, start: null }, false)
								}
							}}
						>
							← Prev
						</button>
						<button
							type="button"
							class="btn sm"
							disabled={!data()?.hasNext}
							onClick={() => {
								const res = data()
								if (!res) return
								if (res.keysetColumn && res.nextCursor !== null) {
									updateRoute({ start: res.nextCursor, direction: 'next', offset: null }, false)
								} else {
									const nextOff = (props.route.offset ?? 0) + props.route.limit
									updateRoute({ offset: nextOff, start: null }, false)
								}
							}}
						>
							Next →
						</button>
					</div>
				</div>
			</Show>

			{/* Schema Tab */}
			<Show when={props.route.tab === 'schema' && props.tableSchema}>
				{(ts) => (
					<div class="schema-view">
						<div class="schema-card">
							<div class="schema-card-head">
								<span>Columns ({ts().columns.length})</span>
								<span class="tag">{ts().type.toUpperCase()}</span>
							</div>
							<table class="data-table" style="width:100%">
								<thead>
									<tr>
										<th>Column</th>
										<th>Type</th>
										<th>Key</th>
										<th>Nullable</th>
										<th>Default</th>
									</tr>
								</thead>
								<tbody>
									<For each={ts().columns}>
										{(col) => (
											<tr>
												<td style="font-weight:600">{col.name}</td>
												<td>{col.type}</td>
												<td>
													<Show when={col.primaryKey > 0}>
														<span class="th-badge pk">PK #{col.primaryKey}</span>
													</Show>
												</td>
												<td>{col.notNull ? 'NOT NULL' : 'NULL'}</td>
												<td>{col.defaultValue ?? <span class="cell-null">—</span>}</td>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>

						<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
							<div class="schema-card">
								<div class="schema-card-head">
									<span>Outgoing Foreign Keys ({ts().foreignKeys.length})</span>
								</div>
								<div style="padding:10px;display:flex;flex-direction:column;gap:6px">
									<Show when={ts().foreignKeys.length === 0}>
										<span style="color:var(--ink-muted)">No outgoing foreign keys.</span>
									</Show>
									<For each={ts().foreignKeys}>
										{(fk) => (
											<button
												type="button"
												class="ref-card"
												onClick={() =>
													props.onNavigate({
														...props.route,
														table: fk.toTable,
														tab: 'schema',
														filters: [],
														order: [],
														start: null,
														offset: null,
													})
												}
											>
												<span class="mono" style="font-size:12px">
													{fk.fromColumn} → <strong>{fk.toTable}</strong>.{fk.toColumn}
												</span>
												<span class="tag">DEL: {fk.onDelete}</span>
											</button>
										)}
									</For>
								</div>
							</div>

							<div class="schema-card">
								<div class="schema-card-head">
									<span>Referenced By / Incoming FKs ({ts().reverseForeignKeys.length})</span>
								</div>
								<div style="padding:10px;display:flex;flex-direction:column;gap:6px">
									<Show when={ts().reverseForeignKeys.length === 0}>
										<span style="color:var(--ink-muted)">No tables reference this table.</span>
									</Show>
									<For each={ts().reverseForeignKeys}>
										{(rfk) => (
											<button
												type="button"
												class="ref-card"
												onClick={() =>
													props.onNavigate({
														...props.route,
														table: rfk.fromTable,
														tab: 'data',
														filters: [],
														order: [],
														start: null,
														offset: null,
													})
												}
											>
												<span class="mono" style="font-size:12px">
													<strong>{rfk.fromTable}</strong>.{rfk.fromColumn} → {rfk.toColumn}
												</span>
												<IconArrowRight />
											</button>
										)}
									</For>
								</div>
							</div>
						</div>

						<div class="schema-card">
							<div class="schema-card-head">
								<span>Indexes ({ts().indexes.length})</span>
							</div>
							<table class="data-table" style="width:100%">
								<thead>
									<tr>
										<th>Index Name</th>
										<th>Columns</th>
										<th>Unique</th>
										<th>Origin</th>
									</tr>
								</thead>
								<tbody>
									<Show when={ts().indexes.length === 0}>
										<tr>
											<td colspan={4} style="color:var(--ink-muted);padding:12px">
												No indexes defined.
											</td>
										</tr>
									</Show>
									<For each={ts().indexes}>
										{(idx) => (
											<tr>
												<td>{idx.name}</td>
												<td>{idx.columns.join(', ')}</td>
												<td>{idx.unique ? 'UNIQUE' : 'NO'}</td>
												<td>{idx.origin}</td>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>

						<div class="schema-card">
							<div class="schema-card-head">
								<span>DDL Definition</span>
								<button
									type="button"
									class="btn sm"
									onClick={async () => {
										if (await copyToClipboard(ts().ddl)) props.onNotify('Copied DDL', 'ok')
									}}
								>
									<IconCopy />
									Copy SQL
								</button>
							</div>
							<pre class="ddl-pre">{ts().ddl || '—'}</pre>
						</div>
					</div>
				)}
			</Show>

			{/* Insert Row <dialog> */}
			<dialog
				ref={(el) => (insertDialogEl = el)}
				class="modal"
				onCancel={(e) => {
					e.preventDefault()
					setInsertOpen(false)
				}}
			>
				<div class="modal-head">
					<span>Insert Row into {props.route.table}</span>
					<button class="icon-btn ghost" type="button" onClick={() => setInsertOpen(false)} aria-label="Close">
						<IconClose />
					</button>
				</div>
				<form novalidate onSubmit={handleInsertRow}>
					<div class="modal-body">
						<For each={props.tableSchema?.columns ?? []}>
							{(col) => (
								<div class="field-group">
									<label class="field-label mono">
										{col.name} <span class="th-type">{col.type}</span>
										{col.defaultValue ? ` (default: ${col.defaultValue})` : ''}
									</label>
									<input
										class="input mono"
										placeholder={col.notNull ? 'Required (or default)' : 'NULL if blank'}
										value={insertDraft()[col.name] ?? ''}
										onInput={(e) => setInsertDraft((prev) => ({ ...prev, [col.name]: e.currentTarget.value }))}
									/>
								</div>
							)}
						</For>
					</div>
					<div class="modal-foot">
						<button type="button" class="btn" onClick={() => setInsertOpen(false)}>
							Cancel
						</button>
						<button type="submit" class="btn primary">
							Insert Row
						</button>
					</div>
				</form>
			</dialog>

			<FkPeekCard state={peek()} />

			<Show when={hoverPeek()}>
				{(hp) => {
					const left = () => Math.min(hp().x + 14, window.innerWidth - 380)
					const top = () => Math.min(hp().y + 14, window.innerHeight - 200)
					return (
						<div class="cell-hover-peek" style={`left:${Math.max(12, left())}px;top:${Math.max(12, top())}px`}>
							<div class="cell-hover-peek-body">{hp().text}</div>
							<div class="cell-hover-peek-foot">Double-click or press Enter to view &amp; copy</div>
						</div>
					)
				}}
			</Show>

			<CellViewer
				state={cellViewer()}
				canEdit={canEditTable()}
				rwArmed={props.rwArmed}
				onClose={() => setCellViewer(null)}
				onCommitEdit={stageCellValue}
				onRequestArmRw={props.onRequestArmRw}
				onSwitchToEdit={() => setCellViewer((cur) => (cur ? { ...cur, mode: 'edit' } : null))}
				onNotify={props.onNotify}
			/>
		</div>
	)
}

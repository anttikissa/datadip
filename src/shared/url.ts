// Browser URL codec mapping DataDip navigation state (connection, table, fields, filters, sort, cursor, scratchpad) to/from URLs.
import type { FilterOp, FilterSpec, OrderSpec } from './types.ts'

export type AppRoute =
	| { kind: 'home' }
	| { kind: 'connection'; connId: string }
	| {
			kind: 'table'
			connId: string
			table: string
			tab: 'data' | 'schema'
			fields: string[]
			filters: FilterSpec[]
			order: OrderSpec[]
			limit: number
			start: string | null
			direction: 'next' | 'prev'
			offset: number | null
			search: string
			selectedRow: string | null
	  }
	| {
			kind: 'sql'
			connId: string
			padId: string | null
	  }

const VALID_OPS = new Set<FilterOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'in', 'isnull', 'notnull'])

export function parseRoute(pathname: string, search: string): AppRoute {
	const clean = pathname.replace(/\/+$/, '') || '/'
	const parts = clean.split('/').filter(Boolean).map(decodeURIComponent)

	if (parts.length === 0 || parts[0] !== 'c' || !parts[1]) {
		return { kind: 'home' }
	}

	const connId = parts[1]

	if (parts[2] === 't' && parts[3]) {
		const table = parts[3]
		const tab: 'data' | 'schema' = parts[4] === 'schema' ? 'schema' : 'data'
		const params = new URLSearchParams(search)

		const fieldsRaw = params.get('fields') ?? ''
		const fields = fieldsRaw
			? fieldsRaw
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: []

		const filters: FilterSpec[] = []
		for (const raw of params.getAll('where')) {
			const parsed = parseFilterToken(raw)
			if (parsed) filters.push(parsed)
		}

		const order: OrderSpec[] = []
		const orderRaw = params.get('order') ?? ''
		if (orderRaw) {
			for (const part of orderRaw.split(';')) {
				const trimmed = part.trim()
				if (!trimmed) continue
				// Support both "id.desc" and "id,desc" styles
				const sep = trimmed.includes('.') ? '.' : ','
				const idx = trimmed.lastIndexOf(sep)
				if (idx > 0) {
					const col = trimmed.slice(0, idx).trim()
					const dirRaw = trimmed
						.slice(idx + 1)
						.trim()
						.toLowerCase()
					if (col && (dirRaw === 'asc' || dirRaw === 'desc')) {
						order.push({ column: col, dir: dirRaw })
						continue
					}
				}
				order.push({ column: trimmed, dir: 'asc' })
			}
		}

		const limitNum = Number(params.get('limit'))
		const limit = Number.isFinite(limitNum) && limitNum > 0 && limitNum <= 2000 ? Math.floor(limitNum) : 100

		const start = params.get('start') || null
		const direction: 'next' | 'prev' = params.get('dir') === 'prev' ? 'prev' : 'next'
		const offsetRaw = params.get('offset')
		const offsetNum = offsetRaw !== null ? Number(offsetRaw) : NaN
		const offset = Number.isFinite(offsetNum) && offsetNum >= 0 ? Math.floor(offsetNum) : null
		const q = params.get('q') ?? ''
		const selectedRow = params.get('row') || null

		return {
			kind: 'table',
			connId,
			table,
			tab,
			fields,
			filters,
			order,
			limit,
			start,
			direction,
			offset,
			search: q,
			selectedRow,
		}
	}

	if (parts[2] === 'sql') {
		return {
			kind: 'sql',
			connId,
			padId: parts[3] ?? null,
		}
	}

	return { kind: 'connection', connId }
}

export function formatRoute(route: AppRoute): string {
	if (route.kind === 'home') return '/'
	if (route.kind === 'connection') return `/c/${encodeURIComponent(route.connId)}`
	if (route.kind === 'sql') {
		const base = `/c/${encodeURIComponent(route.connId)}/sql`
		return route.padId ? `${base}/${encodeURIComponent(route.padId)}` : base
	}

	const base =
		`/c/${encodeURIComponent(route.connId)}/t/${encodeURIComponent(route.table)}` +
		(route.tab === 'schema' ? '/schema' : '')

	if (route.tab === 'schema') return base

	const params = new URLSearchParams()
	if (route.fields.length > 0) params.set('fields', route.fields.join(','))
	for (const f of route.filters) {
		params.append('where', formatFilterToken(f))
	}
	if (route.order.length > 0) {
		params.set('order', route.order.map((o) => `${o.column}.${o.dir}`).join(';'))
	}
	if (route.limit !== 100) params.set('limit', String(route.limit))
	if (route.start !== null) {
		params.set('start', route.start)
		if (route.direction === 'prev') params.set('dir', 'prev')
	} else if (route.offset !== null && route.offset > 0) {
		params.set('offset', String(route.offset))
	}
	if (route.search.trim()) params.set('q', route.search.trim())
	if (route.selectedRow) params.set('row', route.selectedRow)

	const qs = params.toString()
	return qs ? `${base}?${qs}` : base
}

function parseFilterToken(raw: string): FilterSpec | null {
	const first = raw.indexOf(':')
	if (first <= 0) return null
	const column = raw.slice(0, first)
	const rest = raw.slice(first + 1)
	const second = rest.indexOf(':')
	const opRaw = (second === -1 ? rest : rest.slice(0, second)) as FilterOp
	if (!VALID_OPS.has(opRaw)) return null
	const value = second === -1 ? '' : rest.slice(second + 1)
	return { column, op: opRaw, value }
}

function formatFilterToken(f: FilterSpec): string {
	if (f.op === 'isnull' || f.op === 'notnull') return `${f.column}:${f.op}`
	return `${f.column}:${f.op}:${f.value}`
}

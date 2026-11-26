// Browser URL codec mapping DataDip navigation state (connection, table, fields, filters, sort, cursor, console) to/from URLs.
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
			consoleId: string | null
	  }
	| {
			kind: 'er'
			connId: string
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
			consoleId: parts[3] ?? null,
		}
	}

	if (parts[2] === 'er') {
		return {
			kind: 'er',
			connId,
		}
	}

	return { kind: 'connection', connId }
}

export function formatRoute(route: AppRoute): string {
	if (route.kind === 'home') return '/'
	if (route.kind === 'connection') return `/c/${encodeURIComponent(route.connId)}`
	if (route.kind === 'er') return `/c/${encodeURIComponent(route.connId)}/er`
	if (route.kind === 'sql') {
		const base = `/c/${encodeURIComponent(route.connId)}/sql`
		return route.consoleId ? `${base}/${encodeURIComponent(route.consoleId)}` : base
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

const PASSWORD_MASK_SENTINEL = '__DATADIP_MASKED_PW__'

export function maskConnectionPath(path: string): string {
	const trimmed = path.trim()
	if (/^postgres(?:ql)?:\/\//i.test(trimmed)) {
		try {
			const u = new URL(trimmed)
			if (!u.password) return u.toString()
			u.password = PASSWORD_MASK_SENTINEL
			return u.toString().replace(PASSWORD_MASK_SENTINEL, '••••')
		} catch {
			return path.replace(/(:\/\/[^:@/\s]+):[^@/\s]+@/, '$1:••••@')
		}
	}
	if (/^(?:libsql|https?):\/\//i.test(trimmed)) {
		try {
			const u = new URL(trimmed)
			let changed = false
			if (u.password) {
				u.password = PASSWORD_MASK_SENTINEL
				changed = true
			}
			for (const key of ['authToken', 'token']) {
				if (u.searchParams.has(key)) {
					u.searchParams.set(key, PASSWORD_MASK_SENTINEL)
					changed = true
				}
			}
			if (!changed) return u.toString()
			return u.toString().replaceAll(PASSWORD_MASK_SENTINEL, '••••')
		} catch {
			return trimmed.replace(/([?&](?:authToken|token)=)[^&]+/gi, '$1••••')
		}
	}
	return path
}

export function slugifyConnectionName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

// Resolves a URL connection segment by exact ID, exact name (case-insensitive), or slugified name for teammate links.
export function resolveConnectionRef<T extends { id: string; name: string }>(ref: string, connections: T[]): T | null {
	if (!ref) return null
	const byId = connections.find((c) => c.id === ref)
	if (byId) return byId
	const lower = ref.trim().toLowerCase()
	const byExactName = connections.find((c) => c.name.trim().toLowerCase() === lower)
	if (byExactName) return byExactName
	const slug = slugifyConnectionName(ref)
	if (!slug) return null
	return connections.find((c) => slugifyConnectionName(c.name) === slug) ?? null
}

export function buildTeammateRouteUrl(route: AppRoute, connName: string, origin: string): string {
	if (route.kind === 'home') return origin + '/'
	const slug = slugifyConnectionName(connName) || route.connId
	const nextRoute: AppRoute = { ...route, connId: slug }
	return origin + formatRoute(nextRoute)
}

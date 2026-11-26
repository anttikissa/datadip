// Typed HTTP client speaking ASON against DataDip's /api/* endpoints.
import { parse as parseAson, stringify as stringifyAson } from '../shared/ason.ts'
import type {
	BrowseParams,
	BrowseResult,
	ColumnProfile,
	ConnectionConfig,
	ConnectionsPayload,
	DatabaseInfo,
	DatabaseSchema,
	DiscoveredDb,
	DiscoverPreset,
	IdMatch,
	MutateRequest,
	MutateResponse,
	QueryHistoryEntry,
	QueryResponse,
	RecentTable,
	ReverseFkCount,
	Console,
	SshHostOption,
} from '../shared/types.ts'

export class ApiError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
	const init: RequestInit = {
		method,
		headers: body !== undefined ? { 'content-type': 'text/plain; charset=utf-8' } : undefined,
		body: body !== undefined ? stringifyAson(body, 'short') : undefined,
	}
	const res = await fetch(path, init)
	const text = await res.text()
	let data: unknown = {}
	if (text.trim()) {
		try {
			data = parseAson(text)
		} catch {
			data = { error: text }
		}
	}
	if (!res.ok) {
		const msg = (data as { error?: string })?.error || `${res.status} ${res.statusText || 'Request failed'}`
		throw new ApiError(res.status, msg)
	}
	return data as T
}

export const api = {
	getPreferences: () => request<{ preferences: Record<string, string> }>('GET', '/api/preferences'),
	setPreference: (key: string, value: string) =>
		request<{ ok: true; preferences: Record<string, string> }>('POST', '/api/preferences', { key, value }),

	listConnections: () => request<ConnectionsPayload>('GET', '/api/connections'),
	addConnection: (input: Omit<ConnectionConfig, 'id' | 'createdAt'>) =>
		request<{ connection: ConnectionConfig }>('POST', '/api/connections', input),
	updateConnection: (id: string, patch: Partial<Omit<ConnectionConfig, 'id' | 'createdAt'>>) =>
		request<{ connection: ConnectionConfig }>('PUT', `/api/connections/${encodeURIComponent(id)}`, patch),
	deleteConnection: (id: string) => request<{ ok: true }>('DELETE', `/api/connections/${encodeURIComponent(id)}`),
	restoreConnection: (id: string) =>
		request<{ connection: ConnectionConfig }>('POST', `/api/connections/${encodeURIComponent(id)}/restore`),
	disconnectConnection: (id: string) =>
		request<{ ok: true; disconnected: boolean }>('POST', `/api/connections/${encodeURIComponent(id)}/disconnect`),
	testConnection: (draft: Omit<ConnectionConfig, 'id' | 'createdAt'>) =>
		request<{ ok: true; latencyMs: number; version?: string; tableCount: number }>(
			'POST',
			'/api/connections/test',
			draft,
		),
	pingConnection: (id: string) =>
		request<{ ok: true; latencyMs: number; version?: string }>(
			'POST',
			`/api/connections/${encodeURIComponent(id)}/ping`,
		),
	setRwMode: (id: string, armed: boolean) =>
		request<{ armed: boolean; until: number | null }>('POST', `/api/connections/${encodeURIComponent(id)}/rw`, {
			armed,
		}),

	getSchema: (id: string) => request<DatabaseSchema>('GET', `/api/connections/${encodeURIComponent(id)}/schema`),
	browseTable: (id: string, params: BrowseParams) =>
		request<BrowseResult>('POST', `/api/connections/${encodeURIComponent(id)}/browse`, params),
	runQuery: (id: string, sql: string, confirmedDestructive = false, queryId?: string) =>
		request<QueryResponse>('POST', `/api/connections/${encodeURIComponent(id)}/query`, {
			sql,
			confirmedDestructive,
			queryId,
		}),
	cancelQuery: (id: string, queryId: string) =>
		request<{ ok: true; cancelled: boolean }>('POST', `/api/connections/${encodeURIComponent(id)}/query/cancel`, {
			queryId,
		}),
	mutateTable: (id: string, req: MutateRequest) =>
		request<MutateResponse>('POST', `/api/connections/${encodeURIComponent(id)}/mutate`, req),
	peekRow: (id: string, table: string, column: string, value: unknown) =>
		request<{ row: Record<string, unknown> | null }>('POST', `/api/connections/${encodeURIComponent(id)}/peek`, {
			table,
			column,
			value,
		}),
	countReverseFks: (id: string, table: string, row: Record<string, unknown>) =>
		request<{ counts: ReverseFkCount[] }>('POST', `/api/connections/${encodeURIComponent(id)}/reverse-fks`, {
			table,
			row,
		}),
	searchId: (id: string, value: string) =>
		request<{ matches: IdMatch[] }>('POST', `/api/connections/${encodeURIComponent(id)}/search-id`, { value }),
	profileColumn: (id: string, table: string, column: string) =>
		request<{ profile: ColumnProfile }>('POST', `/api/connections/${encodeURIComponent(id)}/profile`, {
			table,
			column,
		}),
	getDbInfo: (id: string) => request<{ info: DatabaseInfo }>('GET', `/api/connections/${encodeURIComponent(id)}/info`),
	runMaintenance: (id: string, action: 'wal_checkpoint' | 'vacuum') =>
		request<{ ok: true; message: string; durationMs: number }>(
			'POST',
			`/api/connections/${encodeURIComponent(id)}/maintenance`,
			{ action },
		),

	listSshHosts: () => request<{ hosts: SshHostOption[] }>('GET', '/api/ssh/hosts'),

	listConsoles: (connId: string) =>
		request<{ consoles: Console[] }>('GET', `/api/connections/${encodeURIComponent(connId)}/consoles`),
	createConsole: (connId: string, title?: string, sql?: string) =>
		request<{ console: Console }>('POST', `/api/connections/${encodeURIComponent(connId)}/consoles`, {
			title,
			sql,
		}),
	updateConsole: (consoleId: string, patch: { title?: string; sql?: string; pinned?: boolean }) =>
		request<{ console: Console }>('PUT', `/api/consoles/${encodeURIComponent(consoleId)}`, patch),
	deleteConsole: (consoleId: string) =>
		request<{ ok: true }>('DELETE', `/api/consoles/${encodeURIComponent(consoleId)}`),

	listHistory: (connId: string | 'all', limit = 100, q?: string) => {
		const params = new URLSearchParams({ limit: String(limit) })
		if (q?.trim()) params.set('q', q.trim())
		if (connId === 'all') {
			params.set('connectionId', 'all')
			return request<{ history: QueryHistoryEntry[] }>('GET', `/api/history?${params.toString()}`)
		}
		return request<{ history: QueryHistoryEntry[] }>(
			'GET',
			`/api/connections/${encodeURIComponent(connId)}/history?${params.toString()}`,
		)
	},
	clearHistory: (connId: string) =>
		request<{ ok: true }>('DELETE', `/api/connections/${encodeURIComponent(connId)}/history`),

	listRecents: () => request<{ recents: RecentTable[] }>('GET', '/api/recents'),
	deleteRecent: (connectionId: string, tableName: string) =>
		request<{ ok: true }>('DELETE', '/api/recents', { connectionId, tableName }),

	discover: (params: {
		location: 'local' | 'ssh'
		sshHost?: string
		sshUser?: string
		sshPort?: number
		roots?: string[]
		maxDepth?: number
		preset?: DiscoverPreset
	}) => request<{ databases: DiscoveredDb[] }>('POST', '/api/discover', params),

	answerSshPrompt: (id: string, payload: { answer?: string; cancelled?: boolean }) =>
		request<{ ok: true }>('POST', `/api/ssh/prompts/${encodeURIComponent(id)}`, payload),

	openLocalFile: (path: string) =>
		request<{ connection: ConnectionConfig }>('POST', '/api/connections/open-file', { path }),

	exportToFile: async (
		connId: string,
		payload: {
			mode: 'table' | 'query'
			format: 'csv' | 'tsv' | 'json' | 'markdown' | 'sql'
			browse?: BrowseParams
			sql?: string
			filename?: string
		},
	): Promise<{ filename: string; rowCount: number; truncated: boolean }> => {
		const res = await fetch(`/api/connections/${encodeURIComponent(connId)}/export`, {
			method: 'POST',
			headers: { 'content-type': 'text/plain; charset=utf-8' },
			body: stringifyAson(payload, 'short'),
		})
		if (!res.ok) {
			const text = await res.text()
			let msg = `${res.status} Export failed`
			if (text.trim()) {
				try {
					const data = parseAson(text) as { error?: string }
					if (data?.error) msg = data.error
				} catch {
					msg = text
				}
			}
			throw new ApiError(res.status, msg)
		}
		const blob = await res.blob()
		const cd = res.headers.get('content-disposition') ?? ''
		const match = /filename="([^"]+)"/.exec(cd)
		const filename = match?.[1] ?? `export.${payload.format === 'markdown' ? 'md' : payload.format}`
		const rowCount = Number(res.headers.get('x-datadip-row-count') ?? '0')
		const truncated = res.headers.get('x-datadip-truncated') === '1'
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = filename
		document.body.appendChild(a)
		a.click()
		a.remove()
		setTimeout(() => URL.revokeObjectURL(url), 1000)
		return { filename, rowCount, truncated }
	},
}

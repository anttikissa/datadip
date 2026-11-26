// Typed HTTP client speaking ASON against DataDip's /api/* endpoints.
import { parse as parseAson, stringify as stringifyAson } from '../shared/ason.ts'
import type {
	BrowseParams,
	BrowseResult,
	ConnectionConfig,
	ConnectionsPayload,
	DatabaseSchema,
	DiscoveredDb,
	IdMatch,
	MutateRequest,
	MutateResponse,
	QueryHistoryEntry,
	QueryResponse,
	RecentTable,
	ReverseFkCount,
	Scratchpad,
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
	runQuery: (id: string, sql: string, confirmedDestructive = false) =>
		request<QueryResponse>('POST', `/api/connections/${encodeURIComponent(id)}/query`, {
			sql,
			confirmedDestructive,
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

	listScratchpads: (connId: string) =>
		request<{ scratchpads: Scratchpad[] }>('GET', `/api/connections/${encodeURIComponent(connId)}/scratchpads`),
	createScratchpad: (connId: string, title?: string, sql?: string) =>
		request<{ scratchpad: Scratchpad }>('POST', `/api/connections/${encodeURIComponent(connId)}/scratchpads`, {
			title,
			sql,
		}),
	updateScratchpad: (padId: string, patch: { title?: string; sql?: string; pinned?: boolean }) =>
		request<{ scratchpad: Scratchpad }>('PUT', `/api/scratchpads/${encodeURIComponent(padId)}`, patch),
	deleteScratchpad: (padId: string) => request<{ ok: true }>('DELETE', `/api/scratchpads/${encodeURIComponent(padId)}`),

	listHistory: (connId: string, limit = 100) =>
		request<{ history: QueryHistoryEntry[] }>(
			'GET',
			`/api/connections/${encodeURIComponent(connId)}/history?limit=${limit}`,
		),
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
	}) => request<{ databases: DiscoveredDb[] }>('POST', '/api/discover', params),
}

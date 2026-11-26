// HTTP /api/* route handler speaking ASON for connections, browsing, SQL execution, mutations, scratchpads, and discovery.
import { parse as parseAson, stringify as stringifyAson } from '../src/shared/ason.ts'
import type { BrowseParams, ConnectionConfig, MutateRequest } from '../src/shared/types.ts'
import { type ConnectionManager, HttpError } from './db/manager.ts'

function asonResponse(data: unknown, status = 200): Response {
	return new Response(stringifyAson(data, 'short'), {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'x-datadip-format': 'ason',
		},
	})
}

async function readBody<T = Record<string, unknown>>(req: Request): Promise<T> {
	const text = (await req.text()).trim()
	if (!text) return {} as T
	return parseAson(text) as T
}

export async function handleApiRequest(req: Request, manager: ConnectionManager): Promise<Response> {
	const url = new URL(req.url)
	const path = url.pathname
	const method = req.method

	try {
		// Health & meta
		if (path === '/api/health' && method === 'GET') {
			return asonResponse({ ok: true, version: '0.1.0', now: new Date().toISOString() })
		}

		// Live Server-Sent Events stream for connections.ason hot-reload & orphaned state
		if (path === '/api/events' && method === 'GET') {
			const encoder = new TextEncoder()
			let cleanup: (() => void) | null = null
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const send = (event: string, data: unknown) => {
						try {
							const payload = stringifyAson(data, 'short')
							controller.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`))
						} catch {}
					}
					send('connections', manager.getConnectionsPayload())
					const unsub = manager.subscribe((payload) => send('connections', payload))
					const ping = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(': ping\n\n'))
						} catch {}
					}, 25_000)
					ping.unref?.()
					cleanup = () => {
						unsub()
						clearInterval(ping)
					}
					req.signal.addEventListener(
						'abort',
						() => {
							cleanup?.()
							cleanup = null
							try {
								controller.close()
							} catch {}
						},
						{ once: true },
					)
				},
				cancel() {
					cleanup?.()
					cleanup = null
				},
			})
			return new Response(stream, {
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache, no-transform',
					connection: 'keep-alive',
				},
			})
		}

		// Preferences
		if (path === '/api/preferences' && method === 'GET') {
			return asonResponse({ preferences: manager.store.getPreferences() })
		}
		if (path === '/api/preferences' && method === 'POST') {
			const body = await readBody<{ key: string; value: string }>(req)
			if (!body.key) throw new HttpError(400, 'Missing preference key')
			manager.store.setPreference(body.key, String(body.value ?? ''))
			return asonResponse({ ok: true, preferences: manager.store.getPreferences() })
		}

		// Recents
		if (path === '/api/recents' && method === 'GET') {
			return asonResponse({ recents: manager.store.listRecentTables(30, manager.getOrphanedConfigs()) })
		}
		if (path === '/api/recents' && method === 'DELETE') {
			const body = await readBody<{ connectionId: string; tableName: string }>(req)
			manager.store.deleteRecentTable(body.connectionId, body.tableName)
			return asonResponse({ ok: true })
		}

		// Auto-discover wizard
		if (path === '/api/discover' && method === 'POST') {
			const body = await readBody<{
				location: 'local' | 'ssh'
				sshHost?: string
				sshUser?: string
				sshPort?: number
				roots?: string[]
				maxDepth?: number
			}>(req)
			const databases = await manager.discover(body)
			return asonResponse({ databases })
		}

		// Connections CRUD
		if (path === '/api/connections' && method === 'GET') {
			return asonResponse(manager.getConnectionsPayload())
		}
		if (path === '/api/connections' && method === 'POST') {
			const body = await readBody<Omit<ConnectionConfig, 'id' | 'createdAt'>>(req)
			if (!body.name?.trim()) throw new HttpError(400, 'Connection name is required')
			if (!body.path?.trim()) throw new HttpError(400, 'Database path is required')
			if (body.location === 'ssh' && !body.sshHost?.trim()) {
				throw new HttpError(400, 'SSH host is required for remote connections')
			}
			const conn = manager.store.addConnection({
				name: body.name.trim(),
				driver: body.driver === 'postgres' ? 'postgres' : 'sqlite',
				location: body.location === 'ssh' ? 'ssh' : 'local',
				path: body.path.trim(),
				sshHost: body.sshHost?.trim() || undefined,
				sshUser: body.sshUser?.trim() || undefined,
				sshPort: body.sshPort ? Number(body.sshPort) : undefined,
				isProduction: Boolean(body.isProduction),
				pinned: Boolean(body.pinned),
			})
			return asonResponse({ connection: conn }, 201)
		}
		if (path === '/api/connections/test' && method === 'POST') {
			const body = await readBody<Omit<ConnectionConfig, 'id' | 'createdAt'>>(req)
			const result = await manager.testDraftConnection(body)
			return asonResponse(result)
		}

		// Per-connection routes: /api/connections/:id/...
		const connMatch = /^\/api\/connections\/([^/]+)(?:\/(.*))?$/.exec(path)
		if (connMatch) {
			const connId = decodeURIComponent(connMatch[1]!)
			const rest = connMatch[2] ?? ''

			if (rest === '' && method === 'PUT') {
				const body = await readBody<Partial<Omit<ConnectionConfig, 'id' | 'createdAt'>>>(req)
				const updated = manager.store.updateConnection(connId, body)
				if (!updated) throw new HttpError(404, 'Connection not found')
				manager.dropConnection(connId)
				return asonResponse({ connection: updated })
			}
			if (rest === '' && method === 'DELETE') {
				const wasOrphaned = manager.isOrphaned(connId)
				const dropped = manager.dropConnection(connId)
				const deleted = wasOrphaned ? false : manager.store.deleteConnection(connId)
				if (!deleted && !dropped) throw new HttpError(404, 'Connection not found')
				return asonResponse({ ok: true })
			}

			if (rest === 'restore' && method === 'POST') {
				const restored = manager.restoreOrphanedConnection(connId)
				return asonResponse({ connection: restored })
			}

			if (rest === 'ping' && method === 'POST') {
				const res = await manager.pingConnection(connId)
				return asonResponse(res)
			}

			if (rest === 'rw' && method === 'POST') {
				const body = await readBody<{ armed: boolean }>(req)
				const state = manager.setRwMode(connId, Boolean(body.armed))
				return asonResponse(state)
			}

			if (rest === 'schema' && method === 'GET') {
				const { adapter } = manager.getAdapterById(connId)
				const schema = await adapter.getSchema()
				manager.store.touchConnection(connId)
				return asonResponse(schema)
			}

			if (rest === 'browse' && method === 'POST') {
				const body = await readBody<BrowseParams>(req)
				const { adapter } = manager.getAdapterById(connId)
				const result = await adapter.browseTable(body)
				manager.store.recordRecentTable(connId, body.table)
				return asonResponse(result)
			}

			if (rest === 'query' && method === 'POST') {
				const body = await readBody<{
					sql: string
					confirmedDestructive?: boolean
					maxRows?: number
				}>(req)
				const result = await manager.runQuery(connId, body.sql ?? '', {
					confirmedDestructive: Boolean(body.confirmedDestructive),
					maxRows: body.maxRows,
				})
				return asonResponse(result)
			}

			if (rest === 'mutate' && method === 'POST') {
				const body = await readBody<MutateRequest>(req)
				const result = await manager.runMutate(connId, body)
				return asonResponse(result)
			}

			if (rest === 'peek' && method === 'POST') {
				const body = await readBody<{ table: string; column: string; value: unknown }>(req)
				const { adapter } = manager.getAdapterById(connId)
				const row = await adapter.peekRow(body.table, body.column, body.value)
				return asonResponse({ row })
			}

			if (rest === 'reverse-fks' && method === 'POST') {
				const body = await readBody<{ table: string; row: Record<string, unknown> }>(req)
				const { adapter } = manager.getAdapterById(connId)
				const counts = await adapter.countReverseFks(body.table, body.row)
				return asonResponse({ counts })
			}

			if (rest === 'search-id' && method === 'POST') {
				const body = await readBody<{ value: string }>(req)
				const { adapter } = manager.getAdapterById(connId)
				const matches = await adapter.searchId(body.value ?? '')
				return asonResponse({ matches })
			}

			// Scratchpads per connection
			if (rest === 'scratchpads' && method === 'GET') {
				return asonResponse({ scratchpads: manager.store.listScratchpads(connId) })
			}
			if (rest === 'scratchpads' && method === 'POST') {
				const body = await readBody<{ title?: string; sql?: string }>(req)
				const pad = manager.store.createScratchpad(connId, body.title || 'Untitled console', body.sql ?? '')
				return asonResponse({ scratchpad: pad }, 201)
			}

			// Query history per connection
			if (rest === 'history' && method === 'GET') {
				const limit = Number(url.searchParams.get('limit')) || 100
				return asonResponse({ history: manager.store.listQueryHistory(connId, limit) })
			}
			if (rest === 'history' && method === 'DELETE') {
				manager.store.clearQueryHistory(connId)
				return asonResponse({ ok: true })
			}
		}

		// Scratchpad update/delete by id
		const padMatch = /^\/api\/scratchpads\/([^/]+)$/.exec(path)
		if (padMatch) {
			const padId = decodeURIComponent(padMatch[1]!)
			if (method === 'PUT') {
				const body = await readBody<{ title?: string; sql?: string; pinned?: boolean }>(req)
				const updated = manager.store.updateScratchpad(padId, body)
				if (!updated) throw new HttpError(404, 'Console not found')
				return asonResponse({ scratchpad: updated })
			}
			if (method === 'DELETE') {
				const ok = manager.store.deleteScratchpad(padId)
				if (!ok) throw new HttpError(404, 'Console not found')
				return asonResponse({ ok: true })
			}
		}

		return asonResponse({ error: `Not found: ${method} ${path}` }, 404)
	} catch (err) {
		const status = err instanceof HttpError ? err.status : 500
		const message = err instanceof Error ? err.message : String(err)
		return asonResponse({ error: message }, status)
	}
}

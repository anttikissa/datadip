// HTTP /api/* route handler speaking ASON for connections, browsing, SQL execution, mutations, consoles, and discovery.
import { parse as parseAson, stringify as stringifyAson } from '../src/shared/ason.ts'
import { APP_VERSION } from '../src/shared/changelog.ts'
import type {
	BrowseParams,
	ConnectionConfig,
	DiscoverPreset,
	IgnoredForeignKey,
	MutateRequest,
	VirtualForeignKey,
} from '../src/shared/types.ts'
import { type ConnectionManager, HttpError } from './db/manager.ts'
import { listSshConfigHosts } from './db/ssh-config.ts'
import { EXPORT_MIME, type ExportFormat } from './export.ts'

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
			return asonResponse({ ok: true, version: APP_VERSION, now: new Date().toISOString() })
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
					send('ssh-prompts', { prompts: manager.sshPrompts.list() })
					const unsub = manager.subscribe((payload) => send('connections', payload))
					const unsubPrompts = manager.sshPrompts.subscribe((prompts) => send('ssh-prompts', { prompts }))
					const unsubDbChanges = manager.subscribeDbChanges((ev) => send('db-changed', ev))
					const unsubSchemaChanges = manager.subscribeSchemaChanges((ev) => send('schema-changed', ev))
					const ping = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(': ping\n\n'))
						} catch {}
					}, 25_000)
					ping.unref?.()
					cleanup = () => {
						unsub()
						unsubPrompts()
						unsubDbChanges()
						unsubSchemaChanges()
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

		// Internal SSH_ASKPASS callback (authenticated by per-process secretId token in env)
		if (path === '/api/internal/ssh-askpass' && method === 'POST') {
			if (!manager.sshPrompts.verifyToken(req.headers.get('x-datadip-askpass-token'))) {
				throw new HttpError(403, 'Forbidden')
			}
			const body = await readBody<{ host?: string; prompt?: string; askpassMode?: string }>(req)
			const result = await manager.sshPrompts.requestPrompt(
				{
					host: body.host ?? 'remote',
					prompt: body.prompt ?? 'SSH authentication required',
					askpassMode: body.askpassMode,
				},
				req.signal,
				{ hasUiClient: () => manager.hasSubscribers() },
			)
			return asonResponse(result)
		}

		// Interactive SSH auth prompts for UI clients
		if (path === '/api/ssh/prompts' && method === 'GET') {
			return asonResponse({ prompts: manager.sshPrompts.list() })
		}
		const sshPromptMatch = /^\/api\/ssh\/prompts\/([^/]+)$/.exec(path)
		if (sshPromptMatch && method === 'POST') {
			const promptId = decodeURIComponent(sshPromptMatch[1]!)
			const body = await readBody<{ answer?: string; cancelled?: boolean }>(req)
			const ok = manager.sshPrompts.respond(promptId, body)
			if (!ok) throw new HttpError(404, 'SSH prompt expired or already answered')
			return asonResponse({ ok: true })
		}

		// SSH config host alias picker
		if (path === '/api/ssh/hosts' && method === 'GET') {
			return asonResponse({ hosts: listSshConfigHosts() })
		}

		// Explicit user-confirmed remote Bun installer (never called automatically)
		if (path === '/api/ssh/install-bun' && method === 'POST') {
			const body = await readBody<{ sshHost?: string; sshUser?: string; sshPort?: number }>(req)
			if (!body.sshHost?.trim()) throw new HttpError(400, 'SSH host is required')
			const res = await manager.installRemoteBun({
				sshHost: body.sshHost.trim(),
				sshUser: body.sshUser?.trim() || undefined,
				sshPort: body.sshPort ? Number(body.sshPort) : undefined,
			})
			return asonResponse(res)
		}

		// Cross-connection searchable query history
		if (path === '/api/history' && method === 'GET') {
			const connFilter = url.searchParams.get('connectionId') || 'all'
			const q = url.searchParams.get('q') || undefined
			const limit = Number(url.searchParams.get('limit')) || 100
			return asonResponse({
				history: manager.store.listQueryHistory(connFilter, limit, q, manager.getOrphanedConfigs()),
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
				preset?: DiscoverPreset
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
			const location =
				body.location === 'ssh' || body.location === 'turso' || body.location === 'd1' ? body.location : 'local'
			const sshRuntime =
				body.sshRuntime === 'bun' ||
				body.sshRuntime === 'python3' ||
				body.sshRuntime === 'sqlite3' ||
				body.sshRuntime === 'auto'
					? body.sshRuntime
					: undefined
			const conn = manager.store.addConnection({
				name: body.name.trim(),
				driver: body.driver === 'postgres' ? 'postgres' : 'sqlite',
				location,
				path: body.path.trim(),
				sshHost: body.sshHost?.trim() || undefined,
				sshUser: body.sshUser?.trim() || undefined,
				sshPort: body.sshPort ? Number(body.sshPort) : undefined,
				sshRuntime: location === 'ssh' ? sshRuntime : undefined,
				authToken: location === 'turso' || location === 'd1' ? body.authToken?.trim() || undefined : undefined,
				isProduction: Boolean(body.isProduction),
				alwaysReadOnly: Boolean(body.alwaysReadOnly) || undefined,
				group: body.group?.trim() || undefined,
				tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).trim()).filter(Boolean) : undefined,
				color: body.color,
				pinned: Boolean(body.pinned),
				virtualForeignKeys: Array.isArray(body.virtualForeignKeys) ? body.virtualForeignKeys : undefined,
				ignoredForeignKeys: Array.isArray(body.ignoredForeignKeys) ? body.ignoredForeignKeys : undefined,
			})
			return asonResponse({ connection: conn }, 201)
		}
		if (path === '/api/connections/test' && method === 'POST') {
			const body = await readBody<Omit<ConnectionConfig, 'id' | 'createdAt'>>(req)
			const result = await manager.testDraftConnection(body)
			return asonResponse(result)
		}
		if (path === '/api/connections/open-file' && method === 'POST') {
			const body = await readBody<{ path?: string }>(req)
			if (!body.path?.trim()) throw new HttpError(400, 'File path is required')
			const connection = manager.openLocalFile(body.path)
			return asonResponse({ connection })
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

			if (rest === 'disconnect' && method === 'POST') {
				const disconnected = manager.dropConnection(connId)
				return asonResponse({ ok: true, disconnected })
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
				const schema = await manager.getSchema(connId)
				return asonResponse(schema)
			}

			if (rest === 'virtual-fks' && (method === 'POST' || method === 'DELETE')) {
				const body = await readBody<Partial<VirtualForeignKey>>(req)
				const fk: VirtualForeignKey = {
					fromTable: String(body.fromTable ?? '').trim(),
					fromColumn: String(body.fromColumn ?? '').trim(),
					toTable: String(body.toTable ?? '').trim(),
					toColumn: String(body.toColumn ?? '').trim(),
				}
				if (!fk.fromTable || !fk.fromColumn || !fk.toTable || !fk.toColumn) {
					throw new HttpError(400, 'fromTable, fromColumn, toTable, and toColumn are required')
				}
				const virtualForeignKeys =
					method === 'POST'
						? manager.store.addVirtualForeignKey(connId, fk)
						: manager.store.removeVirtualForeignKey(connId, fk)
				if (virtualForeignKeys === null) {
					throw new HttpError(404, 'Connection not found in connections.ason')
				}
				return asonResponse({ virtualForeignKeys })
			}

			if (rest === 'ignored-fks' && (method === 'POST' || method === 'DELETE')) {
				const body = await readBody<Partial<IgnoredForeignKey>>(req)
				const target: IgnoredForeignKey = {
					fromTable: String(body.fromTable ?? '').trim(),
					fromColumn: String(body.fromColumn ?? '').trim(),
				}
				if (!target.fromTable || !target.fromColumn) {
					throw new HttpError(400, 'fromTable and fromColumn are required')
				}
				const ignoredForeignKeys =
					method === 'POST'
						? manager.store.addIgnoredForeignKey(connId, target)
						: manager.store.removeIgnoredForeignKey(connId, target)
				if (ignoredForeignKeys === null) {
					throw new HttpError(404, 'Connection not found in connections.ason')
				}
				return asonResponse({ ignoredForeignKeys })
			}

			if (rest === 'browse' && method === 'POST') {
				const body = await readBody<BrowseParams>(req)
				const result = await manager.browseTable(connId, body)
				return asonResponse(result)
			}

			if (rest === 'query' && method === 'POST') {
				const body = await readBody<{
					sql: string
					confirmedDestructive?: boolean
					maxRows?: number
					queryId?: string
				}>(req)
				const result = await manager.runQuery(connId, body.sql ?? '', {
					confirmedDestructive: Boolean(body.confirmedDestructive),
					maxRows: body.maxRows,
					queryId: body.queryId,
				})
				return asonResponse(result)
			}

			if (rest === 'query/cancel' && method === 'POST') {
				const body = await readBody<{ queryId: string }>(req)
				const cancelled = body.queryId ? await manager.cancelQuery(connId, body.queryId) : false
				return asonResponse({ ok: true, cancelled })
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
				const counts = await manager.countReverseFks(connId, body.table, body.row)
				return asonResponse({ counts })
			}

			if (rest === 'search-id' && method === 'POST') {
				const body = await readBody<{ value: string }>(req)
				const { adapter } = manager.getAdapterById(connId)
				const matches = await adapter.searchId(body.value ?? '')
				return asonResponse({ matches })
			}

			if (rest === 'profile' && method === 'POST') {
				const body = await readBody<{ table?: string; column?: string }>(req)
				if (!body.table || !body.column) throw new HttpError(400, 'Table and column are required')
				const profile = await manager.profileColumn(connId, body.table, body.column)
				return asonResponse({ profile })
			}

			if (rest === 'info' && method === 'GET') {
				const info = await manager.getDbInfo(connId)
				return asonResponse({ info })
			}

			if (rest === 'maintenance' && method === 'POST') {
				const body = await readBody<{ action?: 'wal_checkpoint' | 'vacuum' }>(req)
				if (body.action !== 'wal_checkpoint' && body.action !== 'vacuum') {
					throw new HttpError(400, 'Invalid maintenance action')
				}
				const result = await manager.runMaintenance(connId, body.action)
				return asonResponse(result)
			}

			if (rest === 'export' && method === 'POST') {
				const body = await readBody<{
					mode?: 'table' | 'query'
					format?: ExportFormat
					browse?: BrowseParams
					sql?: string
					filename?: string
					maxRows?: number
				}>(req)
				const format = body.format && body.format in EXPORT_MIME ? body.format : 'csv'
				const exported = await manager.exportData(connId, {
					mode: body.mode === 'query' ? 'query' : 'table',
					format,
					browse: body.browse,
					sql: body.sql,
					filename: body.filename,
					maxRows: body.maxRows,
				})
				const meta = EXPORT_MIME[format]
				return new Response(exported.body, {
					status: 200,
					headers: {
						'content-type': meta.contentType,
						'content-disposition': `attachment; filename="${exported.filename}"`,
						'x-datadip-row-count': String(exported.rowCount),
						'x-datadip-truncated': exported.truncated ? '1' : '0',
					},
				})
			}

			// Consoles per connection
			if (rest === 'consoles' && method === 'GET') {
				return asonResponse({ consoles: manager.store.listConsoles(connId) })
			}
			if (rest === 'consoles' && method === 'POST') {
				const body = await readBody<{ title?: string; sql?: string }>(req)
				const sqlConsole = manager.store.createConsole(connId, body.title || 'Untitled console', body.sql ?? '')
				return asonResponse({ console: sqlConsole }, 201)
			}

			// Query history per connection (with optional substring search)
			if (rest === 'history' && method === 'GET') {
				const limit = Number(url.searchParams.get('limit')) || 100
				const q = url.searchParams.get('q') || undefined
				return asonResponse({ history: manager.store.listQueryHistory(connId, limit, q, manager.getOrphanedConfigs()) })
			}
			if (rest === 'history' && method === 'DELETE') {
				manager.store.clearQueryHistory(connId)
				return asonResponse({ ok: true })
			}
		}

		// Console update/delete by id
		const consoleMatch = /^\/api\/consoles\/([^/]+)$/.exec(path)
		if (consoleMatch) {
			const consoleId = decodeURIComponent(consoleMatch[1]!)
			if (method === 'PUT') {
				const body = await readBody<{ title?: string; sql?: string; pinned?: boolean }>(req)
				const updated = manager.store.updateConsole(consoleId, body)
				if (!updated) throw new HttpError(404, 'Console not found')
				return asonResponse({ console: updated })
			}
			if (method === 'DELETE') {
				const ok = manager.store.deleteConsole(consoleId)
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

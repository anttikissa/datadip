// Zero-dependency Cloudflare D1 adapter speaking the Cloudflare D1 HTTP REST API via native fetch().
import {
	AsyncSqliteAdapter,
	type SqliteQueryResult,
	type SqliteQueryRunner,
	type SqliteStatementSpec,
} from './sqlite-async.ts'

interface D1ApiResponse {
	success: boolean
	errors?: { code?: number; message?: string }[]
	result?: {
		results?: Record<string, unknown>[]
		success?: boolean
		meta?: {
			changes?: number
			last_row_id?: number | string | null
		}
	}[]
}

export interface ParsedD1Target {
	accountId: string
	databaseId: string
	endpoint: string
}

// Parses `d1://<accountId>/<databaseId>` (optional loopback `?endpoint=http://127.0.0.1:...` for local testing).
export function parseD1Path(rawPath: string): ParsedD1Target {
	const trimmed = rawPath.trim()
	const m = /^d1:\/\/([^/?#]+)\/([^/?#]+)(?:\?(.*))?$/i.exec(trimmed)
	if (!m) {
		throw new Error('Cloudflare D1 path must be d1://<accountId>/<databaseId>')
	}
	const accountId = decodeURIComponent(m[1]!)
	const databaseId = decodeURIComponent(m[2]!)
	if (!accountId || !databaseId) {
		throw new Error('Cloudflare D1 accountId and databaseId are required')
	}
	let base = 'https://api.cloudflare.com/client/v4'
	if (m[3]) {
		const sp = new URLSearchParams(m[3])
		const custom = sp.get('endpoint')
		if (custom) {
			const u = new URL(custom)
			if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
				throw new Error('Custom D1 endpoint is only permitted for localhost/127.0.0.1')
			}
			base = u.toString().replace(/\/+$/, '')
		}
	}
	return {
		accountId,
		databaseId,
		endpoint: `${base}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
	}
}

class D1Runner implements SqliteQueryRunner {
	readonly runtimeName = 'd1'
	readonly supportsMaintenance = false
	private readonly target: ParsedD1Target
	private readonly authToken: string
	private readonly activeControllers = new Map<string, AbortController>()

	constructor(rawPath: string, authToken?: string) {
		this.target = parseD1Path(rawPath)
		const token = authToken?.trim()
		if (!token) throw new Error('Cloudflare D1 API Token is required')
		this.authToken = token
	}

	async query(
		sql: string,
		params?: unknown[],
		opts?: { writable?: boolean; queryId?: string },
	): Promise<SqliteQueryResult> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 30_000)
		if (opts?.queryId) this.activeControllers.set(opts.queryId, controller)
		try {
			const body: Record<string, unknown> = { sql }
			if (params && params.length > 0) {
				body.params = params.map((p) => (p === undefined ? null : typeof p === 'bigint' ? p.toString() : p))
			}
			const res = await fetch(this.target.endpoint, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${this.authToken}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			})
			const text = await res.text()
			let parsed: D1ApiResponse | null = null
			try {
				parsed = JSON.parse(text) as D1ApiResponse
			} catch {}
			if (!res.ok || !parsed?.success) {
				const errMsg =
					parsed?.errors
						?.map((e) => e.message)
						.filter(Boolean)
						.join('; ') ||
					text.trim() ||
					`Cloudflare D1 HTTP ${res.status}`
				throw new Error(errMsg)
			}
			const first = parsed.result?.[0]
			const rows = Array.isArray(first?.results) ? first.results : []
			const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
			return {
				columns,
				rows,
				changes: Number(first?.meta?.changes ?? 0),
				lastInsertRowid: first?.meta?.last_row_id ?? null,
			}
		} catch (err) {
			if (controller.signal.aborted) throw new Error('Query cancelled')
			throw err
		} finally {
			clearTimeout(timeout)
			if (opts?.queryId) this.activeControllers.delete(opts.queryId)
		}
	}

	async batch(
		stmts: SqliteStatementSpec[],
		opts?: { writable?: boolean; transactional?: boolean; queryId?: string },
	): Promise<SqliteQueryResult[]> {
		const out: SqliteQueryResult[] = []
		for (const s of stmts) {
			out.push(await this.query(s.sql, s.params, { writable: opts?.writable, queryId: opts?.queryId }))
		}
		return out
	}

	async cancelQuery(queryId: string): Promise<boolean> {
		const ctrl = this.activeControllers.get(queryId)
		if (!ctrl) return false
		ctrl.abort()
		this.activeControllers.delete(queryId)
		return true
	}

	getExtraInfo() {
		return {
			runtime: 'Cloudflare D1 (REST API)',
			currentDatabase: this.target.databaseId,
		}
	}

	close() {
		for (const ctrl of this.activeControllers.values()) ctrl.abort()
		this.activeControllers.clear()
	}
}

export function createD1Adapter(rawPath: string, authToken?: string): AsyncSqliteAdapter {
	return new AsyncSqliteAdapter(new D1Runner(rawPath, authToken))
}

// Zero-dependency Turso / libSQL adapter speaking Hrana v2 over HTTP (/v2/pipeline) via native fetch().
import {
	AsyncSqliteAdapter,
	type SqliteQueryResult,
	type SqliteQueryRunner,
	type SqliteStatementSpec,
} from './sqlite-async.ts'

interface HranaValue {
	type: 'null' | 'integer' | 'float' | 'text' | 'blob'
	value?: string | number
	base64?: string
}

interface HranaResult {
	cols?: { name: string | null; decltype?: string | null }[]
	rows?: HranaValue[][]
	affected_row_count?: number
	last_insert_rowid?: string | null
}

interface HranaBatchResult {
	step_results?: (HranaResult | null)[]
	step_errors?: ({ message?: string; code?: string } | null)[]
}

interface HranaPipelineResponse {
	results?: {
		type: 'ok' | 'error'
		response?: { type: string; result?: HranaResult | HranaBatchResult }
		error?: { message?: string; code?: string }
	}[]
}

export function resolveTursoEndpoint(rawUrl: string, explicitToken?: string): { endpoint: string; authToken?: string } {
	const trimmed = rawUrl.trim()
	if (!trimmed) throw new Error('Turso / libSQL URL is required')
	const normalized = /^libsql:\/\//i.test(trimmed)
		? 'https://' + trimmed.slice('libsql://'.length)
		: /^wss?:\/\//i.test(trimmed)
			? trimmed.replace(/^ws/i, 'http')
			: /^https?:\/\//i.test(trimmed)
				? trimmed
				: `https://${trimmed}`
	let u: URL
	try {
		u = new URL(normalized)
	} catch {
		throw new Error(`Invalid Turso / libSQL URL: ${trimmed}`)
	}
	const urlToken = u.searchParams.get('authToken') || u.searchParams.get('token') || undefined
	u.searchParams.delete('authToken')
	u.searchParams.delete('token')
	const base = u.toString().replace(/\/+$/, '')
	const endpoint = base.endsWith('/v2/pipeline') ? base : `${base}/v2/pipeline`
	return { endpoint, authToken: explicitToken?.trim() || urlToken }
}

function encodeHranaArg(val: unknown): HranaValue {
	if (val === null || val === undefined) return { type: 'null' }
	if (typeof val === 'bigint') return { type: 'integer', value: val.toString() }
	if (typeof val === 'number') {
		if (!Number.isFinite(val)) return { type: 'null' }
		if (Number.isInteger(val)) return { type: 'integer', value: String(val) }
		return { type: 'float', value: val }
	}
	if (typeof val === 'boolean') return { type: 'integer', value: val ? '1' : '0' }
	if (val instanceof Uint8Array) {
		return { type: 'blob', base64: Buffer.from(val).toString('base64') }
	}
	return { type: 'text', value: String(val) }
}

function decodeHranaValue(v: HranaValue | undefined): unknown {
	if (!v || v.type === 'null') return null
	if (v.type === 'integer') {
		const raw = String(v.value ?? '0')
		const n = Number(raw)
		return Number.isSafeInteger(n) ? n : raw
	}
	if (v.type === 'float') return Number(v.value ?? 0)
	if (v.type === 'blob') {
		const bytes = v.base64 ? Buffer.from(v.base64, 'base64') : new Uint8Array()
		const preview = Array.from(bytes.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('')
		return `<BLOB ${bytes.length}B 0x${preview}${bytes.length > 32 ? '…' : ''}>`
	}
	return v.value ?? ''
}

function parseHranaResult(res?: HranaResult): SqliteQueryResult {
	const columns = (res?.cols ?? []).map((c, i) => c.name || `col_${i}`)
	const rows: Record<string, unknown>[] = []
	for (const rawRow of res?.rows ?? []) {
		const obj: Record<string, unknown> = {}
		for (let i = 0; i < columns.length; i++) {
			obj[columns[i]!] = decodeHranaValue(rawRow[i])
		}
		rows.push(obj)
	}
	const lastId = res?.last_insert_rowid
	const parsedLastId =
		lastId === null || lastId === undefined ? null : Number.isSafeInteger(Number(lastId)) ? Number(lastId) : lastId
	return {
		columns,
		rows,
		changes: Number(res?.affected_row_count ?? 0),
		lastInsertRowid: parsedLastId,
	}
}

class TursoRunner implements SqliteQueryRunner {
	readonly runtimeName = 'turso'
	readonly supportsMaintenance = false
	private readonly endpoint: string
	private readonly authToken?: string
	private readonly activeControllers = new Map<string, AbortController>()

	constructor(rawUrl: string, authToken?: string) {
		const resolved = resolveTursoEndpoint(rawUrl, authToken)
		this.endpoint = resolved.endpoint
		this.authToken = resolved.authToken
	}

	private async postPipeline(
		requests: unknown[],
		queryId?: string,
	): Promise<NonNullable<HranaPipelineResponse['results']>> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), 30_000)
		if (queryId) this.activeControllers.set(queryId, controller)
		try {
			const headers: Record<string, string> = { 'content-type': 'application/json' }
			if (this.authToken) headers.authorization = `Bearer ${this.authToken}`
			const res = await fetch(this.endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify({ requests }),
				signal: controller.signal,
			})
			const text = await res.text()
			if (!res.ok) {
				let detail = text.trim()
				try {
					const j = JSON.parse(text) as { error?: string; message?: string }
					detail = j.error || j.message || detail
				} catch {}
				throw new Error(`Turso HTTP ${res.status}: ${detail || res.statusText}`)
			}
			const parsed = JSON.parse(text) as HranaPipelineResponse
			if (!Array.isArray(parsed.results)) throw new Error('Invalid Hrana pipeline response from Turso')
			return parsed.results
		} catch (err) {
			if (controller.signal.aborted) throw new Error('Query cancelled')
			throw err
		} finally {
			clearTimeout(timeout)
			if (queryId) this.activeControllers.delete(queryId)
		}
	}

	async query(
		sql: string,
		params?: unknown[],
		opts?: { writable?: boolean; queryId?: string },
	): Promise<SqliteQueryResult> {
		const results = await this.batch([{ sql, params }], {
			writable: opts?.writable,
			transactional: false,
			queryId: opts?.queryId,
		})
		return results[0] ?? { columns: [], rows: [], changes: 0, lastInsertRowid: null }
	}

	async batch(
		stmts: SqliteStatementSpec[],
		opts?: { writable?: boolean; transactional?: boolean; queryId?: string },
	): Promise<SqliteQueryResult[]> {
		if (stmts.length === 0) return []
		const requests: unknown[] = []
		let offset = 0

		// Explicitly set PRAGMA query_only per pipeline stream so RO streams cannot write and RW streams always work.
		requests.push({
			type: 'execute',
			stmt: { sql: opts?.writable ? 'PRAGMA query_only = OFF' : 'PRAGMA query_only = ON' },
		})
		offset++

		if (opts?.transactional) {
			// Use Hrana v2 conditional batch so any failing statement triggers ROLLBACK atomically.
			const steps: { condition?: unknown; stmt: Record<string, unknown> }[] = [{ stmt: { sql: 'BEGIN' } }]
			for (let i = 0; i < stmts.length; i++) {
				const s = stmts[i]!
				const stmtObj: Record<string, unknown> = { sql: s.sql }
				if (s.params && s.params.length > 0) stmtObj.args = s.params.map(encodeHranaArg)
				steps.push({ condition: { type: 'ok', step: i }, stmt: stmtObj })
			}
			const lastStmtStep = stmts.length
			steps.push({ condition: { type: 'ok', step: lastStmtStep }, stmt: { sql: 'COMMIT' } })
			steps.push({ condition: { type: 'not', cond: { type: 'ok', step: lastStmtStep } }, stmt: { sql: 'ROLLBACK' } })

			requests.push({ type: 'batch', batch: { steps } })
			requests.push({ type: 'close' })

			const raw = await this.postPipeline(requests, opts?.queryId)
			const batchItem = raw[offset]
			if (!batchItem) throw new Error('Missing batch response from Turso')
			if (batchItem.type === 'error') {
				throw new Error(batchItem.error?.message || batchItem.error?.code || 'Turso batch failed')
			}
			const batchRes = batchItem.response?.result as HranaBatchResult | undefined
			const stepErrors = batchRes?.step_errors ?? []
			const stepResults = batchRes?.step_results ?? []
			const firstErr = stepErrors.find((e) => e !== null && e !== undefined)
			if (firstErr) {
				throw new Error(firstErr.message || firstErr.code || 'Turso transaction failed (rolled back)')
			}
			const out: SqliteQueryResult[] = []
			for (let i = 0; i < stmts.length; i++) {
				out.push(parseHranaResult(stepResults[i + 1] ?? undefined))
			}
			return out
		}

		for (const s of stmts) {
			const stmtObj: Record<string, unknown> = { sql: s.sql }
			if (s.params && s.params.length > 0) stmtObj.args = s.params.map(encodeHranaArg)
			requests.push({ type: 'execute', stmt: stmtObj })
		}
		requests.push({ type: 'close' })

		const raw = await this.postPipeline(requests, opts?.queryId)
		const out: SqliteQueryResult[] = []
		for (let i = 0; i < stmts.length; i++) {
			const item = raw[offset + i]
			if (!item) throw new Error('Missing statement response in Turso pipeline')
			if (item.type === 'error') {
				throw new Error(item.error?.message || item.error?.code || 'Turso query error')
			}
			out.push(parseHranaResult(item.response?.result as HranaResult | undefined))
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
		return { runtime: 'turso (Hrana HTTP)' }
	}

	close() {
		for (const ctrl of this.activeControllers.values()) ctrl.abort()
		this.activeControllers.clear()
	}
}

export function createTursoAdapter(rawUrl: string, authToken?: string): AsyncSqliteAdapter {
	return new AsyncSqliteAdapter(new TursoRunner(rawUrl, authToken))
}

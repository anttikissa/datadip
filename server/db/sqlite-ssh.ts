// Remote SQLite adapter backed by the multiplexed SSH worker (Bun, Python 3, or sqlite3 CLI).
import type {
	BrowseParams,
	BrowseResult,
	ColumnProfile,
	DatabaseInfo,
	DatabaseSchema,
	IdMatch,
	MutateRequest,
	MutateResponse,
	QueryStatementResult,
	ReverseFkCount,
	ReverseForeignKeyInfo,
	SshResolvedRuntime,
} from '../../src/shared/types.ts'
import {
	AsyncSqliteAdapter,
	formatSqlWithParams,
	type SqliteQueryResult,
	type SqliteQueryRunner,
	type SqliteStatementSpec,
} from './sqlite-async.ts'
import type { SshHostChannel, SshMuxPool, SshTarget } from './ssh-mux.ts'
import type { DbAdapter } from './types.ts'

function b64(s: string): string {
	return Buffer.from(s, 'utf8').toString('base64')
}

// Adapts the persistent remote POSIX sh + sqlite3 CLI worker to AsyncSqliteAdapter.
class SshSqliteCliRunner implements SqliteQueryRunner {
	readonly runtimeName = 'sqlite3'
	readonly supportsMaintenance = true
	private readonly getChannel: () => SshHostChannel
	private readonly dbPath: string
	private lastSizes: { file: number | null; wal: number | null; shm: number | null } = {
		file: null,
		wal: null,
		shm: null,
	}

	constructor(getChannel: () => SshHostChannel, dbPath: string) {
		this.getChannel = getChannel
		this.dbPath = dbPath
	}

	async refreshFileSizes(): Promise<void> {
		try {
			const res = await this.getChannel().callCli('stat', [b64(this.dbPath)], 10_000)
			if (res.rc === 0) {
				const [f, w, s] = res.stdout.split('\t')
				const parseNum = (v?: string) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null)
				this.lastSizes = { file: parseNum(f), wal: parseNum(w), shm: parseNum(s) }
			}
		} catch {}
	}

	async query(
		sql: string,
		params?: unknown[],
		opts?: { writable?: boolean; queryId?: string },
	): Promise<SqliteQueryResult> {
		const rendered = formatSqlWithParams(sql, params).trim()
		const withSemi = rendered.endsWith(';') ? rendered : `${rendered};`
		const ch = this.getChannel()
		const res = await ch.callCli(
			'exec',
			[opts?.writable ? '1' : '0', b64(this.dbPath), b64(withSemi)],
			60_000,
			opts?.queryId,
		)
		if (res.rc !== 0) {
			throw new Error(res.stderr.trim() || `sqlite3 exited with status ${res.rc}`)
		}
		const trimmed = res.stdout.trim()
		if (!trimmed) {
			return { columns: [], rows: [], changes: opts?.writable ? 1 : 0, lastInsertRowid: null }
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(trimmed)
		} catch {
			// Multiple JSON arrays can occur if SQL emitted multiple result sets; take the last valid array.
			const lines = trimmed.split('\n').filter(Boolean)
			parsed = JSON.parse(lines[lines.length - 1] ?? '[]')
		}
		const rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
		const columns = rows.length > 0 ? Object.keys(rows[0]!) : []
		return { columns, rows, changes: 0, lastInsertRowid: null }
	}

	async batch(
		stmts: SqliteStatementSpec[],
		opts?: { writable?: boolean; transactional?: boolean; queryId?: string },
	): Promise<SqliteQueryResult[]> {
		if (stmts.length === 0) return []
		if (opts?.transactional && opts.writable) {
			const lines = ['BEGIN;']
			for (const s of stmts) {
				const rendered = formatSqlWithParams(s.sql, s.params).trim()
				lines.push(rendered.endsWith(';') ? rendered : `${rendered};`)
			}
			lines.push('COMMIT;')
			lines.push('SELECT total_changes() AS c;')
			const res = await this.query(lines.join('\n'), undefined, { writable: true, queryId: opts.queryId })
			const totalChanges = Number(res.rows[0]?.c ?? stmts.length)
			return stmts.map((_, i) => ({
				columns: [],
				rows: [],
				changes: i === 0 ? totalChanges : 0,
				lastInsertRowid: null,
			}))
		}
		const out: SqliteQueryResult[] = []
		for (const s of stmts) {
			out.push(await this.query(s.sql, s.params, { writable: opts?.writable, queryId: opts?.queryId }))
		}
		return out
	}

	getExtraInfo() {
		return {
			runtime: 'sqlite3',
			fileSizeBytes: this.lastSizes.file,
			walSizeBytes: this.lastSizes.wal,
			shmSizeBytes: this.lastSizes.shm,
		}
	}

	close() {
		// Shared channel owned by SshMuxPool
	}
}

export class SshSqliteAdapter implements DbAdapter {
	readonly driver = 'sqlite' as const
	private readonly pool: SshMuxPool
	private readonly target: SshTarget
	private readonly dbPath: string
	private readonly cliRunner: SshSqliteCliRunner
	private readonly cliAdapter: AsyncSqliteAdapter
	private readonly directChannel?: SshHostChannel

	constructor(pool: SshMuxPool, target: SshTarget, dbPath: string, directChannel?: SshHostChannel) {
		this.pool = pool
		this.target = target
		this.dbPath = dbPath
		this.directChannel = directChannel
		this.cliRunner = new SshSqliteCliRunner(() => this.channel(), dbPath)
		this.cliAdapter = new AsyncSqliteAdapter(this.cliRunner)
	}

	private channel(): SshHostChannel {
		return this.directChannel ?? this.pool.getChannel(this.target)
	}

	getResolvedRuntime(): SshResolvedRuntime | undefined {
		return this.channel().getRuntime()
	}

	private async isCliRuntime(): Promise<boolean> {
		const rt = await this.channel().ensureConnected()
		return rt === 'sqlite3'
	}

	private rpc<T>(op: string, params?: unknown, rw = false): Promise<T> {
		return this.channel().call<T>({ op, path: this.dbPath, rw, params })
	}

	async ping() {
		const t0 = performance.now()
		if (await this.isCliRuntime()) {
			const res = await this.cliAdapter.ping()
			return { ...res, runtime: 'sqlite3' as SshResolvedRuntime }
		}
		const res = await this.rpc<{ ok: true; latencyMs: number; version?: string; runtime?: SshResolvedRuntime }>('ping')
		return {
			ok: true as const,
			latencyMs: Math.round((performance.now() - t0) * 100) / 100,
			version: res.version,
			runtime: res.runtime ?? this.channel().getRuntime(),
		}
	}

	async getSchema(): Promise<DatabaseSchema> {
		if (await this.isCliRuntime()) return this.cliAdapter.getSchema()
		return this.rpc<DatabaseSchema>('schema')
	}

	async browseTable(params: BrowseParams): Promise<BrowseResult> {
		if (await this.isCliRuntime()) return this.cliAdapter.browseTable(params)
		return this.rpc<BrowseResult>('browse', params)
	}

	async executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number; queryId?: string },
	): Promise<QueryStatementResult[]> {
		if (await this.isCliRuntime()) return this.cliAdapter.executeStatements(statements, options)
		return this.channel().call<QueryStatementResult[]>(
			{ op: 'query', path: this.dbPath, rw: options.writable, params: { statements, maxRows: options.maxRows } },
			600_000,
			options.queryId,
		)
	}

	cancelQuery(queryId: string): Promise<boolean> {
		return this.channel().cancel(queryId)
	}

	async mutate(req: MutateRequest): Promise<MutateResponse> {
		if (await this.isCliRuntime()) return this.cliAdapter.mutate(req)
		return this.rpc<MutateResponse>('mutate', req, true)
	}

	async peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null> {
		if (await this.isCliRuntime()) return this.cliAdapter.peekRow(table, column, value)
		return this.rpc<Record<string, unknown> | null>('peek', { table, column, value })
	}

	async countReverseFks(
		table: string,
		row: Record<string, unknown>,
		extraReverseFks?: ReverseForeignKeyInfo[],
	): Promise<ReverseFkCount[]> {
		if (await this.isCliRuntime()) return this.cliAdapter.countReverseFks(table, row, extraReverseFks)
		return this.rpc<ReverseFkCount[]>('reverseFks', { table, row, extraReverseFks })
	}

	async checkKeysExist(
		probes: { table: string; column: string; values: string[] }[],
	): Promise<{ table: string; column: string; matchedValues: string[] }[]> {
		if (await this.isCliRuntime()) return this.cliAdapter.checkKeysExist(probes)
		return this.rpc<{ table: string; column: string; matchedValues: string[] }[]>('checkKeys', { probes })
	}

	async searchId(value: string): Promise<IdMatch[]> {
		if (await this.isCliRuntime()) return this.cliAdapter.searchId(value)
		return this.rpc<IdMatch[]>('searchId', { value })
	}

	async profileColumn(table: string, column: string): Promise<ColumnProfile> {
		if (await this.isCliRuntime()) return this.cliAdapter.profileColumn(table, column)
		return this.rpc<ColumnProfile>('profileColumn', { table, column })
	}

	async getInfo(): Promise<DatabaseInfo> {
		if (await this.isCliRuntime()) {
			await this.cliRunner.refreshFileSizes()
			return this.cliAdapter.getInfo()
		}
		return this.rpc<DatabaseInfo>('info')
	}

	async runMaintenance(action: 'wal_checkpoint' | 'vacuum') {
		if (await this.isCliRuntime()) return this.cliAdapter.runMaintenance(action)
		return this.rpc<{ ok: true; message: string; durationMs: number }>('maintenance', { action }, true)
	}

	close() {
		this.cliAdapter.close()
		// Shared SSH channel is owned by SshMuxPool
	}
}

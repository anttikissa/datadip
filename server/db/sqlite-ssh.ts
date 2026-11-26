// Remote SQLite adapter backed by the multiplexed SSH Bun worker.
import type {
	BrowseParams,
	BrowseResult,
	DatabaseSchema,
	IdMatch,
	MutateRequest,
	MutateResponse,
	QueryStatementResult,
	ReverseFkCount,
} from '../../src/shared/types.ts'
import type { SshMuxPool, SshTarget } from './ssh-mux.ts'
import type { DbAdapter } from './types.ts'

export class SshSqliteAdapter implements DbAdapter {
	readonly driver = 'sqlite' as const
	private readonly pool: SshMuxPool
	private readonly target: SshTarget
	private readonly dbPath: string

	constructor(pool: SshMuxPool, target: SshTarget, dbPath: string) {
		this.pool = pool
		this.target = target
		this.dbPath = dbPath
	}

	private rpc<T>(op: string, params?: unknown, rw = false): Promise<T> {
		return this.pool.getChannel(this.target).call<T>({ op, path: this.dbPath, rw, params })
	}

	async ping() {
		const t0 = performance.now()
		const res = await this.rpc<{ ok: true; latencyMs: number; version?: string }>('ping')
		return {
			ok: true as const,
			latencyMs: Math.round((performance.now() - t0) * 100) / 100,
			version: res.version,
		}
	}

	getSchema(): Promise<DatabaseSchema> {
		return this.rpc<DatabaseSchema>('schema')
	}

	browseTable(params: BrowseParams): Promise<BrowseResult> {
		return this.rpc<BrowseResult>('browse', params)
	}

	executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number; queryId?: string },
	): Promise<QueryStatementResult[]> {
		return this.pool
			.getChannel(this.target)
			.call<QueryStatementResult[]>(
				{ op: 'query', path: this.dbPath, rw: options.writable, params: { statements, maxRows: options.maxRows } },
				600_000,
				options.queryId,
			)
	}

	cancelQuery(queryId: string): Promise<boolean> {
		return this.pool.getChannel(this.target).cancel(queryId)
	}

	mutate(req: MutateRequest): Promise<MutateResponse> {
		return this.rpc<MutateResponse>('mutate', req, true)
	}

	peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null> {
		return this.rpc<Record<string, unknown> | null>('peek', { table, column, value })
	}

	countReverseFks(table: string, row: Record<string, unknown>): Promise<ReverseFkCount[]> {
		return this.rpc<ReverseFkCount[]>('reverseFks', { table, row })
	}

	searchId(value: string): Promise<IdMatch[]> {
		return this.rpc<IdMatch[]>('searchId', { value })
	}

	close() {
		// Shared SSH channel is owned by SshMuxPool
	}
}

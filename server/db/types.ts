// Driver-agnostic database adapter interface so SQLite, SSH-SQLite, and future Postgres adapters share one contract.
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

export interface DbAdapter {
	readonly driver: 'sqlite' | 'postgres'
	ping(): Promise<{ ok: true; latencyMs: number; version?: string }>
	getSchema(): Promise<DatabaseSchema>
	browseTable(params: BrowseParams): Promise<BrowseResult>
	executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number },
	): Promise<QueryStatementResult[]>
	mutate(req: MutateRequest): Promise<MutateResponse>
	peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null>
	countReverseFks(table: string, row: Record<string, unknown>): Promise<ReverseFkCount[]>
	searchId(value: string): Promise<IdMatch[]>
	close(): void
}

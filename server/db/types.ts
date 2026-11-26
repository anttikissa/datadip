// Driver-agnostic database adapter interface so SQLite, SSH-SQLite, and future Postgres adapters share one contract.
import type {
	BrowseParams,
	BrowseResult,
	ColumnProfile,
	DatabaseInfo,
	DatabaseSchema,
	IdMatch,
	KeyExistenceProbe,
	KeyExistenceResult,
	MutateRequest,
	MutateResponse,
	QueryStatementResult,
	ReverseFkCount,
	ReverseForeignKeyInfo,
} from '../../src/shared/types.ts'

export interface DbAdapter {
	readonly driver: 'sqlite' | 'postgres'
	ping(): Promise<{ ok: true; latencyMs: number; version?: string }>
	getSchema(): Promise<DatabaseSchema>
	browseTable(params: BrowseParams): Promise<BrowseResult>
	executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number; queryId?: string },
	): Promise<QueryStatementResult[]>
	cancelQuery?(queryId: string): Promise<boolean>
	mutate(req: MutateRequest): Promise<MutateResponse>
	peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null>
	countReverseFks(
		table: string,
		row: Record<string, unknown>,
		extraReverseFks?: ReverseForeignKeyInfo[],
	): Promise<ReverseFkCount[]>
	checkKeysExist?(probes: KeyExistenceProbe[]): Promise<KeyExistenceResult[]>
	searchId(value: string): Promise<IdMatch[]>
	profileColumn(table: string, column: string): Promise<ColumnProfile>
	getInfo(): Promise<DatabaseInfo>
	runMaintenance?(action: 'wal_checkpoint' | 'vacuum'): Promise<{ ok: true; message: string; durationMs: number }>
	close(): void
}

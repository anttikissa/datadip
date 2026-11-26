// Shared data types for DataDip connections, schemas, browsing, queries, and mutations.

export type DriverKind = 'sqlite' | 'postgres'
export type LocationKind = 'local' | 'ssh'

export interface ConnectionConfig {
	id: string
	name: string
	driver: DriverKind
	location: LocationKind
	path: string
	sshHost?: string
	sshUser?: string
	sshPort?: number
	isProduction: boolean
	pinned?: boolean
	createdAt: string
	lastVisitedAt?: string
}

export interface ConnectionWithStatus extends ConnectionConfig {
	rwArmed: boolean
	rwArmedUntil: number | null // epoch ms, null if unlimited or not armed
	connected: boolean
	latencyMs: number | null
}

export interface TableSummary {
	name: string
	type: 'table' | 'view'
	rowCount: number | null
}

export interface ColumnInfo {
	name: string
	type: string
	notNull: boolean
	defaultValue: string | null
	primaryKey: number // 0 = not PK, 1..n = PK position
}

export interface ForeignKeyInfo {
	id: number
	fromColumn: string
	toTable: string
	toColumn: string
	onUpdate: string
	onDelete: string
}

export interface ReverseForeignKeyInfo {
	fromTable: string
	fromColumn: string
	toColumn: string
}

export interface IndexInfo {
	name: string
	unique: boolean
	origin: string
	columns: string[]
}

export interface TableSchema {
	name: string
	type: 'table' | 'view'
	ddl: string
	columns: ColumnInfo[]
	foreignKeys: ForeignKeyInfo[]
	reverseForeignKeys: ReverseForeignKeyInfo[]
	indexes: IndexInfo[]
	primaryKeyColumns: string[]
}

export interface DatabaseSchema {
	tables: TableSummary[]
	schemas: Record<string, TableSchema>
	durationMs: number
}

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'isnull' | 'notnull'

export interface FilterSpec {
	column: string
	op: FilterOp
	value: string
}

export interface OrderSpec {
	column: string
	dir: 'asc' | 'desc'
}

export interface BrowseParams {
	table: string
	fields?: string[]
	filters?: FilterSpec[]
	order?: OrderSpec[]
	limit: number
	start?: string
	direction?: 'next' | 'prev'
	offset?: number
	search?: string
}

export interface BrowseResult {
	table: string
	columns: string[]
	columnTypes: Record<string, string>
	rows: Record<string, unknown>[]
	totalCount: number | null
	hasNext: boolean
	hasPrev: boolean
	nextCursor: string | null
	prevCursor: string | null
	durationMs: number
	generatedSql: string
	keysetColumn: string | null
}

export interface QueryStatementResult {
	sql: string
	columns: string[]
	rows: Record<string, unknown>[]
	rowCount: number
	changes: number
	lastInsertRowid: string | number | null
	durationMs: number
	sourceTable: string | null
	truncated: boolean
	error?: string
}

export interface QueryResponse {
	results: QueryStatementResult[]
	totalDurationMs: number
	needsConfirmation?: boolean
	warnings?: string[]
	rwArmedUntil?: number | null
}

export interface PendingUpdate {
	pk: Record<string, unknown>
	changes: Record<string, unknown>
}

export interface MutateRequest {
	table: string
	updates?: PendingUpdate[]
	inserts?: Record<string, unknown>[]
	deletes?: Record<string, unknown>[]
	confirmedDestructive?: boolean
}

export interface MutateResponse {
	applied: number
	durationMs: number
	sqlPreview: string[]
	needsConfirmation?: boolean
	warnings?: string[]
}

export interface ReverseFkCount {
	fromTable: string
	fromColumn: string
	toColumn: string
	count: number
}

export interface IdMatch {
	table: string
	column: string
	isPrimaryKey: boolean
	row: Record<string, unknown>
}

export interface Scratchpad {
	id: string
	connectionId: string
	title: string
	sql: string
	pinned: boolean
	createdAt: string
	updatedAt: string
}

export interface QueryHistoryEntry {
	id: string
	connectionId: string
	sql: string
	durationMs: number
	rowCount: number
	error: string | null
	executedAt: string
}

export interface RecentTable {
	connectionId: string
	connectionName?: string
	isProduction?: boolean
	tableName: string
	visitedAt: string
}

export interface DiscoveredDb {
	path: string
	sizeBytes: number
	modifiedAt: string
	suggestedName: string
	alreadySaved: boolean
}

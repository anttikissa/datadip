// Local SQLite adapter using bun:sqlite with strict read-only handles by default.
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
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
import {
	browseSqliteTable,
	countSqliteReverseFks,
	executeSqliteStatements,
	getSqliteSchema,
	mutateSqliteTable,
	peekSqliteRow,
	searchSqliteId,
} from './sqlite-ops.ts'
import type { DbAdapter } from './types.ts'

export function expandTilde(path: string): string {
	if (path === '~') return homedir()
	if (path.startsWith('~/')) return homedir() + path.slice(1)
	return path
}

export class LocalSqliteAdapter implements DbAdapter {
	readonly driver = 'sqlite' as const
	private readonly resolvedPath: string
	private roDb: Database | null = null
	private rwDb: Database | null = null

	constructor(filePath: string) {
		this.resolvedPath = expandTilde(filePath)
	}

	private open(writable: boolean): Database {
		if (!existsSync(this.resolvedPath)) {
			throw new Error(`SQLite database file not found: ${this.resolvedPath}`)
		}
		if (writable) {
			if (!this.rwDb) {
				this.rwDb = new Database(this.resolvedPath, { readwrite: true })
				this.rwDb.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
			}
			return this.rwDb
		}
		if (!this.roDb) {
			this.roDb = new Database(this.resolvedPath, { readonly: true })
			this.roDb.exec('PRAGMA busy_timeout = 5000;')
		}
		return this.roDb
	}

	async ping() {
		const t0 = performance.now()
		const db = this.open(false)
		const v = db.query<{ v: string }, []>('SELECT sqlite_version() AS v').get()
		return {
			ok: true as const,
			latencyMs: Math.round((performance.now() - t0) * 100) / 100,
			version: v?.v,
		}
	}

	async getSchema(): Promise<DatabaseSchema> {
		return getSqliteSchema(this.open(false))
	}

	async browseTable(params: BrowseParams): Promise<BrowseResult> {
		return browseSqliteTable(this.open(false), params)
	}

	async executeStatements(
		statements: string[],
		options: { writable: boolean; maxRows?: number },
	): Promise<QueryStatementResult[]> {
		const db = this.open(options.writable)
		return executeSqliteStatements(db, statements, { maxRows: options.maxRows })
	}

	async mutate(req: MutateRequest): Promise<MutateResponse> {
		return mutateSqliteTable(this.open(true), req)
	}

	async peekRow(table: string, column: string, value: unknown): Promise<Record<string, unknown> | null> {
		return peekSqliteRow(this.open(false), table, column, value)
	}

	async countReverseFks(table: string, row: Record<string, unknown>): Promise<ReverseFkCount[]> {
		return countSqliteReverseFks(this.open(false), table, row)
	}

	async searchId(value: string): Promise<IdMatch[]> {
		return searchSqliteId(this.open(false), value)
	}

	close() {
		try {
			this.roDb?.close()
		} catch {}
		try {
			this.rwDb?.close()
		} catch {}
		this.roDb = null
		this.rwDb = null
	}
}

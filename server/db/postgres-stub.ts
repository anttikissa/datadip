// Placeholder Postgres adapter implementing DbAdapter so Postgres can be dropped in cleanly after v1.
import type { DbAdapter } from './types.ts'

export class PostgresAdapterStub implements DbAdapter {
	readonly driver = 'postgres' as const
	private fail(): never {
		throw new Error('PostgreSQL adapter is planned for a future release (the DbAdapter interface is ready).')
	}
	async ping() {
		return this.fail()
	}
	async getSchema() {
		return this.fail()
	}
	async browseTable() {
		return this.fail()
	}
	async executeStatements() {
		return this.fail()
	}
	async mutate() {
		return this.fail()
	}
	async peekRow() {
		return this.fail()
	}
	async countReverseFks() {
		return this.fail()
	}
	async searchId() {
		return this.fail()
	}
	close() {}
}

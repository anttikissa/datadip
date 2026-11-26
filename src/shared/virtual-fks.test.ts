// Unit tests for automatic foreign-key inference and virtual FK schema merging.
import { describe, expect, test } from 'bun:test'
import type { DatabaseSchema, TableSchema } from './types.ts'
import {
	getExtraReverseFksForTable,
	guessTargetTableForColumn,
	inferForeignKeys,
	mergeSchemaForeignKeys,
} from './virtual-fks.ts'

function makeTable(
	name: string,
	columns: { name: string; type: string; primaryKey?: number }[],
	opts?: { type?: 'table' | 'view'; foreignKeys?: TableSchema['foreignKeys'] },
): TableSchema {
	const pkCols = columns
		.filter((c) => (c.primaryKey ?? 0) > 0)
		.sort((a, b) => (a.primaryKey ?? 0) - (b.primaryKey ?? 0))
		.map((c) => c.name)
	return {
		name,
		type: opts?.type ?? 'table',
		ddl: '',
		columns: columns.map((c) => ({
			name: c.name,
			type: c.type,
			notNull: Boolean(c.primaryKey),
			defaultValue: null,
			primaryKey: c.primaryKey ?? 0,
		})),
		foreignKeys: opts?.foreignKeys ?? [],
		reverseForeignKeys: [],
		indexes: [],
		primaryKeyColumns: pkCols,
	}
}

function makeSchema(tables: TableSchema[], internal: string[] = []): DatabaseSchema {
	const schemas: Record<string, TableSchema> = {}
	for (const t of tables) schemas[t.name] = t
	return {
		tables: tables.map((t) => ({
			name: t.name,
			type: t.type,
			rowCount: 10,
			...(internal.includes(t.name) ? { isInternal: true } : {}),
		})),
		schemas,
		durationMs: 1,
	}
}

describe('virtual-fks automatic inference and schema merging', () => {
	test('infers snake_case, irregular plural (-ies/-es), camelCase, and views while respecting schema locality & types', () => {
		const raw = makeSchema([
			makeTable('users', [
				{ name: 'id', type: 'TEXT', primaryKey: 1 },
				{ name: 'email', type: 'TEXT' },
			]),
			makeTable('auth.users', [
				{ name: 'id', type: 'uuid', primaryKey: 1 },
				{ name: 'email', type: 'TEXT' },
			]),
			makeTable('categories', [{ name: 'id', type: 'INTEGER', primaryKey: 1 }]),
			makeTable('order_items', [{ name: 'id', type: 'BIGINT', primaryKey: 1 }]),
			makeTable('tickets', [
				{ name: 'id', type: 'TEXT', primaryKey: 1 },
				{ name: 'user_id', type: 'TEXT' },
				{ name: 'category_id', type: 'INTEGER' },
				{ name: 'orderItemId', type: 'INTEGER' },
				{ name: 'wrong_type_user_id', type: 'INTEGER' },
				{ name: 'stripe_id', type: 'TEXT' },
			]),
			makeTable('auth.identities', [
				{ name: 'id', type: 'uuid', primaryKey: 1 },
				{ name: 'user_id', type: 'uuid' },
			]),
			makeTable(
				'tickets_view',
				[
					{ name: 'id', type: 'TEXT' },
					{ name: 'user_id', type: 'TEXT' },
				],
				{ type: 'view' },
			),
		])

		const inferred = inferForeignKeys(raw)
		expect(inferred).toEqual([
			{ fromTable: 'tickets', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' },
			{ fromTable: 'tickets', fromColumn: 'category_id', toTable: 'categories', toColumn: 'id' },
			{ fromTable: 'tickets', fromColumn: 'orderItemId', toTable: 'order_items', toColumn: 'id' },
			{ fromTable: 'auth.identities', fromColumn: 'user_id', toTable: 'auth.users', toColumn: 'id' },
			{ fromTable: 'tickets_view', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' },
		])
	})

	test('rejects incompatible SQL type families (e.g. TEXT column vs INTEGER PK or UUID PK)', () => {
		const raw = makeSchema([
			makeTable('users', [{ name: 'id', type: 'INTEGER', primaryKey: 1 }]),
			makeTable('auth.accounts', [{ name: 'id', type: 'uuid', primaryKey: 1 }]),
			makeTable('logs', [
				{ name: 'id', type: 'INTEGER', primaryKey: 1 },
				{ name: 'user_id', type: 'TEXT' },
				{ name: 'account_id', type: 'TEXT' },
			]),
		])
		expect(inferForeignKeys(raw)).toEqual([])
	})

	test('merges virtual and inferred FKs without mutating the cached raw schema, and honors overrides & ignores', () => {
		const raw = makeSchema([
			makeTable('users', [{ name: 'id', type: 'TEXT', primaryKey: 1 }]),
			makeTable('tickets', [
				{ name: 'id', type: 'TEXT', primaryKey: 1 },
				{ name: 'user_id', type: 'TEXT' },
				{ name: 'owner', type: 'TEXT' },
			]),
		])

		const merged = mergeSchemaForeignKeys(
			raw,
			[{ fromTable: 'tickets', fromColumn: 'owner', toTable: 'users', toColumn: 'id' }],
			[{ fromTable: 'tickets', fromColumn: 'user_id' }],
		)

		// Raw input must stay untouched (protects PostgresAdapter cachedSchema)
		expect(raw.schemas.tickets!.foreignKeys).toEqual([])
		expect(raw.schemas.users!.reverseForeignKeys).toEqual([])

		// `owner` is virtual; `user_id` was ignored so it is omitted
		expect(merged.schemas.tickets!.foreignKeys).toEqual([
			{
				id: -1,
				fromColumn: 'owner',
				toTable: 'users',
				toColumn: 'id',
				onUpdate: '',
				onDelete: '',
				source: 'virtual',
			},
		])
		expect(merged.schemas.users!.reverseForeignKeys).toEqual([
			{ fromTable: 'tickets', fromColumn: 'owner', toColumn: 'id', source: 'virtual' },
		])
		expect(
			getExtraReverseFksForTable(
				raw,
				'users',
				[{ fromTable: 'tickets', fromColumn: 'owner', toTable: 'users', toColumn: 'id' }],
				[{ fromTable: 'tickets', fromColumn: 'user_id' }],
			),
		).toEqual([{ fromTable: 'tickets', fromColumn: 'owner', toColumn: 'id', source: 'virtual' }])
	})

	test('guessTargetTableForColumn suggests suffix-matched tables for manual modal defaults', () => {
		const raw = makeSchema([
			makeTable('users', [{ name: 'id', type: 'TEXT', primaryKey: 1 }]),
			makeTable('tickets', [{ name: 'id', type: 'TEXT', primaryKey: 1 }]),
		])
		expect(guessTargetTableForColumn('tickets', 'buyer_user_id', raw)).toBe('users')
	})
})

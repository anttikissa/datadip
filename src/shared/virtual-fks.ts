// Pure automatic FK inference and virtual/inferred foreign-key schema merging.
import type {
	DatabaseSchema,
	ForeignKeyInfo,
	IgnoredForeignKey,
	ReverseForeignKeyInfo,
	TableSchema,
	VirtualForeignKey,
} from './types.ts'

function tableSchemaPrefix(name: string): string {
	const dot = name.indexOf('.')
	return dot === -1 ? '' : name.slice(0, dot + 1)
}

function bareTableName(name: string): string {
	const dot = name.indexOf('.')
	return dot === -1 ? name : name.slice(dot + 1)
}

function sqlTypeFamily(rawType: string): string {
	const t = rawType
		.trim()
		.toLowerCase()
		.replace(/\(.*\)$/, '')
		.trim()
	if (!t) return 'any'
	if (t === 'uuid') return 'uuid'
	if (
		t === 'int' ||
		t === 'integer' ||
		t === 'bigint' ||
		t === 'smallint' ||
		t === 'tinyint' ||
		t === 'mediumint' ||
		t === 'int2' ||
		t === 'int4' ||
		t === 'int8' ||
		t === 'serial' ||
		t === 'bigserial' ||
		t === 'smallserial'
	) {
		return 'int'
	}
	if (
		t === 'text' ||
		t === 'varchar' ||
		t === 'character varying' ||
		t === 'char' ||
		t === 'character' ||
		t === 'citext' ||
		t === 'string' ||
		t === 'clob' ||
		t === 'nvarchar' ||
		t === 'nchar'
	) {
		return 'text'
	}
	return t
}

function areTypesCompatible(fromType: string, toType: string): boolean {
	const a = sqlTypeFamily(fromType)
	const b = sqlTypeFamily(toType)
	if (a === 'any' || b === 'any') return true
	return a === b
}

function stemVariants(rawStem: string): string[] {
	const lower = rawStem.toLowerCase().replace(/^_+|_+$/g, '')
	if (!lower) return []
	const snake = rawStem
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase()
		.replace(/^_+|_+$/g, '')
	const bases = snake && snake !== lower ? [snake, lower] : [lower]
	const out: string[] = []
	const add = (s: string) => {
		if (s && !out.includes(s)) out.push(s)
	}
	for (const b of bases) {
		add(`${b}s`)
		add(`${b}es`)
		if (b.endsWith('y') && b.length > 1 && !/[aeiou]y$/.test(b)) {
			add(`${b.slice(0, -1)}ies`)
		}
		add(b)
	}
	return out
}

function extractStrictStem(columnName: string): string | null {
	if (!columnName || columnName.toLowerCase() === 'id') return null
	if (/_id$/i.test(columnName)) {
		return columnName.slice(0, -3) || null
	}
	if (columnName.length > 2 && columnName.endsWith('Id') && /[a-z0-9]Id$/.test(columnName)) {
		return columnName.slice(0, -2) || null
	}
	return null
}

function getTargetPkColumn(ts: TableSchema): { name: string; type: string } | null {
	if (ts.primaryKeyColumns.length === 1) {
		const col = ts.columns.find((c) => c.name === ts.primaryKeyColumns[0])
		if (col) return { name: col.name, type: col.type }
	}
	if (ts.primaryKeyColumns.length === 0) {
		const idCol = ts.columns.find((c) => c.name.toLowerCase() === 'id')
		if (idCol) return { name: idCol.name, type: idCol.type }
	}
	return null
}

// High-precision automatic FK inference for columns like `user_id` -> `users.id` or `orderItemId` -> `order_items.id`.
export function inferForeignKeys(
	schema: DatabaseSchema,
	virtualFks: VirtualForeignKey[] = [],
	ignoredFks: IgnoredForeignKey[] = [],
): VirtualForeignKey[] {
	const ignoredSet = new Set(ignoredFks.map((i) => `${i.fromTable}\0${i.fromColumn}`))
	const virtualColSet = new Set(virtualFks.map((v) => `${v.fromTable}\0${v.fromColumn}`))
	const internalSet = new Set(schema.tables.filter((t) => t.isInternal).map((t) => t.name))

	// Eligible target tables: non-internal real tables with a clear single-column PK (or `id` column).
	const targetMeta: {
		name: string
		prefix: string
		bareLower: string
		pkCol: string
		pkType: string
	}[] = []
	for (const summary of schema.tables) {
		if (summary.type !== 'table' || internalSet.has(summary.name)) continue
		const ts = schema.schemas[summary.name]
		if (!ts) continue
		const pk = getTargetPkColumn(ts)
		if (!pk) continue
		targetMeta.push({
			name: summary.name,
			prefix: tableSchemaPrefix(summary.name),
			bareLower: bareTableName(summary.name).toLowerCase(),
			pkCol: pk.name,
			pkType: pk.type,
		})
	}

	const inferred: VirtualForeignKey[] = []

	for (const summary of schema.tables) {
		if (internalSet.has(summary.name)) continue
		const fromSchema = schema.schemas[summary.name]
		if (!fromSchema) continue

		const declaredCols = new Set(fromSchema.foreignKeys.map((fk) => fk.fromColumn))
		const fromPrefix = tableSchemaPrefix(summary.name)

		for (const col of fromSchema.columns) {
			if (declaredCols.has(col.name)) continue
			const colKey = `${summary.name}\0${col.name}`
			if (virtualColSet.has(colKey) || ignoredSet.has(colKey)) continue

			const stem = extractStrictStem(col.name)
			if (!stem) continue
			const variants = stemVariants(stem)
			if (variants.length === 0) continue

			// Prefer matching in the same schema (e.g. `public` over `auth`) and prefer plural/exact order in `variants`.
			let matched: (typeof targetMeta)[number] | null = null
			for (const variant of variants) {
				const sameSchemaMatches = targetMeta.filter(
					(t) => t.prefix === fromPrefix && t.bareLower === variant && areTypesCompatible(col.type, t.pkType),
				)
				if (sameSchemaMatches.length === 1) {
					matched = sameSchemaMatches[0]!
					break
				}
			}

			if (!matched) {
				for (const variant of variants) {
					const crossSchemaMatches = targetMeta.filter(
						(t) => t.prefix !== fromPrefix && t.bareLower === variant && areTypesCompatible(col.type, t.pkType),
					)
					if (crossSchemaMatches.length === 1) {
						matched = crossSchemaMatches[0]!
						break
					}
				}
			}

			if (matched) {
				inferred.push({
					fromTable: summary.name,
					fromColumn: col.name,
					toTable: matched.name,
					toColumn: matched.pkCol,
				})
			}
		}
	}

	return inferred
}

// Non-mutating merge of DB-declared FKs, user-configured virtual FKs, and auto-inferred FKs.
export function mergeSchemaForeignKeys(
	rawSchema: DatabaseSchema,
	virtualFks: VirtualForeignKey[] = [],
	ignoredFks: IgnoredForeignKey[] = [],
): DatabaseSchema {
	const inferredFks = inferForeignKeys(rawSchema, virtualFks, ignoredFks)
	if (virtualFks.length === 0 && inferredFks.length === 0) return rawSchema

	const clonedSchemas: Record<string, TableSchema> = {}
	for (const [name, ts] of Object.entries(rawSchema.schemas)) {
		clonedSchemas[name] = {
			...ts,
			foreignKeys: [...ts.foreignKeys],
			reverseForeignKeys: [...ts.reverseForeignKeys],
		}
	}

	let nextSyntheticId = -1
	const applyList = (list: VirtualForeignKey[], source: 'virtual' | 'inferred') => {
		for (const vfk of list) {
			const fromSchema = clonedSchemas[vfk.fromTable]
			const toSchema = clonedSchemas[vfk.toTable]
			if (!fromSchema || !toSchema) continue
			if (!fromSchema.columns.some((c) => c.name === vfk.fromColumn)) continue
			if (!toSchema.columns.some((c) => c.name === vfk.toColumn)) continue

			const dupOut = fromSchema.foreignKeys.some(
				(fk) => fk.fromColumn === vfk.fromColumn && fk.toTable === vfk.toTable && fk.toColumn === vfk.toColumn,
			)
			if (!dupOut) {
				const info: ForeignKeyInfo = {
					id: nextSyntheticId--,
					fromColumn: vfk.fromColumn,
					toTable: vfk.toTable,
					toColumn: vfk.toColumn,
					onUpdate: '',
					onDelete: '',
					source,
				}
				fromSchema.foreignKeys.push(info)
			}

			const dupIn = toSchema.reverseForeignKeys.some(
				(rfk) => rfk.fromTable === vfk.fromTable && rfk.fromColumn === vfk.fromColumn && rfk.toColumn === vfk.toColumn,
			)
			if (!dupIn) {
				const rfk: ReverseForeignKeyInfo = {
					fromTable: vfk.fromTable,
					fromColumn: vfk.fromColumn,
					toColumn: vfk.toColumn,
					source,
				}
				toSchema.reverseForeignKeys.push(rfk)
			}
		}
	}

	applyList(virtualFks, 'virtual')
	applyList(inferredFks, 'inferred')

	return {
		...rawSchema,
		schemas: clonedSchemas,
	}
}

export function getExtraReverseFksForTable(
	rawSchema: DatabaseSchema,
	table: string,
	virtualFks: VirtualForeignKey[] = [],
	ignoredFks: IgnoredForeignKey[] = [],
): ReverseForeignKeyInfo[] {
	const merged = mergeSchemaForeignKeys(rawSchema, virtualFks, ignoredFks)
	const ts = merged.schemas[table]
	if (!ts) return []
	return ts.reverseForeignKeys.filter((rfk) => rfk.source === 'virtual' || rfk.source === 'inferred')
}

// Broader suggestion heuristic for the manual Virtual FK modal (also tries trailing segment after `_`).
export function guessTargetTableForColumn(
	fromTable: string,
	fromColumn: string,
	schema: DatabaseSchema | null,
): string {
	if (!schema || schema.tables.length === 0) return ''
	const tables = schema.tables.filter((t) => !t.isInternal)
	const pool = tables.length > 0 ? tables : schema.tables
	const preferredPrefix = tableSchemaPrefix(fromTable)

	const stems: string[] = []
	const strict = extractStrictStem(fromColumn)
	if (strict) {
		stems.push(strict)
		const lastUnderscore = strict.lastIndexOf('_')
		if (lastUnderscore !== -1) stems.push(strict.slice(lastUnderscore + 1))
	} else {
		stems.push(fromColumn)
	}

	for (const stem of stems) {
		const variants = stemVariants(stem)
		for (const v of variants) {
			const sameSchema = pool.find(
				(t) => tableSchemaPrefix(t.name) === preferredPrefix && bareTableName(t.name).toLowerCase() === v,
			)
			if (sameSchema) return sameSchema.name
		}
		for (const v of variants) {
			const anySchema = pool.find((t) => bareTableName(t.name).toLowerCase() === v)
			if (anySchema) return anySchema.name
		}
	}

	return pool.find((t) => t.name !== fromTable)?.name ?? pool[0]?.name ?? ''
}

// Pure automatic FK inference and virtual/inferred/learned foreign-key schema merging.
import type {
	DatabaseSchema,
	ForeignKeyInfo,
	IgnoredForeignKey,
	LearnedForeignKey,
	ReverseForeignKeyInfo,
	TableSchema,
	VirtualForeignKey,
} from './types.ts'

const IRREGULAR_PLURALS: Record<string, string[]> = {
	person: ['people', 'persons'],
	child: ['children'],
	man: ['men'],
	woman: ['women'],
	index: ['indices', 'indexes'],
	datum: ['data'],
	criterion: ['criteria'],
	medium: ['media'],
	analysis: ['analyses'],
	status: ['statuses'],
	address: ['addresses'],
	class: ['classes'],
	campus: ['campuses'],
	bus: ['buses'],
}

function tableSchemaPrefix(name: string): string {
	const dot = name.indexOf('.')
	return dot === -1 ? '' : name.slice(0, dot + 1)
}

function bareTableName(name: string): string {
	const dot = name.indexOf('.')
	return dot === -1 ? name : name.slice(dot + 1)
}

export function sqlTypeFamily(rawType: string): string {
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

export function areTypesCompatible(fromType: string, toType: string): boolean {
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
		const irregulars = IRREGULAR_PLURALS[b]
		if (irregulars) {
			for (const irr of irregulars) add(irr)
		}
		// Compound stem ending in an irregular word (e.g. `contact_person` -> `contact_people`)
		const lastUs = b.lastIndexOf('_')
		if (lastUs !== -1) {
			const tail = b.slice(lastUs + 1)
			const tailIrr = IRREGULAR_PLURALS[tail]
			if (tailIrr) {
				const head = b.slice(0, lastUs + 1)
				for (const irr of tailIrr) add(`${head}${irr}`)
			}
		}
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

export function getTargetPkColumn(ts: TableSchema): { name: string; type: string } | null {
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

// High-precision automatic FK inference for columns like `user_id` -> `users.id`, `orderItemId` -> `order_items.id`,
// or unique single-PK column name matches like `course_id` -> `courses.course_id`.
export function inferForeignKeys(
	schema: DatabaseSchema,
	virtualFks: VirtualForeignKey[] = [],
	ignoredFks: IgnoredForeignKey[] = [],
	learnedFks: LearnedForeignKey[] = [],
): VirtualForeignKey[] {
	const ignoredSet = new Set(ignoredFks.map((i) => `${i.fromTable}\0${i.fromColumn}`))
	const virtualColSet = new Set(virtualFks.map((v) => `${v.fromTable}\0${v.fromColumn}`))
	const learnedColSet = new Set(learnedFks.map((l) => `${l.fromTable}\0${l.fromColumn}`))
	const internalSet = new Set(schema.tables.filter((t) => t.isInternal).map((t) => t.name))

	// Eligible target tables: non-internal real tables with a clear single-column PK (or `id` column).
	const targetMeta: {
		name: string
		prefix: string
		bareLower: string
		pkCol: string
		pkColLower: string
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
			pkColLower: pk.name.toLowerCase(),
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
			if (virtualColSet.has(colKey) || ignoredSet.has(colKey) || learnedColSet.has(colKey)) continue

			const stem = extractStrictStem(col.name)
			if (!stem) continue
			const variants = stemVariants(stem)
			if (variants.length === 0) continue

			// Prefer matching in the same schema (e.g. `public` over `auth`) and prefer plural/exact order in `variants`.
			// Never auto-infer self-referencing `<own_table>_id` columns (often external IDs like `stripe_events.stripe_event_id`),
			// and never fall back across schemas if a same-schema table with the matching name already exists.
			let matched: (typeof targetMeta)[number] | null = null
			let sameSchemaNameExists = false
			for (const variant of variants) {
				const sameSchemaByName = targetMeta.filter(
					(t) => t.name !== summary.name && t.prefix === fromPrefix && t.bareLower === variant,
				)
				if (sameSchemaByName.length > 0) sameSchemaNameExists = true
				const sameSchemaMatches = sameSchemaByName.filter((t) => areTypesCompatible(col.type, t.pkType))
				if (sameSchemaMatches.length === 1) {
					matched = sameSchemaMatches[0]!
					break
				}
			}

			if (!matched && !sameSchemaNameExists) {
				for (const variant of variants) {
					const crossSchemaMatches = targetMeta.filter(
						(t) =>
							t.name !== summary.name &&
							t.prefix !== fromPrefix &&
							t.bareLower === variant &&
							areTypesCompatible(col.type, t.pkType),
					)
					if (crossSchemaMatches.length === 1) {
						matched = crossSchemaMatches[0]!
						break
					}
				}
			}

			// Fallback: unique single-column PK name match (e.g. `admin_id` -> `admin_tb.admin_id`, `dept_id` -> `dept_tb.dept_id`).
			// Skip if this column is itself the sole PK of `summary.name`.
			if (!matched && !sameSchemaNameExists && !(fromSchema.primaryKeyColumns.length === 1 && col.primaryKey === 1)) {
				const colLower = col.name.toLowerCase()
				if (colLower !== 'id') {
					const sameSchemaPkOwners = targetMeta.filter((t) => t.prefix === fromPrefix && t.pkColLower === colLower)
					if (
						sameSchemaPkOwners.length === 1 &&
						sameSchemaPkOwners[0]!.name !== summary.name &&
						areTypesCompatible(col.type, sameSchemaPkOwners[0]!.pkType)
					) {
						matched = sameSchemaPkOwners[0]!
					} else if (sameSchemaPkOwners.length === 0) {
						const anyPkOwners = targetMeta.filter((t) => t.pkColLower === colLower)
						if (
							anyPkOwners.length === 1 &&
							anyPkOwners[0]!.name !== summary.name &&
							areTypesCompatible(col.type, anyPkOwners[0]!.pkType)
						) {
							matched = anyPkOwners[0]!
						}
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

// Non-mutating merge of DB-declared FKs, user-configured virtual FKs, data-learned FKs, and schema-inferred FKs.
export function mergeSchemaForeignKeys(
	rawSchema: DatabaseSchema,
	virtualFks: VirtualForeignKey[] = [],
	ignoredFks: IgnoredForeignKey[] = [],
	learnedFks: LearnedForeignKey[] = [],
): DatabaseSchema {
	const ignoredSet = new Set(ignoredFks.map((i) => `${i.fromTable}\0${i.fromColumn}`))
	const virtualColSet = new Set(virtualFks.map((v) => `${v.fromTable}\0${v.fromColumn}`))
	const activeLearned = learnedFks.filter((l) => {
		const k = `${l.fromTable}\0${l.fromColumn}`
		if (ignoredSet.has(k) || virtualColSet.has(k)) return false
		const fromSchema = rawSchema.schemas[l.fromTable]
		if (!fromSchema) return false
		if (fromSchema.foreignKeys.some((fk) => fk.fromColumn === l.fromColumn)) return false
		return true
	})

	const inferredFks = inferForeignKeys(rawSchema, virtualFks, ignoredFks, activeLearned)
	if (virtualFks.length === 0 && activeLearned.length === 0 && inferredFks.length === 0) return rawSchema

	const clonedSchemas: Record<string, TableSchema> = {}
	for (const [name, ts] of Object.entries(rawSchema.schemas)) {
		clonedSchemas[name] = {
			...ts,
			foreignKeys: [...ts.foreignKeys],
			reverseForeignKeys: [...ts.reverseForeignKeys],
		}
	}

	let nextSyntheticId = -1
	const applyEntry = (
		vfk: VirtualForeignKey,
		source: 'virtual' | 'inferred',
		inferenceKind?: 'schema' | 'data',
		inferenceReason?: string,
	) => {
		const fromSchema = clonedSchemas[vfk.fromTable]
		const toSchema = clonedSchemas[vfk.toTable]
		if (!fromSchema || !toSchema) return
		if (!fromSchema.columns.some((c) => c.name === vfk.fromColumn)) return
		if (!toSchema.columns.some((c) => c.name === vfk.toColumn)) return

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
				...(inferenceKind ? { inferenceKind } : {}),
				...(inferenceReason ? { inferenceReason } : {}),
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
				...(inferenceKind ? { inferenceKind } : {}),
				...(inferenceReason ? { inferenceReason } : {}),
			}
			toSchema.reverseForeignKeys.push(rfk)
		}
	}

	for (const vfk of virtualFks) applyEntry(vfk, 'virtual')
	for (const lfk of activeLearned) applyEntry(lfk, 'inferred', 'data', lfk.reason)
	for (const ifk of inferredFks) applyEntry(ifk, 'inferred', 'schema', 'Matched column name & type')

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
	learnedFks: LearnedForeignKey[] = [],
): ReverseForeignKeyInfo[] {
	const merged = mergeSchemaForeignKeys(rawSchema, virtualFks, ignoredFks, learnedFks)
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

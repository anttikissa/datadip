// Passive incremental FK learner: learns ID signatures from browsed rows and verifies candidates via O(k log N) PK-index probes.
import {
	type CandidateTargetInfo,
	type ColumnFingerprint,
	type ColumnIdSignature,
	formatLearnedReason,
	isProbableIdSignature,
	mergeFingerprints,
	scoreCandidateTarget,
	signaturesCompatible,
} from '../../src/shared/id-fingerprint.ts'
import type { ConnectionConfig, DatabaseSchema, KeyExistenceProbe, TableSchema } from '../../src/shared/types.ts'
import { areTypesCompatible, getTargetPkColumn, sqlTypeFamily } from '../../src/shared/virtual-fks.ts'
import type { DataStore, StoredColumnProfile, StoredLearnedFkRow } from '../store.ts'
import type { DbAdapter } from './types.ts'

const MAX_PROBE_VALUES = 12
const MAX_PASS1_TARGETS = 8
const MAX_PASS2_TOTAL_TABLES = 36
const MAX_PASS2_VALUES = 6

interface RankedTarget {
	target: CandidateTargetInfo
	score: number
	reason: string
	matchedTypedSignature: boolean
}

interface ProbeOutcome {
	target: CandidateTargetInfo
	score: number
	matched: number
	matchedSet: Set<string>
	inclusion: number
}

export interface LearnedChangeEvent {
	connectionId: string
	ts: number
	discovered?: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; reason: string }[]
}

export class PassiveFkLearner {
	private readonly store: DataStore
	private readonly onChange: (ev: LearnedChangeEvent) => void
	private readonly inFlight = new Set<string>()
	private readonly pending = new Set<Promise<void>>()

	constructor(store: DataStore, onChange: (ev: LearnedChangeEvent) => void) {
		this.store = store
		this.onChange = onChange
	}

	// Deterministic barrier for tests and benchmarks (never needed in production request paths).
	async waitForIdle(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled(Array.from(this.pending))
		}
	}

	observeRows(
		conn: ConnectionConfig,
		rawSchema: DatabaseSchema,
		adapter: DbAdapter,
		tableName: string,
		rows: Record<string, unknown>[],
	): void {
		if (!rows || rows.length === 0 || !adapter.checkKeysExist) return
		const tableSchema = rawSchema.schemas[tableName]
		if (!tableSchema || tableSchema.type !== 'table') return

		const flightKey = `${conn.id}\0${tableName}`
		if (this.inFlight.has(flightKey)) return
		this.inFlight.add(flightKey)

		const task = this.processTableRows(conn, rawSchema, adapter, tableSchema, rows)
			.catch(() => {})
			.finally(() => {
				this.inFlight.delete(flightKey)
				this.pending.delete(task)
			})
		this.pending.add(task)
	}

	private buildEligibleTargets(rawSchema: DatabaseSchema): {
		targets: CandidateTargetInfo[]
		centrality: Map<string, number>
		fkEdges: Set<string> // "fromTable\0toTable"
	} {
		const internalSet = new Set(rawSchema.tables.filter((t) => t.isInternal).map((t) => t.name))
		const targets: CandidateTargetInfo[] = []
		const centrality = new Map<string, number>()
		const fkEdges = new Set<string>()

		for (const summary of rawSchema.tables) {
			if (summary.type !== 'table' || internalSet.has(summary.name)) continue
			const ts = rawSchema.schemas[summary.name]
			if (!ts) continue
			for (const fk of ts.foreignKeys) {
				centrality.set(fk.toTable, (centrality.get(fk.toTable) ?? 0) + 1)
				fkEdges.add(`${ts.name}\0${fk.toTable}`)
			}
			// Skip tables known to be strictly empty
			if (summary.rowCount === 0 && !summary.rowCountEstimated) continue
			const pk = getTargetPkColumn(ts)
			if (!pk) continue
			// Never probe plain sequential integer PKs
			if (sqlTypeFamily(pk.type) === 'int') continue
			targets.push({
				table: summary.name,
				pkColumn: pk.name,
				pkType: pk.type,
				rowCount: summary.rowCount,
				rowCountEstimated: summary.rowCountEstimated,
			})
		}
		return { targets, centrality, fkEdges }
	}

	private async processTableRows(
		conn: ConnectionConfig,
		rawSchema: DatabaseSchema,
		adapter: DbAdapter,
		tableSchema: TableSchema,
		rows: Record<string, unknown>[],
	): Promise<void> {
		const profiles = this.store.listFkColumnProfiles(conn.id)
		const profileMap = new Map<string, StoredColumnProfile>()
		const pkProfiles = new Map<string, StoredColumnProfile>()
		for (const p of profiles) {
			profileMap.set(`${p.tableName}\0${p.columnName}`, p)
			if (p.isPk) pkProfiles.set(p.tableName, p)
		}

		const learnedEntries = this.store.listLearnedFkEntries(conn.id)
		const learnedMap = new Map<string, StoredLearnedFkRow>()
		for (const l of learnedEntries) learnedMap.set(`${l.fromTable}\0${l.fromColumn}`, l)

		const ignoredSet = new Set((conn.ignoredForeignKeys ?? []).map((i) => `${i.fromTable}\0${i.fromColumn}`))
		const virtualSet = new Set((conn.virtualForeignKeys ?? []).map((v) => `${v.fromTable}\0${v.fromColumn}`))
		const declaredSet = new Set(tableSchema.foreignKeys.map((fk) => fk.fromColumn))

		const { targets, centrality, fkEdges } = this.buildEligibleTargets(rawSchema)
		for (const l of learnedEntries) {
			if (l.status === 'verified' && l.toTable) {
				centrality.set(l.toTable, (centrality.get(l.toTable) ?? 0) + 1)
				fkEdges.add(`${l.fromTable}\0${l.toTable}`)
			}
		}

		const discovered: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; reason: string }[] =
			[]
		let changed = false

		// 1. Learn / refine PK signature of the browsed table (zero extra DB queries)
		let pkSignatureUpdated = false
		let updatedPkProfile: StoredColumnProfile | null = null
		const ownPk = getTargetPkColumn(tableSchema)
		if (ownPk && sqlTypeFamily(ownPk.type) !== 'int') {
			const pkVals = rows.map((r) => r[ownPk.name])
			const prevPk = pkProfiles.get(tableSchema.name) ?? null
			const mergedPk = mergeFingerprints(
				prevPk ? { signature: prevPk.signature, samples: prevPk.samples } : null,
				pkVals,
				{ isPk: true },
			)
			if (isProbableIdSignature(mergedPk.signature)) {
				const prevSigKey = prevPk ? `${prevPk.signature.kind}:${prevPk.signature.prefix ?? ''}` : ''
				const nextSigKey = `${mergedPk.signature.kind}:${mergedPk.signature.prefix ?? ''}`
				if (prevSigKey !== nextSigKey || !prevPk || mergedPk.samples.length > prevPk.samples.length) {
					this.store.upsertFkColumnProfile(conn.id, {
						tableName: tableSchema.name,
						columnName: ownPk.name,
						isPk: true,
						signature: mergedPk.signature,
						samples: mergedPk.samples,
					})
					updatedPkProfile = {
						tableName: tableSchema.name,
						columnName: ownPk.name,
						isPk: true,
						signature: mergedPk.signature,
						samples: mergedPk.samples,
						updatedAt: new Date().toISOString(),
					}
					pkProfiles.set(tableSchema.name, updatedPkProfile)
					profileMap.set(`${tableSchema.name}\0${ownPk.name}`, updatedPkProfile)
					if (prevSigKey !== nextSigKey) pkSignatureUpdated = true
				}
			}
		}

		// 2. Inspect non-PK candidate columns on this table (skip plain integer columns & bare `id` sole PK)
		for (const col of tableSchema.columns) {
			if (declaredSet.has(col.name)) continue
			const colKey = `${tableSchema.name}\0${col.name}`
			if (ignoredSet.has(colKey) || virtualSet.has(colKey)) continue
			if (sqlTypeFamily(col.type) === 'int') continue
			// Skip sole PK columns named `id` (prevents 1:1 PK reversal like users.id -> user_profiles.id)
			const isSolePk = tableSchema.primaryKeyColumns.length === 1 && col.primaryKey === 1
			if (isSolePk && col.name.toLowerCase() === 'id') continue
			if (isSolePk && ownPk?.name === col.name) continue

			const colVals = rows.map((r) => r[col.name])
			const prevProfile = profileMap.get(colKey) ?? null
			const merged = mergeFingerprints(
				prevProfile ? { signature: prevProfile.signature, samples: prevProfile.samples } : null,
				colVals,
				{ isPk: false },
			)

			// Persist updated column fingerprint if it looks ID-like or polymorphic
			if (merged.signature.kind !== 'non-id') {
				this.store.upsertFkColumnProfile(conn.id, {
					tableName: tableSchema.name,
					columnName: col.name,
					isPk: false,
					signature: merged.signature,
					samples: merged.samples,
				})
				profileMap.set(colKey, {
					tableName: tableSchema.name,
					columnName: col.name,
					isPk: false,
					signature: merged.signature,
					samples: merged.samples,
					updatedAt: new Date().toISOString(),
				})
			}

			const existing = learnedMap.get(colKey)

			// 2a. Drift detection on already-verified learned FKs
			if (existing?.status === 'verified') {
				if (merged.signature.kind === 'polymorphic') {
					this.store.upsertLearnedFk(conn.id, {
						fromTable: tableSchema.name,
						fromColumn: col.name,
						toTable: '',
						toColumn: '',
						confidence: 0,
						reason: 'Polymorphic IDs detected across pages',
						matchedCount: 0,
						sampledCount: merged.samples.length,
						status: 'polymorphic',
					})
					changed = true
				} else if (merged.signature.kind !== 'non-id' && merged.samples.length > 0) {
					const pageFresh = mergeFingerprints(null, colVals, { isPk: false })
					const targetPkSig = pkProfiles.get(existing.toTable)?.signature ?? null
					if (
						pageFresh.samples.length >= 2 &&
						targetPkSig &&
						!signaturesCompatible(pageFresh.signature, pageFresh.samples, targetPkSig)
					) {
						// Re-verify fresh page values against the learned target
						const check = await adapter.checkKeysExist!([
							{
								table: existing.toTable,
								column: existing.toColumn,
								values: pageFresh.samples.slice(0, MAX_PROBE_VALUES),
							},
						])
						const matched = check[0]?.matchedValues.length ?? 0
						if (matched / pageFresh.samples.slice(0, MAX_PROBE_VALUES).length < 0.5) {
							this.store.upsertLearnedFk(conn.id, {
								fromTable: tableSchema.name,
								fromColumn: col.name,
								toTable: '',
								toColumn: '',
								confidence: 0,
								reason: 'Contradicted by newer rows',
								matchedCount: matched,
								sampledCount: pageFresh.samples.slice(0, MAX_PROBE_VALUES).length,
								status: 'probed_none',
							})
							changed = true
						}
					}
				}
				continue
			}

			if (merged.signature.kind === 'non-id') continue

			if (merged.signature.kind === 'polymorphic') {
				if (existing?.status !== 'polymorphic') {
					this.store.upsertLearnedFk(conn.id, {
						fromTable: tableSchema.name,
						fromColumn: col.name,
						toTable: '',
						toColumn: '',
						confidence: 0,
						reason: `Polymorphic prefixes (${(merged.signature.prefixes ?? []).join(', ')})`,
						matchedCount: 0,
						sampledCount: merged.samples.length,
						status: 'polymorphic',
					})
				}
				continue
			}

			// Negative cache: don't re-probe a column already resolved as probed_none/ambiguous/polymorphic
			// unless a previously unknown compatible PK signature might exist (handled in retroactive step 3).
			if (
				existing &&
				(existing.status === 'probed_none' || existing.status === 'polymorphic' || existing.status === 'ambiguous')
			) {
				// Exception: if a learned typed-ID PK signature NOW matches this column (learned after initial probe), allow retry!
				const hasMatchingTypedPk = targets.some((t) => {
					const pkSig = pkProfiles.get(t.table)?.signature
					return (
						pkSig &&
						(pkSig.kind === 'typed-delim' || pkSig.kind === 'typed-nodelim') &&
						signaturesCompatible(merged.signature, merged.samples, pkSig)
					)
				})
				if (!hasMatchingTypedPk) continue
			}

			// 2b. Verify candidate column via Tier 3 PK-index probe
			const win = await this.probeColumnTargets(
				adapter,
				tableSchema.name,
				col.name,
				col.type,
				merged,
				targets,
				pkProfiles,
				centrality,
				fkEdges,
			)
			if (win.status === 'verified' && win.toTable && win.toColumn) {
				this.store.upsertLearnedFk(conn.id, {
					fromTable: tableSchema.name,
					fromColumn: col.name,
					toTable: win.toTable,
					toColumn: win.toColumn,
					confidence: win.confidence,
					reason: win.reason,
					matchedCount: win.matchedCount,
					sampledCount: win.sampledCount,
					status: 'verified',
				})
				learnedMap.set(colKey, {
					fromTable: tableSchema.name,
					fromColumn: col.name,
					toTable: win.toTable,
					toColumn: win.toColumn,
					confidence: win.confidence,
					reason: win.reason,
					matchedCount: win.matchedCount,
					sampledCount: win.sampledCount,
					status: 'verified',
					updatedAt: new Date().toISOString(),
				})
				discovered.push({
					fromTable: tableSchema.name,
					fromColumn: col.name,
					toTable: win.toTable,
					toColumn: win.toColumn,
					reason: win.reason,
				})
				changed = true
			} else {
				this.store.upsertLearnedFk(conn.id, {
					fromTable: tableSchema.name,
					fromColumn: col.name,
					toTable: '',
					toColumn: '',
					confidence: 0,
					reason: win.reason,
					matchedCount: win.matchedCount,
					sampledCount: win.sampledCount,
					status: win.status,
				})
			}
		}

		// 3. Retroactive matching: if we just learned/updated this table's PK signature, check previously browsed
		// unresolved columns from OTHER tables that match this table's PK signature!
		if (pkSignatureUpdated && updatedPkProfile && ownPk) {
			const pkTarget = targets.find((t) => t.table === tableSchema.name)
			if (pkTarget) {
				const retroCandidates: StoredColumnProfile[] = []
				for (const p of profileMap.values()) {
					if (p.isPk || p.tableName === tableSchema.name) continue
					const key = `${p.tableName}\0${p.columnName}`
					if (ignoredSet.has(key) || virtualSet.has(key)) continue
					const existing = learnedMap.get(key)
					if (existing?.status === 'verified' || existing?.status === 'polymorphic') continue
					const fromSchema = rawSchema.schemas[p.tableName]
					if (!fromSchema) continue
					if (fromSchema.foreignKeys.some((fk) => fk.fromColumn === p.columnName)) continue
					const fromCol = fromSchema.columns.find((c) => c.name === p.columnName)
					if (!fromCol || !areTypesCompatible(fromCol.type, pkTarget.pkType)) continue
					if (!signaturesCompatible(p.signature, p.samples, updatedPkProfile.signature)) continue
					if (p.samples.length === 0) continue
					retroCandidates.push(p)
				}

				if (retroCandidates.length > 0) {
					const cappedRetro = retroCandidates.slice(0, 24)
					const probes: KeyExistenceProbe[] = cappedRetro.map((p) => ({
						table: pkTarget.table,
						column: pkTarget.pkColumn,
						values: p.samples.slice(0, MAX_PROBE_VALUES),
					}))
					const results = await adapter.checkKeysExist!(probes)
					for (let i = 0; i < cappedRetro.length; i++) {
						const p = cappedRetro[i]!
						const res = results[i]
						const sampled = Math.min(p.samples.length, MAX_PROBE_VALUES)
						const matched = res?.matchedValues.length ?? 0
						if (this.qualifiesSingleTarget(p.signature, matched, sampled)) {
							const reason = formatLearnedReason(
								updatedPkProfile.signature.kind === 'typed-delim' || updatedPkProfile.signature.kind === 'typed-nodelim'
									? updatedPkProfile.signature
									: p.signature,
								matched,
								sampled,
								pkTarget.table,
								pkTarget.pkColumn,
							)
							this.store.upsertLearnedFk(conn.id, {
								fromTable: p.tableName,
								fromColumn: p.columnName,
								toTable: pkTarget.table,
								toColumn: pkTarget.pkColumn,
								confidence: Math.round((matched / sampled) * 1000) / 1000,
								reason,
								matchedCount: matched,
								sampledCount: sampled,
								status: 'verified',
							})
							discovered.push({
								fromTable: p.tableName,
								fromColumn: p.columnName,
								toTable: pkTarget.table,
								toColumn: pkTarget.pkColumn,
								reason,
							})
							changed = true
						}
					}
				}
			}
		}

		if (changed) {
			this.onChange({
				connectionId: conn.id,
				ts: Date.now(),
				...(discovered.length > 0 ? { discovered } : {}),
			})
		}
	}

	private qualifiesSingleTarget(sig: ColumnIdSignature, matched: number, sampled: number): boolean {
		if (sampled === 0 || matched === 0) return false
		const inclusion = matched / sampled
		if (sampled === 1) {
			// Single distinct value on page: require high entropy (>= 48 bits, UUID, ULID, or strong typed ID >= 40 bits)
			if (sig.kind === 'uuid' || sig.kind === 'ulid') return true
			if ((sig.kind === 'typed-delim' || sig.kind === 'typed-nodelim') && sig.estimatedBits >= 40) return true
			return sig.estimatedBits >= 48
		}
		if (sampled <= 3) {
			if (matched < 2) return false
			return inclusion >= 0.66
		}
		return inclusion >= 0.75
	}

	private async probeColumnTargets(
		adapter: DbAdapter,
		fromTable: string,
		fromCol: string,
		fromColType: string,
		fp: ColumnFingerprint,
		allTargets: CandidateTargetInfo[],
		pkProfiles: Map<string, StoredColumnProfile>,
		centrality: Map<string, number>,
		fkEdges: Set<string>,
	): Promise<{
		status: 'verified' | 'probed_none' | 'polymorphic' | 'ambiguous'
		toTable?: string
		toColumn?: string
		confidence: number
		reason: string
		matchedCount: number
		sampledCount: number
	}> {
		const sampleValues = fp.samples.slice(0, MAX_PROBE_VALUES)
		if (sampleValues.length === 0) {
			return { status: 'probed_none', confidence: 0, reason: 'No sample values', matchedCount: 0, sampledCount: 0 }
		}

		// Rank all type-compatible candidate targets
		const ranked: RankedTarget[] = []
		for (const t of allTargets) {
			if (!areTypesCompatible(fromColType, t.pkType)) continue
			const knownPkSig = pkProfiles.get(t.table)?.signature ?? null
			const scored = scoreCandidateTarget(
				fromTable,
				fromCol,
				fp.signature,
				sampleValues,
				t,
				knownPkSig,
				centrality.get(t.table) ?? 0,
			)
			if (scored.score <= -500) continue
			const matchedTypedSignature = Boolean(
				knownPkSig &&
				(knownPkSig.kind === 'typed-delim' || knownPkSig.kind === 'typed-nodelim') &&
				signaturesCompatible(fp.signature, sampleValues, knownPkSig),
			)
			ranked.push({ target: t, score: scored.score, reason: scored.reason, matchedTypedSignature })
		}

		if (ranked.length === 0) {
			return {
				status: 'probed_none',
				confidence: 0,
				reason: 'No compatible PK targets',
				matchedCount: 0,
				sampledCount: sampleValues.length,
			}
		}

		ranked.sort((a, b) => b.score - a.score)

		// Pass 1 selection:
		// - If 1+ tables matched via a learned typed-ID PK signature, probe those first!
		// - Otherwise probe top MAX_PASS1_TARGETS ranked candidates.
		const typedMatches = ranked.filter((r) => r.matchedTypedSignature)
		const pass1 =
			typedMatches.length > 0 ? typedMatches.slice(0, MAX_PASS1_TARGETS) : ranked.slice(0, MAX_PASS1_TARGETS)

		const outcomes = await this.runProbeBatch(adapter, pass1, sampleValues)

		// Pass 2: if Pass 1 had 0 hits, probe remaining signature-matched targets (e.g. >8 tables sharing a prefix like `act_*`)
		// or remaining compatible tables (when schema has <= MAX_PASS2_TOTAL_TABLES compatible tables).
		let allOutcomes = outcomes
		const pass1AnyHit = outcomes.some((o) => o.matched > 0)
		const pass1Set = new Set(pass1.map((p) => p.target.table))
		const pass2Pool =
			typedMatches.length > pass1.length
				? typedMatches.slice(pass1.length, MAX_PASS2_TOTAL_TABLES)
				: typedMatches.length === 0 && ranked.length <= MAX_PASS2_TOTAL_TABLES
					? ranked.filter((r) => !pass1Set.has(r.target.table))
					: []
		if (!pass1AnyHit && pass2Pool.length > 0) {
			const pass2Vals = sampleValues.slice(0, MAX_PASS2_VALUES)
			const pass2Outcomes = await this.runProbeBatch(adapter, pass2Pool, pass2Vals)
			// If any target hit on the shorter pass2Vals, verify full sampleValues on the hitting target(s) only!
			const pass2Hits = pass2Outcomes.filter((o) => o.matched > 0)
			if (pass2Hits.length > 0 && pass2Vals.length < sampleValues.length) {
				const hitRanked = pass2Hits.map((h) => ranked.find((r) => r.target.table === h.target.table)!).filter(Boolean)
				allOutcomes = await this.runProbeBatch(adapter, hitRanked, sampleValues)
			} else {
				allOutcomes = pass2Outcomes
			}
		}

		const sampled = sampleValues.length
		const withHits = allOutcomes
			.filter((o) => o.matched > 0)
			.sort((a, b) => b.inclusion - a.inclusion || b.score - a.score)
		if (withHits.length === 0) {
			return {
				status: 'probed_none',
				confidence: 0,
				reason: 'No matching primary keys found',
				matchedCount: 0,
				sampledCount: sampled,
			}
		}

		// Polymorphic check across targets: if multiple tables match distinct subsets of sample values
		// and together cover significantly more values than the best single target, this column is polymorphic!
		if (withHits.length >= 2) {
			const best = withHits[0]!
			const unionSet = new Set<string>(best.matchedSet)
			let disjointOtherHits = 0
			for (let i = 1; i < withHits.length; i++) {
				const other = withHits[i]!
				let uniqueToOther = 0
				for (const v of other.matchedSet) {
					if (!best.matchedSet.has(v)) uniqueToOther++
					unionSet.add(v)
				}
				if (uniqueToOther > 0) disjointOtherHits += uniqueToOther
			}
			// If another table matches values that `best` does NOT match, and `best` isn't already >= 90% inclusion
			if (disjointOtherHits >= 2 && unionSet.size - best.matched >= 2 && best.inclusion < 0.9) {
				return {
					status: 'polymorphic',
					confidence: 0,
					reason: `Values span multiple tables (${withHits
						.slice(0, 3)
						.map((w) => w.target.table)
						.join(', ')})`,
					matchedCount: best.matched,
					sampledCount: sampled,
				}
			}
		}

		// Filter to targets meeting our precision threshold
		const qualified = withHits.filter((o) => this.qualifiesSingleTarget(fp.signature, o.matched, sampled))
		if (qualified.length === 0) {
			const best = withHits[0]!
			return {
				status: 'probed_none',
				confidence: best.inclusion,
				reason: `Low key match (${best.matched}/${sampled} in ${best.target.table})`,
				matchedCount: best.matched,
				sampledCount: sampled,
			}
		}

		// Disambiguate if multiple tables qualified (e.g. users + 1:1 user_profiles mirror)
		let winner: ProbeOutcome | null = qualified[0]!
		if (qualified.length > 1) {
			// Step A: drop any target that is strictly weaker in inclusion (>= 15% behind best)
			const topInc = qualified[0]!.inclusion
			let finalists = qualified.filter((q) => topInc - q.inclusion < 0.15)

			// Step B: drop child tables in known FK hierarchy (if B has FK -> A, prefer parent A!)
			if (finalists.length > 1) {
				const filtered = finalists.filter(
					(cand) =>
						!finalists.some(
							(other) =>
								other.target.table !== cand.target.table &&
								fkEdges.has(`${cand.target.table}\0${other.target.table}`) &&
								!fkEdges.has(`${other.target.table}\0${cand.target.table}`),
						),
				)
				if (filtered.length > 0) finalists = filtered
			}

			// Step C: if still > 1, check if one clearly leads on candidate score (>= 25 pts) or exact rowCount
			if (finalists.length > 1) {
				finalists.sort((a, b) => b.score - a.score)
				if (finalists[0]!.score - finalists[1]!.score >= 25) {
					winner = finalists[0]!
				} else {
					const byRows = [...finalists].sort((a, b) => (b.target.rowCount ?? -1) - (a.target.rowCount ?? -1))
					const r0 = byRows[0]!.target.rowCount
					const r1 = byRows[1]!.target.rowCount
					if (r0 !== null && r1 !== null && r0 > r1 * 1.15) {
						winner = byRows[0]!
					} else {
						winner = null
					}
				}
			} else {
				winner = finalists[0]!
			}
		}

		if (!winner) {
			return {
				status: 'ambiguous',
				confidence: qualified[0]!.inclusion,
				reason: `Ambiguous match across ${qualified
					.slice(0, 3)
					.map((q) => q.target.table)
					.join(', ')}`,
				matchedCount: qualified[0]!.matched,
				sampledCount: sampled,
			}
		}

		const targetPkSig = pkProfiles.get(winner.target.table)?.signature
		const displaySig =
			targetPkSig && (targetPkSig.kind === 'typed-delim' || targetPkSig.kind === 'typed-nodelim')
				? targetPkSig
				: fp.signature
		return {
			status: 'verified',
			toTable: winner.target.table,
			toColumn: winner.target.pkColumn,
			confidence: Math.round(winner.inclusion * 1000) / 1000,
			reason: formatLearnedReason(displaySig, winner.matched, sampled, winner.target.table, winner.target.pkColumn),
			matchedCount: winner.matched,
			sampledCount: sampled,
		}
	}

	private async runProbeBatch(
		adapter: DbAdapter,
		candidates: RankedTarget[],
		values: string[],
	): Promise<ProbeOutcome[]> {
		if (candidates.length === 0 || values.length === 0) return []
		const probes: KeyExistenceProbe[] = candidates.map((c) => ({
			table: c.target.table,
			column: c.target.pkColumn,
			values,
		}))
		const results = await adapter.checkKeysExist!(probes)
		const out: ProbeOutcome[] = []
		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i]!
			const matchedVals = results[i]?.matchedValues ?? []
			const matchedSet = new Set(matchedVals)
			out.push({
				target: c.target,
				score: c.score,
				matched: matchedSet.size,
				matchedSet,
				inclusion: matchedSet.size / values.length,
			})
		}
		return out
	}
}

// Contract tests for multi-runtime SSH SQLite (bun, python3, sqlite3 CLI), Turso/libSQL (Hrana v2), and Cloudflare D1.
// Runs 100% locally with zero network access using local shell spawn and loopback HTTP mocks.
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshRuntimePreference } from '../src/shared/types.ts'
import { maskConnectionPath } from '../src/shared/url.ts'
import { createD1Adapter, parseD1Path } from './db/d1.ts'
import { formatSqlWithParams } from './db/sqlite-async.ts'
import { SshSqliteAdapter } from './db/sqlite-ssh.ts'
import { SshHostChannel, SshMuxPool } from './db/ssh-mux.ts'
import { createTursoAdapter, resolveTursoEndpoint } from './db/turso.ts'

let tempDir = ''
let sampleDbPath = ''

function createSampleDb(path: string) {
	const db = new Database(path)
	db.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA foreign_keys = ON;
		CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			org_id INTEGER NOT NULL REFERENCES orgs(id),
			email TEXT NOT NULL UNIQUE,
			note TEXT
		);
		INSERT INTO orgs (id, name) VALUES (1, 'Acme'), (2, 'Beta');
		INSERT INTO users (id, org_id, email, note) VALUES
			(1, 1, 'ada@example.com', 'founder'),
			(2, 1, 'grace@example.com', NULL),
			(3, 2, 'linus@example.com', 'kernel');
	`)
	db.close()
}

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'datadip-runtimes-'))
	sampleDbPath = join(tempDir, 'sample.sqlite')
	createSampleDb(sampleDbPath)
})

afterAll(() => {
	try {
		rmSync(tempDir, { recursive: true, force: true })
	} catch {}
})

function makeLocalSshAdapter(runtime: SshRuntimePreference, dbPath: string) {
	const pool = new SshMuxPool()
	const ch = new SshHostChannel(
		`local:${runtime}`,
		{ host: 'localhost', runtime },
		() => null,
		(remoteCmd) =>
			Bun.spawn(['/bin/sh', '-c', remoteCmd], {
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			}),
	)
	const adapter = new SshSqliteAdapter(pool, { host: 'localhost', runtime }, dbPath, ch)
	return { adapter, channel: ch }
}

describe('Multi-runtime SSH SQLite workers (bun, python3, sqlite3 CLI)', () => {
	for (const runtime of ['bun', 'python3', 'sqlite3'] as const) {
		test(`runs schema, browse, query, mutate, peek, reverse-FK, profile, info via ${runtime}`, async () => {
			const dbPath = join(tempDir, `rt-${runtime}.sqlite`)
			createSampleDb(dbPath)
			const { adapter, channel } = makeLocalSshAdapter(runtime, dbPath)
			try {
				const ping = await adapter.ping()
				expect(ping.ok).toBe(true)
				expect(ping.runtime).toBe(runtime)
				expect(adapter.getResolvedRuntime()).toBe(runtime)
				expect(ping.version).toBeTruthy()

				const schema = await adapter.getSchema()
				expect(schema.tables.map((t) => t.name).sort()).toEqual(['orgs', 'users'])
				expect(schema.schemas.users!.foreignKeys[0]?.toTable).toBe('orgs')
				expect(schema.schemas.orgs!.reverseForeignKeys[0]?.fromTable).toBe('users')

				const browse = await adapter.browseTable({
					table: 'users',
					filters: [{ column: 'org_id', op: 'eq', value: '1' }],
					limit: 10,
				})
				expect(browse.rows.length).toBe(2)
				expect(browse.totalCount).toBe(2)

				const peek = await adapter.peekRow('orgs', 'id', 1)
				expect(peek?.name).toBe('Acme')

				const rev = await adapter.countReverseFks('orgs', { id: 1 })
				expect(rev[0]?.count).toBe(2)

				const keys = await adapter.checkKeysExist([{ table: 'orgs', column: 'id', values: ['1', '999'] }])
				expect(keys[0]?.matchedValues).toEqual(['1'])

				const prof = await adapter.profileColumn('users', 'note')
				expect(prof.totalRows).toBe(3)
				expect(prof.nullCount).toBe(1)

				const info = await adapter.getInfo()
				expect(info.driver).toBe('sqlite')
				expect(info.runtime).toBe(runtime)

				// Mutate in a single transaction
				const mut = await adapter.mutate({
					table: 'users',
					updates: [{ pk: { id: 2 }, changes: { note: `edited-by-${runtime}` } }],
					inserts: [{ id: 4, org_id: 2, email: `new-${runtime}@example.com`, note: "o'reilly" }],
				})
				expect(mut.applied).toBeGreaterThanOrEqual(2)

				const check = await adapter.executeStatements(
					['SELECT email, note FROM users WHERE id IN (2, 4) ORDER BY id'],
					{
						writable: false,
					},
				)
				expect(check[0]?.error).toBeUndefined()
				expect(check[0]?.rows).toEqual([
					{ email: 'grace@example.com', note: `edited-by-${runtime}` },
					{ email: `new-${runtime}@example.com`, note: "o'reilly" },
				])
			} finally {
				adapter.close()
				channel.close()
			}
		})
	}

	test('python3 worker supports concurrent queries and mid-flight cancellation via conn.interrupt()', async () => {
		const { adapter, channel } = makeLocalSshAdapter('python3', sampleDbPath)
		try {
			await adapter.ping()
			const slowSql =
				'WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 20000000) SELECT COUNT(*) FROM cnt'
			const slowPromise = adapter.executeStatements([slowSql], { writable: false, queryId: 'py-slow-1' })
			// Fast query runs concurrently without head-of-line blocking
			const fastRes = await adapter.executeStatements(['SELECT 42 AS answer'], {
				writable: false,
				queryId: 'py-fast-1',
			})
			expect(fastRes[0]?.rows).toEqual([{ answer: 42 }])

			const cancelled = await adapter.cancelQuery('py-slow-1')
			expect(cancelled).toBe(true)
			await expect(slowPromise).rejects.toThrow(/cancelled/i)
		} finally {
			adapter.close()
			channel.close()
		}
	})

	test('auto-detect prefers bun and falls back cleanly when bun is absent from PATH', async () => {
		const pool = new SshMuxPool()
		// Strip bun from PATH & HOME so auto-detect picks python3
		const ch = new SshHostChannel(
			'local:auto-nobun',
			{ host: 'localhost', runtime: 'auto' },
			() => null,
			(remoteCmd) =>
				Bun.spawn(['/bin/sh', '-c', remoteCmd], {
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: 'pipe',
					env: { PATH: '/usr/bin:/bin', HOME: tempDir },
				}),
		)
		const adapter = new SshSqliteAdapter(pool, { host: 'localhost', runtime: 'auto' }, sampleDbPath, ch)
		try {
			const ping = await adapter.ping()
			expect(ping.ok).toBe(true)
			expect(ping.runtime).toBe('python3')
		} finally {
			adapter.close()
			ch.close()
		}
	})
})

describe('Serverless SQLite adapters (Turso / libSQL & Cloudflare D1)', () => {
	test('Turso / libSQL adapter speaks Hrana v2 /v2/pipeline with Bearer auth, RO query_only, and atomic mutations', async () => {
		const mem = new Database(':memory:')
		mem.exec(`
			CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, qty INTEGER NOT NULL);
			INSERT INTO items VALUES (1, 'Bolt', 10), (2, 'Nut', 25);
		`)
		let sawAuthHeader = ''
		let sawQueryOnly = false
		let sawBatchTransaction = false

		const runOne = (stmtSpec: { sql: string; args?: { type: string; value?: string | number }[] }) => {
			const sql = stmtSpec.sql
			const args = (stmtSpec.args ?? []).map((a) => {
				if (a.type === 'null') return null
				if (a.type === 'integer') return Number(a.value)
				if (a.type === 'float') return Number(a.value)
				return String(a.value ?? '')
			})
			const stmt = mem.query(sql)
			const cols = stmt.columnNames
			if (cols.length > 0) {
				const rows = stmt.all(...(args as (string | number | null)[])) as Record<string, unknown>[]
				return {
					cols: cols.map((name) => ({ name })),
					rows: rows.map((row) =>
						cols.map((c) => {
							const v = row[c]
							if (v === null || v === undefined) return { type: 'null' }
							if (typeof v === 'number')
								return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }
							return { type: 'text', value: String(v) }
						}),
					),
					affected_row_count: 0,
					last_insert_rowid: null,
				}
			}
			const info = mem.run(sql, args as (string | number | null)[])
			return {
				cols: [],
				rows: [],
				affected_row_count: info.changes,
				last_insert_rowid: info.lastInsertRowid ? String(info.lastInsertRowid) : null,
			}
		}

		const evalCond = (cond: any, stepOk: boolean[]): boolean => {
			if (!cond) return true
			if (cond.type === 'ok') return Boolean(stepOk[cond.step])
			if (cond.type === 'not') return !evalCond(cond.cond, stepOk)
			return true
		}

		const srv = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: async (req) => {
				if (new URL(req.url).pathname !== '/v2/pipeline') return new Response('not found', { status: 404 })
				sawAuthHeader = req.headers.get('authorization') ?? ''
				const body = (await req.json()) as {
					requests: {
						type: string
						stmt?: { sql: string; args?: { type: string; value?: string | number }[] }
						batch?: { steps: { condition?: unknown; stmt: { sql: string; args?: { type: string; value?: string | number }[] } }[] }
					}[]
				}
				const sqls = body.requests.filter((r) => r.type === 'execute').map((r) => r.stmt?.sql ?? '')
				if (sqls.includes('PRAGMA query_only = ON')) sawQueryOnly = true

				const results = body.requests.map((r) => {
					if (r.type === 'close') return { type: 'ok', response: { type: 'close' } }
					if (r.type === 'batch' && r.batch) {
						const stepSqls = r.batch.steps.map((s) => s.stmt.sql)
						if (stepSqls.includes('BEGIN') && stepSqls.includes('COMMIT') && stepSqls.includes('ROLLBACK')) {
							sawBatchTransaction = true
						}
						const stepOk: boolean[] = []
						const stepResults: (unknown | null)[] = []
						const stepErrors: ({ message: string } | null)[] = []
						for (const step of r.batch.steps) {
							if (!evalCond(step.condition, stepOk)) {
								stepOk.push(false)
								stepResults.push(null)
								stepErrors.push(null)
								continue
							}
							try {
								stepResults.push(runOne(step.stmt))
								stepErrors.push(null)
								stepOk.push(true)
							} catch (err) {
								stepResults.push(null)
								stepErrors.push({ message: err instanceof Error ? err.message : String(err) })
								stepOk.push(false)
							}
						}
						return {
							type: 'ok',
							response: { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } },
						}
					}
					try {
						return { type: 'ok', response: { type: 'execute', result: runOne(r.stmt!) } }
					} catch (err) {
						return { type: 'error', error: { message: err instanceof Error ? err.message : String(err) } }
					}
				})
				return Response.json({ results })
			},
		})

		try {
			expect(resolveTursoEndpoint('libsql://demo-org.turso.io?authToken=tok123')).toEqual({
				endpoint: 'https://demo-org.turso.io/v2/pipeline',
				authToken: 'tok123',
			})
			expect(maskConnectionPath('libsql://demo-org.turso.io?authToken=secret123')).toBe(
				'libsql://demo-org.turso.io?authToken=••••',
			)

			const adapter = createTursoAdapter(`http://127.0.0.1:${srv.port}`, 'turso-secret')
			const ping = await adapter.ping()
			expect(ping.ok).toBe(true)
			expect(sawAuthHeader).toBe('Bearer turso-secret')
			expect(sawQueryOnly).toBe(true)

			const schema = await adapter.getSchema()
			expect(schema.tables.map((t) => t.name)).toEqual(['items'])

			const page = await adapter.browseTable({ table: 'items', limit: 10 })
			expect(page.rows.length).toBe(2)

			const mut = await adapter.mutate({
				table: 'items',
				updates: [{ pk: { id: 1 }, changes: { qty: 99 } }],
				inserts: [{ id: 3, title: 'Washer', qty: 50 }],
			})
			expect(mut.applied).toBe(2)
			expect(sawBatchTransaction).toBe(true)

			// Verify a failing second statement rolls back the whole batch atomically
			await expect(
				adapter.mutate({
					table: 'items',
					updates: [{ pk: { id: 1 }, changes: { qty: 777 } }],
					inserts: [{ id: 1, title: 'Duplicate PK', qty: 1 }],
				}),
			).rejects.toThrow()

			const after = await adapter.browseTable({ table: 'items', limit: 10 })
			expect(after.rows.length).toBe(3)
			expect(after.rows[0]?.qty).toBe(99)
			adapter.close()
		} finally {
			srv.stop(true)
			mem.close()
		}
	})

	test('Cloudflare D1 adapter speaks REST API and enforces loopback-only custom endpoints', async () => {
		expect(() => parseD1Path('d1://acct/db?endpoint=https://evil.example.com')).toThrow(/localhost\/127\.0\.0\.1/)

		const mem = new Database(':memory:')
		mem.exec(`
			CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
			INSERT INTO notes VALUES (1, 'hello d1');
		`)
		let sawBearer = ''

		const srv = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: async (req) => {
				sawBearer = req.headers.get('authorization') ?? ''
				const body = (await req.json()) as { sql: string; params?: (string | number | null)[] }
				try {
					const stmt = mem.query(body.sql)
					if (stmt.columnNames.length > 0) {
						const results = stmt.all(...(body.params ?? []))
						return Response.json({ success: true, result: [{ success: true, results, meta: { changes: 0 } }] })
					}
					const info = mem.run(body.sql, body.params ?? [])
					return Response.json({
						success: true,
						result: [
							{
								success: true,
								results: [],
								meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
							},
						],
					})
				} catch (err) {
					return Response.json(
						{ success: false, errors: [{ message: err instanceof Error ? err.message : String(err) }] },
						{ status: 400 },
					)
				}
			},
		})

		try {
			const adapter = createD1Adapter(
				`d1://acct123/db456?endpoint=${encodeURIComponent(`http://127.0.0.1:${srv.port}`)}`,
				'cf-api-token',
			)
			const ping = await adapter.ping()
			expect(ping.ok).toBe(true)
			expect(sawBearer).toBe('Bearer cf-api-token')

			const schema = await adapter.getSchema()
			expect(schema.tables.map((t) => t.name)).toEqual(['notes'])

			const mut = await adapter.mutate({
				table: 'notes',
				inserts: [{ id: 2, body: 'second note' }],
			})
			expect(mut.applied).toBe(1)

			const rows = await adapter.browseTable({ table: 'notes', limit: 10 })
			expect(rows.rows.length).toBe(2)
			adapter.close()
		} finally {
			srv.stop(true)
			mem.close()
		}
	})

	test('formatSqlWithParams skips placeholders inside string literals and escapes quotes safely', () => {
		const rendered = formatSqlWithParams(`SELECT '?' AS q, * FROM t WHERE a = ? AND b = ?`, ["o'brien", 42])
		expect(rendered).toBe(`SELECT '?' AS q, * FROM t WHERE a = 'o''brien' AND b = 42`)
	})
})

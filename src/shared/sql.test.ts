// Unit tests for SQLite SQL tokenizer, statement splitter, cursor lookup, safety analyzer, linter, and formatter.
import { describe, expect, test } from 'bun:test'
import {
	analyzeSqlDanger,
	detectSourceTable,
	formatSql,
	lintSql,
	splitSqlStatements,
	statementAtCursor,
} from './sql.ts'

describe('splitSqlStatements', () => {
	test('splits multiple statements while ignoring semicolons in strings and comments', () => {
		const sql = `
			-- first; comment;
			SELECT 'a;b' AS x FROM users;
			/* block ; comment */
			SELECT "col;name" FROM orders WHERE note = 'it''s;ok';
		`
		const stmts = splitSqlStatements(sql)
		expect(stmts).toHaveLength(2)
		expect(stmts[0]!.text).toBe("SELECT 'a;b' AS x FROM users")
		expect(stmts[1]!.text).toBe("SELECT \"col;name\" FROM orders WHERE note = 'it''s;ok'")
	})

	test('keeps CREATE TRIGGER BEGIN...END intact', () => {
		const sql = `
			CREATE TRIGGER trg_u AFTER INSERT ON users BEGIN
				INSERT INTO audit(msg) VALUES ('added');
			END;
			SELECT * FROM audit;
		`
		const stmts = splitSqlStatements(sql)
		expect(stmts).toHaveLength(2)
		expect(stmts[0]!.text).toContain('END')
		expect(stmts[1]!.text).toBe('SELECT * FROM audit')
	})
})

describe('statementAtCursor', () => {
	test('finds the exact statement under the cursor', () => {
		const sql = 'SELECT 1;\n\nSELECT * FROM users;\n\nSELECT 3;'
		const idxSecond = sql.indexOf('users')
		const s = statementAtCursor(sql, idxSecond)
		expect(s?.text).toBe('SELECT * FROM users')
		expect(s?.index).toBe(1)
	})
})

describe('analyzeSqlDanger (trust boundary)', () => {
	test('classifies SELECT, EXPLAIN, and read-only PRAGMA as safe reads', () => {
		expect(analyzeSqlDanger('SELECT * FROM users')).toEqual({
			isWrite: false,
			isDestructive: false,
			warnings: [],
		})
		expect(analyzeSqlDanger('EXPLAIN QUERY PLAN DELETE FROM users')).toEqual({
			isWrite: false,
			isDestructive: false,
			warnings: [],
		})
		expect(analyzeSqlDanger('PRAGMA table_info(users)')).toEqual({
			isWrite: false,
			isDestructive: false,
			warnings: [],
		})
	})

	test('flags writes and CTE writes', () => {
		expect(analyzeSqlDanger('INSERT INTO users(name) VALUES ("a")').isWrite).toBe(true)
		expect(analyzeSqlDanger('WITH x AS (SELECT 1) DELETE FROM users WHERE id = 1').isWrite).toBe(true)
		expect(analyzeSqlDanger('PRAGMA journal_mode = WAL').isWrite).toBe(true)
	})

	test('flags destructive SQL (DROP, ALTER, DELETE/UPDATE without WHERE)', () => {
		const delAll = analyzeSqlDanger('DELETE FROM users')
		expect(delAll.isWrite).toBe(true)
		expect(delAll.isDestructive).toBe(true)
		expect(delAll.warnings[0]).toContain('without WHERE')

		const delSafe = analyzeSqlDanger('DELETE FROM users WHERE id = 42')
		expect(delSafe.isWrite).toBe(true)
		expect(delSafe.isDestructive).toBe(false)

		const updAll = analyzeSqlDanger('UPDATE users SET active = 0')
		expect(updAll.isDestructive).toBe(true)

		const drop = analyzeSqlDanger('DROP TABLE users')
		expect(drop.isDestructive).toBe(true)
	})
})

describe('detectSourceTable', () => {
	test('detects base table for simple SELECTs including quoted names', () => {
		expect(detectSourceTable('SELECT * FROM users WHERE id = 1')).toBe('users')
		expect(detectSourceTable('SELECT id, name FROM "order_items" AS oi')).toBe('order_items')
		expect(detectSourceTable('SELECT id FROM main.accounts')).toBe('accounts')
		expect(detectSourceTable('INSERT INTO users VALUES (1)')).toBeNull()
	})
})

describe('lintSql & formatSql', () => {
	test('reports unclosed strings, parens, unknown tables, and missing WHERE', () => {
		const diags = lintSql('SELECT * FROM ghost_table WHERE (id = 1; DELETE FROM users', ['users'])
		const msgs = diags.map((d) => d.message)
		expect(msgs.some((m) => m.includes('Unclosed opening parenthesis'))).toBe(true)
		expect(msgs.some((m) => m.includes('ghost_table'))).toBe(true)
		expect(msgs.some((m) => m.includes('without WHERE'))).toBe(true)
	})

	test('formats SQL with uppercase keywords and clean clause lines', () => {
		const out = formatSql("select id, name from users where active = 1 and role = 'admin' order by id desc limit 20;")
		expect(out).toContain(
			"SELECT\n  id,\n  name\nFROM users\nWHERE active = 1\n  AND role = 'admin'\nORDER BY id DESC\nLIMIT 20;",
		)
	})
})

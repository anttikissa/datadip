// SQLite (and Postgres-ready) SQL tokenizer, statement splitter, safety analyzer, linter, and formatter.

export interface SqlStatement {
	text: string
	from: number
	to: number
	index: number
}

export interface SqlDiagnostic {
	from: number
	to: number
	severity: 'error' | 'warning'
	message: string
}

export interface DangerAnalysis {
	isWrite: boolean
	isDestructive: boolean
	warnings: string[]
}

interface Token {
	kind: 'word' | 'string' | 'ident' | 'number' | 'symbol' | 'comment' | 'whitespace'
	text: string
	from: number
	to: number
}

const WRITE_START_KEYWORDS = new Set([
	'INSERT',
	'UPDATE',
	'DELETE',
	'REPLACE',
	'CREATE',
	'DROP',
	'ALTER',
	'TRUNCATE',
	'ATTACH',
	'DETACH',
	'VACUUM',
	'REINDEX',
	'ANALYZE',
])

const MAJOR_KEYWORDS = new Set([
	'SELECT',
	'FROM',
	'WHERE',
	'GROUP',
	'HAVING',
	'ORDER',
	'LIMIT',
	'OFFSET',
	'UNION',
	'INTERSECT',
	'EXCEPT',
	'VALUES',
	'SET',
	'INTO',
	'RETURNING',
	'WITH',
	'JOIN',
	'INNER',
	'LEFT',
	'RIGHT',
	'FULL',
	'CROSS',
	'OUTER',
	'ON',
	'USING',
	'AND',
	'OR',
	'NOT',
	'IN',
	'IS',
	'NULL',
	'AS',
	'BY',
	'ASC',
	'DESC',
	'DISTINCT',
	'CASE',
	'WHEN',
	'THEN',
	'ELSE',
	'END',
	'EXISTS',
	'LIKE',
	'GLOB',
	'BETWEEN',
	'INSERT',
	'UPDATE',
	'DELETE',
	'REPLACE',
	'CREATE',
	'TABLE',
	'INDEX',
	'VIEW',
	'TRIGGER',
	'DROP',
	'ALTER',
	'ADD',
	'COLUMN',
	'PRIMARY',
	'KEY',
	'FOREIGN',
	'REFERENCES',
	'UNIQUE',
	'DEFAULT',
	'CHECK',
	'AUTOINCREMENT',
	'PRAGMA',
	'EXPLAIN',
	'QUERY',
	'PLAN',
	'BEGIN',
	'COMMIT',
	'ROLLBACK',
	'TRANSACTION',
	'IF',
	'CAST',
	'COALESCE',
	'COUNT',
	'SUM',
	'AVG',
	'MIN',
	'MAX',
])

export function tokenizeSql(sql: string): { tokens: Token[]; errors: SqlDiagnostic[] } {
	const tokens: Token[] = []
	const errors: SqlDiagnostic[] = []
	let i = 0
	const n = sql.length

	while (i < n) {
		const ch = sql[i]!
		const next = sql[i + 1]

		// Whitespace
		if (/\s/.test(ch)) {
			const from = i
			while (i < n && /\s/.test(sql[i]!)) i++
			tokens.push({ kind: 'whitespace', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Line comment --
		if (ch === '-' && next === '-') {
			const from = i
			i += 2
			while (i < n && sql[i] !== '\n') i++
			tokens.push({ kind: 'comment', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Block comment /* ... */
		if (ch === '/' && next === '*') {
			const from = i
			i += 2
			let closed = false
			while (i < n) {
				if (sql[i] === '*' && sql[i + 1] === '/') {
					i += 2
					closed = true
					break
				}
				i++
			}
			if (!closed) {
				errors.push({ from, to: n, severity: 'error', message: 'Unclosed block comment /* ... */' })
			}
			tokens.push({ kind: 'comment', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Single-quoted string
		if (ch === "'") {
			const from = i
			i++
			let closed = false
			while (i < n) {
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if (!closed) {
				errors.push({ from, to: n, severity: 'error', message: 'Unclosed string literal' })
			}
			tokens.push({ kind: 'string', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Double-quoted or backtick identifier
		if (ch === '"' || ch === '`') {
			const quote = ch
			const from = i
			i++
			let closed = false
			while (i < n) {
				if (sql[i] === quote) {
					if (sql[i + 1] === quote) {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if (!closed) {
				errors.push({ from, to: n, severity: 'error', message: `Unclosed quoted identifier (${quote})` })
			}
			tokens.push({ kind: 'ident', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Bracketed identifier [name]
		if (ch === '[') {
			const from = i
			i++
			let closed = false
			while (i < n) {
				if (sql[i] === ']') {
					i++
					closed = true
					break
				}
				i++
			}
			if (!closed) {
				errors.push({ from, to: n, severity: 'error', message: 'Unclosed bracketed identifier [...]' })
			}
			tokens.push({ kind: 'ident', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Number
		if (/[0-9]/.test(ch)) {
			const from = i
			if (ch === '0' && (next === 'x' || next === 'X')) {
				i += 2
				while (i < n && /[0-9a-fA-F]/.test(sql[i]!)) i++
			} else {
				while (i < n && /[0-9.]/.test(sql[i]!)) i++
				if (i < n && (sql[i] === 'e' || sql[i] === 'E')) {
					i++
					if (i < n && (sql[i] === '+' || sql[i] === '-')) i++
					while (i < n && /[0-9]/.test(sql[i]!)) i++
				}
			}
			tokens.push({ kind: 'number', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Word / identifier
		if (/[A-Za-z_$]/.test(ch)) {
			const from = i
			while (i < n && /[A-Za-z0-9_$]/.test(sql[i]!)) i++
			tokens.push({ kind: 'word', text: sql.slice(from, i), from, to: i })
			continue
		}

		// Two-char operators
		if (
			(ch === '!' && next === '=') ||
			(ch === '<' && (next === '=' || next === '>')) ||
			(ch === '>' && next === '=') ||
			(ch === '|' && next === '|') ||
			(ch === ':' && next === ':')
		) {
			tokens.push({ kind: 'symbol', text: sql.slice(i, i + 2), from: i, to: i + 2 })
			i += 2
			continue
		}

		tokens.push({ kind: 'symbol', text: ch, from: i, to: i + 1 })
		i++
	}

	return { tokens, errors }
}

/** Splits a multi-statement SQL script into individual statements, keeping source offsets. */
export function splitSqlStatements(sql: string): SqlStatement[] {
	const { tokens } = tokenizeSql(sql)
	const statements: SqlStatement[] = []
	let stmtStart: number | null = null
	let lastNonTriviaEnd = 0
	let hasCode = false
	let triggerDepth = 0

	const pushCurrent = (endPos: number) => {
		if (stmtStart === null || !hasCode) {
			stmtStart = null
			hasCode = false
			return
		}
		const text = sql.slice(stmtStart, endPos).trim()
		if (text) {
			const leadingTrim = sql.slice(stmtStart, endPos).indexOf(text)
			const from = stmtStart + Math.max(0, leadingTrim)
			statements.push({
				text,
				from,
				to: from + text.length,
				index: statements.length,
			})
		}
		stmtStart = null
		hasCode = false
		triggerDepth = 0
	}

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!
		if (tok.kind === 'whitespace' || tok.kind === 'comment') continue

		if (stmtStart === null) stmtStart = tok.from
		hasCode = true
		lastNonTriviaEnd = tok.to

		if (tok.kind === 'word') {
			const upper = tok.text.toUpperCase()
			if (upper === 'BEGIN') {
				// Only enter trigger block if inside CREATE ... TRIGGER
				const prevWords = tokens
					.slice(0, i)
					.filter((t) => t.kind === 'word')
					.slice(-8)
					.map((t) => t.text.toUpperCase())
				if (prevWords.includes('TRIGGER')) {
					triggerDepth++
				}
			} else if (upper === 'END' && triggerDepth > 0) {
				triggerDepth--
			}
		}

		if (tok.kind === 'symbol' && tok.text === ';' && triggerDepth === 0) {
			pushCurrent(tok.from)
		}
	}

	if (stmtStart !== null && hasCode) {
		pushCurrent(lastNonTriviaEnd)
	}

	return statements
}

/** Returns the statement containing or immediately preceding the cursor offset. */
export function statementAtCursor(sql: string, offset: number): SqlStatement | null {
	const stmts = splitSqlStatements(sql)
	if (stmts.length === 0) return null

	// Direct hit (inclusive of trailing semicolon / whitespace right after statement)
	for (let i = 0; i < stmts.length; i++) {
		const s = stmts[i]!
		const nextStart = stmts[i + 1]?.from ?? sql.length + 1
		if (offset >= s.from && offset < nextStart) {
			// If cursor is on empty lines right before next statement, check distance
			if (offset <= s.to + 1) return s
			const between = sql.slice(s.to, offset)
			if (!between.includes(';')) return s
		}
	}

	// Fallback: statement closest before cursor, else first statement
	for (let i = stmts.length - 1; i >= 0; i--) {
		if (stmts[i]!.from <= offset) return stmts[i]!
	}
	return stmts[0]!
}

function significantTokens(sql: string): Token[] {
	return tokenizeSql(sql).tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment')
}

function unquoteIdent(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0]
		const last = raw[raw.length - 1]
		if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
			return raw.slice(1, -1).replaceAll(first + first, first)
		}
		if (first === '[' && last === ']') {
			return raw.slice(1, -1)
		}
	}
	return raw
}

/** Analyzes whether a SQL script performs writes or destructive actions. */
export function analyzeSqlDanger(sql: string): DangerAnalysis {
	const stmts = splitSqlStatements(sql)
	let isWrite = false
	let isDestructive = false
	const warnings: string[] = []

	for (const stmt of stmts) {
		const toks = significantTokens(stmt.text)
		if (toks.length === 0) continue

		// Skip leading WITH (...) CTE to find the main verb
		let verbIdx = 0
		if (toks[0]!.kind === 'word' && toks[0]!.text.toUpperCase() === 'WITH') {
			let depth = 0
			for (let i = 1; i < toks.length; i++) {
				const t = toks[i]!
				if (t.kind === 'symbol' && t.text === '(') depth++
				else if (t.kind === 'symbol' && t.text === ')') depth = Math.max(0, depth - 1)
				else if (depth === 0 && t.kind === 'word') {
					const u = t.text.toUpperCase()
					if (u === 'SELECT' || u === 'INSERT' || u === 'UPDATE' || u === 'DELETE' || u === 'REPLACE') {
						verbIdx = i
						break
					}
				}
			}
		}

		const verb = toks[verbIdx]?.kind === 'word' ? toks[verbIdx]!.text.toUpperCase() : ''

		if (verb === 'EXPLAIN') {
			// EXPLAIN / EXPLAIN QUERY PLAN never executes writes
			continue
		}

		if (verb === 'PRAGMA') {
			// PRAGMA foo = bar or PRAGMA foo(bar) is a write; PRAGMA table_info(...) / PRAGMA foo is read
			const pragmaName = toks[verbIdx + 1]?.text.toLowerCase() ?? ''
			const hasEquals = toks.slice(verbIdx + 1).some((t) => t.kind === 'symbol' && t.text === '=')
			const readOnlyPragmas = new Set([
				'table_info',
				'table_xinfo',
				'table_list',
				'foreign_key_list',
				'index_list',
				'index_info',
				'index_xinfo',
				'database_list',
				'compile_options',
				'integrity_check',
				'quick_check',
				'foreign_key_check',
				'page_count',
				'page_size',
				'freelist_count',
				'journal_mode',
				'synchronous',
				'user_version',
				'schema_version',
				'application_id',
				'encoding',
			])
			if (hasEquals || !readOnlyPragmas.has(pragmaName)) {
				isWrite = true
			}
			continue
		}

		if (verb === 'BEGIN') {
			const second = toks[verbIdx + 1]?.text.toUpperCase()
			if (second === 'IMMEDIATE' || second === 'EXCLUSIVE') isWrite = true
			continue
		}

		if (WRITE_START_KEYWORDS.has(verb)) {
			isWrite = true
		}

		// Destructive checks (apply on ALL databases per user requirement)
		if (verb === 'DROP') {
			isDestructive = true
			const target = toks
				.slice(verbIdx, verbIdx + 4)
				.map((t) => t.text)
				.join(' ')
			warnings.push(`Drops schema object: ${target}`)
		} else if (verb === 'TRUNCATE') {
			isDestructive = true
			warnings.push('Truncates table (removes all rows)')
		} else if (verb === 'ALTER') {
			isDestructive = true
			warnings.push('Alters table schema')
		} else if (verb === 'DELETE' || verb === 'UPDATE') {
			let depth = 0
			let hasWhere = false
			for (let i = verbIdx + 1; i < toks.length; i++) {
				const t = toks[i]!
				if (t.kind === 'symbol' && t.text === '(') depth++
				else if (t.kind === 'symbol' && t.text === ')') depth = Math.max(0, depth - 1)
				else if (depth === 0 && t.kind === 'word' && t.text.toUpperCase() === 'WHERE') {
					hasWhere = true
					break
				}
			}
			if (!hasWhere) {
				isDestructive = true
				warnings.push(`${verb} without WHERE clause affects every row in the table`)
			}
		}
	}

	return { isWrite, isDestructive, warnings }
}

/** Detects the primary table in a simple SELECT query so FK columns become clickable in console results. */
export function detectSourceTable(sql: string): string | null {
	const toks = significantTokens(sql)
	if (toks.length < 3) return null

	let idx = 0
	if (toks[0]!.kind === 'word' && toks[0]!.text.toUpperCase() === 'SELECT') {
		idx = 1
	} else {
		return null
	}

	let depth = 0
	for (let i = idx; i < toks.length; i++) {
		const t = toks[i]!
		if (t.kind === 'symbol' && t.text === '(') depth++
		else if (t.kind === 'symbol' && t.text === ')') depth = Math.max(0, depth - 1)
		else if (depth === 0 && t.kind === 'word' && t.text.toUpperCase() === 'FROM') {
			const next = toks[i + 1]
			if (!next || (next.kind === 'symbol' && next.text === '(')) return null
			// Handle schema.table
			if (toks[i + 2]?.kind === 'symbol' && toks[i + 2]!.text === '.' && toks[i + 3]) {
				return unquoteIdent(toks[i + 3]!.text)
			}
			if (next.kind === 'word' || next.kind === 'ident') {
				return unquoteIdent(next.text)
			}
			return null
		}
	}
	return null
}

/** Lints SQLite SQL for syntax issues, unbalanced parens, unknown tables, and unsafe UPDATE/DELETE. */
export function lintSql(sql: string, knownTables?: string[]): SqlDiagnostic[] {
	const { tokens, errors } = tokenizeSql(sql)
	const diagnostics: SqlDiagnostic[] = [...errors]

	// Check balanced parentheses
	const stack: Token[] = []
	for (const tok of tokens) {
		if (tok.kind === 'symbol' && tok.text === '(') {
			stack.push(tok)
		} else if (tok.kind === 'symbol' && tok.text === ')') {
			if (stack.length === 0) {
				diagnostics.push({
					from: tok.from,
					to: tok.to,
					severity: 'error',
					message: 'Unmatched closing parenthesis',
				})
			} else {
				stack.pop()
			}
		}
	}
	for (const unclosed of stack) {
		diagnostics.push({
			from: unclosed.from,
			to: unclosed.to,
			severity: 'error',
			message: 'Unclosed opening parenthesis',
		})
	}

	// Per-statement checks
	const tableSet = knownTables ? new Set(knownTables.map((t) => t.toLowerCase())) : null
	const stmts = splitSqlStatements(sql)
	for (const stmt of stmts) {
		const danger = analyzeSqlDanger(stmt.text)
		for (const w of danger.warnings) {
			if (w.includes('without WHERE')) {
				diagnostics.push({
					from: stmt.from,
					to: Math.min(stmt.to, stmt.from + 40),
					severity: 'warning',
					message: w,
				})
			}
		}

		if (tableSet && tableSet.size > 0) {
			const stmtTokens = tokenizeSql(stmt.text).tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment')
			for (let i = 0; i < stmtTokens.length - 1; i++) {
				const kw = stmtTokens[i]!
				if (kw.kind !== 'word') continue
				const upper = kw.text.toUpperCase()
				if (upper === 'FROM' || upper === 'JOIN' || upper === 'INTO' || upper === 'UPDATE') {
					const target = stmtTokens[i + 1]!
					if (target.kind !== 'word' && target.kind !== 'ident') continue
					const name = unquoteIdent(target.text).toLowerCase()
					if (!tableSet.has(name) && !name.startsWith('sqlite_') && !MAJOR_KEYWORDS.has(name.toUpperCase())) {
						// Skip CTE names defined in WITH [RECURSIVE] name[(col, ...)] AS (...)
						const isCte = stmtTokens.some((t, j) => {
							if (j >= i) return false
							if (t.kind !== 'word' && t.kind !== 'ident') return false
							if (unquoteIdent(t.text).toLowerCase() !== name) return false
							let k = j + 1
							if (stmtTokens[k]?.kind === 'symbol' && stmtTokens[k]!.text === '(') {
								let depth = 1
								k++
								while (k < i && depth > 0) {
									if (stmtTokens[k]?.kind === 'symbol' && stmtTokens[k]!.text === '(') depth++
									else if (stmtTokens[k]?.kind === 'symbol' && stmtTokens[k]!.text === ')') depth--
									k++
								}
							}
							return stmtTokens[k]?.text.toUpperCase() === 'AS'
						})
						if (!isCte) {
							diagnostics.push({
								from: stmt.from + target.from,
								to: stmt.from + target.to,
								severity: 'warning',
								message: `Table "${unquoteIdent(target.text)}" not found in current schema`,
							})
						}
					}
				}
			}
		}
	}

	return diagnostics
}

const NEWLINE_BEFORE = new Set([
	'SELECT',
	'FROM',
	'WHERE',
	'HAVING',
	'LIMIT',
	'OFFSET',
	'UNION',
	'INTERSECT',
	'EXCEPT',
	'VALUES',
	'SET',
	'RETURNING',
])

const TWO_WORD_CLAUSES = new Set([
	'GROUP BY',
	'ORDER BY',
	'LEFT JOIN',
	'RIGHT JOIN',
	'INNER JOIN',
	'OUTER JOIN',
	'CROSS JOIN',
	'FULL JOIN',
	'LEFT OUTER',
	'RIGHT OUTER',
	'INSERT INTO',
	'DELETE FROM',
	'UNION ALL',
])

/** Formats SQLite/SQL cleanly with uppercase keywords and consistent clause indentation. */
export function formatSql(sql: string): string {
	const stmts = splitSqlStatements(sql)
	if (stmts.length === 0) return sql.trim()

	const formatted = stmts.map((stmt) => formatSingleStatement(stmt.text))
	return formatted.join(';\n\n') + (sql.trim().endsWith(';') ? ';' : '')
}

function formatSingleStatement(sql: string): string {
	const { tokens } = tokenizeSql(sql)
	const out: string[] = []
	let depth = 0
	let prevKind: Token['kind'] | null = null
	let prevText = ''
	let inSelectList = false

	const meaningful = tokens.filter((t) => t.kind !== 'whitespace')

	for (let i = 0; i < meaningful.length; i++) {
		const tok = meaningful[i]!
		const next = meaningful[i + 1]

		if (tok.kind === 'comment') {
			if (out.length > 0 && !out[out.length - 1]!.endsWith('\n')) out.push(' ')
			out.push(tok.text)
			if (tok.text.startsWith('--')) out.push('\n' + '  '.repeat(depth))
			continue
		}

		let text = tok.text
		const upper = tok.kind === 'word' ? text.toUpperCase() : ''
		if (tok.kind === 'word' && MAJOR_KEYWORDS.has(upper)) {
			text = upper
		}

		const twoWord = tok.kind === 'word' && next?.kind === 'word' ? `${upper} ${next.text.toUpperCase()}` : ''

		if (tok.kind === 'symbol' && tok.text === '(') {
			const noSpaceAfterWord = prevKind === 'word' && !MAJOR_KEYWORDS.has(prevText.toUpperCase())
			if (out.length > 0 && !noSpaceAfterWord && prevText !== '(' && prevText !== '.') {
				if (!out[out.length - 1]!.endsWith('\n') && !out[out.length - 1]!.endsWith(' ')) {
					out.push(' ')
				}
			}
			out.push('(')
			depth++
			prevKind = tok.kind
			prevText = tok.text
			continue
		}

		if (tok.kind === 'symbol' && tok.text === ')') {
			depth = Math.max(0, depth - 1)
			out.push(')')
			prevKind = tok.kind
			prevText = tok.text
			continue
		}

		if (tok.kind === 'symbol' && tok.text === ',') {
			out.push(',')
			if (depth === 0 && inSelectList) {
				out.push('\n  ')
			} else {
				out.push(' ')
			}
			prevKind = tok.kind
			prevText = tok.text
			continue
		}

		if (tok.kind === 'symbol' && tok.text === '.') {
			out.push('.')
			prevKind = tok.kind
			prevText = tok.text
			continue
		}

		if (depth === 0 && tok.kind === 'word') {
			if (upper === 'SELECT') inSelectList = true
			else if (upper === 'FROM' || upper === 'INTO' || upper === 'WHERE' || upper === 'SET') {
				inSelectList = false
			}

			if (out.length > 0) {
				if (TWO_WORD_CLAUSES.has(twoWord)) {
					out.push('\n' + '  '.repeat(depth))
				} else if (
					NEWLINE_BEFORE.has(upper) &&
					prevText !== 'UNION' &&
					prevText !== 'INSERT' &&
					prevText !== 'DELETE'
				) {
					out.push('\n' + '  '.repeat(depth))
				} else if ((upper === 'AND' || upper === 'OR') && !inSelectList) {
					out.push('\n  ' + '  '.repeat(depth))
				} else if (upper === 'JOIN' && !['LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL'].includes(prevText)) {
					out.push('\n' + '  '.repeat(depth))
				} else if (
					!out[out.length - 1]!.endsWith('\n') &&
					!out[out.length - 1]!.endsWith(' ') &&
					prevText !== '(' &&
					prevText !== '.'
				) {
					out.push(' ')
				}
			}
			out.push(text)
			if (upper === 'SELECT') {
				out.push('\n  ')
			}
			prevKind = tok.kind
			prevText = text
			continue
		}

		if (
			out.length > 0 &&
			!out[out.length - 1]!.endsWith('\n') &&
			!out[out.length - 1]!.endsWith(' ') &&
			prevText !== '(' &&
			prevText !== '.'
		) {
			out.push(' ')
		}
		out.push(text)
		prevKind = tok.kind
		prevText = text
	}

	return out
		.join('')
		.replace(/[ \t]+\n/g, '\n')
		.trim()
}

// Self-contained remote worker script transmitted over SSH stdin to run concurrent SQLite operations via Bun.
// Kept as plain JavaScript source string so zero files need to be installed on remote servers.

export const REMOTE_WORKER_SOURCE = String.raw`
const { Database } = await import('bun:sqlite');
const fs = await import('node:fs');
const path = await import('node:path');
const os = await import('node:os');

const handles = new Map();

function expandPath(p) {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

function getDb(dbPath, writable) {
	const resolved = expandPath(dbPath);
	const key = (writable ? 'rw:' : 'ro:') + resolved;
	let entry = handles.get(key);
	if (entry) {
		entry.lastUsed = Date.now();
		return entry.db;
	}
	if (!fs.existsSync(resolved)) {
		throw new Error('SQLite database file not found on remote host: ' + resolved);
	}
	const db = writable
		? new Database(resolved, { readwrite: true })
		: new Database(resolved, { readonly: true });
	db.exec(writable ? 'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;' : 'PRAGMA busy_timeout = 5000;');
	handles.set(key, { db, lastUsed: Date.now() });
	return db;
}

setInterval(() => {
	const cutoff = Date.now() - 5 * 60 * 1000;
	for (const [k, v] of handles.entries()) {
		if (v.lastUsed < cutoff) {
			try { v.db.close(); } catch {}
			handles.delete(k);
		}
	}
}, 60 * 1000).unref();

function quoteIdent(name) {
	return '"' + String(name).replaceAll('"', '""') + '"';
}

function normalizeCell(val) {
	if (val === null || val === undefined) return null;
	if (typeof val === 'bigint') return val.toString();
	if (val instanceof Uint8Array || val instanceof ArrayBuffer) {
		const bytes = val instanceof Uint8Array ? val : new Uint8Array(val);
		const preview = Array.from(bytes.slice(0, 32), b => b.toString(16).padStart(2, '0')).join('');
		return '<BLOB ' + bytes.length + 'B 0x' + preview + (bytes.length > 32 ? '…' : '') + '>';
	}
	return val;
}

function normalizeRow(row) {
	const out = {};
	for (const [k, v] of Object.entries(row)) out[k] = normalizeCell(v);
	return out;
}

function coerceParam(raw, colType) {
	const t = (colType || '').toUpperCase();
	if (t.includes('INT') || t.includes('REAL') || t.includes('NUM') || t.includes('FLOA') || t.includes('DOUB')) {
		if (/^-?\d+(\.\d+)?$/.test(String(raw).trim())) {
			const num = Number(String(raw).trim());
			if (Number.isSafeInteger(num) || String(raw).includes('.')) return num;
		}
	}
	return raw;
}

function sqlLiteralPreview(val) {
	if (val === null || val === undefined) return 'NULL';
	if (typeof val === 'number') return String(val);
	return "'" + String(val).replaceAll("'", "''") + "'";
}

function detectSourceTable(sql) {
	const m = /^\s*SELECT\b[\s\S]*?\bFROM\s+(?:["\`\[]?([A-Za-z0-9_$-]+)["\`\]]?\s*\.\s*)?["\`\[]?([A-Za-z0-9_$-]+)["\`\]]?/i.exec(sql);
	if (!m) return null;
	return m[2] || null;
}

function getSchema(db) {
	const t0 = performance.now();
	const masterRows = db.query(
		"SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE"
	).all();
	let skipSlowCounts = false;
	try {
		const pc = db.query('PRAGMA page_count').get()?.page_count || 0;
		const ps = db.query('PRAGMA page_size').get()?.page_size || 4096;
		skipSlowCounts = pc * ps > 50 * 1024 * 1024;
	} catch {}
	const statCounts = new Map();
	try {
		if (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get()) {
			for (const r of db.query('SELECT tbl, stat FROM sqlite_stat1').all()) {
				const n = Number(String(r.stat || '').split(' ')[0]);
				if (Number.isFinite(n) && !statCounts.has(r.tbl)) statCounts.set(r.tbl, n);
			}
		}
	} catch {}
	const tables = [];
	const schemas = {};
	for (const m of masterRows) {
		const qName = quoteIdent(m.name);
		const columns = db.query('PRAGMA table_info(' + qName + ')').all().map(c => ({
			name: c.name,
			type: c.type || 'ANY',
			notNull: Boolean(c.notnull),
			defaultValue: c.dflt_value,
			primaryKey: c.pk,
		}));
		const primaryKeyColumns = columns.filter(c => c.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey).map(c => c.name);
		const foreignKeys = m.type === 'table'
			? db.query('PRAGMA foreign_key_list(' + qName + ')').all().map(fk => ({
				id: fk.id,
				fromColumn: fk.from,
				toTable: fk.table,
				toColumn: fk.to || 'id',
				onUpdate: fk.on_update,
				onDelete: fk.on_delete,
			}))
			: [];
		const indexes = [];
		if (m.type === 'table') {
			for (const idx of db.query('PRAGMA index_list(' + qName + ')').all()) {
				const cols = db.query('PRAGMA index_info(' + quoteIdent(idx.name) + ')').all().map(c => c.name || '').filter(Boolean);
				indexes.push({ name: idx.name, unique: Boolean(idx.unique), origin: idx.origin, columns: cols });
			}
		}
		let rowCount = null;
		if (m.type === 'table') {
			if (skipSlowCounts) rowCount = statCounts.has(m.name) ? statCounts.get(m.name) : null;
			else {
				try { rowCount = db.query('SELECT COUNT(*) AS c FROM ' + qName).get()?.c ?? 0; } catch {}
			}
		}
		tables.push({ name: m.name, type: m.type, rowCount });
		schemas[m.name] = { name: m.name, type: m.type, ddl: m.sql || '', columns, foreignKeys, reverseForeignKeys: [], indexes, primaryKeyColumns };
	}
	for (const s of Object.values(schemas)) {
		for (const fk of s.foreignKeys) {
			if (schemas[fk.toTable]) {
				schemas[fk.toTable].reverseForeignKeys.push({ fromTable: s.name, fromColumn: fk.fromColumn, toColumn: fk.toColumn });
			}
		}
	}
	return { tables, schemas, durationMs: Math.round((performance.now() - t0) * 100) / 100 };
}

function browseTable(db, params) {
	const t0 = performance.now();
	const schema = getSchema(db);
	const ts = schema.schemas[params.table];
	if (!ts) throw new Error('Table or view not found: ' + params.table);
	const colMap = new Map(ts.columns.map(c => [c.name, c]));
	const selectedCols = params.fields && params.fields.length > 0
		? params.fields.filter(f => colMap.has(f))
		: ts.columns.map(c => c.name);
	if (selectedCols.length === 0) throw new Error('No valid columns selected');

	const validOrders = (params.order || []).filter(o => colMap.has(o.column));
	if (validOrders.length === 0 && ts.primaryKeyColumns.length > 0) {
		validOrders.push({ column: ts.primaryKeyColumns[0], dir: 'asc' });
	}
	const singleUnique = new Set();
	if (ts.primaryKeyColumns.length === 1) singleUnique.add(ts.primaryKeyColumns[0]);
	for (const idx of ts.indexes) if (idx.unique && idx.columns.length === 1) singleUnique.add(idx.columns[0]);
	const keysetCol = validOrders.length === 1 && singleUnique.has(validOrders[0].column) ? validOrders[0].column : null;
	const keysetDir = validOrders[0]?.dir || 'asc';

	const clauses = [];
	const bindings = [];
	for (const f of params.filters || []) {
		const col = colMap.get(f.column);
		if (!col) throw new Error('Unknown column in filter: ' + f.column);
		const qc = quoteIdent(col.name);
		if (f.op === 'eq') { clauses.push(qc + ' = ?'); bindings.push(coerceParam(f.value, col.type)); }
		else if (f.op === 'neq') { clauses.push(qc + ' != ?'); bindings.push(coerceParam(f.value, col.type)); }
		else if (f.op === 'gt') { clauses.push(qc + ' > ?'); bindings.push(coerceParam(f.value, col.type)); }
		else if (f.op === 'gte') { clauses.push(qc + ' >= ?'); bindings.push(coerceParam(f.value, col.type)); }
		else if (f.op === 'lt') { clauses.push(qc + ' < ?'); bindings.push(coerceParam(f.value, col.type)); }
		else if (f.op === 'lte') { clauses.push(qc + ' <= ?'); bindings.push(coerceParam(f.value, col.type)); }
		else if (f.op === 'like') { clauses.push('CAST(' + qc + ' AS TEXT) LIKE ?'); bindings.push(f.value.includes('%') || f.value.includes('_') ? f.value : '%' + f.value + '%'); }
		else if (f.op === 'in') {
			const parts = String(f.value).split(',').map(s => s.trim()).filter(Boolean);
			if (parts.length > 0) { clauses.push(qc + ' IN (' + parts.map(() => '?').join(', ') + ')'); for (const p of parts) bindings.push(coerceParam(p, col.type)); }
		}
		else if (f.op === 'isnull') clauses.push(qc + ' IS NULL');
		else if (f.op === 'notnull') clauses.push(qc + ' IS NOT NULL');
	}
	if (params.search && String(params.search).trim()) {
		const pat = '%' + String(params.search).trim() + '%';
		const checks = [];
		for (const col of colMap.values()) { checks.push('CAST(' + quoteIdent(col.name) + ' AS TEXT) LIKE ?'); bindings.push(pat); }
		if (checks.length > 0) clauses.push('(' + checks.join(' OR ') + ')');
	}

	const qTable = quoteIdent(ts.name);
	let totalCount = null;
	try {
		const cSql = 'SELECT COUNT(*) AS c FROM ' + qTable + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '');
		totalCount = db.query(cSql).get(...bindings)?.c ?? 0;
	} catch {}

	const fetchCols = keysetCol && !selectedCols.includes(keysetCol) ? [...selectedCols, keysetCol] : selectedCols;
	const rowClauses = [...clauses];
	const rowBindings = [...bindings];
	const limit = Math.max(1, Math.min(2000, params.limit || 100));
	const isPrev = params.direction === 'prev';
	let orderSql = '';
	let offsetSql = '';

	if (keysetCol && params.start !== undefined && params.start !== null && params.start !== '') {
		const col = colMap.get(keysetCol);
		const cv = coerceParam(params.start, col.type);
		if (isPrev) {
			rowClauses.push(quoteIdent(keysetCol) + (keysetDir === 'asc' ? ' < ?' : ' > ?'));
			rowBindings.push(cv);
			orderSql = ' ORDER BY ' + quoteIdent(keysetCol) + (keysetDir === 'asc' ? ' DESC' : ' ASC');
		} else {
			rowClauses.push(quoteIdent(keysetCol) + (keysetDir === 'asc' ? ' > ?' : ' < ?'));
			rowBindings.push(cv);
			orderSql = ' ORDER BY ' + quoteIdent(keysetCol) + ' ' + keysetDir.toUpperCase();
		}
	} else {
		if (validOrders.length > 0) {
			orderSql = ' ORDER BY ' + validOrders.map(o => quoteIdent(o.column) + ' ' + o.dir.toUpperCase()).join(', ');
		}
		if (params.offset && params.offset > 0) offsetSql = ' OFFSET ' + Math.floor(params.offset);
	}

	const whereSql = rowClauses.length ? ' WHERE ' + rowClauses.join(' AND ') : '';
	const sql = 'SELECT ' + fetchCols.map(quoteIdent).join(', ') + ' FROM ' + qTable + whereSql + orderSql + ' LIMIT ' + (limit + 1) + offsetSql;
	const rawRows = db.query(sql).all(...rowBindings).map(normalizeRow);
	const hasMore = rawRows.length > limit;
	let rows = hasMore ? rawRows.slice(0, limit) : rawRows;
	if (keysetCol && params.start && isPrev) rows = rows.reverse();

	let hasNext = false, hasPrev = false, nextCursor = null, prevCursor = null;
	if (keysetCol && rows.length > 0) {
		const fk = rows[0][keysetCol], lk = rows[rows.length - 1][keysetCol];
		if (params.start) { hasPrev = isPrev ? hasMore : true; hasNext = isPrev ? true : hasMore; }
		else { hasPrev = false; hasNext = hasMore; }
		nextCursor = hasNext && fk !== undefined && lk !== null && lk !== undefined ? String(lk) : null;
		prevCursor = hasPrev && fk !== null && fk !== undefined ? String(fk) : null;
	} else {
		hasPrev = (params.offset || 0) > 0;
		hasNext = hasMore;
	}
	if (fetchCols.length !== selectedCols.length && keysetCol) {
		rows = rows.map(r => { const c = { ...r }; delete c[keysetCol]; return c; });
	}
	const columnTypes = {};
	for (const c of selectedCols) columnTypes[c] = colMap.get(c)?.type || 'ANY';
	return {
		table: ts.name, columns: selectedCols, columnTypes, rows, totalCount,
		hasNext, hasPrev, nextCursor, prevCursor,
		durationMs: Math.round((performance.now() - t0) * 100) / 100,
		generatedSql: sql, keysetColumn: keysetCol,
	};
}

function executeStatements(db, statements, maxRows) {
	const cap = maxRows || 2000;
	const results = [];
	for (const rawSql of statements) {
		const sql = String(rawSql).trim();
		if (!sql) continue;
		const t0 = performance.now();
		try {
			const stmt = db.query(sql);
			const cols = stmt.columnNames;
			if (cols.length > 0) {
				const rows = [];
				let truncated = false;
				for (const r of stmt.iterate()) {
					if (rows.length >= cap) { truncated = true; break; }
					rows.push(normalizeRow(r));
				}
				results.push({ sql, columns: cols, rows, rowCount: rows.length, changes: 0, lastInsertRowid: null, durationMs: Math.round((performance.now() - t0) * 100) / 100, sourceTable: detectSourceTable(sql), truncated });
			} else {
				const info = stmt.run();
				results.push({ sql, columns: [], rows: [], rowCount: 0, changes: info.changes, lastInsertRowid: typeof info.lastInsertRowid === 'bigint' ? info.lastInsertRowid.toString() : info.lastInsertRowid, durationMs: Math.round((performance.now() - t0) * 100) / 100, sourceTable: null, truncated: false });
			}
		} catch (err) {
			results.push({ sql, columns: [], rows: [], rowCount: 0, changes: 0, lastInsertRowid: null, durationMs: Math.round((performance.now() - t0) * 100) / 100, sourceTable: null, truncated: false, error: err && err.message ? err.message : String(err) });
			break;
		}
	}
	return results;
}

function mutateTable(db, req) {
	const t0 = performance.now();
	const schema = getSchema(db);
	const ts = schema.schemas[req.table];
	if (!ts) throw new Error('Table not found: ' + req.table);
	if (ts.type !== 'table') throw new Error('Cannot mutate view: ' + req.table);
	const colMap = new Map(ts.columns.map(c => [c.name, c]));
	const qTable = quoteIdent(ts.name);
	const sqlPreview = [];
	let applied = 0;

	db.transaction(() => {
		for (const upd of req.updates || []) {
			const sets = Object.entries(upd.changes);
			const pks = Object.entries(upd.pk);
			if (!sets.length) continue;
			if (!pks.length) throw new Error('Update requires primary key');
			const setC = [], whereC = [], vals = [];
			for (const [c, v] of sets) { if (!colMap.has(c)) throw new Error('Unknown column: ' + c); setC.push(quoteIdent(c) + ' = ?'); vals.push(v === undefined ? null : v); }
			for (const [c, v] of pks) { if (!colMap.has(c)) throw new Error('Unknown PK column: ' + c); if (v === null || v === undefined) whereC.push(quoteIdent(c) + ' IS NULL'); else { whereC.push(quoteIdent(c) + ' = ?'); vals.push(v); } }
			const sql = 'UPDATE ' + qTable + ' SET ' + setC.join(', ') + ' WHERE ' + whereC.join(' AND ');
			sqlPreview.push('UPDATE ' + qTable + ' SET ' + sets.map(([c, v]) => quoteIdent(c) + ' = ' + sqlLiteralPreview(v)).join(', ') + ' WHERE ' + pks.map(([c, v]) => v === null ? quoteIdent(c) + ' IS NULL' : quoteIdent(c) + ' = ' + sqlLiteralPreview(v)).join(' AND ') + ';');
			applied += db.run(sql, vals).changes;
		}
		for (const ins of req.inserts || []) {
			const entries = Object.entries(ins).filter(([c]) => colMap.has(c));
			if (!entries.length) {
				sqlPreview.push('INSERT INTO ' + qTable + ' DEFAULT VALUES;');
				applied += db.run('INSERT INTO ' + qTable + ' DEFAULT VALUES').changes;
			} else {
				const cols = entries.map(([c]) => quoteIdent(c)).join(', ');
				const vals = entries.map(([, v]) => v === undefined ? null : v);
				sqlPreview.push('INSERT INTO ' + qTable + ' (' + cols + ') VALUES (' + vals.map(sqlLiteralPreview).join(', ') + ');');
				applied += db.run('INSERT INTO ' + qTable + ' (' + cols + ') VALUES (' + entries.map(() => '?').join(', ') + ')', vals).changes;
			}
		}
		for (const pk of req.deletes || []) {
			const pks = Object.entries(pk);
			if (!pks.length) throw new Error('Delete requires primary key');
			const whereC = [], vals = [];
			for (const [c, v] of pks) { if (!colMap.has(c)) throw new Error('Unknown PK column: ' + c); if (v === null || v === undefined) whereC.push(quoteIdent(c) + ' IS NULL'); else { whereC.push(quoteIdent(c) + ' = ?'); vals.push(v); } }
			sqlPreview.push('DELETE FROM ' + qTable + ' WHERE ' + pks.map(([c, v]) => v === null ? quoteIdent(c) + ' IS NULL' : quoteIdent(c) + ' = ' + sqlLiteralPreview(v)).join(' AND ') + ';');
			applied += db.run('DELETE FROM ' + qTable + ' WHERE ' + whereC.join(' AND '), vals).changes;
		}
	})();
	return { applied, durationMs: Math.round((performance.now() - t0) * 100) / 100, sqlPreview };
}

function peekRow(db, table, column, value) {
	const schema = getSchema(db);
	const ts = schema.schemas[table];
	if (!ts) return null;
	const col = ts.columns.find(c => c.name === column);
	if (!col) return null;
	const val = typeof value === 'string' ? coerceParam(value, col.type) : value;
	const r = db.query('SELECT * FROM ' + quoteIdent(ts.name) + ' WHERE ' + quoteIdent(col.name) + ' = ? LIMIT 1').get(val);
	return r ? normalizeRow(r) : null;
}

function countReverseFks(db, table, row) {
	const schema = getSchema(db);
	const ts = schema.schemas[table];
	if (!ts) return [];
	return ts.reverseForeignKeys.map(rfk => {
		const v = row[rfk.toColumn];
		if (v === null || v === undefined) return { ...rfk, count: 0 };
		try {
			const c = db.query('SELECT COUNT(*) AS c FROM ' + quoteIdent(rfk.fromTable) + ' WHERE ' + quoteIdent(rfk.fromColumn) + ' = ?').get(v)?.c ?? 0;
			return { ...rfk, count: c };
		} catch { return { ...rfk, count: 0 }; }
	});
}

function searchId(db, value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) return [];
	const schema = getSchema(db);
	const matches = [];
	for (const ts of Object.values(schema.schemas)) {
		if (ts.type !== 'table') continue;
		const cols = new Set(ts.primaryKeyColumns);
		for (const fk of ts.foreignKeys) cols.add(fk.fromColumn);
		for (const c of ts.columns) if (c.name === 'id' || c.name.endsWith('_id') || c.name.endsWith('Id')) cols.add(c.name);
		for (const cn of cols) {
			const col = ts.columns.find(c => c.name === cn);
			if (!col) continue;
			try {
				const r = db.query('SELECT * FROM ' + quoteIdent(ts.name) + ' WHERE ' + quoteIdent(col.name) + ' = ? LIMIT 1').get(coerceParam(trimmed, col.type));
				if (r) {
					matches.push({ table: ts.name, column: col.name, isPrimaryKey: col.primaryKey > 0, row: normalizeRow(r) });
					if (matches.length >= 25) return matches;
				}
			} catch {}
		}
	}
	return matches;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.config', '.local', '.npm', '.bun', '.Trash', 'attic', 'Library', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const SQLITE_MAGIC = 'SQLite format 3\0';

function isSqliteFile(filePath) {
	let fd;
	try {
		fd = fs.openSync(filePath, 'r');
		const buf = Buffer.alloc(16);
		const bytes = fs.readSync(fd, buf, 0, 16, 0);
		return bytes === 16 && buf.toString('utf8') === SQLITE_MAGIC;
	} catch { return false; }
	finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function discoverDbs(roots, maxDepth) {
	const found = [];
	const seenFiles = new Set();
	const seenDirs = new Set();
	const depthLimit = Math.max(1, Math.min(6, maxDepth || 4));
	const startRoots = (roots && roots.length ? roots : [os.homedir(), '/var/lib']).map(expandPath);

	function walk(dir, depth) {
		if (depth > depthLimit || found.length >= 100) return;
		let realDir;
		try { realDir = fs.realpathSync(dir); } catch { return; }
		if (seenDirs.has(realDir)) return;
		seenDirs.add(realDir);

		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			if (found.length >= 100) return;
			const full = path.join(dir, ent.name);
			let isDir = ent.isDirectory();
			let isFile = ent.isFile();
			if (ent.isSymbolicLink()) {
				try {
					const st = fs.statSync(full);
					isDir = st.isDirectory();
					isFile = st.isFile();
				} catch { continue; }
			}
			if (isDir) {
				if (SKIP_DIRS.has(ent.name)) continue;
				if (ent.name.startsWith('.') && ent.name !== '.data' && !ent.name.startsWith('.hal')) continue;
				walk(full, depth + 1);
			} else if (isFile) {
				if (/\.(sqlite|sqlite3|db)$/i.test(ent.name) && !ent.name.endsWith('-wal') && !ent.name.endsWith('-shm')) {
					let realFile = full;
					try { realFile = fs.realpathSync(full); } catch {}
					if (seenFiles.has(realFile)) continue;
					if (!isSqliteFile(full)) continue;
					seenFiles.add(realFile);
					try {
						const st = fs.statSync(full);
						found.push({ path: realFile, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() });
					} catch {}
				}
			}
		}
	}
	for (const r of startRoots) if (fs.existsSync(r)) walk(r, 0);
	return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function handle(req) {
	const { op, path: dbPath, rw, params } = req;
	if (op === 'discover') return discoverDbs(params.roots, params.maxDepth);
	if (op === 'hostPing') return { ok: true, hostname: os.hostname(), bunVersion: Bun.version };
	const db = getDb(dbPath, Boolean(rw));
	switch (op) {
		case 'ping': {
			const t0 = performance.now();
			const v = db.query('SELECT sqlite_version() AS v').get();
			return { ok: true, latencyMs: Math.round((performance.now() - t0) * 100) / 100, version: v?.v };
		}
		case 'schema': return getSchema(db);
		case 'browse': return browseTable(db, params);
		case 'query': return executeStatements(db, params.statements, params.maxRows);
		case 'mutate': return mutateTable(db, params);
		case 'peek': return peekRow(db, params.table, params.column, params.value);
		case 'reverseFks': return countReverseFks(db, params.table, params.row);
		case 'searchId': return searchId(db, params.value);
		default: throw new Error('Unknown op: ' + op);
	}
}

const QUERY_WORKER_CODE = [
	"const { Database } = await import('bun:sqlite');",
	"const fs = await import('node:fs');",
	"function normalizeCell(val) {",
	"  if (val === null || val === undefined) return null;",
	"  if (typeof val === 'bigint') return val.toString();",
	"  if (val instanceof Uint8Array || val instanceof ArrayBuffer) {",
	"    const bytes = val instanceof Uint8Array ? val : new Uint8Array(val);",
	"    const preview = Array.from(bytes.slice(0, 32), b => b.toString(16).padStart(2, '0')).join('');",
	"    return '<BLOB ' + bytes.length + 'B 0x' + preview + (bytes.length > 32 ? '…' : '') + '>';",
	"  }",
	"  return val;",
	"}",
	"function normalizeRow(row) {",
	"  const out = {};",
	"  for (const [k, v] of Object.entries(row)) out[k] = normalizeCell(v);",
	"  return out;",
	"}",
	"function detectSourceTable(sql) {",
	"  const m = /^\\s*SELECT\\b[\\s\\S]*?\\bFROM\\s+(?:[\"\\x60\\[]?([A-Za-z0-9_$-]+)[\"\\x60\\]]?\\s*\\.\\s*)?[\"\\x60\\[]?([A-Za-z0-9_$-]+)[\"\\x60\\]]?/i.exec(sql);",
	"  return m && m[2] ? m[2] : null;",
	"}",
	"self.onmessage = (ev) => {",
	"  const { dbPath, writable, statements, maxRows } = ev.data;",
	"  let db = null;",
	"  try {",
	"    if (!fs.existsSync(dbPath)) throw new Error('SQLite database file not found on remote host: ' + dbPath);",
	"    db = writable ? new Database(dbPath, { readwrite: true }) : new Database(dbPath, { readonly: true });",
	"    db.exec(writable ? 'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;' : 'PRAGMA busy_timeout = 5000;');",
	"    const cap = maxRows || 2000;",
	"    const results = [];",
	"    for (const rawSql of statements) {",
	"      const sql = String(rawSql).trim();",
	"      if (!sql) continue;",
	"      const t0 = performance.now();",
	"      try {",
	"        const stmt = db.query(sql);",
	"        const cols = stmt.columnNames;",
	"        if (cols.length > 0) {",
	"          const rows = [];",
	"          let truncated = false;",
	"          for (const r of stmt.iterate()) {",
	"            if (rows.length >= cap) { truncated = true; break; }",
	"            rows.push(normalizeRow(r));",
	"          }",
	"          results.push({ sql, columns: cols, rows, rowCount: rows.length, changes: 0, lastInsertRowid: null, durationMs: Math.round((performance.now() - t0) * 100) / 100, sourceTable: detectSourceTable(sql), truncated });",
	"        } else {",
	"          const info = stmt.run();",
	"          results.push({ sql, columns: [], rows: [], rowCount: 0, changes: info.changes, lastInsertRowid: typeof info.lastInsertRowid === 'bigint' ? info.lastInsertRowid.toString() : info.lastInsertRowid, durationMs: Math.round((performance.now() - t0) * 100) / 100, sourceTable: null, truncated: false });",
	"        }",
	"      } catch (err) {",
	"        results.push({ sql, columns: [], rows: [], rowCount: 0, changes: 0, lastInsertRowid: null, durationMs: Math.round((performance.now() - t0) * 100) / 100, sourceTable: null, truncated: false, error: err && err.message ? err.message : String(err) });",
	"        break;",
	"      }",
	"    }",
	"    self.postMessage({ ok: true, result: results });",
	"  } catch (err) {",
	"    self.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });",
	"  } finally {",
	"    try { if (db) db.close(); } catch {}",
	"  }",
	"};",
].join('\n');

const queryWorkerUrl = URL.createObjectURL(new Blob([QUERY_WORKER_CODE], { type: 'application/javascript' }));
const activeQueryWorkers = new Map();

function runQueryAsync(req) {
	const w = new Worker(queryWorkerUrl);
	let settled = false;
	const finish = (payload) => {
		if (settled) return;
		settled = true;
		activeQueryWorkers.delete(req.id);
		try { w.terminate(); } catch {}
		process.stdout.write(JSON.stringify({ id: req.id, ...payload }) + '\n');
	};
	activeQueryWorkers.set(req.id, {
		cancel: () => finish({ ok: false, error: 'Query cancelled' }),
	});
	w.onmessage = (ev) => {
		const msg = ev.data || {};
		if (msg.ok) finish({ ok: true, result: msg.result });
		else finish({ ok: false, error: msg.error || 'Remote query worker failed' });
	};
	w.onerror = (ev) => {
		finish({ ok: false, error: (ev && ev.message) || 'Remote query worker crashed' });
	};
	w.postMessage({
		dbPath: expandPath(req.path),
		writable: Boolean(req.rw),
		statements: req.params?.statements || [],
		maxRows: req.params?.maxRows,
	});
}

const decoder = new TextDecoder();
let buf = initialBuf || '';
process.stdout.write(JSON.stringify({ ready: true }) + '\n');

function drainLines() {
	let nl;
	while ((nl = buf.indexOf('\n')) !== -1) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let req;
		try { req = JSON.parse(line); } catch { continue; }
		if (req.op === 'query') {
			try {
				runQueryAsync(req);
			} catch (err) {
				process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: err && err.message ? err.message : String(err) }) + '\n');
			}
			continue;
		}
		if (req.op === 'cancel') {
			const targetId = req.params?.targetId;
			const entry = targetId ? activeQueryWorkers.get(targetId) : null;
			if (entry) entry.cancel();
			process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { cancelled: Boolean(entry) } }) + '\n');
			continue;
		}
		try {
			const result = handle(req);
			process.stdout.write(JSON.stringify({ id: req.id, ok: true, result }) + '\n');
		} catch (err) {
			process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: err && err.message ? err.message : String(err) }) + '\n');
		}
	}
}

drainLines();
while (true) {
	const { value, done } = await reader.read();
	if (done) break;
	buf += decoder.decode(value, { stream: true });
	drainLines();
}
`

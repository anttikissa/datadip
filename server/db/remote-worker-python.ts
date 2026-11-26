// Self-contained remote Python 3 stdlib worker transmitted over SSH stdin for multiplexed SQLite operations.
// Uses threading + conn.interrupt() for concurrent queries and real mid-flight cancellation with zero pip packages.

export const REMOTE_PYTHON_WORKER_SOURCE = String.raw`
import concurrent.futures
import json
import os
import re
import sqlite3
import sys
import threading
import time
from urllib.parse import quote

handles_lock = threading.Lock()
handles = {}
active_lock = threading.Lock()
active_queries = {}
stdout_lock = threading.Lock()
executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)


def send(obj):
    line = json.dumps(obj, separators=(',', ':'), ensure_ascii=False) + '\n'
    with stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def expand_path(p):
    if not p:
        return ''
    if p == '~':
        return os.path.expanduser('~')
    if p.startswith('~/'):
        return os.path.join(os.path.expanduser('~'), p[2:])
    return p


def open_conn(db_path, writable):
    resolved = expand_path(db_path)
    if not os.path.exists(resolved):
        raise FileNotFoundError('SQLite database file not found on remote host: ' + resolved)
    if writable:
        conn = sqlite3.connect(resolved, check_same_thread=False, isolation_level=None)
        conn.execute('PRAGMA busy_timeout = 5000')
        conn.execute('PRAGMA foreign_keys = ON')
    else:
        uri = 'file:' + quote(resolved, safe='/') + '?mode=ro'
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False, isolation_level=None)
        conn.execute('PRAGMA busy_timeout = 5000')
        conn.execute('PRAGMA query_only = ON')
    conn.row_factory = sqlite3.Row
    return conn


def quote_ident(name):
    return '"' + str(name).replace('"', '""') + '"'


def normalize_cell(val):
    if val is None:
        return None
    if isinstance(val, (bytes, bytearray, memoryview)):
        raw = bytes(val)
        preview = raw[:32].hex()
        ellipsis = '…' if len(raw) > 32 else ''
        return f'<BLOB {len(raw)}B 0x{preview}{ellipsis}>'
    if isinstance(val, int) and not isinstance(val, bool):
        if val > 9007199254740991 or val < -9007199254740991:
            return str(val)
    return val


def normalize_row(row):
    return {k: normalize_cell(row[k]) for k in row.keys()}


def coerce_param(raw, col_type=''):
    t = (col_type or '').upper()
    s = str(raw).strip()
    if any(k in t for k in ('INT', 'REAL', 'NUM', 'FLOA', 'DOUB')):
        if re.match(r'^-?\d+(\.\d+)?$', s):
            if '.' in s:
                return float(s)
            n = int(s)
            if -9007199254740991 <= n <= 9007199254740991:
                return n
    return raw


def sql_literal_preview(val):
    if val is None:
        return 'NULL'
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return str(val)
    return "'" + str(val).replace("'", "''") + "'"


def detect_source_table(sql):
    m = re.match(
        r'^\s*SELECT\b[\s\S]*?\bFROM\s+(?:["\x60\[]?([A-Za-z0-9_$-]+)["\x60\]]?\s*\.\s*)?["\x60\[]?([A-Za-z0-9_$-]+)["\x60\]]?',
        sql,
        re.IGNORECASE,
    )
    return m.group(2) if m and m.group(2) else None


def get_schema(conn):
    t0 = time.perf_counter()
    master_rows = conn.execute(
        "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
        "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name COLLATE NOCASE"
    ).fetchall()
    skip_slow = False
    try:
        pc = (conn.execute('PRAGMA page_count').fetchone() or [0])[0] or 0
        ps = (conn.execute('PRAGMA page_size').fetchone() or [4096])[0] or 4096
        skip_slow = pc * ps > 50 * 1024 * 1024
    except Exception:
        pass

    stat_counts = {}
    try:
        if conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").fetchone():
            for r in conn.execute('SELECT tbl, stat FROM sqlite_stat1').fetchall():
                tok = str(r['stat'] or '').split(' ')[0]
                if tok.isdigit() and r['tbl'] not in stat_counts:
                    stat_counts[r['tbl']] = int(tok)
    except Exception:
        pass

    shadow_tables = set()
    fts_suf = ('_content', '_data', '_docsize', '_idx', '_config', '_segments', '_segdir', '_stat')
    rt_suf = ('_node', '_rowid', '_parent')
    for m in master_rows:
        ddl = m['sql'] or ''
        if re.match(r'^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+fts[345]\b', ddl, re.IGNORECASE):
            for s in fts_suf:
                shadow_tables.add(m['name'] + s)
        elif re.match(r'^CREATE\s+VIRTUAL\s+TABLE\b[\s\S]*?\bUSING\s+rtree', ddl, re.IGNORECASE):
            for s in rt_suf:
                shadow_tables.add(m['name'] + s)

    triggers = [
        {'name': tr['name'], 'table': tr['tbl_name'], 'sql': tr['sql'] or ''}
        for tr in conn.execute(
            "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name COLLATE NOCASE, name COLLATE NOCASE"
        ).fetchall()
    ]
    triggers_by_table = {}
    for tr in triggers:
        triggers_by_table.setdefault(tr['table'], []).append(tr)

    tables = []
    schemas = {}
    for m in master_rows:
        name = m['name']
        typ = m['type']
        q_name = quote_ident(name)
        columns = [
            {
                'name': c['name'],
                'type': c['type'] or 'ANY',
                'notNull': bool(c['notnull']),
                'defaultValue': c['dflt_value'],
                'primaryKey': c['pk'],
            }
            for c in conn.execute(f'PRAGMA table_info({q_name})').fetchall()
        ]
        pk_cols = [c['name'] for c in sorted([c for c in columns if c['primaryKey'] > 0], key=lambda x: x['primaryKey'])]
        fks = []
        if typ == 'table':
            for fk in conn.execute(f'PRAGMA foreign_key_list({q_name})').fetchall():
                fks.append({
                    'id': fk['id'],
                    'fromColumn': fk['from'],
                    'toTable': fk['table'],
                    'toColumn': fk['to'] or 'id',
                    'onUpdate': fk['on_update'],
                    'onDelete': fk['on_delete'],
                })
        indexes = []
        if typ == 'table':
            for idx in conn.execute(f'PRAGMA index_list({q_name})').fetchall():
                cols = [c['name'] for c in conn.execute(f'PRAGMA index_info({quote_ident(idx["name"])})').fetchall() if c['name']]
                indexes.append({'name': idx['name'], 'unique': bool(idx['unique']), 'origin': idx['origin'], 'columns': cols})

        row_count = None
        if typ == 'table':
            if skip_slow:
                row_count = stat_counts.get(name)
            else:
                try:
                    c_row = conn.execute(f'SELECT COUNT(*) AS c FROM {q_name}').fetchone()
                    row_count = c_row['c'] if c_row else 0
                except Exception:
                    row_count = None

        entry = {'name': name, 'type': typ, 'rowCount': row_count}
        if name in shadow_tables:
            entry['isInternal'] = True
        tables.append(entry)
        schemas[name] = {
            'name': name,
            'type': typ,
            'ddl': m['sql'] or '',
            'columns': columns,
            'foreignKeys': fks,
            'reverseForeignKeys': [],
            'indexes': indexes,
            'primaryKeyColumns': pk_cols,
            'triggers': triggers_by_table.get(name, []),
        }

    for s in schemas.values():
        for fk in s['foreignKeys']:
            target = schemas.get(fk['toTable'])
            if target is not None:
                target['reverseForeignKeys'].append({
                    'fromTable': s['name'],
                    'fromColumn': fk['fromColumn'],
                    'toColumn': fk['toColumn'],
                })

    return {'tables': tables, 'schemas': schemas, 'triggers': triggers, 'durationMs': round((time.perf_counter() - t0) * 1000, 2)}


def browse_table(conn, params):
    t0 = time.perf_counter()
    schema = get_schema(conn)
    ts = schema['schemas'].get(params['table'])
    if not ts:
        raise ValueError('Table or view not found: ' + str(params['table']))
    col_map = {c['name']: c for c in ts['columns']}
    fields = params.get('fields') or []
    selected_cols = [f for f in fields if f in col_map] if fields else [c['name'] for c in ts['columns']]
    if not selected_cols:
        raise ValueError('No valid columns selected')

    valid_orders = [o for o in (params.get('order') or []) if o.get('column') in col_map]
    if not valid_orders and ts['primaryKeyColumns']:
        valid_orders.append({'column': ts['primaryKeyColumns'][0], 'dir': 'asc'})

    single_unique = set()
    if len(ts['primaryKeyColumns']) == 1:
        single_unique.add(ts['primaryKeyColumns'][0])
    for idx in ts['indexes']:
        if idx['unique'] and len(idx['columns']) == 1:
            single_unique.add(idx['columns'][0])
    keyset_col = valid_orders[0]['column'] if len(valid_orders) == 1 and valid_orders[0]['column'] in single_unique else None
    keyset_dir = valid_orders[0]['dir'] if valid_orders else 'asc'

    clauses = []
    bindings = []
    for f in params.get('filters') or []:
        col = col_map.get(f['column'])
        if not col:
            raise ValueError('Unknown column in filter: ' + str(f['column']))
        qc = quote_ident(col['name'])
        op = f['op']
        val = f.get('value', '')
        if op == 'eq':
            clauses.append(f'{qc} = ?'); bindings.append(coerce_param(val, col['type']))
        elif op == 'neq':
            clauses.append(f'{qc} != ?'); bindings.append(coerce_param(val, col['type']))
        elif op == 'gt':
            clauses.append(f'{qc} > ?'); bindings.append(coerce_param(val, col['type']))
        elif op == 'gte':
            clauses.append(f'{qc} >= ?'); bindings.append(coerce_param(val, col['type']))
        elif op == 'lt':
            clauses.append(f'{qc} < ?'); bindings.append(coerce_param(val, col['type']))
        elif op == 'lte':
            clauses.append(f'{qc} <= ?'); bindings.append(coerce_param(val, col['type']))
        elif op == 'like':
            clauses.append(f'CAST({qc} AS TEXT) LIKE ?')
            bindings.append(val if ('%' in val or '_' in val) else f'%{val}%')
        elif op == 'in':
            parts = [p.strip() for p in str(val).split(',') if p.strip()]
            if parts:
                clauses.append(f'{qc} IN ({", ".join(["?"] * len(parts))})')
                for p in parts:
                    bindings.append(coerce_param(p, col['type']))
        elif op == 'isnull':
            clauses.append(f'{qc} IS NULL')
        elif op == 'notnull':
            clauses.append(f'{qc} IS NOT NULL')

    search = str(params.get('search') or '').strip()
    if search:
        pat = f'%{search}%'
        checks = []
        for col in col_map.values():
            checks.append(f'CAST({quote_ident(col["name"])} AS TEXT) LIKE ?')
            bindings.append(pat)
        if checks:
            clauses.append('(' + ' OR '.join(checks) + ')')

    q_table = quote_ident(ts['name'])
    table_summary = next((t for t in schema['tables'] if t['name'] == ts['name']), None)
    skip_slow = False
    try:
        pc = (conn.execute('PRAGMA page_count').fetchone() or [0])[0] or 0
        ps = (conn.execute('PRAGMA page_size').fetchone() or [4096])[0] or 4096
        skip_slow = pc * ps > 50 * 1024 * 1024
    except Exception:
        pass

    total_count = None
    if skip_slow:
        total_count = table_summary['rowCount'] if (not clauses and table_summary) else None
    else:
        try:
            c_sql = f'SELECT COUNT(*) AS c FROM {q_table}' + (f' WHERE {" AND ".join(clauses)}' if clauses else '')
            c_row = conn.execute(c_sql, bindings).fetchone()
            total_count = c_row['c'] if c_row else 0
        except Exception:
            total_count = None

    fetch_cols = selected_cols + [keyset_col] if (keyset_col and keyset_col not in selected_cols) else list(selected_cols)
    row_clauses = list(clauses)
    row_bindings = list(bindings)
    limit = max(1, min(2000, int(params.get('limit') or 100)))
    is_prev = params.get('direction') == 'prev'
    start = params.get('start')
    order_sql = ''
    offset_sql = ''

    if keyset_col and start is not None and start != '':
        cv = coerce_param(start, col_map[keyset_col]['type'])
        if is_prev:
            row_clauses.append(f'{quote_ident(keyset_col)} {"<" if keyset_dir == "asc" else ">"} ?')
            row_bindings.append(cv)
            order_sql = f' ORDER BY {quote_ident(keyset_col)} {"DESC" if keyset_dir == "asc" else "ASC"}'
        else:
            row_clauses.append(f'{quote_ident(keyset_col)} {">" if keyset_dir == "asc" else "<"} ?')
            row_bindings.append(cv)
            order_sql = f' ORDER BY {quote_ident(keyset_col)} {keyset_dir.upper()}'
    else:
        if valid_orders:
            order_sql = ' ORDER BY ' + ', '.join(f'{quote_ident(o["column"])} {o["dir"].upper()}' for o in valid_orders)
        offset = int(params.get('offset') or 0)
        if offset > 0:
            offset_sql = f' OFFSET {offset}'

    where_sql = f' WHERE {" AND ".join(row_clauses)}' if row_clauses else ''
    sql = f'SELECT {", ".join(quote_ident(c) for c in fetch_cols)} FROM {q_table}{where_sql}{order_sql} LIMIT {limit + 1}{offset_sql}'
    raw_rows = [normalize_row(r) for r in conn.execute(sql, row_bindings).fetchall()]
    has_more = len(raw_rows) > limit
    rows = raw_rows[:limit] if has_more else raw_rows
    if keyset_col and start and is_prev:
        rows.reverse()

    has_next = False
    has_prev = False
    next_cursor = None
    prev_cursor = None
    if keyset_col and rows:
        fk = rows[0].get(keyset_col)
        lk = rows[-1].get(keyset_col)
        if start:
            has_prev = has_more if is_prev else True
            has_next = True if is_prev else has_more
        else:
            has_prev = False
            has_next = has_more
        next_cursor = str(lk) if (has_next and lk is not None) else None
        prev_cursor = str(fk) if (has_prev and fk is not None) else None
    else:
        has_prev = int(params.get('offset') or 0) > 0
        has_next = has_more

    if len(fetch_cols) != len(selected_cols) and keyset_col:
        for r in rows:
            r.pop(keyset_col, None)

    col_types = {c: col_map[c]['type'] for c in selected_cols}
    return {
        'table': ts['name'],
        'columns': selected_cols,
        'columnTypes': col_types,
        'rows': rows,
        'totalCount': total_count,
        'hasNext': has_next,
        'hasPrev': has_prev,
        'nextCursor': next_cursor,
        'prevCursor': prev_cursor,
        'durationMs': round((time.perf_counter() - t0) * 1000, 2),
        'generatedSql': sql,
        'keysetColumn': keyset_col,
    }


def execute_statements(db_path, writable, statements, max_rows, req_id):
    conn = open_conn(db_path, writable)
    with active_lock:
        active_queries[req_id] = conn
    cap = int(max_rows or 2000)
    results = []
    try:
        for raw_sql in statements or []:
            sql = str(raw_sql).strip()
            if not sql:
                continue
            t0 = time.perf_counter()
            try:
                cur = conn.execute(sql)
                if cur.description:
                    cols = [d[0] for d in cur.description]
                    rows = []
                    truncated = False
                    while True:
                        r = cur.fetchone()
                        if r is None:
                            break
                        if len(rows) >= cap:
                            truncated = True
                            break
                        rows.append({cols[i]: normalize_cell(r[i]) for i in range(len(cols))})
                    results.append({
                        'sql': sql,
                        'columns': cols,
                        'rows': rows,
                        'rowCount': len(rows),
                        'changes': 0,
                        'lastInsertRowid': None,
                        'durationMs': round((time.perf_counter() - t0) * 1000, 2),
                        'sourceTable': detect_source_table(sql),
                        'truncated': truncated,
                    })
                else:
                    changes = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else 0
                    last_id = cur.lastrowid if cur.lastrowid else None
                    results.append({
                        'sql': sql,
                        'columns': [],
                        'rows': [],
                        'rowCount': 0,
                        'changes': changes,
                        'lastInsertRowid': last_id,
                        'durationMs': round((time.perf_counter() - t0) * 1000, 2),
                        'sourceTable': None,
                        'truncated': False,
                    })
            except sqlite3.OperationalError as err:
                msg = str(err)
                if 'interrupted' in msg.lower():
                    raise RuntimeError('Query cancelled')
                results.append({
                    'sql': sql, 'columns': [], 'rows': [], 'rowCount': 0, 'changes': 0, 'lastInsertRowid': None,
                    'durationMs': round((time.perf_counter() - t0) * 1000, 2), 'sourceTable': None, 'truncated': False,
                    'error': msg,
                })
                break
            except Exception as err:
                results.append({
                    'sql': sql, 'columns': [], 'rows': [], 'rowCount': 0, 'changes': 0, 'lastInsertRowid': None,
                    'durationMs': round((time.perf_counter() - t0) * 1000, 2), 'sourceTable': None, 'truncated': False,
                    'error': str(err),
                })
                break
        return results
    finally:
        with active_lock:
            active_queries.pop(req_id, None)
        try:
            conn.close()
        except Exception:
            pass


def mutate_table(conn, req):
    t0 = time.perf_counter()
    schema = get_schema(conn)
    ts = schema['schemas'].get(req['table'])
    if not ts:
        raise ValueError('Table not found: ' + str(req['table']))
    if ts['type'] != 'table':
        raise ValueError('Cannot mutate view: ' + str(req['table']))
    col_map = {c['name']: c for c in ts['columns']}
    q_table = quote_ident(ts['name'])
    sql_preview = []
    applied = 0

    conn.execute('BEGIN')
    try:
        for upd in req.get('updates') or []:
            sets = list((upd.get('changes') or {}).items())
            pks = list((upd.get('pk') or {}).items())
            if not sets:
                continue
            if not pks:
                raise ValueError('Update requires primary key')
            set_c, where_c, vals = [], [], []
            for c, v in sets:
                if c not in col_map:
                    raise ValueError('Unknown column: ' + c)
                set_c.append(f'{quote_ident(c)} = ?'); vals.append(v)
            for c, v in pks:
                if c not in col_map:
                    raise ValueError('Unknown PK column: ' + c)
                if v is None:
                    where_c.append(f'{quote_ident(c)} IS NULL')
                else:
                    where_c.append(f'{quote_ident(c)} = ?'); vals.append(v)
            sql = f'UPDATE {q_table} SET {", ".join(set_c)} WHERE {" AND ".join(where_c)}'
            sql_preview.append(
                f'UPDATE {q_table} SET {", ".join(quote_ident(c) + " = " + sql_literal_preview(v) for c, v in sets)} '
                f'WHERE {" AND ".join((quote_ident(c) + " IS NULL") if v is None else (quote_ident(c) + " = " + sql_literal_preview(v)) for c, v in pks)};'
            )
            cur = conn.execute(sql, vals)
            applied += max(0, cur.rowcount)

        for ins in req.get('inserts') or []:
            entries = [(c, v) for c, v in ins.items() if c in col_map]
            if not entries:
                sql_preview.append(f'INSERT INTO {q_table} DEFAULT VALUES;')
                cur = conn.execute(f'INSERT INTO {q_table} DEFAULT VALUES')
                applied += max(0, cur.rowcount)
            else:
                cols = ', '.join(quote_ident(c) for c, _ in entries)
                vals = [v for _, v in entries]
                sql_preview.append(f'INSERT INTO {q_table} ({cols}) VALUES ({", ".join(sql_literal_preview(v) for v in vals)});')
                cur = conn.execute(f'INSERT INTO {q_table} ({cols}) VALUES ({", ".join(["?"] * len(vals))})', vals)
                applied += max(0, cur.rowcount)

        for pk in req.get('deletes') or []:
            pks = list(pk.items())
            if not pks:
                raise ValueError('Delete requires primary key')
            where_c, vals = [], []
            for c, v in pks:
                if c not in col_map:
                    raise ValueError('Unknown PK column: ' + c)
                if v is None:
                    where_c.append(f'{quote_ident(c)} IS NULL')
                else:
                    where_c.append(f'{quote_ident(c)} = ?'); vals.append(v)
            sql_preview.append(
                f'DELETE FROM {q_table} WHERE {" AND ".join((quote_ident(c) + " IS NULL") if v is None else (quote_ident(c) + " = " + sql_literal_preview(v)) for c, v in pks)};'
            )
            cur = conn.execute(f'DELETE FROM {q_table} WHERE {" AND ".join(where_c)}', vals)
            applied += max(0, cur.rowcount)
        conn.execute('COMMIT')
    except Exception:
        try:
            conn.execute('ROLLBACK')
        except Exception:
            pass
        raise
    return {'applied': applied, 'durationMs': round((time.perf_counter() - t0) * 1000, 2), 'sqlPreview': sql_preview}


def peek_row(conn, table, column, value):
    schema = get_schema(conn)
    ts = schema['schemas'].get(table)
    if not ts:
        return None
    col = next((c for c in ts['columns'] if c['name'] == column), None)
    if not col:
        return None
    val = coerce_param(value, col['type']) if isinstance(value, str) else value
    r = conn.execute(f'SELECT * FROM {quote_ident(ts["name"])} WHERE {quote_ident(col["name"])} = ? LIMIT 1', [val]).fetchone()
    return normalize_row(r) if r else None


def count_reverse_fks(conn, table, row, extra_rfks):
    schema = get_schema(conn)
    ts = schema['schemas'].get(table)
    if not ts:
        return []
    seen = set()
    all_rfks = []
    for rfk in ts['reverseForeignKeys']:
        key = (rfk['fromTable'], rfk['fromColumn'], rfk['toColumn'])
        seen.add(key)
        all_rfks.append(rfk)
    for rfk in extra_rfks or []:
        key = (rfk['fromTable'], rfk['fromColumn'], rfk['toColumn'])
        if key in seen:
            continue
        from_s = schema['schemas'].get(rfk['fromTable'])
        if not from_s or not any(c['name'] == rfk['fromColumn'] for c in from_s['columns']):
            continue
        if not any(c['name'] == rfk['toColumn'] for c in ts['columns']):
            continue
        seen.add(key)
        all_rfks.append(rfk)

    out = []
    for rfk in all_rfks:
        v = row.get(rfk['toColumn'])
        if v is None:
            out.append({**rfk, 'count': 0})
            continue
        try:
            c_row = conn.execute(
                f'SELECT COUNT(*) AS c FROM {quote_ident(rfk["fromTable"])} WHERE {quote_ident(rfk["fromColumn"])} = ?',
                [v],
            ).fetchone()
            out.append({**rfk, 'count': c_row['c'] if c_row else 0})
        except Exception:
            out.append({**rfk, 'count': 0})
    return out


def check_keys_exist(conn, probes):
    if not probes:
        return []
    schema = get_schema(conn)
    results = []
    for probe in probes[:48]:
        ts = schema['schemas'].get(probe.get('table'))
        col = next((c for c in (ts['columns'] if ts else []) if c['name'] == probe.get('column')), None)
        vals = list(dict.fromkeys([v for v in (probe.get('values') or []) if isinstance(v, str) and v]))[:16]
        if not ts or not col or not vals:
            results.append({'table': probe.get('table'), 'column': probe.get('column'), 'matchedValues': []})
            continue
        try:
            ph = ', '.join(['?'] * len(vals))
            rows = conn.execute(
                f'SELECT DISTINCT {quote_ident(col["name"])} AS v FROM {quote_ident(ts["name"])} WHERE {quote_ident(col["name"])} IN ({ph})',
                vals,
            ).fetchall()
            matched = [str(r['v']) for r in rows if r['v'] is not None and str(r['v'])]
            results.append({'table': probe['table'], 'column': probe['column'], 'matchedValues': matched})
        except Exception:
            results.append({'table': probe['table'], 'column': probe['column'], 'matchedValues': []})
    return results


def search_id(conn, value):
    trimmed = str(value or '').strip()
    if not trimmed:
        return []
    schema = get_schema(conn)
    matches = []
    for ts in schema['schemas'].values():
        if ts['type'] != 'table':
            continue
        cols = set(ts['primaryKeyColumns'])
        for fk in ts['foreignKeys']:
            cols.add(fk['fromColumn'])
        for c in ts['columns']:
            if c['name'] == 'id' or c['name'].endswith('_id') or c['name'].endswith('Id'):
                cols.add(c['name'])
        for cn in cols:
            col = next((c for c in ts['columns'] if c['name'] == cn), None)
            if not col:
                continue
            try:
                r = conn.execute(
                    f'SELECT * FROM {quote_ident(ts["name"])} WHERE {quote_ident(col["name"])} = ? LIMIT 1',
                    [coerce_param(trimmed, col['type'])],
                ).fetchone()
                if r:
                    matches.append({'table': ts['name'], 'column': col['name'], 'isPrimaryKey': col['primaryKey'] > 0, 'row': normalize_row(r)})
                    if len(matches) >= 25:
                        return matches
            except Exception:
                pass
    return matches


def profile_column(conn, table, column):
    t0 = time.perf_counter()
    schema = get_schema(conn)
    ts = schema['schemas'].get(table)
    if not ts:
        raise ValueError('Table or view not found: ' + str(table))
    col = next((c for c in ts['columns'] if c['name'] == column), None)
    if not col:
        raise ValueError(f'Column not found: {table}.{column}')
    qt = quote_ident(ts['name'])
    qc = quote_ident(col['name'])
    agg = conn.execute(
        f'SELECT COUNT(*) AS total, COUNT({qc}) AS non_null, COUNT(DISTINCT {qc}) AS distinct_cnt, MIN({qc}) AS min_val, MAX({qc}) AS max_val FROM {qt}'
    ).fetchone()
    total = agg['total'] or 0
    non_null = agg['non_null'] or 0
    null_cnt = max(0, total - non_null)
    null_pct = round((null_cnt / total) * 100, 1) if total > 0 else 0.0
    top_rows = conn.execute(f'SELECT {qc} AS val, COUNT(*) AS cnt FROM {qt} GROUP BY {qc} ORDER BY cnt DESC LIMIT 10').fetchall()

    def fmt(v):
        n = normalize_cell(v)
        return None if n is None else str(n)

    return {
        'table': ts['name'],
        'column': col['name'],
        'columnType': col['type'],
        'totalRows': total,
        'nonNullCount': non_null,
        'nullCount': null_cnt,
        'nullPct': null_pct,
        'distinctCount': agg['distinct_cnt'] or 0,
        'min': fmt(agg['min_val']),
        'max': fmt(agg['max_val']),
        'topValues': [{'value': fmt(r['val']), 'count': r['cnt']} for r in top_rows],
        'durationMs': round((time.perf_counter() - t0) * 1000, 2),
    }


def get_db_info(conn, db_path):
    t0 = time.perf_counter()
    resolved = expand_path(db_path)
    ver = (conn.execute('SELECT sqlite_version()').fetchone() or [''])[0]

    def pv(name):
        try:
            r = conn.execute(f'PRAGMA {name}').fetchone()
            return r[0] if r else None
        except Exception:
            return None

    def st(p):
        try:
            return os.stat(p).st_size
        except Exception:
            return None

    sync_modes = ['OFF', 'NORMAL', 'FULL', 'EXTRA']
    av_modes = ['NONE', 'FULL', 'INCREMENTAL']
    s_raw = pv('synchronous')
    a_raw = pv('auto_vacuum')
    jm = pv('journal_mode')
    enc = pv('encoding')
    return {
        'driver': 'sqlite',
        'version': str(ver),
        'runtime': 'python3',
        'fileSizeBytes': st(resolved),
        'walSizeBytes': st(resolved + '-wal'),
        'shmSizeBytes': st(resolved + '-shm'),
        'journalMode': str(jm).upper() if jm else None,
        'synchronous': sync_modes[int(s_raw)] if isinstance(s_raw, int) and 0 <= s_raw < len(sync_modes) else (str(s_raw) if s_raw is not None else None),
        'foreignKeys': bool(pv('foreign_keys')),
        'userVersion': int(pv('user_version') or 0),
        'pageSize': int(pv('page_size') or 0),
        'pageCount': int(pv('page_count') or 0),
        'freelistCount': int(pv('freelist_count') or 0),
        'encoding': str(enc) if enc else None,
        'autoVacuum': av_modes[int(a_raw)] if isinstance(a_raw, int) and 0 <= a_raw < len(av_modes) else (str(a_raw) if a_raw is not None else None),
        'durationMs': round((time.perf_counter() - t0) * 1000, 2),
    }


def run_maintenance(conn, action):
    t0 = time.perf_counter()
    if action == 'wal_checkpoint':
        r = conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
        msg = f'WAL checkpoint complete (checkpointed {r[2]}/{r[1]} frames, busy={r[0]})' if r else 'WAL checkpoint complete'
        return {'ok': True, 'message': msg, 'durationMs': round((time.perf_counter() - t0) * 1000, 2)}
    conn.execute('VACUUM')
    return {'ok': True, 'message': 'VACUUM complete', 'durationMs': round((time.perf_counter() - t0) * 1000, 2)}


SKIP_DIRS = {'node_modules', '.git', '.cache', '.config', '.local', '.npm', '.bun', '.Trash', 'attic', 'Library', 'dist', 'build', '.venv', 'venv', '__pycache__'}


def is_sqlite_file(path):
    try:
        with open(path, 'rb') as f:
            return f.read(16) == b'SQLite format 3\x00'
    except Exception:
        return False


def discover_dbs(roots, max_depth):
    found = []
    seen_files = set()
    seen_dirs = set()
    depth_limit = max(1, min(6, int(max_depth or 4)))
    start_roots = [expand_path(r) for r in (roots if roots else [os.path.expanduser('~'), '/var/lib'])]

    def walk(d, depth):
        if depth > depth_limit or len(found) >= 100:
            return
        try:
            real_dir = os.path.realpath(d)
        except Exception:
            return
        if real_dir in seen_dirs:
            return
        seen_dirs.add(real_dir)
        try:
            entries = list(os.scandir(d))
        except Exception:
            return
        for ent in entries:
            if len(found) >= 100:
                return
            full = ent.path
            try:
                is_dir = ent.is_dir(follow_symlinks=True)
                is_file = ent.is_file(follow_symlinks=True)
            except Exception:
                continue
            if is_dir:
                if ent.name in SKIP_DIRS:
                    continue
                if ent.name.startswith('.') and ent.name != '.data' and not ent.name.startswith('.hal'):
                    continue
                walk(full, depth + 1)
            elif is_file:
                if re.search(r'\.(sqlite|sqlite3|db)$', ent.name, re.IGNORECASE) and not ent.name.endswith(('-wal', '-shm')):
                    real_file = os.path.realpath(full)
                    if real_file in seen_files:
                        continue
                    if not is_sqlite_file(full):
                        continue
                    seen_files.add(real_file)
                    try:
                        st = os.stat(full)
                        mtime = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(st.st_mtime))
                        found.append({'path': real_file, 'sizeBytes': st.st_size, 'modifiedAt': mtime})
                    except Exception:
                        pass

    for r in start_roots:
        if os.path.exists(r):
            walk(r, 0)
    found.sort(key=lambda x: x['modifiedAt'], reverse=True)
    return found


def handle_request(req):
    req_id = req.get('id')
    op = req.get('op')
    db_path = req.get('path')
    rw = bool(req.get('rw'))
    params = req.get('params') or {}
    try:
        if op == 'discover':
            res = discover_dbs(params.get('roots'), params.get('maxDepth'))
        elif op == 'hostPing':
            res = {'ok': True, 'runtime': 'python3', 'sqliteVersion': sqlite3.sqlite_version}
        elif op == 'query':
            res = execute_statements(db_path, rw, params.get('statements'), params.get('maxRows'), req_id)
        else:
            conn = open_conn(db_path, rw)
            try:
                if op == 'ping':
                    t0 = time.perf_counter()
                    v = (conn.execute('SELECT sqlite_version()').fetchone() or [''])[0]
                    res = {'ok': True, 'latencyMs': round((time.perf_counter() - t0) * 1000, 2), 'version': str(v), 'runtime': 'python3'}
                elif op == 'schema':
                    res = get_schema(conn)
                elif op == 'browse':
                    res = browse_table(conn, params)
                elif op == 'mutate':
                    res = mutate_table(conn, params)
                elif op == 'peek':
                    res = peek_row(conn, params.get('table'), params.get('column'), params.get('value'))
                elif op == 'reverseFks':
                    res = count_reverse_fks(conn, params.get('table'), params.get('row') or {}, params.get('extraReverseFks'))
                elif op in ('checkKeys', 'checkKeysExist'):
                    res = check_keys_exist(conn, params.get('probes') or [])
                elif op == 'searchId':
                    res = search_id(conn, params.get('value'))
                elif op == 'profileColumn':
                    res = profile_column(conn, params.get('table'), params.get('column'))
                elif op == 'info':
                    res = get_db_info(conn, db_path)
                elif op == 'maintenance':
                    res = run_maintenance(conn, params.get('action'))
                else:
                    raise ValueError('Unknown op: ' + str(op))
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        send({'id': req_id, 'ok': True, 'result': res})
    except Exception as err:
        send({'id': req_id, 'ok': False, 'error': str(err)})


send({'ready': True, 'runtime': 'python3'})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get('op') == 'cancel':
        target_id = (req.get('params') or {}).get('targetId')
        cancelled = False
        with active_lock:
            target_conn = active_queries.get(target_id)
        if target_conn is not None:
            try:
                target_conn.interrupt()
                cancelled = True
            except Exception:
                pass
        send({'id': req.get('id'), 'ok': True, 'result': {'cancelled': cancelled}})
        continue
    executor.submit(handle_request, req)
`

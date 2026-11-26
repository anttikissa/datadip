// Dedicated Bun Worker thread for running local SQLite queries in parallel without blocking the HTTP server.
import { Database } from 'bun:sqlite'
import { executeSqliteStatements } from './sqlite-ops.ts'

declare const self: Worker

self.onmessage = (ev: MessageEvent<{ path: string; writable: boolean; statements: string[]; maxRows?: number }>) => {
	const { path, writable, statements, maxRows } = ev.data
	let db: Database | null = null
	try {
		db = writable ? new Database(path, { readwrite: true }) : new Database(path, { readonly: true })
		db.exec(writable ? 'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;' : 'PRAGMA busy_timeout = 5000;')
		const results = executeSqliteStatements(db, statements, { maxRows })
		self.postMessage({ ok: true, results })
	} catch (err) {
		self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
	} finally {
		try {
			db?.close()
		} catch {}
	}
}

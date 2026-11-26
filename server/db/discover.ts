// Local SQLite database auto-discovery scanner matching the remote SSH worker's heuristics and header check.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expandTilde } from './sqlite-local.ts'

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.cache',
	'.config',
	'.local',
	'.npm',
	'.bun',
	'.Trash',
	'attic',
	'Library',
	'Applications',
	'Pictures',
	'Music',
	'Movies',
	'dist',
	'build',
	'.venv',
	'venv',
	'__pycache__',
])

const SQLITE_MAGIC = 'SQLite format 3\0'

function isSqliteFile(filePath: string): boolean {
	let fd: number | undefined
	try {
		fd = openSync(filePath, 'r')
		const buf = Buffer.alloc(16)
		const n = readSync(fd, buf, 0, 16, 0)
		return n === 16 && buf.toString('utf8') === SQLITE_MAGIC
	} catch {
		return false
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {}
		}
	}
}

export function suggestDbName(filePath: string, host?: string): string {
	const file = basename(filePath).replace(/\.(sqlite3?|db)$/i, '')
	const parent = basename(dirname(filePath))
	const grandparent = basename(dirname(dirname(filePath)))
	const project = parent === 'data' || parent === '.data' || parent === 'db' ? grandparent : parent
	const label = project && project !== '/' && project !== 'root' ? `${project}/${file}` : file
	return host ? `${host}: ${label}` : label
}

export function discoverLocalSqliteDbs(
	roots?: string[],
	maxDepth = 4,
): { path: string; sizeBytes: number; modifiedAt: string }[] {
	const found: { path: string; sizeBytes: number; modifiedAt: string }[] = []
	const seen = new Set<string>()
	const depthLimit = Math.max(1, Math.min(6, maxDepth))
	const startRoots = (roots && roots.length > 0 ? roots : [homedir()]).map(expandTilde)

	function walk(dir: string, depth: number) {
		if (depth > depthLimit || found.length >= 100) return
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const ent of entries) {
			if (found.length >= 100) return
			const full = join(dir, ent.name)
			if (ent.isDirectory()) {
				if (SKIP_DIRS.has(ent.name)) continue
				if (ent.name.startsWith('.') && ent.name !== '.data' && !ent.name.startsWith('.hal')) continue
				walk(full, depth + 1)
			} else if (ent.isFile()) {
				if (/\.(sqlite|sqlite3|db)$/i.test(ent.name) && !ent.name.endsWith('-wal') && !ent.name.endsWith('-shm')) {
					if (seen.has(full)) continue
					if (!isSqliteFile(full)) continue
					seen.add(full)
					try {
						const st = statSync(full)
						found.push({ path: full, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() })
					} catch {}
				}
			}
		}
	}

	for (const r of startRoots) {
		if (existsSync(r)) walk(r, 0)
	}

	return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

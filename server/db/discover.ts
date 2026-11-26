// Local SQLite database auto-discovery scanner (including macOS iOS Simulator & App Container presets).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DiscoverPreset } from '../../src/shared/types.ts'
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

const APPLE_SKIP_DIRS = new Set([
	'Caches',
	'Logs',
	'Saved Application State',
	'WebKit',
	'SplashBoard',
	'tmp',
	'Cookies',
	'HTTPStorages',
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

function readPlistString(plistPath: string, key: string): string | null {
	try {
		const txt = readFileSync(plistPath, 'utf8')
		const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`)
		return re.exec(txt)?.[1]?.trim() ?? null
	} catch {
		return null
	}
}

export function suggestDbName(filePath: string, host?: string): string {
	const file = basename(filePath).replace(/\.(sqlite3?|db)$/i, '')

	// Friendly naming for macOS iOS Simulator DBs
	const simMatch = /\/CoreSimulator\/Devices\/([0-9A-F-]+)\//i.exec(filePath)
	if (simMatch) {
		const devDir = filePath.slice(0, simMatch.index + `/CoreSimulator/Devices/${simMatch[1]}`.length)
		const devName = readPlistString(join(devDir, 'device.plist'), 'name') || simMatch[1]!.slice(0, 8)
		const appDirMatch = /\/Application\/([^/]+)\//.exec(filePath)
		const appLabel = appDirMatch ? appDirMatch[1]!.slice(0, 8) : basename(dirname(filePath))
		return `Sim (${devName}) · ${appLabel}/${file}`
	}

	// Friendly naming for macOS App Container DBs
	const contMatch = /\/Library\/Containers\/([^/]+)\//.exec(filePath)
	if (contMatch) {
		return `Container · ${contMatch[1]}/${file}`
	}

	const parent = basename(dirname(filePath))
	const grandparent = basename(dirname(dirname(filePath)))
	const project = parent === 'data' || parent === '.data' || parent === 'db' ? grandparent : parent
	const label = project && project !== '/' && project !== 'root' ? `${project}/${file}` : file
	return host ? `${host}: ${label}` : label
}

export function discoverLocalSqliteDbs(
	roots?: string[],
	maxDepth = 4,
	preset: DiscoverPreset = 'default',
): { path: string; sizeBytes: number; modifiedAt: string }[] {
	const found: { path: string; sizeBytes: number; modifiedAt: string }[] = []
	const seenFiles = new Set<string>()
	const seenDirs = new Set<string>()

	let effectiveRoots = roots && roots.length > 0 ? roots : [homedir()]
	let effectiveMaxDepth = maxDepth
	const isApplePreset = preset === 'ios-simulators' || preset === 'mac-containers'

	if (preset === 'ios-simulators') {
		effectiveRoots = [join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices')]
		effectiveMaxDepth = Math.max(maxDepth, 7)
	} else if (preset === 'mac-containers') {
		effectiveRoots = [join(homedir(), 'Library', 'Containers')]
		effectiveMaxDepth = Math.max(maxDepth, 6)
	}

	const depthLimit = Math.max(1, Math.min(isApplePreset ? 8 : 6, effectiveMaxDepth))
	const startRoots = effectiveRoots.map(expandTilde)

	function walk(dir: string, depth: number) {
		if (depth > depthLimit || found.length >= 100) return
		let realDir: string
		try {
			realDir = realpathSync(dir)
		} catch {
			return
		}
		if (seenDirs.has(realDir)) return
		seenDirs.add(realDir)

		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const ent of entries) {
			if (found.length >= 100) return
			const full = join(dir, ent.name)
			let isDir = ent.isDirectory()
			let isFile = ent.isFile()
			if (ent.isSymbolicLink()) {
				try {
					const st = statSync(full)
					isDir = st.isDirectory()
					isFile = st.isFile()
				} catch {
					continue
				}
			}
			if (isDir) {
				if (isApplePreset) {
					if (APPLE_SKIP_DIRS.has(ent.name)) continue
					if (ent.name.startsWith('.')) continue
				} else {
					if (SKIP_DIRS.has(ent.name)) continue
					if (ent.name.startsWith('.') && ent.name !== '.data' && !ent.name.startsWith('.hal')) continue
				}
				walk(full, depth + 1)
			} else if (isFile) {
				if (/\.(sqlite|sqlite3|db|db3)$/i.test(ent.name) && !ent.name.endsWith('-wal') && !ent.name.endsWith('-shm')) {
					let realFile = full
					try {
						realFile = realpathSync(full)
					} catch {}
					if (seenFiles.has(realFile)) continue
					if (!isSqliteFile(full)) continue
					seenFiles.add(realFile)
					try {
						const st = statSync(full)
						found.push({ path: realFile, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() })
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

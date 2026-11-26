// Lightweight parser for ~/.ssh/config returning concrete Host aliases for connection pickers.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SshHostOption } from '../../src/shared/types.ts'

function expandPath(p: string, baseDir: string): string {
	if (p === '~') return homedir()
	if (p.startsWith('~/')) return join(homedir(), p.slice(2))
	if (isAbsolute(p)) return p
	return resolve(baseDir, p)
}

function expandIncludePattern(pattern: string, baseDir: string): string[] {
	const full = expandPath(pattern, baseDir)
	if (!full.includes('*') && !full.includes('?')) {
		return existsSync(full) ? [full] : []
	}
	const dir = dirname(full)
	const filePat = full.slice(dir.length + 1)
	if (!existsSync(dir)) return []
	const re = new RegExp(
		'^' +
			filePat
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replaceAll('*', '.*')
				.replaceAll('?', '.') +
			'$',
	)
	try {
		return readdirSync(dir)
			.filter((name) => re.test(name))
			.map((name) => join(dir, name))
	} catch {
		return []
	}
}

export function parseSshConfigText(
	text: string,
	resolveInclude?: (pattern: string) => string[],
	visited = new Set<string>(),
): SshHostOption[] {
	const entries = new Map<string, SshHostOption>()
	let currentAliases: string[] = []

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, '').trim()
		if (!line) continue
		const match = /^(\S+)(?:\s*=\s*|\s+)(.+)$/.exec(line)
		if (!match) continue
		const key = match[1]!.toLowerCase()
		const val = match[2]!.trim().replace(/^"(.*)"$/, '$1')

		if (key === 'include' && resolveInclude) {
			for (const pat of val.split(/\s+/)) {
				for (const incPath of resolveInclude(pat)) {
					if (visited.has(incPath)) continue
					visited.add(incPath)
					try {
						const incText = readFileSync(incPath, 'utf8')
						for (const item of parseSshConfigText(incText, resolveInclude, visited)) {
							if (!entries.has(item.alias)) entries.set(item.alias, item)
						}
					} catch {}
				}
			}
			continue
		}

		if (key === 'host') {
			currentAliases = val.split(/\s+/).filter((a) => a && !a.startsWith('!') && !a.includes('*') && !a.includes('?'))
			for (const alias of currentAliases) {
				if (!entries.has(alias)) entries.set(alias, { alias })
			}
			continue
		}

		if (key === 'match') {
			currentAliases = []
			continue
		}

		for (const alias of currentAliases) {
			const entry = entries.get(alias)
			if (!entry) continue
			if (key === 'hostname' && !entry.hostName) entry.hostName = val
			else if (key === 'user' && !entry.user) entry.user = val
			else if (key === 'port' && !entry.port) {
				const n = Number(val)
				if (Number.isFinite(n) && n > 0 && n <= 65535) entry.port = n
			}
		}
	}

	return Array.from(entries.values()).sort((a, b) => a.alias.localeCompare(b.alias))
}

export function listSshConfigHosts(configPath = join(homedir(), '.ssh', 'config')): SshHostOption[] {
	if (!existsSync(configPath)) return []
	try {
		const text = readFileSync(configPath, 'utf8')
		const baseDir = dirname(configPath)
		const visited = new Set<string>([configPath])
		return parseSshConfigText(text, (pat) => expandIncludePattern(pat, baseDir), visited)
	} catch {
		return []
	}
}

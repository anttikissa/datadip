// Formatting, timestamp helpers, JSON/ASON inspection, and row export utilities.
import { stringify as stringifyAson } from '../shared/ason.ts'

export function formatIsoShort(iso: string | undefined | null): string {
	if (!iso) return '—'
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

export function formatRelative(iso: string | undefined | null): string {
	if (!iso) return ''
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return ''
	const diff = Date.now() - d.getTime()
	const sec = Math.floor(Math.abs(diff) / 1000)
	const suffix = diff >= 0 ? 'ago' : 'from now'
	if (sec < 60) return `${sec}s ${suffix}`
	const min = Math.floor(sec / 60)
	if (min < 60) return `${min}m ${suffix}`
	const hr = Math.floor(min / 60)
	if (hr < 48) return `${hr}h ${suffix}`
	const days = Math.floor(hr / 24)
	return `${days}d ${suffix}`
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatCellText(val: unknown): string {
	if (val === null || val === undefined) return 'NULL'
	if (typeof val === 'string') return val
	if (typeof val === 'number' || typeof val === 'boolean') return String(val)
	return JSON.stringify(val)
}

export function tryFormatTimestampHint(val: unknown): string | null {
	if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(val)) {
		const d = new Date(val)
		if (!Number.isNaN(d.getTime())) {
			return `${d.toISOString()} (${formatRelative(d.toISOString())})`
		}
	}
	if (typeof val === 'number' && Number.isInteger(val)) {
		// Epoch seconds (2000..2100) or epoch ms (2000..2100)
		if (val >= 946_684_800 && val <= 4_102_444_800) {
			const iso = new Date(val * 1000).toISOString()
			return `${iso} (${formatRelative(iso)})`
		}
		if (val >= 946_684_800_000 && val <= 4_102_444_800_000) {
			const iso = new Date(val).toISOString()
			return `${iso} (${formatRelative(iso)})`
		}
	}
	return null
}

export function tryPrettyJson(val: unknown): string | null {
	if (typeof val !== 'string') return null
	const t = val.trim()
	if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) {
		return null
	}
	try {
		return JSON.stringify(JSON.parse(t), null, 2)
	} catch {
		return null
	}
}

export function formatCountdown(untilMs: number | null, nowMs: number): string {
	if (!untilMs) return ''
	const rem = Math.max(0, Math.floor((untilMs - nowMs) / 1000))
	const m = Math.floor(rem / 60)
	const s = rem % 60
	return `${m}:${String(s).padStart(2, '0')}`
}

export function exportRowsCsv(columns: string[], rows: Record<string, unknown>[]): string {
	const esc = (v: unknown) => {
		if (v === null || v === undefined) return ''
		const s = String(v)
		return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
	}
	const lines = [columns.map(esc).join(',')]
	for (const r of rows) {
		lines.push(columns.map((c) => esc(r[c])).join(','))
	}
	return lines.join('\n')
}

export function exportRowsJson(rows: Record<string, unknown>[]): string {
	return JSON.stringify(rows, null, 2)
}

export function exportRowsAson(rows: Record<string, unknown>[]): string {
	return stringifyAson(rows, 'long')
}

export function exportRowsSqlInsert(table: string, columns: string[], rows: Record<string, unknown>[]): string {
	const q = (s: string) => `"${s.replaceAll('"', '""')}"`
	const lit = (v: unknown) => {
		if (v === null || v === undefined) return 'NULL'
		if (typeof v === 'number') return String(v)
		return `'${String(v).replaceAll("'", "''")}'`
	}
	const colList = columns.map(q).join(', ')
	return rows
		.map((r) => `INSERT INTO ${q(table)} (${colList}) VALUES (${columns.map((c) => lit(r[c])).join(', ')});`)
		.join('\n')
}

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}

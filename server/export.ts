// Full-result file export formatters (CSV, TSV, JSON, Markdown, SQL INSERT) for downloadable table and query exports.

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'sql'

export const EXPORT_MIME: Record<ExportFormat, { contentType: string; ext: string }> = {
	csv: { contentType: 'text/csv; charset=utf-8', ext: 'csv' },
	tsv: { contentType: 'text/tab-separated-values; charset=utf-8', ext: 'tsv' },
	json: { contentType: 'application/json; charset=utf-8', ext: 'json' },
	markdown: { contentType: 'text/markdown; charset=utf-8', ext: 'md' },
	sql: { contentType: 'application/sql; charset=utf-8', ext: 'sql' },
}

function csvCell(val: unknown): string {
	if (val === null || val === undefined) return ''
	const s = typeof val === 'object' ? JSON.stringify(val) : String(val)
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

function tsvCell(val: unknown): string {
	if (val === null || val === undefined) return ''
	const s = typeof val === 'object' ? JSON.stringify(val) : String(val)
	return s.replaceAll('\t', ' ').replaceAll('\r', '').replaceAll('\n', ' ')
}

function mdCell(val: unknown): string {
	if (val === null || val === undefined) return '*NULL*'
	const s = typeof val === 'object' ? JSON.stringify(val) : String(val)
	return s.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ')
}

function sqlLiteral(val: unknown): string {
	if (val === null || val === undefined) return 'NULL'
	if (typeof val === 'number' || typeof val === 'boolean') return String(val)
	const s = typeof val === 'object' ? JSON.stringify(val) : String(val)
	return `'${s.replaceAll("'", "''")}'`
}

function quoteIdent(name: string): string {
	return '"' + name.replaceAll('"', '""') + '"'
}

export function formatExportRows(
	format: ExportFormat,
	columns: string[],
	rows: Record<string, unknown>[],
	tableName = 'exported_rows',
): string {
	if (format === 'json') {
		return JSON.stringify(rows, null, 2) + '\n'
	}

	if (format === 'csv') {
		const lines = [columns.map(csvCell).join(',')]
		for (const row of rows) {
			lines.push(columns.map((c) => csvCell(row[c])).join(','))
		}
		return lines.join('\n') + '\n'
	}

	if (format === 'tsv') {
		const lines = [columns.map(tsvCell).join('\t')]
		for (const row of rows) {
			lines.push(columns.map((c) => tsvCell(row[c])).join('\t'))
		}
		return lines.join('\n') + '\n'
	}

	if (format === 'markdown') {
		const header = `| ${columns.map(mdCell).join(' | ')} |`
		const sep = `| ${columns.map(() => '---').join(' | ')} |`
		const body = rows.map((row) => `| ${columns.map((c) => mdCell(row[c])).join(' | ')} |`)
		return [header, sep, ...body].join('\n') + '\n'
	}

	// sql INSERT statements
	const qTable = tableName.split('.').map(quoteIdent).join('.')
	const qCols = columns.map(quoteIdent).join(', ')
	const lines = rows.map((row) => {
		const vals = columns.map((c) => sqlLiteral(row[c])).join(', ')
		return `INSERT INTO ${qTable} (${qCols}) VALUES (${vals});`
	})
	return lines.join('\n') + '\n'
}

export function sanitizeExportFilename(name: string, ext: string): string {
	const safe = name
		.replace(/[^a-zA-Z0-9._-]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80)
	return `${safe || 'export'}.${ext}`
}

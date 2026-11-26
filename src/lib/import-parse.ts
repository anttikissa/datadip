// Zero-dependency RFC 4180 CSV and JSON row parser for importing data into tables.

export interface ParsedImport {
	format: 'csv' | 'json'
	columns: string[]
	rows: Record<string, unknown>[]
}

export function parseCsvText(text: string): { columns: string[]; rows: Record<string, unknown>[] } {
	const clean = text.replace(/^\uFEFF/, '')
	const records: string[][] = []
	let row: string[] = []
	let field = ''
	let inQuotes = false

	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i]!
		if (inQuotes) {
			if (ch === '"') {
				if (clean[i + 1] === '"') {
					field += '"'
					i++
				} else {
					inQuotes = false
				}
			} else {
				field += ch
			}
		} else if (ch === '"') {
			inQuotes = true
		} else if (ch === ',') {
			row.push(field)
			field = ''
		} else if (ch === '\r') {
			if (clean[i + 1] === '\n') i++
			row.push(field)
			if (row.some((cell) => cell !== '')) records.push(row)
			row = []
			field = ''
		} else if (ch === '\n') {
			row.push(field)
			if (row.some((cell) => cell !== '')) records.push(row)
			row = []
			field = ''
		} else {
			field += ch
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field)
		if (row.some((cell) => cell !== '')) records.push(row)
	}

	if (records.length === 0) return { columns: [], rows: [] }
	const columns = records[0]!.map((h, idx) => h.trim() || `col_${idx + 1}`)
	const rows: Record<string, unknown>[] = []
	for (let r = 1; r < records.length; r++) {
		const rec = records[r]!
		const obj: Record<string, unknown> = {}
		for (let c = 0; c < columns.length; c++) {
			const val = rec[c] ?? ''
			obj[columns[c]!] = val === '' ? null : val
		}
		rows.push(obj)
	}
	return { columns, rows }
}

export function parseImportText(text: string, filename?: string): ParsedImport {
	const trimmed = text.replace(/^\uFEFF/, '').trim()
	if (!trimmed) throw new Error('Input is empty')

	const looksJson = filename?.toLowerCase().endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')
	if (looksJson) {
		let parsed: unknown
		try {
			parsed = JSON.parse(trimmed)
		} catch (err) {
			throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
		}
		const arr = Array.isArray(parsed) ? parsed : [parsed]
		const objs = arr.filter(
			(v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
		)
		if (objs.length === 0) throw new Error('JSON must be an object or array of objects')
		const colSet = new Set<string>()
		for (const obj of objs) {
			for (const k of Object.keys(obj)) colSet.add(k)
		}
		const columns = Array.from(colSet)
		const rows = objs.map((obj) => {
			const out: Record<string, unknown> = {}
			for (const c of columns) {
				const v = obj[c]
				if (v === undefined || v === null) out[c] = null
				else if (typeof v === 'object') out[c] = JSON.stringify(v)
				else out[c] = v
			}
			return out
		})
		return { format: 'json', columns, rows }
	}

	const csv = parseCsvText(trimmed)
	if (csv.columns.length === 0) throw new Error('No columns found in CSV')
	return { format: 'csv', ...csv }
}

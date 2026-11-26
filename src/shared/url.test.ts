// Unit tests for URL route parsing and formatting (fields, filters, multi-sort, keyset cursor, schema, console).
import { describe, expect, test } from 'bun:test'
import { formatRoute, parseRoute } from './url.ts'

describe('URL state codec', () => {
	test('round-trips table browse route with fields, filters, sort, limit, and keyset start cursor', () => {
		const route = parseRoute(
			'/c/c123abc/t/users',
			'?fields=id,name,address&where=status:eq:active&where=deleted_at:isnull&order=id.desc;name.asc&limit=50&start=u98123xyz',
		)
		expect(route).toEqual({
			kind: 'table',
			connId: 'c123abc',
			table: 'users',
			tab: 'data',
			fields: ['id', 'name', 'address'],
			filters: [
				{ column: 'status', op: 'eq', value: 'active' },
				{ column: 'deleted_at', op: 'isnull', value: '' },
			],
			order: [
				{ column: 'id', dir: 'desc' },
				{ column: 'name', dir: 'asc' },
			],
			limit: 50,
			start: 'u98123xyz',
			direction: 'next',
			offset: null,
			search: '',
			selectedRow: null,
		})

		const formatted = formatRoute(route)
		const reparsed = parseRoute(formatted.split('?')[0]!, '?' + formatted.split('?')[1]!)
		expect(reparsed).toEqual(route)
	})

	test('accepts comma-separated order syntax (order=id,desc)', () => {
		const route = parseRoute('/c/c1/t/orders', '?order=id,desc')
		expect(route.kind).toBe('table')
		if (route.kind === 'table') {
			expect(route.order).toEqual([{ column: 'id', dir: 'desc' }])
		}
	})

	test('parses schema and console routes', () => {
		expect(parseRoute('/c/c1/t/users/schema', '')).toMatchObject({
			kind: 'table',
			connId: 'c1',
			table: 'users',
			tab: 'schema',
		})
		expect(parseRoute('/c/c1/sql/s999', '')).toEqual({
			kind: 'sql',
			connId: 'c1',
			consoleId: 's999',
		})
	})
})

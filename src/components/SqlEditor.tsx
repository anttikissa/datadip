// CodeMirror 6 SQL editor with SQLite dialect, live schema autocomplete, SQL linter, active-statement highlight, and shortcuts.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql as sqlLang, SQLite } from '@codemirror/lang-sql'
import {
	bracketMatching,
	defaultHighlightStyle,
	HighlightStyle,
	indentOnInput,
	syntaxHighlighting,
} from '@codemirror/language'
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state'
import {
	Decoration,
	type DecorationSet,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { createEffect, onSettled } from 'solid-js'
import { lintSql, statementAtCursor } from '../shared/sql.ts'
import type { DatabaseSchema } from '../shared/types.ts'

const activeStmtLineDeco = Decoration.line({ class: 'cm-active-stmt' })

function activeStatementHighlighter() {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet
			constructor(view: EditorView) {
				this.decorations = this.build(view)
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.selectionSet) {
					this.decorations = this.build(update.view)
				}
			}
			build(view: EditorView): DecorationSet {
				const text = view.state.doc.toString()
				const pos = view.state.selection.main.head
				const stmt = statementAtCursor(text, pos)
				if (!stmt) return Decoration.none
				const startLine = view.state.doc.lineAt(Math.max(0, Math.min(stmt.from, text.length)))
				const endLine = view.state.doc.lineAt(Math.max(0, Math.min(stmt.to, text.length)))
				const builder = new RangeSetBuilder<Decoration>()
				for (let n = startLine.number; n <= endLine.number; n++) {
					const line = view.state.doc.line(n)
					builder.add(line.from, line.from, activeStmtLineDeco)
				}
				return builder.finish()
			}
		},
		{ decorations: (v) => v.decorations },
	)
}

const lightTheme = EditorView.theme(
	{
		'&': { backgroundColor: '#ffffff', color: '#161616' },
		'.cm-gutters': {
			backgroundColor: '#f4f5f7',
			color: '#767e8f',
			borderRight: '1px solid #e0e4ec',
		},
		'.cm-activeLine': { backgroundColor: 'rgba(15, 98, 254, 0.04)' },
		'.cm-activeLineGutter': { backgroundColor: '#e8edf5', color: '#161616' },
		'.cm-cursor': { borderLeftColor: '#0f62fe' },
		'&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#cfe0ff' },
	},
	{ dark: false },
)

const darkTheme = EditorView.theme(
	{
		'&': { backgroundColor: '#181b22', color: '#eef1f6' },
		'.cm-gutters': {
			backgroundColor: '#14171d',
			color: '#727b8f',
			borderRight: '1px solid #262b37',
		},
		'.cm-activeLine': { backgroundColor: 'rgba(69, 137, 255, 0.08)' },
		'.cm-activeLineGutter': { backgroundColor: '#222836', color: '#eef1f6' },
		'.cm-cursor': { borderLeftColor: '#4589ff' },
		'&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#213a66' },
	},
	{ dark: true },
)

const darkHighlight = HighlightStyle.define([
	{ tag: tags.keyword, color: '#78a9ff', fontWeight: '500' },
	{ tag: [tags.string, tags.special(tags.string)], color: '#42be65' },
	{ tag: [tags.number, tags.bool], color: '#ff944d' },
	{ tag: [tags.comment], color: '#727b8f', fontStyle: 'italic' },
	{ tag: [tags.operator, tags.punctuation], color: '#a2abc0' },
	{ tag: [tags.variableName, tags.propertyName], color: '#eef1f6' },
])

function buildSqlSchemaMap(schema: DatabaseSchema | null): Record<string, string[]> {
	const map: Record<string, string[]> = {}
	if (!schema) return map
	for (const ts of Object.values(schema.schemas)) {
		map[ts.name] = ts.columns.map((c) => c.name)
	}
	return map
}

export interface SqlEditorHandle {
	getCursor: () => number
	getSelection: () => string
	replaceAll: (text: string) => void
	insertText: (text: string) => void
	focus: () => void
}

export function SqlEditor(props: {
	value: string
	dark: boolean
	schema: DatabaseSchema | null
	onChange: (value: string) => void
	onRunCurrent: (cursorOffset: number, selectionText: string) => void
	onRunAll: () => void
	onExplain: (cursorOffset: number, selectionText: string) => void
	onFormat: () => void
	onReady?: (handle: SqlEditorHandle) => void
}) {
	let hostEl: HTMLDivElement | undefined
	let view: EditorView | undefined
	const themeComp = new Compartment()
	const sqlComp = new Compartment()
	const lintComp = new Compartment()
	let suppressExternal = false

	function makeLinter(schema: DatabaseSchema | null) {
		const tableNames = schema ? schema.tables.map((t) => t.name) : undefined
		return linter(
			(v): Diagnostic[] => {
				const text = v.state.doc.toString()
				return lintSql(text, tableNames).map((d) => ({
					from: Math.max(0, Math.min(d.from, text.length)),
					to: Math.max(0, Math.min(Math.max(d.to, d.from + 1), text.length)),
					severity: d.severity,
					message: d.message,
				}))
			},
			{ delay: 300 },
		)
	}

	onSettled(() => {
		if (!hostEl) return

		const shortcuts = keymap.of([
			{
				key: 'Mod-Enter',
				run: (v) => {
					const sel = v.state.selection.main
					const selected = sel.empty ? '' : v.state.doc.sliceString(sel.from, sel.to)
					props.onRunCurrent(sel.head, selected)
					return true
				},
			},
			{
				key: 'Mod-Shift-Enter',
				run: () => {
					props.onRunAll()
					return true
				},
			},
			{
				key: 'Mod-e',
				run: (v) => {
					const sel = v.state.selection.main
					const selected = sel.empty ? '' : v.state.doc.sliceString(sel.from, sel.to)
					props.onExplain(sel.head, selected)
					return true
				},
			},
			{
				key: 'Mod-Shift-f',
				run: () => {
					props.onFormat()
					return true
				},
			},
		])

		const state = EditorState.create({
			doc: props.value,
			extensions: [
				shortcuts,
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightActiveLine(),
				history(),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				autocompletion({ activateOnTyping: true }),
				highlightSelectionMatches(),
				lintGutter(),
				activeStatementHighlighter(),
				keymap.of([
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...historyKeymap,
					...completionKeymap,
					indentWithTab,
				]),
				themeComp.of(
					props.dark
						? [darkTheme, syntaxHighlighting(darkHighlight)]
						: [lightTheme, syntaxHighlighting(defaultHighlightStyle)],
				),
				sqlComp.of(
					sqlLang({
						dialect: SQLite,
						upperCaseKeywords: true,
						schema: buildSqlSchemaMap(props.schema),
					}),
				),
				lintComp.of(makeLinter(props.schema)),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !suppressExternal) {
						props.onChange(update.state.doc.toString())
					}
				}),
			],
		})

		view = new EditorView({ state, parent: hostEl })

		props.onReady?.({
			getCursor: () => view?.state.selection.main.head ?? 0,
			getSelection: () => {
				if (!view) return ''
				const sel = view.state.selection.main
				return sel.empty ? '' : view.state.doc.sliceString(sel.from, sel.to)
			},
			replaceAll: (text: string) => {
				if (!view) return
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: text },
				})
			},
			insertText: (text: string) => {
				if (!view) return
				const pos = view.state.selection.main.head
				view.dispatch({
					changes: { from: pos, to: pos, insert: text },
					selection: { anchor: pos + text.length },
				})
				view.focus()
			},
			focus: () => view?.focus(),
		})

		return () => {
			view?.destroy()
			view = undefined
		}
	})

	createEffect(
		() => props.value,
		(nextVal) => {
			if (!view) return
			const cur = view.state.doc.toString()
			if (cur !== nextVal) {
				suppressExternal = true
				view.dispatch({
					changes: { from: 0, to: cur.length, insert: nextVal },
				})
				suppressExternal = false
			}
		},
	)

	createEffect(
		() => props.dark,
		(isDark) => {
			if (!view) return
			view.dispatch({
				effects: themeComp.reconfigure(
					isDark
						? [darkTheme, syntaxHighlighting(darkHighlight)]
						: [lightTheme, syntaxHighlighting(defaultHighlightStyle)],
				),
			})
		},
	)

	createEffect(
		() => props.schema,
		(schema) => {
			if (!view) return
			view.dispatch({
				effects: [
					sqlComp.reconfigure(
						sqlLang({
							dialect: SQLite,
							upperCaseKeywords: true,
							schema: buildSqlSchemaMap(schema),
						}),
					),
					lintComp.reconfigure(makeLinter(schema)),
				],
			})
		},
	)

	return <div ref={(el) => (hostEl = el)} class="cm-host" />
}

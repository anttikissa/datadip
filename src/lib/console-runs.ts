// Reactive per-console query execution store so multiple SQL consoles run concurrently and retain results across navigation.
import { createSignal } from 'solid-js'
import type { QueryStatementResult } from '../shared/types.ts'

export interface ConsoleRunState {
	running: boolean
	startedAt: number | null
	queryId: string | null
	results: QueryStatementResult[]
	activeTab: number
	totalMs: number | null
	runError: string | null
}

const EMPTY_RUN: ConsoleRunState = {
	running: false,
	startedAt: null,
	queryId: null,
	results: [],
	activeTab: 0,
	totalMs: null,
	runError: null,
}

const [runsMap, setRunsMap] = createSignal<Record<string, ConsoleRunState>>({})

export function getConsoleRun(padId: string | undefined): ConsoleRunState {
	if (!padId) return EMPTY_RUN
	return runsMap()[padId] ?? EMPTY_RUN
}

export function updateConsoleRun(padId: string, patch: Partial<ConsoleRunState>): void {
	setRunsMap((prev) => ({
		...prev,
		[padId]: { ...(prev[padId] ?? EMPTY_RUN), ...patch },
	}))
}

export function clearConsoleRun(padId: string): void {
	setRunsMap((prev) => {
		if (!(padId in prev)) return prev
		const next = { ...prev }
		delete next[padId]
		return next
	})
}

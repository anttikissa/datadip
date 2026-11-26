// Platform-aware keyboard shortcut helpers shared across DataDip views (macOS Emacs safety, native app detection, editable-target guards).

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

export function isPrimaryMod(e: KeyboardEvent): boolean {
	return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

export function isNativeApp(): boolean {
	if (typeof window === 'undefined') return false
	const w = window as unknown as { webkit?: { messageHandlers?: { datadip?: unknown } } }
	return Boolean(w.webkit?.messageHandlers?.datadip)
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return (
		target.tagName === 'INPUT' ||
		target.tagName === 'TEXTAREA' ||
		target.tagName === 'SELECT' ||
		target.isContentEditable ||
		Boolean(target.closest('.cm-editor'))
	)
}

export function hasTextSelection(target?: EventTarget | null): boolean {
	if (typeof window !== 'undefined' && window.getSelection()?.toString()) return true
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		return (
			target.selectionStart !== null && target.selectionEnd !== null && target.selectionStart !== target.selectionEnd
		)
	}
	return false
}

export function modKeyLabel(key: string, shift = false): string {
	if (isMac) return `${shift ? '⇧' : ''}⌘${key}`
	return `${shift ? 'Ctrl+Shift+' : 'Ctrl+'}${key}`
}

export function recentsKeyLabel(): string {
	return isMac ? '⌃R' : 'Alt+R'
}

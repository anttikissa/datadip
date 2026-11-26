// Native <dialog> confirmation modal for destructive SQL, row deletes, and SQL commit previews.
import { createEffect, For, Show } from 'solid-js'
import { IconAlert, IconClose } from '../lib/icons.tsx'

export interface ConfirmState {
	title: string
	message: string
	warnings?: string[]
	sqlPreview?: string[]
	confirmLabel: string
	danger?: boolean
	onConfirm: () => void | Promise<void>
}

export function ConfirmDialog(props: { state: ConfirmState | null; onClose: () => void }) {
	let dialogEl: HTMLDialogElement | undefined
	let cancelBtn: HTMLButtonElement | undefined

	createEffect(
		() => props.state,
		(st) => {
			if (!dialogEl) return
			if (st) {
				if (!dialogEl.open) dialogEl.showModal()
				// Focus the least destructive button per DECISIONS.md
				queueMicrotask(() => cancelBtn?.focus())
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="modal"
			onCancel={(e) => {
				e.preventDefault()
				props.onClose()
			}}
		>
			<Show when={props.state}>
				{(st) => (
					<>
						<div class="modal-head">
							<span style="display:inline-flex;align-items:center;gap:8px">
								<Show when={st().danger}>
									<span style="color:var(--prod);display:inline-flex">
										<IconAlert />
									</span>
								</Show>
								{st().title}
							</span>
							<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
								<IconClose />
							</button>
						</div>
						<div class="modal-body">
							<p style="margin:0">{st().message}</p>
							<Show when={(st().warnings?.length ?? 0) > 0}>
								<div class="error-box" style="margin:0">
									<For each={st().warnings ?? []}>{(w) => <div>• {w}</div>}</For>
								</div>
							</Show>
							<Show when={(st().sqlPreview?.length ?? 0) > 0}>
								<pre class="inspector-val" style="max-height:220px;overflow:auto">
									{(st().sqlPreview ?? []).join('\n')}
								</pre>
							</Show>
						</div>
						<div class="modal-foot">
							<button ref={(el) => (cancelBtn = el)} class="btn" type="button" onClick={() => props.onClose()}>
								Cancel
							</button>
							<button
								class={['btn', st().danger ? 'danger' : 'primary']}
								type="button"
								onClick={async () => {
									const fn = st().onConfirm
									props.onClose()
									await fn()
								}}
							>
								{st().confirmLabel}
							</button>
						</div>
					</>
				)}
			</Show>
		</dialog>
	)
}

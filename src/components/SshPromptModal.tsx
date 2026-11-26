// Native <dialog> modal answering OpenSSH SSH_ASKPASS prompts (key passphrases, passwords, 2FA, and host-key verification).
import { createEffect, createSignal, Show } from 'solid-js'
import { IconClose, IconLock, IconServer } from '../lib/icons.tsx'
import type { SshPromptRequest } from '../shared/types.ts'

export function SshPromptModal(props: {
	prompt: SshPromptRequest | null
	onSubmit: (id: string, answer: string) => void | Promise<void>
	onCancel: (id: string) => void | Promise<void>
}) {
	let dialogEl: HTMLDialogElement | undefined
	let inputEl: HTMLInputElement | undefined
	let confirmBtnEl: HTMLButtonElement | undefined

	const [answer, setAnswer] = createSignal('')
	const [showSecret, setShowSecret] = createSignal(false)
	const [submitting, setSubmitting] = createSignal(false)

	createEffect(
		() => props.prompt?.id,
		(id) => {
			if (!dialogEl) return
			setAnswer('')
			setShowSecret(false)
			setSubmitting(false)
			if (id) {
				if (!dialogEl.open) dialogEl.showModal()
				queueMicrotask(() => {
					if (props.prompt?.kind === 'confirm') confirmBtnEl?.focus()
					else inputEl?.focus()
				})
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	async function handleSubmit(e?: Event) {
		e?.preventDefault()
		const p = props.prompt
		if (!p || submitting()) return
		setSubmitting(true)
		const val = p.kind === 'confirm' ? 'yes' : answer()
		setAnswer('')
		try {
			await props.onSubmit(p.id, val)
		} finally {
			setSubmitting(false)
		}
	}

	async function handleCancel() {
		const p = props.prompt
		if (!p || submitting()) return
		setSubmitting(true)
		setAnswer('')
		try {
			await props.onCancel(p.id)
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="modal"
			onCancel={(e) => {
				e.preventDefault()
				void handleCancel()
			}}
		>
			<Show when={props.prompt}>
				{(p) => (
					<form onSubmit={(e) => void handleSubmit(e)}>
						<div class="modal-head">
							<span style="display:inline-flex;align-items:center;gap:8px">
								<IconLock />
								<span>{p().kind === 'confirm' ? 'Verify SSH Host Key' : 'SSH Authentication'}</span>
								<span class="tag ssh">
									<IconServer />
									{p().host}
								</span>
							</span>
							<button
								class="icon-btn ghost"
								type="button"
								onClick={() => void handleCancel()}
								aria-label="Cancel SSH prompt"
							>
								<IconClose />
							</button>
						</div>

						<div class="modal-body">
							<pre class="inspector-val" style="max-height:220px;overflow:auto;white-space:pre-wrap">
								{p().prompt}
							</pre>

							<Show
								when={p().kind === 'secret'}
								fallback={
									<p style="margin:0;font-size:12px;color:var(--ink-secondary)">
										Confirm only if you recognize and trust this host key fingerprint.
									</p>
								}
							>
								<div class="field-group">
									<label class="field-label" for="ssh-askpass-input">
										Passphrase / Password
									</label>
									<div style="display:flex;gap:6px">
										<input
											id="ssh-askpass-input"
											ref={(el) => (inputEl = el)}
											class="input mono"
											style="flex:1"
											type={showSecret() ? 'text' : 'password'}
											autocomplete="off"
											spellcheck={false}
											value={answer()}
											onInput={(e) => setAnswer(e.currentTarget.value)}
										/>
										<button type="button" class="btn" onClick={() => setShowSecret((v) => !v)}>
											{showSecret() ? 'Hide' : 'Show'}
										</button>
									</div>
								</div>
								<p style="margin:0;font-size:11.5px;color:var(--ink-muted)">
									Sent directly to <span class="mono">ssh</span> — never logged or saved by DataDip.
								</p>
							</Show>
						</div>

						<div class="modal-foot">
							<button class="btn" type="button" disabled={submitting()} onClick={() => void handleCancel()}>
								Cancel
							</button>
							<button ref={(el) => (confirmBtnEl = el)} class="btn primary" type="submit" disabled={submitting()}>
								{p().kind === 'confirm' ? 'Trust & Continue' : 'Authenticate'}
							</button>
						</div>
					</form>
				)}
			</Show>
		</dialog>
	)
}

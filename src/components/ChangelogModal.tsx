// Native <dialog> What's New & Changelog modal displaying DataDip release history inside the app.
import { createEffect, For, Show } from 'solid-js'
import { IconClose } from '../lib/icons.tsx'
import { APP_VERSION, CHANGELOG, type ChangelogTag } from '../shared/changelog.ts'

const TAG_LABELS: Record<ChangelogTag, string> = {
	new: 'NEW',
	fix: 'FIX',
	safety: 'SAFETY',
	sql: 'SQL',
	sqlite: 'SQLITE',
	macos: 'MACOS',
}

export function ChangelogModal(props: { open: boolean; onClose: () => void }) {
	let dialogEl: HTMLDialogElement | undefined
	let closeBtn: HTMLButtonElement | undefined

	createEffect(
		() => props.open,
		(open) => {
			if (!dialogEl) return
			if (open) {
				if (!dialogEl.open) dialogEl.showModal()
				queueMicrotask(() => closeBtn?.focus())
			} else if (dialogEl.open) {
				dialogEl.close()
			}
		},
	)

	return (
		<dialog
			ref={(el) => (dialogEl = el)}
			class="modal wide changelog-modal"
			aria-label="DataDip Changelog"
			onCancel={(e) => {
				e.preventDefault()
				props.onClose()
			}}
			onClick={(e) => {
				if (e.target === dialogEl) props.onClose()
			}}
		>
			<div class="modal-head">
				<span style="display:inline-flex;align-items:center;gap:8px">
					<span>What&apos;s New in DataDip</span>
					<span class="tag mono" style="color:var(--accent);border-color:var(--accent)">
						v{APP_VERSION}
					</span>
				</span>
				<button class="icon-btn ghost" type="button" onClick={() => props.onClose()} aria-label="Close">
					<IconClose />
				</button>
			</div>

			<div class="modal-body changelog-body">
				<For each={CHANGELOG}>
					{(rel, idx) => (
						<section class={['changelog-release', { latest: idx() === 0 }]}>
							<div class="changelog-release-head">
								<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
									<span class="changelog-ver mono">v{rel.version}</span>
									<Show when={idx() === 0}>
										<span class="tag" style="color:var(--ok);border-color:var(--ok)">
											LATEST
										</span>
									</Show>
									<span class="changelog-date mono">{rel.date}</span>
								</div>
								<a
									class="changelog-gh-link"
									href={`https://github.com/anttikissa/datadip/releases/tag/v${rel.version}`}
									target="_blank"
									rel="noreferrer"
								>
									GitHub Release ↗
								</a>
							</div>

							<h3 class="changelog-headline">{rel.headline}</h3>
							<p class="changelog-summary">{rel.summary}</p>

							<ul class="changelog-list">
								<For each={rel.items}>
									{(item) => (
										<li class="changelog-item">
											<span class={['changelog-tag mono', `tag-${item.tag}`]}>{TAG_LABELS[item.tag]}</span>
											<div class="changelog-item-copy">
												<div class="changelog-item-title">
													<strong>{item.title}</strong>
													<Show when={item.shortcut}>
														{(k) => (
															<span class="kbd" style="margin-left:6px">
																{k()}
															</span>
														)}
													</Show>
												</div>
												<div class="changelog-item-detail">{item.detail}</div>
											</div>
										</li>
									)}
								</For>
							</ul>
						</section>
					)}
				</For>
			</div>

			<div class="modal-foot" style="justify-content:space-between">
				<a
					class="btn sm"
					href="https://github.com/anttikissa/datadip/releases"
					target="_blank"
					rel="noreferrer"
					style="text-decoration:none"
				>
					All Releases on GitHub ↗
				</a>
				<button ref={(el) => (closeBtn = el)} class="btn primary" type="button" onClick={() => props.onClose()}>
					Got It
				</button>
			</div>
		</dialog>
	)
}

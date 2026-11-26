// In-memory broker for interactive OpenSSH SSH_ASKPASS prompts (key passphrases, passwords, 2FA, host-key checks).
// Secrets are relayed directly to the waiting ssh process and are never logged or written to disk.
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secretId, tid } from '../../src/shared/tid.ts'
import type { SshPromptRequest } from '../../src/shared/types.ts'

const IS_COMPILED = import.meta.url.includes('/$bunfs/')
const THIS_DIR = IS_COMPILED ? '' : dirname(fileURLToPath(import.meta.url))

function resolveAskpassHelper(): { scriptSh: string; scriptTs?: string } {
	if (!IS_COMPILED) {
		return {
			scriptSh: join(THIS_DIR, 'ssh-askpass.sh'),
			scriptTs: join(THIS_DIR, 'ssh-askpass.ts'),
		}
	}
	const candidates: string[] = []
	if (process.env.DATADIP_ASSETS_DIR) {
		candidates.push(join(process.env.DATADIP_ASSETS_DIR, 'ssh-askpass.sh'))
	}
	let execDir = dirname(process.execPath)
	try {
		execDir = dirname(realpathSync(process.execPath))
	} catch {}
	candidates.push(resolve(execDir, '..', 'Resources', 'ssh-askpass.sh'))
	const found = candidates.find((p) => existsSync(p)) ?? candidates[0]!
	return { scriptSh: found }
}

export function applySshAskpassEnv(
	env: Record<string, string | undefined>,
	askpass: { url: string; token: string },
	host: string,
) {
	const helper = resolveAskpassHelper()
	env.SSH_ASKPASS = helper.scriptSh
	env.SSH_ASKPASS_REQUIRE = 'force'
	env.DISPLAY = env.DISPLAY || ':0'
	env.DATADIP_BUN = process.execPath
	if (helper.scriptTs) env.DATADIP_ASKPASS_SCRIPT = helper.scriptTs
	else delete env.DATADIP_ASKPASS_SCRIPT
	env.DATADIP_ASKPASS_URL = askpass.url
	env.DATADIP_ASKPASS_TOKEN = askpass.token
	env.DATADIP_ASKPASS_HOST = host
}

export type SshPromptResult =
	| { ok: true; answer: string; cancelled?: false }
	| { ok: false; cancelled: true; reason?: string }

interface PendingPrompt {
	meta: SshPromptRequest
	resolve: (result: SshPromptResult) => void
	timer: ReturnType<typeof setTimeout>
	cleanupAbort?: () => void
}

export class SshPromptBroker {
	readonly token = secretId()
	private pending = new Map<string, PendingPrompt>()
	private listeners = new Set<(prompts: SshPromptRequest[]) => void>()
	private readonly onHostActivity?: (host: string, active: boolean) => void

	constructor(onHostActivity?: (host: string, active: boolean) => void) {
		this.onHostActivity = onHostActivity
	}

	verifyToken(candidate: string | null | undefined): boolean {
		return typeof candidate === 'string' && candidate.length > 0 && candidate === this.token
	}

	list(): SshPromptRequest[] {
		return Array.from(this.pending.values(), (p) => p.meta)
	}

	subscribe(listener: (prompts: SshPromptRequest[]) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private notify() {
		if (this.listeners.size === 0) return
		const list = this.list()
		for (const cb of this.listeners) {
			try {
				cb(list)
			} catch {}
		}
	}

	private hasHostPrompt(host: string): boolean {
		for (const p of this.pending.values()) {
			if (p.meta.host === host) return true
		}
		return false
	}

	private classifyKind(prompt: string, askpassMode?: string): 'secret' | 'confirm' {
		if (askpassMode === 'confirm') return 'confirm'
		if (/\(yes\/no/i.test(prompt) || /continue connecting/i.test(prompt)) return 'confirm'
		return 'secret'
	}

	async requestPrompt(
		input: { host: string; prompt: string; askpassMode?: string },
		signal?: AbortSignal,
		options?: { timeoutMs?: number; hasUiClient?: () => boolean },
	): Promise<SshPromptResult> {
		if (signal?.aborted) return { ok: false, cancelled: true, reason: 'Aborted' }

		// Avoid hanging 120s when no DataDip UI is connected (e.g. headless CLI/curl probe).
		if (options?.hasUiClient && !options.hasUiClient()) {
			const waitUntil = Date.now() + 1500
			while (Date.now() < waitUntil && !options.hasUiClient()) {
				if (signal?.aborted) return { ok: false, cancelled: true, reason: 'Aborted' }
				await Bun.sleep(100)
			}
			if (!options.hasUiClient()) {
				return { ok: false, cancelled: true, reason: 'No UI client connected to answer SSH prompt' }
			}
		}

		const id = tid('p')
		const meta: SshPromptRequest = {
			id,
			host: input.host || 'remote',
			prompt: input.prompt || 'SSH authentication required',
			kind: this.classifyKind(input.prompt || '', input.askpassMode),
			createdAt: new Date().toISOString(),
		}
		const timeoutMs = options?.timeoutMs ?? 120_000

		return new Promise<SshPromptResult>((resolve) => {
			let settled = false
			const finish = (result: SshPromptResult) => {
				if (settled) return
				settled = true
				const entry = this.pending.get(id)
				if (entry) {
					clearTimeout(entry.timer)
					entry.cleanupAbort?.()
					this.pending.delete(id)
				}
				this.onHostActivity?.(meta.host, this.hasHostPrompt(meta.host))
				this.notify()
				resolve(result)
			}

			const timer = setTimeout(() => finish({ ok: false, cancelled: true, reason: 'Prompt timed out' }), timeoutMs)
			timer.unref?.()

			let cleanupAbort: (() => void) | undefined
			if (signal) {
				const onAbort = () => finish({ ok: false, cancelled: true, reason: 'SSH process closed' })
				signal.addEventListener('abort', onAbort, { once: true })
				cleanupAbort = () => signal.removeEventListener('abort', onAbort)
			}

			this.pending.set(id, { meta, resolve: finish, timer, cleanupAbort })
			this.onHostActivity?.(meta.host, true)
			this.notify()
		})
	}

	respond(id: string, input: { answer?: string; cancelled?: boolean }): boolean {
		const entry = this.pending.get(id)
		if (!entry) return false
		if (input.cancelled) {
			entry.resolve({ ok: false, cancelled: true })
		} else {
			entry.resolve({ ok: true, answer: String(input.answer ?? '') })
		}
		return true
	}

	closeAll() {
		for (const entry of Array.from(this.pending.values())) {
			entry.resolve({ ok: false, cancelled: true, reason: 'Server shutting down' })
		}
		this.pending.clear()
		this.listeners.clear()
	}
}

// Multiplexed SSH connection pool running a single persistent remote Bun worker per SSH host.
// Concurrent queries share one SSH pipe via NDJSON-RPC request IDs, avoiding SSH startup latency.
import type { Subprocess } from 'bun'
import { tid } from '../../src/shared/tid.ts'
import { REMOTE_WORKER_SOURCE } from './remote-worker.ts'
import { applySshAskpassEnv } from './ssh-prompts.ts'

export interface SshAskpassConfig {
	url: string
	token: string
}

export interface SshTarget {
	host: string
	user?: string
	port?: number
}

interface PendingRpc {
	resolve: (value: unknown) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout>
}

// One-line remote bootstrap that reads the worker source from the first stdin line and executes it as async ESM.
const BOOTSTRAP =
	"const d=new TextDecoder(),r=Bun.stdin.stream().getReader();let b='';while(true){const{value,done}=await r.read();if(done)break;b+=d.decode(value,{stream:true});const i=b.indexOf('\\n');if(i!==-1){const s=JSON.parse(b.slice(0,i));await new Function('reader','initialBuf','return (async()=>{'+s+'})()')(r,b.slice(i+1));break}}"

class SshHostChannel {
	readonly key: string
	readonly target: SshTarget
	readonly dest: string
	private readonly getAskpass: () => SshAskpassConfig | null
	private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
	private pending = new Map<string, PendingRpc>()
	private readyPromise: Promise<void> | null = null
	private stderrTail = ''
	private connectTimer: ReturnType<typeof setTimeout> | null = null
	private onConnectTimeout: (() => void) | null = null
	private promptActive = false

	constructor(key: string, target: SshTarget, getAskpass: () => SshAskpassConfig | null) {
		this.key = key
		this.target = target
		this.dest = target.user ? `${target.user}@${target.host}` : target.host
		this.getAskpass = getAskpass
	}

	setPromptActive(active: boolean) {
		this.promptActive = active
		if (!this.onConnectTimeout) return
		if (active) {
			if (this.connectTimer) {
				clearTimeout(this.connectTimer)
				this.connectTimer = null
			}
		} else if (!this.connectTimer) {
			this.connectTimer = setTimeout(this.onConnectTimeout, 15_000)
		}
	}

	private clearConnectTimer() {
		if (this.connectTimer) {
			clearTimeout(this.connectTimer)
			this.connectTimer = null
		}
		this.onConnectTimeout = null
	}

	private ensureConnected(): Promise<void> {
		if (this.readyPromise) return this.readyPromise
		this.stderrTail = ''

		const askpass = this.getAskpass()
		const args: string[] = []
		if (!askpass) {
			args.push('-o', 'BatchMode=yes')
		} else {
			args.push('-o', 'NumberOfPasswordPrompts=3')
		}
		args.push('-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-T')
		if (this.target.port && this.target.port !== 22) {
			args.push('-p', String(this.target.port))
		}
		const dest = this.dest
		// Pass worker via a single sh invocation that resolves bun in PATH or ~/.bun/bin/bun
		const remoteCmd = `BUN=$(command -v bun || echo "$HOME/.bun/bin/bun"); [ -x "$BUN" ] || { echo "bun not found on remote host" >&2; exit 127; }; exec "$BUN" -e ${JSON.stringify(BOOTSTRAP)}`
		args.push(dest, remoteCmd)

		const env: Record<string, string | undefined> = { ...process.env }
		if (askpass) {
			applySshAskpassEnv(env, askpass, dest)
		}

		const proc = Bun.spawn(['ssh', ...args], {
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})
		this.proc = proc

		// Capture stderr tail for clear diagnostics on connection/auth failure
		;(async () => {
			const dec = new TextDecoder()
			for await (const chunk of proc.stderr) {
				this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-4000)
			}
		})().catch(() => {})

		this.readyPromise = new Promise<void>((resolve, reject) => {
			let settled = false
			this.onConnectTimeout = () => {
				if (!settled) {
					settled = true
					this.clearConnectTimer()
					this.reset(
						new Error(`SSH connection to ${dest} timed out${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`),
					)
					reject(new Error(`SSH connection to ${dest} timed out`))
				}
			}
			if (!this.promptActive) {
				this.connectTimer = setTimeout(this.onConnectTimeout, 15_000)
			}

			// Send worker source as the first line on stdin
			try {
				proc.stdin.write(JSON.stringify(REMOTE_WORKER_SOURCE) + '\n')
				proc.stdin.flush()
			} catch (err) {
				this.clearConnectTimer()
				settled = true
				reject(err instanceof Error ? err : new Error(String(err)))
				return
			}

			// Read NDJSON responses from stdout
			;(async () => {
				const dec = new TextDecoder()
				let buf = ''
				try {
					for await (const chunk of proc.stdout) {
						buf += dec.decode(chunk, { stream: true })
						let nl: number
						while ((nl = buf.indexOf('\n')) !== -1) {
							const line = buf.slice(0, nl).trim()
							buf = buf.slice(nl + 1)
							if (!line) continue
							let msg: { ready?: boolean; id?: string; ok?: boolean; result?: unknown; error?: string }
							try {
								msg = JSON.parse(line)
							} catch {
								continue
							}
							if (msg.ready && !settled) {
								this.clearConnectTimer()
								settled = true
								resolve()
								continue
							}
							if (msg.id) {
								const p = this.pending.get(msg.id)
								if (p) {
									this.pending.delete(msg.id)
									clearTimeout(p.timer)
									if (msg.ok) p.resolve(msg.result)
									else p.reject(new Error(msg.error || 'Remote worker error'))
								}
							}
						}
					}
				} finally {
					this.clearConnectTimer()
					const detail = this.stderrTail.trim()
					const err = new Error(`SSH session to ${dest} closed${detail ? `: ${detail}` : ''}`)
					if (!settled) {
						settled = true
						reject(err)
					}
					this.reset(err)
				}
			})()
		})

		return this.readyPromise
	}

	async call<T>(
		payload: { op: string; path?: string; rw?: boolean; params?: unknown },
		timeoutMs = 30_000,
		customId?: string,
	): Promise<T> {
		await this.ensureConnected()
		const proc = this.proc
		if (!proc) throw new Error('SSH channel is not connected')

		const id = customId || tid('r')
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`Remote query timed out after ${Math.round(timeoutMs / 1000)}s`))
			}, timeoutMs)

			this.pending.set(id, {
				resolve: (v) => resolve(v as T),
				reject,
				timer,
			})

			try {
				proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
				proc.stdin.flush()
			} catch (err) {
				clearTimeout(timer)
				this.pending.delete(id)
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}

	async cancel(targetId: string): Promise<boolean> {
		if (!this.proc || !this.pending.has(targetId)) return false
		try {
			const res = await this.call<{ cancelled: boolean }>({ op: 'cancel', params: { targetId } }, 5_000)
			return Boolean(res?.cancelled)
		} catch {
			return false
		}
	}

	private reset(err: Error) {
		this.readyPromise = null
		const proc = this.proc
		this.proc = null
		if (proc) {
			try {
				proc.stdin.end()
			} catch {}
			try {
				proc.kill()
			} catch {}
		}
		for (const [id, p] of this.pending.entries()) {
			clearTimeout(p.timer)
			p.reject(err)
			this.pending.delete(id)
		}
	}

	close() {
		this.reset(new Error('SSH channel closed'))
	}
}

export class SshMuxPool {
	private channels = new Map<string, SshHostChannel>()
	private askpass: SshAskpassConfig | null = null

	setAskpassConfig(cfg: SshAskpassConfig | null) {
		this.askpass = cfg
	}

	setHostPromptActive(dest: string, active: boolean) {
		for (const ch of this.channels.values()) {
			if (ch.dest === dest) ch.setPromptActive(active)
		}
	}

	private keyOf(t: SshTarget): string {
		return `${t.user ?? ''}@${t.host}:${t.port ?? 22}`
	}

	getChannel(target: SshTarget): SshHostChannel {
		const key = this.keyOf(target)
		let ch = this.channels.get(key)
		if (!ch) {
			ch = new SshHostChannel(key, target, () => this.askpass)
			this.channels.set(key, ch)
		}
		return ch
	}

	closeAll() {
		for (const ch of this.channels.values()) ch.close()
		this.channels.clear()
	}
}

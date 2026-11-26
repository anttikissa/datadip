// Multiplexed SSH connection pool supporting Bun, Python 3, and sqlite3 CLI runtimes with auto-detection.
// Concurrent queries share one persistent SSH pipe per host, avoiding SSH startup latency.
import type { Subprocess } from 'bun'
import { tid } from '../../src/shared/tid.ts'
import type { SshResolvedRuntime, SshRuntimePreference } from '../../src/shared/types.ts'
import { REMOTE_WORKER_SOURCE } from './remote-worker.ts'
import { REMOTE_PYTHON_WORKER_SOURCE } from './remote-worker-python.ts'
import { REMOTE_SQLITE3_SH_WORKER } from './remote-worker-sqlite3.ts'
import { applySshAskpassEnv } from './ssh-prompts.ts'

export interface SshAskpassConfig {
	url: string
	token: string
}

export interface SshTarget {
	host: string
	user?: string
	port?: number
	runtime?: SshRuntimePreference
}

interface PendingRpc {
	resolve: (value: unknown) => void
	reject: (err: Error) => void
	timer: ReturnType<typeof setTimeout>
}

export interface CliExecResult {
	rc: number
	stdout: string
	stderr: string
}

// One-line bootstraps that read the full worker source from stdin line 1 and execute it without writing remote files.
const BUN_BOOTSTRAP =
	"const d=new TextDecoder(),r=Bun.stdin.stream().getReader();let b='';while(true){const{value,done}=await r.read();if(done)break;b+=d.decode(value,{stream:true});const i=b.indexOf('\\n');if(i!==-1){const s=JSON.parse(b.slice(0,i));await new Function('reader','initialBuf','return (async()=>{'+s+'})()')(r,b.slice(i+1));break}}"

const PYTHON_BOOTSTRAP = 'import sys,json; exec(json.loads(sys.stdin.readline()), {"__name__":"__main__"})'

const SQLITE3_SH_BOOTSTRAP =
	'IFS= read -r b; if base64 -d </dev/null >/dev/null 2>&1; then s=$(printf "%s" "$b" | base64 -d); else s=$(printf "%s" "$b" | base64 -D); fi; eval "$s"'

function shSingleQuote(s: string): string {
	return "'" + s.replaceAll("'", "'\\''") + "'"
}

// Builds the POSIX sh launcher that resolves the preferred (or auto-detected) runtime and announces it on stdout line 1.
export function buildRemoteLauncherCmd(preference: SshRuntimePreference = 'auto'): string {
	const pref = preference === 'bun' || preference === 'python3' || preference === 'sqlite3' ? preference : 'auto'
	const bunProbe = 'BUN=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun"); [ -x "$BUN" ] || BUN=""'
	const pyProbe =
		'PY=$(command -v python3 2>/dev/null || true); if [ -n "$PY" ]; then "$PY" -c "import sqlite3" >/dev/null 2>&1 || PY=""; fi'
	const sqProbe = 'SQ=$(command -v sqlite3 2>/dev/null || true)'

	let selectBlock: string
	if (pref === 'bun') {
		selectBlock = `${bunProbe}
if [ -n "$BUN" ]; then SEL=bun
else echo "bun not found on remote host [DATADIP_MISSING_RUNTIME:bun]" >&2; exit 127; fi`
	} else if (pref === 'python3') {
		selectBlock = `${pyProbe}
if [ -n "$PY" ]; then SEL=python3
else echo "python3 (with sqlite3) not found on remote host [DATADIP_MISSING_RUNTIME:python3]" >&2; exit 127; fi`
	} else if (pref === 'sqlite3') {
		selectBlock = `${sqProbe}
if [ -n "$SQ" ]; then SEL=sqlite3
else echo "sqlite3 CLI not found on remote host [DATADIP_MISSING_RUNTIME:sqlite3]" >&2; exit 127; fi`
	} else {
		selectBlock = `${bunProbe}
${pyProbe}
${sqProbe}
if [ -n "$BUN" ]; then SEL=bun
elif [ -n "$PY" ]; then SEL=python3
elif [ -n "$SQ" ]; then SEL=sqlite3
else echo "No SQLite runtime found on remote host (tried bun, python3, sqlite3) [DATADIP_MISSING_RUNTIME:auto]" >&2; exit 127; fi`
	}

	return [
		selectBlock,
		`if [ "$SEL" = "bun" ]; then printf '{"select":"bun"}\\n'; exec "$BUN" -e ${shSingleQuote(BUN_BOOTSTRAP)};`,
		`elif [ "$SEL" = "python3" ]; then printf '{"select":"python3"}\\n'; exec "$PY" -u -c ${shSingleQuote(PYTHON_BOOTSTRAP)};`,
		`else printf '{"select":"sqlite3"}\\n'; exec /bin/sh -c ${shSingleQuote(SQLITE3_SH_BOOTSTRAP)}; fi`,
	].join('\n')
}

export type RemoteSpawnFn = (remoteCmd: string) => Subprocess<'pipe', 'pipe', 'pipe'>

export class SshHostChannel {
	readonly key: string
	readonly target: SshTarget
	readonly dest: string
	private readonly getAskpass: () => SshAskpassConfig | null
	private readonly spawnOverride?: RemoteSpawnFn
	private proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
	private pending = new Map<string, PendingRpc>()
	private readyPromise: Promise<SshResolvedRuntime> | null = null
	private stderrTail = ''
	private connectTimer: ReturnType<typeof setTimeout> | null = null
	private onConnectTimeout: (() => void) | null = null
	private promptActive = false
	private resolvedRuntime: SshResolvedRuntime | undefined = undefined

	constructor(
		key: string,
		target: SshTarget,
		getAskpass: () => SshAskpassConfig | null,
		spawnOverride?: RemoteSpawnFn,
	) {
		this.key = key
		this.target = target
		this.dest = target.user ? `${target.user}@${target.host}` : target.host
		this.getAskpass = getAskpass
		this.spawnOverride = spawnOverride
	}

	getRuntime(): SshResolvedRuntime | undefined {
		return this.resolvedRuntime
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

	ensureConnected(): Promise<SshResolvedRuntime> {
		if (this.readyPromise) return this.readyPromise
		this.stderrTail = ''
		this.resolvedRuntime = undefined

		const remoteCmd = buildRemoteLauncherCmd(this.target.runtime ?? 'auto')
		const dest = this.dest

		let proc: Subprocess<'pipe', 'pipe', 'pipe'>
		if (this.spawnOverride) {
			proc = this.spawnOverride(remoteCmd)
		} else {
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
			args.push(dest, remoteCmd)

			const env: Record<string, string | undefined> = { ...process.env }
			if (askpass) {
				applySshAskpassEnv(env, askpass, dest)
			}

			proc = Bun.spawn(['ssh', ...args], {
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
				env,
			})
		}
		this.proc = proc

		// Capture stderr tail for clear diagnostics on connection/auth/runtime failure
		;(async () => {
			const dec = new TextDecoder()
			for await (const chunk of proc.stderr) {
				this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-4000)
			}
		})().catch(() => {})

		this.readyPromise = new Promise<SshResolvedRuntime>((resolve, reject) => {
			let settled = false
			let workerSent = false

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

							// Base64-framed response line from the sqlite3 POSIX sh worker
							if (this.resolvedRuntime === 'sqlite3' && line.startsWith('res\t')) {
								const parts = line.split('\t')
								const id = parts[1] ?? ''
								const rc = Number(parts[2] ?? '1')
								const outText = parts[3] ? Buffer.from(parts[3], 'base64').toString('utf8') : ''
								const errText = parts[4] ? Buffer.from(parts[4], 'base64').toString('utf8') : ''
								const p = this.pending.get(id)
								if (p) {
									this.pending.delete(id)
									clearTimeout(p.timer)
									p.resolve({ rc, stdout: outText, stderr: errText } satisfies CliExecResult)
								}
								continue
							}

							let msg: {
								select?: SshResolvedRuntime
								ready?: boolean
								runtime?: SshResolvedRuntime
								id?: string
								ok?: boolean
								result?: unknown
								error?: string
							}
							try {
								msg = JSON.parse(line)
							} catch {
								continue
							}

							// Step 1: launcher announced which runtime is available; send matching worker source on stdin
							if (msg.select && !workerSent) {
								workerSent = true
								this.resolvedRuntime = msg.select
								try {
									if (msg.select === 'bun') {
										proc.stdin.write(JSON.stringify(REMOTE_WORKER_SOURCE) + '\n')
									} else if (msg.select === 'python3') {
										proc.stdin.write(JSON.stringify(REMOTE_PYTHON_WORKER_SOURCE) + '\n')
									} else {
										proc.stdin.write(Buffer.from(REMOTE_SQLITE3_SH_WORKER, 'utf8').toString('base64') + '\n')
									}
									proc.stdin.flush()
								} catch (err) {
									if (!settled) {
										settled = true
										this.clearConnectTimer()
										reject(err instanceof Error ? err : new Error(String(err)))
									}
								}
								continue
							}

							// Step 2: worker initialized and ready to accept RPCs
							if (msg.ready && !settled) {
								if (msg.runtime) this.resolvedRuntime = msg.runtime
								this.clearConnectTimer()
								settled = true
								resolve(this.resolvedRuntime ?? 'bun')
								continue
							}

							// Step 3: NDJSON RPC response (bun / python3)
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
					const err = new Error(detail ? detail : `SSH session to ${dest} closed`)
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
		const runtime = await this.ensureConnected()
		if (runtime === 'sqlite3') {
			throw new Error('NDJSON RPC is not used on sqlite3 CLI channel')
		}
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

	// Base64-framed command invocation for the persistent remote `sqlite3` CLI shell worker.
	async callCli(
		op: 'exec' | 'stat' | 'discover',
		fields: string[],
		timeoutMs = 30_000,
		customId?: string,
	): Promise<CliExecResult> {
		const runtime = await this.ensureConnected()
		if (runtime !== 'sqlite3') {
			throw new Error(`Expected sqlite3 CLI runtime, got ${runtime}`)
		}
		const proc = this.proc
		if (!proc) throw new Error('SSH channel is not connected')

		const id = customId || tid('r')
		return new Promise<CliExecResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`Remote sqlite3 command timed out after ${Math.round(timeoutMs / 1000)}s`))
			}, timeoutMs)

			this.pending.set(id, {
				resolve: (v) => resolve(v as CliExecResult),
				reject,
				timer,
			})

			try {
				proc.stdin.write([op, id, ...fields].join('\t') + '\n')
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
		if (this.resolvedRuntime === 'sqlite3') return false
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
		return `${t.user ?? ''}@${t.host}:${t.port ?? 22}:${t.runtime ?? 'auto'}`
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

	closeHost(target: Pick<SshTarget, 'host' | 'user' | 'port'>) {
		const prefix = `${target.user ?? ''}@${target.host}:${target.port ?? 22}:`
		for (const [k, ch] of this.channels.entries()) {
			if (k.startsWith(prefix)) {
				ch.close()
				this.channels.delete(k)
			}
		}
	}

	// Explicitly user-triggered remote Bun installation via official install script over SSH (reuses SSH_ASKPASS).
	async installBunOnHost(target: Pick<SshTarget, 'host' | 'user' | 'port'>): Promise<{
		ok: true
		version: string
		output: string
	}> {
		if (!target.host.trim()) throw new Error('SSH host is required')
		const dest = target.user ? `${target.user}@${target.host}` : target.host
		const askpass = this.askpass
		const args: string[] = []
		if (!askpass) {
			args.push('-o', 'BatchMode=yes')
		} else {
			args.push('-o', 'NumberOfPasswordPrompts=3')
		}
		args.push('-o', 'ConnectTimeout=15', '-T')
		if (target.port && target.port !== 22) {
			args.push('-p', String(target.port))
		}
		const installCmd =
			'set -e; curl -fsSL https://bun.sh/install | bash; BUN=$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun"); "$BUN" --version'
		args.push(dest, installCmd)

		const env: Record<string, string | undefined> = { ...process.env }
		if (askpass) applySshAskpassEnv(env, askpass, dest)

		const proc = Bun.spawn(['ssh', ...args], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})

		const [outText, errText, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		const combined = `${outText}\n${errText}`.trim()
		if (exitCode !== 0) {
			throw new Error(`Remote Bun install failed (exit ${exitCode}): ${combined.slice(-600)}`)
		}
		const version =
			outText
				.trim()
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean)
				.pop() ?? 'installed'
		this.closeHost(target)
		return { ok: true, version, output: combined.slice(-1200) }
	}

	closeAll() {
		for (const ch of this.channels.values()) ch.close()
		this.channels.clear()
	}
}

// OpenSSH local TCP port-forwarding tunnel (ssh -N -L) for remote PostgreSQL/TCP databases.
// Uses the same SSH_ASKPASS prompt broker as SshMuxPool and requires zero software installed on the remote host.
import type { Subprocess } from 'bun'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SshAskpassConfig, SshTarget } from './ssh-mux.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const ASKPASS_SH = join(THIS_DIR, 'ssh-askpass.sh')
const ASKPASS_TS = join(THIS_DIR, 'ssh-askpass.ts')

function allocateFreePort(): number {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data() {},
		},
	})
	const port = listener.port
	listener.stop(true)
	return port
}

async function canConnectTcp(port: number): Promise<boolean> {
	try {
		const sock = await Bun.connect({
			hostname: '127.0.0.1',
			port,
			socket: {
				data() {},
				error() {},
			},
		})
		sock.end()
		return true
	} catch {
		return false
	}
}

export class SshTcpTunnel {
	readonly target: SshTarget
	readonly dest: string
	readonly remoteHost: string
	readonly remotePort: number
	private readonly getAskpass: () => SshAskpassConfig | null
	private proc: Subprocess<'ignore', 'pipe', 'pipe'> | null = null
	private localPort: number | null = null
	private openPromise: Promise<number> | null = null
	private stderrTail = ''
	private promptActive = false

	constructor(target: SshTarget, remoteHost: string, remotePort: number, getAskpass: () => SshAskpassConfig | null) {
		this.target = target
		this.dest = target.user ? `${target.user}@${target.host}` : target.host
		this.remoteHost = remoteHost
		this.remotePort = remotePort
		this.getAskpass = getAskpass
	}

	setPromptActive(active: boolean) {
		this.promptActive = active
	}

	ensureOpen(): Promise<number> {
		if (this.localPort !== null && this.proc && this.proc.exitCode === null) {
			return Promise.resolve(this.localPort)
		}
		if (this.openPromise) return this.openPromise

		this.openPromise = this.spawnTunnel().catch((err) => {
			this.openPromise = null
			throw err
		})
		return this.openPromise
	}

	private async spawnTunnel(): Promise<number> {
		this.close()
		this.stderrTail = ''
		const localPort = allocateFreePort()
		const askpass = this.getAskpass()

		const args: string[] = ['-N', '-T', '-o', 'ExitOnForwardFailure=yes']
		if (!askpass) {
			args.push('-o', 'BatchMode=yes')
		} else {
			args.push('-o', 'NumberOfPasswordPrompts=3')
		}
		args.push(
			'-o',
			'ConnectTimeout=10',
			'-o',
			'ServerAliveInterval=15',
			'-o',
			'ServerAliveCountMax=3',
			'-L',
			`127.0.0.1:${localPort}:${this.remoteHost}:${this.remotePort}`,
		)
		if (this.target.port && this.target.port !== 22) {
			args.push('-p', String(this.target.port))
		}
		args.push(this.dest)

		const env: Record<string, string | undefined> = { ...process.env }
		if (askpass) {
			env.SSH_ASKPASS = ASKPASS_SH
			env.SSH_ASKPASS_REQUIRE = 'force'
			env.DISPLAY = env.DISPLAY || ':0'
			env.DATADIP_BUN = process.execPath
			env.DATADIP_ASKPASS_SCRIPT = ASKPASS_TS
			env.DATADIP_ASKPASS_URL = askpass.url
			env.DATADIP_ASKPASS_TOKEN = askpass.token
			env.DATADIP_ASKPASS_HOST = this.dest
		}

		const proc = Bun.spawn(['ssh', ...args], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env,
		})
		this.proc = proc

		;(async () => {
			const dec = new TextDecoder()
			for await (const chunk of proc.stderr) {
				this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-4000)
			}
		})().catch(() => {})

		let waitedMs = 0
		const maxWaitMs = 15_000
		while (true) {
			if (proc.exitCode !== null) {
				const detail = this.stderrTail.trim()
				this.close()
				throw new Error(
					`SSH tunnel to ${this.dest} (${this.remoteHost}:${this.remotePort}) failed${detail ? `: ${detail}` : ''}`,
				)
			}
			if (await canConnectTcp(localPort)) {
				this.localPort = localPort
				return localPort
			}
			await Bun.sleep(80)
			if (!this.promptActive) {
				waitedMs += 80
				if (waitedMs >= maxWaitMs) {
					const detail = this.stderrTail.trim()
					this.close()
					throw new Error(`SSH tunnel to ${this.dest} timed out${detail ? `: ${detail}` : ''}`)
				}
			}
		}
	}

	close() {
		const proc = this.proc
		this.proc = null
		this.localPort = null
		this.openPromise = null
		if (proc) {
			try {
				proc.kill()
			} catch {}
		}
	}
}

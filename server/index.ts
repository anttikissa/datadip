// DataDip CLI and HTTP server serving /api/* (ASON) and the built Vite web client.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from './api.ts'
import { ConnectionManager } from './db/manager.ts'
import { DataStore } from './store.ts'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT_DIR, 'dist')
const PUBLIC_DIR = join(ROOT_DIR, 'public')

interface CliArgs {
	command: 'serve' | 'url' | 'status' | 'open'
	host: string
	port: number
	dataDir?: string
}

function parseArgs(argv: string[]): CliArgs {
	let command: CliArgs['command'] = 'serve'
	let host = '127.0.0.1'
	let port = 4747
	let dataDir: string | undefined

	const args = [...argv]
	if (args[0] && ['serve', 'url', 'status', 'open'].includes(args[0])) {
		command = args.shift() as CliArgs['command']
	}

	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === '--host' && args[i + 1]) host = args[++i]!
		else if (a === '--port' && args[i + 1]) port = Number(args[++i]!) || 4747
		else if ((a === '--data' || a === '--home') && args[i + 1]) dataDir = args[++i]!
	}

	return { command, host, port, dataDir }
}

async function isServerAlive(url: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })
		return res.ok
	} catch {
		return false
	}
}

async function runServe(opts: CliArgs) {
	const store = new DataStore(opts.dataDir)

	// If another DataDip server is already live for this dataDir, print its URL and exit cleanly
	const existing = store.readServerInfo()
	if (existing && (await isServerAlive(existing.url))) {
		console.log(`DataDip already running on ${existing.url} (pid ${existing.pid})`)
		store.close()
		process.exit(0)
	}

	const manager = new ConnectionManager(store)

	let server: ReturnType<typeof Bun.serve> | null = null
	let boundPort = opts.port
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			server = Bun.serve({
				hostname: opts.host,
				port: boundPort,
				fetch: async (req) => {
					const url = new URL(req.url)
					if (url.pathname.startsWith('/api/')) {
						return handleApiRequest(req, manager)
					}

					// Serve static files from dist/ or public/
					const relPath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
					if (!relPath.includes('..')) {
						const distFile = join(DIST_DIR, relPath)
						if (existsSync(distFile) && !distFile.endsWith('/')) {
							return new Response(Bun.file(distFile))
						}
						const pubFile = join(PUBLIC_DIR, relPath)
						if (existsSync(pubFile) && !pubFile.endsWith('/')) {
							return new Response(Bun.file(pubFile))
						}
					}

					// SPA fallback to dist/index.html
					const indexFile = join(DIST_DIR, 'index.html')
					if (existsSync(indexFile)) {
						return new Response(Bun.file(indexFile), {
							headers: { 'content-type': 'text/html; charset=utf-8' },
						})
					}

					return new Response(
						'DataDip client not built yet. Run `bun run build` or open the Vite dev server on http://127.0.0.1:4748.',
						{ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
					)
				},
			})
			break
		} catch (err) {
			if (attempt === 19) throw err
			boundPort++
		}
	}

	if (!server) throw new Error('Failed to start DataDip server')

	const actualPort = server.port ?? boundPort
	const serverUrl = `http://${opts.host}:${actualPort}`
	store.writeServerInfo({
		pid: process.pid,
		host: opts.host,
		port: actualPort,
		url: serverUrl,
		startedAt: new Date().toISOString(),
	})

	console.log(`DataDip listening on ${serverUrl}`)

	const shutdown = () => {
		manager.closeAll()
		store.clearServerInfo(process.pid)
		store.close()
		server?.stop(true)
		process.exit(0)
	}
	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}

async function runUrl(opts: CliArgs) {
	const store = new DataStore(opts.dataDir)
	const info = store.readServerInfo()
	store.close()
	if (info && (await isServerAlive(info.url))) {
		console.log(`Local: ${info.url}`)
		process.exit(0)
	}
	console.error('DataDip server is not running')
	process.exit(1)
}

async function runStatus(opts: CliArgs) {
	const store = new DataStore(opts.dataDir)
	const info = store.readServerInfo()
	store.close()
	if (info && (await isServerAlive(info.url))) {
		console.log(`Running: ${info.url} (pid ${info.pid}, started ${info.startedAt})`)
		process.exit(0)
	}
	console.log('Not running')
	process.exit(1)
}

async function runOpen(opts: CliArgs) {
	const store = new DataStore(opts.dataDir)
	const info = store.readServerInfo()
	store.close()
	let url: string | null = null
	if (info && (await isServerAlive(info.url))) {
		url = info.url
	} else {
		// Start server detached
		const args = [
			process.execPath,
			join(ROOT_DIR, 'server', 'index.ts'),
			'serve',
			'--host',
			opts.host,
			'--port',
			String(opts.port),
		]
		if (opts.dataDir) args.push('--data', opts.dataDir)
		const child = Bun.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
		child.unref()
		const deadline = Date.now() + 8000
		while (Date.now() < deadline) {
			await Bun.sleep(100)
			const s2 = new DataStore(opts.dataDir)
			const i2 = s2.readServerInfo()
			s2.close()
			if (i2 && (await isServerAlive(i2.url))) {
				url = i2.url
				break
			}
		}
	}
	if (!url) {
		console.error('Failed to start DataDip server')
		process.exit(1)
	}
	console.log(url)
	const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
	Bun.spawnSync([opener, url])
}

const opts = parseArgs(process.argv.slice(2))
if (opts.command === 'serve') await runServe(opts)
else if (opts.command === 'url') await runUrl(opts)
else if (opts.command === 'status') await runStatus(opts)
else await runOpen(opts)

// OpenSSH SSH_ASKPASS helper that relays passphrase, password, 2FA, and host-key prompts to DataDip's local server.
import { parse as parseAson, stringify as stringifyAson } from '../../src/shared/ason.ts'

export async function runSshAskpass(argv: string[]): Promise<never> {
	const askpassMode = process.env.SSH_ASKPASS_PROMPT || ''
	if (askpassMode === 'none') {
		process.exit(0)
	}

	const url = process.env.DATADIP_ASKPASS_URL
	const token = process.env.DATADIP_ASKPASS_TOKEN
	const host = process.env.DATADIP_ASKPASS_HOST || 'remote'
	const prompt = argv.join(' ').trim() || 'SSH authentication required'

	if (!url || !token) {
		process.exit(1)
	}

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'x-datadip-askpass-token': token,
			},
			body: stringifyAson({ host, prompt, askpassMode }, 'short'),
		})
		if (!res.ok) process.exit(1)
		const text = await res.text()
		const data = parseAson(text) as { ok?: boolean; answer?: string; cancelled?: boolean }
		if (!data?.ok || data.cancelled) process.exit(1)
		process.stdout.write(`${data.answer ?? ''}\n`)
		process.exit(0)
	} catch {
		process.exit(1)
	}
}

if (import.meta.main) {
	await runSshAskpass(process.argv.slice(2))
}

// Short ids that sort by creation time: a type letter, 9 characters of ms timestamp, then random characters:
// 2 for ids the server makes, 4 for ids a client makes, e.g. t1m62w782yzt.
// Ids come from tid(), secrets from secretId(); neither carries over 128 bits.
export const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'

// Strictly increasing per process, so ids made in the same millisecond cannot collide.
let last = 0

export function tid(type: string, random = 2) {
	last = Math.max(Date.now(), last + 1)
	return tidAt(type, last, random)
}

export function tidAt(type: string, ms: number, random = 2) {
	if (!/^[a-z]$/.test(type)) throw new Error(`Invalid tid type: ${type}`)
	let id = ''
	for (let t = ms, i = 0; i < 9; i++, t = Math.floor(t / 32)) id = alphabet[t % 32] + id
	return type + id + secretId(random)
}

// The creation time of a tid, in ms.
export function tidTime(id: string) {
	let t = 0
	for (const c of id.slice(1, 10)) t = t * 32 + alphabet.indexOf(c)
	return t
}

// Unguessable: tokens use 25 characters (125 bits, under a UUID's 128).
export function secretId(length = 25) {
	return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => alphabet[b % 32]).join('')
}

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 * 26 characters: 10 for timestamp (ms), 16 random. Crockford Base32.
 * Monotonic within the same millisecond (increments random component).
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(now: number, len: number): string {
	let str = "";
	let t = now;
	for (let i = len; i > 0; i--) {
		str = ENCODING[t % 32]! + str;
		t = Math.floor(t / 32);
	}
	return str;
}

function randomChars(len: number): number[] {
	const chars: number[] = [];
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	for (let i = 0; i < len; i++) {
		chars.push(bytes[i]! % 32);
	}
	return chars;
}

export function ulid(): string {
	const now = Date.now();

	if (now === lastTime) {
		// Increment random component for monotonicity
		let i = lastRandom.length - 1;
		while (i >= 0 && lastRandom[i] === 31) {
			lastRandom[i] = 0;
			i--;
		}
		if (i >= 0) {
			lastRandom[i]!++;
		}
	} else {
		lastTime = now;
		lastRandom = randomChars(16);
	}

	return encodeTime(now, 10) + lastRandom.map((c) => ENCODING[c]!).join("");
}

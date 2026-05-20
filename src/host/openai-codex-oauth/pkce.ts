export interface PkcePair {
	codeVerifier: string;
	codeChallenge: string;
}

export interface PkceRandomSource {
	getRandomValues(array: Uint8Array): Uint8Array;
}

const VERIFIER_BYTE_LENGTH = 64;

export async function generatePkce(
	randomSource: PkceRandomSource = globalThis.crypto,
): Promise<PkcePair> {
	const bytes = new Uint8Array(VERIFIER_BYTE_LENGTH);
	randomSource.getRandomValues(bytes);
	const codeVerifier = base64UrlEncodeBytes(bytes);
	return {
		codeVerifier,
		codeChallenge: await createCodeChallenge(codeVerifier),
	};
}

export async function createCodeChallenge(codeVerifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
	return base64UrlEncodeBytes(new Uint8Array(digest));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

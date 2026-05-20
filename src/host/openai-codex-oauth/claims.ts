const CHATGPT_ACCOUNT_ID_CLAIM = "https://api.openai.com/auth.chatgpt_account_id";
const DECODE_ERROR = "Unable to decode OpenAI OAuth token claims";

export function extractChatGPTAccountId(input: {
	accessToken: string;
	idToken?: string;
	storedAccountId?: string;
}): string {
	const accessClaims = decodeJwtClaims(input.accessToken);
	const accessAccountId = getStringClaim(accessClaims, CHATGPT_ACCOUNT_ID_CLAIM);
	if (accessAccountId !== undefined) {
		return accessAccountId;
	}

	if (input.idToken !== undefined) {
		const idClaims = decodeJwtClaims(input.idToken);
		const idAccountId = getStringClaim(idClaims, CHATGPT_ACCOUNT_ID_CLAIM);
		if (idAccountId !== undefined) {
			return idAccountId;
		}
	}

	if (input.storedAccountId !== undefined && input.storedAccountId.trim() !== "") {
		return input.storedAccountId;
	}

	throw new Error("OpenAI OAuth token claims did not include a ChatGPT account id");
}

function decodeJwtClaims(token: string): Record<string, unknown> {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[1] === undefined || parts[1] === "") {
		throw new Error(DECODE_ERROR);
	}

	try {
		const json = new TextDecoder().decode(base64UrlDecode(parts[1]));
		const claims = JSON.parse(json);
		if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
			throw new Error("JWT claims must be an object");
		}
		return claims as Record<string, unknown>;
	} catch {
		throw new Error(DECODE_ERROR);
	}
}

function base64UrlDecode(value: string): Uint8Array {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function getStringClaim(claims: Record<string, unknown>, name: string): string | undefined {
	const value = claims[name];
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

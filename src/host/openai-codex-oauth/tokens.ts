import { redactCredentialText } from "../settings/redaction";
import { OPENAI_CODEX_OAUTH } from "./config";

export interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt: string;
}

type TokenEndpointPayload = Record<string, unknown>;

export async function exchangeCodeForTokens(input: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<TokenResponse> {
	const payload = await postTokenRequest(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: OPENAI_CODEX_OAUTH.clientId,
			code: input.code,
			code_verifier: input.codeVerifier,
			redirect_uri: input.redirectUri,
		}),
		input.fetchImpl,
	);
	return parseTokenResponse(payload, {
		requireRefreshToken: true,
		now: input.now,
	});
}

export async function refreshTokens(input: {
	refreshToken: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<TokenResponse> {
	const payload = await postTokenRequest(
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: OPENAI_CODEX_OAUTH.clientId,
			refresh_token: input.refreshToken,
		}),
		input.fetchImpl,
	);
	return parseTokenResponse(payload, {
		requireRefreshToken: false,
		now: input.now,
	});
}

async function postTokenRequest(
	body: URLSearchParams,
	fetchImpl: typeof fetch = fetch,
): Promise<TokenEndpointPayload> {
	let response: Response;
	try {
		response = await fetchImpl(OPENAI_CODEX_OAUTH.tokenUrl, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
			},
			body,
		});
	} catch (error) {
		throw new Error(
			`OpenAI Codex OAuth token request failed: ${redactCredentialText(String(error))}`,
		);
	}

	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`OpenAI Codex OAuth token request failed: ${redactTokenEndpointText(
				responseText || response.statusText,
			)}`,
		);
	}

	try {
		const payload = JSON.parse(responseText);
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
			throw new Error("Token response must be an object");
		}
		return payload as TokenEndpointPayload;
	} catch {
		throw new Error(
			`OpenAI Codex OAuth token response is not valid JSON: ${redactTokenEndpointText(
				responseText,
			)}`,
		);
	}
}

function parseTokenResponse(
	payload: TokenEndpointPayload,
	options: {
		requireRefreshToken: boolean;
		now?: () => number;
	},
): TokenResponse {
	const accessToken = payload.access_token;
	const refreshToken = payload.refresh_token;
	const idToken = payload.id_token;
	const expiresIn = payload.expires_in;

	if (
		typeof accessToken !== "string" ||
		(options.requireRefreshToken && typeof refreshToken !== "string") ||
		(refreshToken !== undefined && typeof refreshToken !== "string") ||
		(idToken !== undefined && typeof idToken !== "string") ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn)
	) {
		throw new Error(
			`OpenAI Codex OAuth token response is missing required fields: ${redactTokenEndpointText(
				JSON.stringify(payload),
			)}`,
		);
	}

	return {
		accessToken,
		...(refreshToken !== undefined ? { refreshToken } : {}),
		...(idToken !== undefined ? { idToken } : {}),
		expiresAt: new Date((options.now ?? Date.now)() + expiresIn * 1000).toISOString(),
	};
}

function redactTokenEndpointText(value: string): string {
	try {
		const payload = JSON.parse(value);
		return JSON.stringify(redactTokenEndpointPayload(payload));
	} catch {
		return redactCredentialText(value);
	}
}

function redactTokenEndpointPayload(payload: unknown): unknown {
	if (Array.isArray(payload)) {
		return payload.map(redactTokenEndpointPayload);
	}
	if (payload !== null && typeof payload === "object") {
		const redacted: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(payload)) {
			redacted[key] = isSensitiveTokenEndpointKey(key)
				? "[redacted]"
				: redactTokenEndpointPayload(value);
		}
		return redacted;
	}
	if (typeof payload === "string") {
		if (isCallbackUrl(payload)) {
			return "[redacted]";
		}
		return redactCredentialText(payload);
	}
	return payload;
}

function isSensitiveTokenEndpointKey(key: string): boolean {
	return [
		"access_token",
		"refresh_token",
		"id_token",
		"accessToken",
		"refreshToken",
		"idToken",
		"code",
		"state",
		"redirect_uri",
		"redirectUri",
	].includes(key);
}

function isCallbackUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.origin + url.pathname === "http://localhost:1455/auth/callback" ||
			url.origin + url.pathname === "http://localhost:1457/auth/callback"
		);
	} catch {
		return false;
	}
}

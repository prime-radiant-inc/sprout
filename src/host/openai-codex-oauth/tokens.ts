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
			`OpenAI Codex OAuth token request failed: ${redactTokenEndpointText(String(error))}`,
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
	const parsedAccessToken = parseRequiredTokenField(accessToken);
	const parsedRefreshToken = parseOptionalTokenField(refreshToken);
	const parsedIdToken = parseOptionalTokenField(idToken);

	if (
		parsedAccessToken === undefined ||
		(options.requireRefreshToken && parsedRefreshToken === undefined) ||
		(refreshToken !== undefined && parsedRefreshToken === undefined) ||
		(idToken !== undefined && parsedIdToken === undefined) ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(
			`OpenAI Codex OAuth token response is missing required fields: ${redactTokenEndpointText(
				JSON.stringify(payload),
			)}`,
		);
	}

	return {
		accessToken: parsedAccessToken,
		...(parsedRefreshToken !== undefined ? { refreshToken: parsedRefreshToken } : {}),
		...(parsedIdToken !== undefined ? { idToken: parsedIdToken } : {}),
		expiresAt: new Date((options.now ?? Date.now)() + expiresIn * 1000).toISOString(),
	};
}

function parseRequiredTokenField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseOptionalTokenField(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return parseRequiredTokenField(value);
}

function redactTokenEndpointText(value: string): string {
	try {
		const payload = JSON.parse(value);
		return JSON.stringify(redactTokenEndpointPayload(payload));
	} catch {
		return redactTokenEndpointPlainText(value);
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
		"code_verifier",
		"codeVerifier",
		"code",
		"state",
		"redirect_uri",
		"redirectUri",
	].includes(key);
}

function redactTokenEndpointPlainText(value: string): string {
	return redactCredentialText(value)
		.replace(callbackUrlPattern(), "[redacted]")
		.replace(/\b(code|code_verifier|codeVerifier)(=)[^\s&]+/g, "$1$2[redacted]")
		.replace(/\b(access|refresh|id)[-_]?token[-_][A-Za-z0-9._-]+\b/gi, "[redacted]");
}

function callbackUrlPattern(): RegExp {
	return /http:\/\/localhost:145[57]\/auth\/callback(?:\?[^\s]*)?/g;
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

import { redactCredentialText } from "../settings/redaction";
import { OPENAI_CODEX_OAUTH } from "./config";

export interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt: string;
}

type TokenEndpointPayload = Record<string, unknown>;
interface TokenRedactionContext {
	sensitiveValues: readonly string[];
}

export async function exchangeCodeForTokens(input: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<TokenResponse> {
	validateRequiredInput(input.code, "OpenAI Codex OAuth code");
	validateRequiredInput(input.codeVerifier, "OpenAI Codex OAuth code verifier");
	validateSupportedRedirectUri(input.redirectUri);
	const redactionContext = createTokenRedactionContext([
		input.code,
		input.codeVerifier,
		input.redirectUri,
	]);
	const payload = await postTokenRequest({
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: OPENAI_CODEX_OAUTH.clientId,
			code: input.code,
			code_verifier: input.codeVerifier,
			redirect_uri: input.redirectUri,
		}),
		fetchImpl: input.fetchImpl,
		redactionContext,
	});
	return parseTokenResponse(payload, {
		requireRefreshToken: true,
		now: input.now,
		redactionContext,
	});
}

export async function refreshTokens(input: {
	refreshToken: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
}): Promise<TokenResponse> {
	validateRequiredInput(input.refreshToken, "OpenAI Codex OAuth refresh token");
	const redactionContext = createTokenRedactionContext([input.refreshToken]);
	const payload = await postTokenRequest({
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: OPENAI_CODEX_OAUTH.clientId,
			refresh_token: input.refreshToken,
		}),
		fetchImpl: input.fetchImpl,
		redactionContext,
	});
	return parseTokenResponse(payload, {
		requireRefreshToken: false,
		now: input.now,
		redactionContext,
	});
}

async function postTokenRequest(input: {
	body: URLSearchParams;
	fetchImpl?: typeof fetch;
	redactionContext: TokenRedactionContext;
}): Promise<TokenEndpointPayload> {
	const fetchImpl = input.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(OPENAI_CODEX_OAUTH.tokenUrl, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
			},
			body: input.body,
		});
	} catch (error) {
		throw new Error(
			`OpenAI Codex OAuth token request failed: ${redactTokenEndpointText(
				String(error),
				input.redactionContext,
			)}`,
		);
	}

	let responseText: string;
	try {
		responseText = await response.text();
	} catch (error) {
		throw new Error(
			`OpenAI Codex OAuth token request failed: ${redactTokenEndpointText(
				String(error),
				input.redactionContext,
			)}`,
		);
	}
	if (!response.ok) {
		throw new Error(
			`OpenAI Codex OAuth token request failed: ${redactTokenEndpointText(
				responseText || response.statusText,
				input.redactionContext,
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
				input.redactionContext,
			)}`,
		);
	}
}

function parseTokenResponse(
	payload: TokenEndpointPayload,
	options: {
		requireRefreshToken: boolean;
		now?: () => number;
		redactionContext: TokenRedactionContext;
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
				options.redactionContext,
			)}`,
		);
	}

	const expiresAt = buildExpiresAt((options.now ?? Date.now)(), expiresIn);
	if (expiresAt === undefined) {
		throw new Error(
			`OpenAI Codex OAuth token response is missing required fields: ${redactTokenEndpointText(
				JSON.stringify(payload),
				options.redactionContext,
			)}`,
		);
	}

	return {
		accessToken: parsedAccessToken,
		...(parsedRefreshToken !== undefined ? { refreshToken: parsedRefreshToken } : {}),
		...(parsedIdToken !== undefined ? { idToken: parsedIdToken } : {}),
		expiresAt,
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

function buildExpiresAt(now: number, expiresIn: number): string | undefined {
	const expiresAtMs = now + expiresIn * 1000;
	if (!Number.isFinite(expiresAtMs)) {
		return undefined;
	}
	try {
		return new Date(expiresAtMs).toISOString();
	} catch {
		return undefined;
	}
}

function createTokenRedactionContext(values: readonly string[]): TokenRedactionContext {
	return {
		sensitiveValues: values.map((value) => value.trim()).filter((value) => value !== ""),
	};
}

function validateRequiredInput(value: string, label: string): void {
	if (value.trim() === "") {
		throw new Error(`${label} is required`);
	}
}

function validateSupportedRedirectUri(value: string): void {
	if (
		value !== OPENAI_CODEX_OAUTH.primaryRedirectUri &&
		value !== OPENAI_CODEX_OAUTH.fallbackRedirectUri
	) {
		throw new Error("OpenAI Codex OAuth redirect URI is not supported");
	}
}

function redactTokenEndpointText(value: string, context: TokenRedactionContext): string {
	try {
		const payload = JSON.parse(value);
		return JSON.stringify(redactTokenEndpointPayload(payload, context));
	} catch {
		return redactTokenEndpointPlainText(value, context);
	}
}

function redactTokenEndpointPayload(payload: unknown, context: TokenRedactionContext): unknown {
	if (Array.isArray(payload)) {
		return payload.map((value) => redactTokenEndpointPayload(value, context));
	}
	if (payload !== null && typeof payload === "object") {
		const redacted: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(payload)) {
			redacted[key] = isSensitiveTokenEndpointKey(key)
				? "[redacted]"
				: redactTokenEndpointPayload(value, context);
		}
		return redacted;
	}
	if (typeof payload === "string") {
		if (isCallbackUrl(payload)) {
			return "[redacted]";
		}
		return redactTokenEndpointPlainText(payload, context);
	}
	return payload;
}

function isSensitiveTokenEndpointKey(key: string): boolean {
	const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
	return [
		"accesstoken",
		"refreshtoken",
		"idtoken",
		"token",
		"authorization",
		"authorizationcode",
		"auth",
		"codeverifier",
		"code",
		"state",
		"redirecturi",
	].includes(normalizedKey);
}

function redactTokenEndpointPlainText(value: string, context: TokenRedactionContext): string {
	return redactExactSensitiveValues(redactCredentialText(value), context)
		.replace(callbackUrlPattern(), "[redacted]")
		.replace(
			/\b(code|code_verifier|codeVerifier|code-verifier|authorization_code|authorizationCode|authorization-code)(\s*[:=]\s*)[^\s&]+/g,
			"$1$2[redacted]",
		)
		.replace(jwtPattern(), "[redacted]")
		.replace(opaqueTokenPattern(), "[redacted]")
		.replace(/\b(access|refresh|id)[-_]?token[-_][A-Za-z0-9._-]+\b/gi, "[redacted]");
}

function redactExactSensitiveValues(value: string, context: TokenRedactionContext): string {
	let redacted = value;
	for (const sensitiveValue of context.sensitiveValues) {
		redacted = redacted.split(sensitiveValue).join("[redacted]");
	}
	return redacted;
}

function callbackUrlPattern(): RegExp {
	return /http:\/\/localhost:145[57]\/auth\/callback(?:\?[^\s]*)?/g;
}

function jwtPattern(): RegExp {
	return /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
}

function opaqueTokenPattern(): RegExp {
	return /\b[A-Za-z0-9._-]*(?:[-_.]token|token[-_.])[A-Za-z0-9._-]*\b/gi;
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

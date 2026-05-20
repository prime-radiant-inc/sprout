export const OPENAI_CODEX_OAUTH = {
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	authorizeUrl: "https://auth.openai.com/oauth/authorize",
	tokenUrl: "https://auth.openai.com/oauth/token",
	primaryRedirectUri: "http://localhost:1455/auth/callback",
	fallbackRedirectUri: "http://localhost:1457/auth/callback",
	scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
} as const;

export function buildAuthorizeUrl(input: {
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): URL {
	const redirectUri = requireNonEmpty(input.redirectUri, "OpenAI Codex OAuth redirect URI");
	const state = requireNonEmpty(input.state, "OpenAI Codex OAuth state");
	const codeChallenge = requireNonEmpty(input.codeChallenge, "OpenAI Codex OAuth code challenge");

	validateSupportedRedirectUri(redirectUri);

	const url = new URL(OPENAI_CODEX_OAUTH.authorizeUrl);
	url.searchParams.set("client_id", OPENAI_CODEX_OAUTH.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", OPENAI_CODEX_OAUTH.scope);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", "pi");
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", codeChallenge);
	return url;
}

function requireNonEmpty(value: string, label: string): string {
	if (value.trim() === "") {
		throw new Error(`${label} is required`);
	}
	return value;
}

function validateSupportedRedirectUri(value: string): void {
	if (
		value !== OPENAI_CODEX_OAUTH.primaryRedirectUri &&
		value !== OPENAI_CODEX_OAUTH.fallbackRedirectUri
	) {
		throw new Error("OpenAI Codex OAuth redirect URI is not supported");
	}
}

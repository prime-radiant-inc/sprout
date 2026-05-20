import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl, OPENAI_CODEX_OAUTH } from "@/host/openai-codex-oauth/config";
import { createCodeChallenge, generatePkce } from "@/host/openai-codex-oauth/pkce";

describe("OpenAI Codex OAuth config", () => {
	test("builds the Pi-compatible Codex authorize URL", () => {
		const url = buildAuthorizeUrl({
			redirectUri: OPENAI_CODEX_OAUTH.primaryRedirectUri,
			state: "state-123",
			codeChallenge: "challenge-123",
		});

		expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
		expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(url.searchParams.get("originator")).toBe("pi");
		expect(url.searchParams.get("state")).toBe("state-123");
		expect(url.searchParams.get("code_challenge")).toBe("challenge-123");
	});

	test("declares primary and fallback callback URLs", () => {
		expect(OPENAI_CODEX_OAUTH.primaryRedirectUri).toBe("http://localhost:1455/auth/callback");
		expect(OPENAI_CODEX_OAUTH.fallbackRedirectUri).toBe("http://localhost:1457/auth/callback");
		expect(OPENAI_CODEX_OAUTH.tokenUrl).toBe("https://auth.openai.com/oauth/token");
	});

	test("rejects malformed authorize URL inputs", () => {
		expect(() =>
			buildAuthorizeUrl({
				redirectUri: "",
				state: "state-123",
				codeChallenge: "challenge-123",
			}),
		).toThrow("OpenAI Codex OAuth redirect URI is required");
		expect(() =>
			buildAuthorizeUrl({
				redirectUri: OPENAI_CODEX_OAUTH.primaryRedirectUri,
				state: "",
				codeChallenge: "challenge-123",
			}),
		).toThrow("OpenAI Codex OAuth state is required");
		expect(() =>
			buildAuthorizeUrl({
				redirectUri: OPENAI_CODEX_OAUTH.primaryRedirectUri,
				state: "state-123",
				codeChallenge: "",
			}),
		).toThrow("OpenAI Codex OAuth code challenge is required");
	});
});

describe("OpenAI Codex OAuth PKCE", () => {
	test("creates an S256 code challenge from a known verifier", async () => {
		await expect(createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	test("generates a 64-byte base64url verifier and matching challenge", async () => {
		let requestedLength = 0;
		const pkce = await generatePkce({
			getRandomValues(bytes) {
				requestedLength = bytes.length;
				for (let index = 0; index < bytes.length; index += 1) {
					bytes[index] = index;
				}
				return bytes;
			},
		});

		expect(requestedLength).toBe(64);
		expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(pkce.codeVerifier).not.toContain("=");
		expect(pkce.codeVerifier).toHaveLength(86);
		await expect(createCodeChallenge(pkce.codeVerifier)).resolves.toBe(pkce.codeChallenge);
	});
});

import { describe, expect, test } from "bun:test";
import {
	exchangeCodeForTokens,
	refreshTokens,
	type TokenResponse,
} from "@/host/openai-codex-oauth/tokens";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
		...init,
	});
}

function fetchWithBodyAssertion(
	assertBody: (body: URLSearchParams, init: RequestInit) => void,
	responseBody: unknown,
): typeof fetch {
	return ((url: string | URL | Request, init?: RequestInit) => {
		const requestInit = init ?? {};
		expect(String(url)).toBe("https://auth.openai.com/oauth/token");
		expect(requestInit.method).toBe("POST");
		expect(requestInit.headers).toEqual({
			"content-type": "application/x-www-form-urlencoded",
		});
		expect(requestInit.body).toBeInstanceOf(URLSearchParams);
		assertBody(requestInit.body as URLSearchParams, requestInit);
		return Promise.resolve(jsonResponse(responseBody));
	}) as typeof fetch;
}

const fetchMustNotBeCalled = (() => {
	throw new Error("fetch should not be called");
}) as unknown as typeof fetch;

describe("OpenAI Codex OAuth token helpers", () => {
	test("exchanges an auth code using a form-encoded POST body", async () => {
		const tokens = await exchangeCodeForTokens({
			code: "auth-code-secret",
			codeVerifier: "verifier-secret",
			redirectUri: "http://localhost:1455/auth/callback",
			now: () => Date.parse("2026-05-20T10:00:00.000Z"),
			fetchImpl: fetchWithBodyAssertion(
				(body) => {
					expect(body.get("grant_type")).toBe("authorization_code");
					expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
					expect(body.get("code")).toBe("auth-code-secret");
					expect(body.get("code_verifier")).toBe("verifier-secret");
					expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
				},
				{
					access_token: "access-token-secret",
					refresh_token: "refresh-token-secret",
					id_token: "id-token-secret",
					expires_in: 3600,
				},
			),
		});

		expect(tokens).toEqual({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			idToken: "id-token-secret",
			expiresAt: "2026-05-20T11:00:00.000Z",
		} satisfies TokenResponse);
	});

	test("refreshes tokens and allows missing rotated refresh token", async () => {
		const tokens = await refreshTokens({
			refreshToken: "refresh-token-secret",
			now: () => Date.parse("2026-05-20T10:00:00.000Z"),
			fetchImpl: fetchWithBodyAssertion(
				(body) => {
					expect(body.get("grant_type")).toBe("refresh_token");
					expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
					expect(body.get("refresh_token")).toBe("refresh-token-secret");
				},
				{
					access_token: "rotated-access-token-secret",
					expires_in: 1800,
				},
			),
		});

		expect(tokens).toEqual({
			accessToken: "rotated-access-token-secret",
			expiresAt: "2026-05-20T10:30:00.000Z",
		} satisfies TokenResponse);
	});

	test("redacts sensitive response details from token endpoint errors", async () => {
		let error: unknown;
		try {
			await exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: (() =>
					Promise.resolve(
						new Response(
							JSON.stringify({
								error: "invalid_grant",
								access_token: "access-token-secret",
								refreshToken: "refresh-token-secret",
								code_verifier: "verifier-secret",
								codeVerifier: "camel-verifier-secret",
								redirect_uri:
									"http://localhost:1455/auth/callback?code=callback-secret&state=state-secret",
								redirectUri: "http://localhost:1457/auth/callback",
								detail: "backend access-token-secret refresh-token-secret",
								echo: "echo auth-code-secret and verifier-secret",
								jwtDetail: "backend aaa.bbb.ccc",
								opaqueDetail: "backend-token-value",
								token: "backend-token-secret",
								Authorization: "Bearer backend-authorization-secret",
								Token: "mixed-case-secret",
								ACCESS_TOKEN: "upper-access-secret",
								"refresh-token": "kebab-refresh-secret",
								AUTHORIZATION: "upper-authorization-secret",
								authorization_code: "snake-authorization-code-secret",
								authorizationCode: "camel-authorization-code-secret",
								"authorization-code": "kebab-authorization-code-secret",
							}),
							{ status: 400 },
						),
					)) as unknown as typeof fetch,
			});
		} catch (caughtError) {
			error = caughtError;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain('"access_token":"[redacted]"');
		expect(message).toContain('"refreshToken":"[redacted]"');
		expect(message).toContain('"code_verifier":"[redacted]"');
		expect(message).toContain('"codeVerifier":"[redacted]"');
		expect(message).toContain('"redirect_uri":"[redacted]"');
		expect(message).toContain('"redirectUri":"[redacted]"');
		expect(message).toContain('"token":"[redacted]"');
		expect(message).toContain('"Authorization":"[redacted]"');
		expect(message).toContain('"Token":"[redacted]"');
		expect(message).toContain('"ACCESS_TOKEN":"[redacted]"');
		expect(message).toContain('"refresh-token":"[redacted]"');
		expect(message).toContain('"AUTHORIZATION":"[redacted]"');
		expect(message).toContain('"authorization_code":"[redacted]"');
		expect(message).toContain('"authorizationCode":"[redacted]"');
		expect(message).toContain('"authorization-code":"[redacted]"');
		expect(message).not.toContain("access-token-secret");
		expect(message).not.toContain("refresh-token-secret");
		expect(message).not.toContain("backend-token-secret");
		expect(message).not.toContain("backend-token-value");
		expect(message).not.toContain("backend-authorization-secret");
		expect(message).not.toContain("mixed-case-secret");
		expect(message).not.toContain("upper-access-secret");
		expect(message).not.toContain("kebab-refresh-secret");
		expect(message).not.toContain("upper-authorization-secret");
		expect(message).not.toContain("snake-authorization-code-secret");
		expect(message).not.toContain("camel-authorization-code-secret");
		expect(message).not.toContain("kebab-authorization-code-secret");
		expect(message).not.toContain("auth-code-secret");
		expect(message).not.toContain("verifier-secret");
		expect(message).not.toContain("camel-verifier-secret");
		expect(message).not.toContain("aaa.bbb.ccc");
		expect(message).not.toContain("http://localhost:1455/auth/callback");
		expect(message).not.toContain("http://localhost:1457/auth/callback");
	});

	test("redacts non-JSON token endpoint errors", async () => {
		let error: unknown;
		try {
			await exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: (() =>
					Promise.resolve(
						new Response(
							[
								"invalid request",
								"code=plain-code-secret",
								"code: colon-code-secret",
								"code_verifier=plain-verifier-secret",
								"code_verifier: colon-verifier-secret",
								"codeVerifier: camel-colon-verifier-secret",
								"authorization_code=snake-authorization-secret",
								"authorizationCode: camel-authorization-secret",
								"authorization-code=hyphen-authorization-secret",
								"code-verifier: hyphen-verifier-secret",
								"grant_type=authorization_code",
								"access-token-secret",
								"refresh-token-secret",
								"aaa.bbb.ccc",
								"backend-token-value",
								"http://localhost:1455/auth/callback?code=callback-secret",
								"http://localhost:1457/auth/callback",
							].join(" "),
							{ status: 400 },
						),
					)) as unknown as typeof fetch,
			});
		} catch (caughtError) {
			error = caughtError;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("[redacted]");
		expect(message).not.toContain("plain-code-secret");
		expect(message).not.toContain("colon-code-secret");
		expect(message).not.toContain("plain-verifier-secret");
		expect(message).not.toContain("colon-verifier-secret");
		expect(message).not.toContain("camel-colon-verifier-secret");
		expect(message).not.toContain("snake-authorization-secret");
		expect(message).not.toContain("camel-authorization-secret");
		expect(message).not.toContain("hyphen-authorization-secret");
		expect(message).not.toContain("hyphen-verifier-secret");
		expect(message).toContain("grant_type=authorization_code");
		expect(message).not.toContain("access-token-secret");
		expect(message).not.toContain("refresh-token-secret");
		expect(message).not.toContain("aaa.bbb.ccc");
		expect(message).not.toContain("backend-token-value");
		expect(message).not.toContain("http://localhost:1455/auth/callback");
		expect(message).not.toContain("http://localhost:1457/auth/callback");
	});

	test("rejects malformed token request inputs before fetch", async () => {
		await expect(
			exchangeCodeForTokens({
				code: "",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: fetchMustNotBeCalled,
			}),
		).rejects.toThrow("OpenAI Codex OAuth code is required");
		await expect(
			exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "  ",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: fetchMustNotBeCalled,
			}),
		).rejects.toThrow("OpenAI Codex OAuth code verifier is required");
		await expect(
			exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "https://example.com/auth/callback",
				fetchImpl: fetchMustNotBeCalled,
			}),
		).rejects.toThrow("OpenAI Codex OAuth redirect URI is not supported");
		await expect(
			refreshTokens({
				refreshToken: "",
				fetchImpl: fetchMustNotBeCalled,
			}),
		).rejects.toThrow("OpenAI Codex OAuth refresh token is required");
	});

	test("redacts fetch errors with form-body-like secrets", async () => {
		let error: unknown;
		try {
			await exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: (() =>
					Promise.reject(
						new Error(
							"failed auth-code-secret verifier-secret code=plain-code-secret code: colon-code-secret code_verifier=plain-verifier-secret code_verifier: colon-verifier-secret codeVerifier: camel-colon-verifier-secret access-token-secret refresh-token-secret http://localhost:1455/auth/callback",
						),
					)) as unknown as typeof fetch,
			});
		} catch (caughtError) {
			error = caughtError;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("[redacted]");
		expect(message).not.toContain("auth-code-secret");
		expect(message).not.toContain("verifier-secret");
		expect(message).not.toContain("plain-code-secret");
		expect(message).not.toContain("colon-code-secret");
		expect(message).not.toContain("plain-verifier-secret");
		expect(message).not.toContain("colon-verifier-secret");
		expect(message).not.toContain("camel-colon-verifier-secret");
		expect(message).not.toContain("access-token-secret");
		expect(message).not.toContain("refresh-token-secret");
		expect(message).not.toContain("http://localhost:1455/auth/callback");
	});

	test("wraps and redacts response body read failures", async () => {
		let error: unknown;
		try {
			await exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: (() =>
					Promise.resolve({
						ok: false,
						statusText: "Bad Request",
						text: () => Promise.reject(new Error("read failed access-token-secret")),
					} as Response)) as unknown as typeof fetch,
			});
		} catch (caughtError) {
			error = caughtError;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("OpenAI Codex OAuth token request failed:");
		expect(message).toContain("[redacted]");
		expect(message).not.toContain("access-token-secret");
	});

	test("redacts refresh request secrets echoed under arbitrary JSON keys", async () => {
		let error: unknown;
		try {
			await refreshTokens({
				refreshToken: "refresh-request-secret",
				fetchImpl: (() =>
					Promise.resolve(
						new Response(
							JSON.stringify({
								error: "invalid_grant",
								detail: "echo refresh-request-secret",
							}),
							{ status: 400 },
						),
					)) as unknown as typeof fetch,
			});
		} catch (caughtError) {
			error = caughtError;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("[redacted]");
		expect(message).not.toContain("refresh-request-secret");
	});

	test("redacts missing-field payloads", async () => {
		let error: unknown;
		try {
			await exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: fetchWithBodyAssertion(() => {}, {
					access_token: "access-token-secret",
					refreshToken: "refresh-token-secret",
					redirect_uri: "http://localhost:1455/auth/callback",
					expires_in: "3600",
				}),
			});
		} catch (caughtError) {
			error = caughtError;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain('"access_token":"[redacted]"');
		expect(message).toContain('"refreshToken":"[redacted]"');
		expect(message).toContain('"redirect_uri":"[redacted]"');
		expect(message).toContain('"expires_in":"3600"');
		expect(message).not.toContain("access-token-secret");
		expect(message).not.toContain("refresh-token-secret");
		expect(message).not.toContain("http://localhost:1455/auth/callback");
	});

	test("rejects empty tokens and non-positive expirations", async () => {
		for (const responseBody of [
			{
				access_token: "",
				refresh_token: "refresh-token-secret",
				expires_in: 3600,
			},
			{
				access_token: "access-token-secret",
				refresh_token: "   ",
				expires_in: 3600,
			},
			{
				access_token: "access-token-secret",
				refresh_token: "refresh-token-secret",
				id_token: "",
				expires_in: 3600,
			},
			{
				access_token: "access-token-secret",
				refresh_token: "refresh-token-secret",
				expires_in: 0,
			},
			{
				access_token: "access-token-secret",
				refresh_token: "refresh-token-secret",
				expires_in: -1,
			},
		]) {
			let error: unknown;
			try {
				await exchangeCodeForTokens({
					code: "auth-code-secret",
					codeVerifier: "verifier-secret",
					redirectUri: "http://localhost:1455/auth/callback",
					fetchImpl: fetchWithBodyAssertion(() => {}, responseBody),
				});
			} catch (caughtError) {
				error = caughtError;
			}

			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("[redacted]");
			expect(message).not.toContain("access-token-secret");
			expect(message).not.toContain("refresh-token-secret");
		}
	});

	test("rejects invalid token expiration dates", async () => {
		await expect(
			exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				now: () => Number.POSITIVE_INFINITY,
				fetchImpl: fetchWithBodyAssertion(() => {}, {
					access_token: "access-token-secret",
					refresh_token: "refresh-token-secret",
					expires_in: 3600,
				}),
			}),
		).rejects.toThrow("OpenAI Codex OAuth token response is missing required fields");
		await expect(
			exchangeCodeForTokens({
				code: "auth-code-secret",
				codeVerifier: "verifier-secret",
				redirectUri: "http://localhost:1455/auth/callback",
				fetchImpl: fetchWithBodyAssertion(() => {}, {
					access_token: "access-token-secret",
					refresh_token: "refresh-token-secret",
					expires_in: Number.MAX_VALUE,
				}),
			}),
		).rejects.toThrow("OpenAI Codex OAuth token response is missing required fields");
	});
});

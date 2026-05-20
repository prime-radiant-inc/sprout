import { afterEach, describe, expect, test } from "bun:test";
import {
	type CallbackValidationResult,
	createCallbackListenerForTests,
	getCallbackRedirectUriForPort,
	listenForCallback,
	parseManualPasteback,
	validateCallbackRequest,
} from "@/host/openai-codex-oauth/callback-server";
import { OPENAI_CODEX_OAUTH } from "@/host/openai-codex-oauth/config";

const activeListeners: Array<{ stop: () => void }> = [];

afterEach(() => {
	for (const listener of activeListeners.splice(0)) {
		listener.stop();
	}
});

describe("OpenAI Codex OAuth callback validation", () => {
	test("accepts only matching GET callback path and state", () => {
		expect(
			validateCallbackRequest(new Request("http://localhost:1455/auth/callback?code=c&state=s"), {
				expectedState: "s",
			}),
		).toEqual({ ok: true, code: "c" } satisfies CallbackValidationResult);
		expect(
			validateCallbackRequest(new Request("http://localhost:1455/wrong?code=c&state=s"), {
				expectedState: "s",
			}).ok,
		).toBe(false);
	});

	test("rejects malformed callback requests without leaking code or state", () => {
		const cases = [
			new Request("http://localhost:1455/auth/callback?code=secret-code&state=state-secret", {
				method: "POST",
			}),
			new Request("http://localhost:1455/wrong?code=secret-code&state=state-secret"),
			new Request("http://localhost:1455/auth/callback?state=state-secret"),
			new Request("http://localhost:1455/auth/callback?code=secret-code"),
			new Request("http://localhost:1455/auth/callback?code=secret-code&state=wrong-state"),
			new Request(
				"http://localhost:1455/auth/callback?error=access_denied&error_description=secret-code&state=state-secret",
			),
		];

		for (const request of cases) {
			const result = validateCallbackRequest(request, { expectedState: "state-secret" });

			expect(result.ok).toBe(false);
			expect(result.error).not.toContain("secret-code");
			expect(result.error).not.toContain("state-secret");
			expect(result.error).not.toContain("wrong-state");
		}
	});
});

describe("OpenAI Codex OAuth manual pasteback parsing", () => {
	test("parses full callback pasteback with state validation", () => {
		expect(
			parseManualPasteback({
				input: "http://localhost:1455/auth/callback?code=c&state=s",
				expectedState: "s",
			}),
		).toEqual({ ok: true, code: "c" } satisfies CallbackValidationResult);
	});

	test("accepts raw code only with matching returned state", () => {
		expect(parseManualPasteback({ input: "c", returnedState: "s", expectedState: "s" })).toEqual({
			ok: true,
			code: "c",
		} satisfies CallbackValidationResult);
		expect(parseManualPasteback({ input: "c", expectedState: "s" }).ok).toBe(false);
		expect(
			parseManualPasteback({ input: "c", returnedState: "wrong", expectedState: "s" }).ok,
		).toBe(false);
	});

	test("rejects callback URLs outside the supported redirect targets", () => {
		const rejected = [
			"https://example.com/auth/callback?code=c&state=s",
			"http://localhost:1455/wrong?code=c&state=s",
			"http://localhost:9999/auth/callback?code=c&state=s",
			"http://127.0.0.1:1455/auth/callback?code=c&state=s",
		];

		for (const input of rejected) {
			expect(parseManualPasteback({ input, expectedState: "s" }).ok).toBe(false);
		}
	});
});

describe("OpenAI Codex OAuth callback redirect mapping", () => {
	test("maps only registered localhost ports to production redirect URIs", () => {
		expect(getCallbackRedirectUriForPort(1455)).toBe(OPENAI_CODEX_OAUTH.primaryRedirectUri);
		expect(getCallbackRedirectUriForPort(1457)).toBe(OPENAI_CODEX_OAUTH.fallbackRedirectUri);
		expect(() => getCallbackRedirectUriForPort(0)).toThrow(
			"OpenAI Codex OAuth callback listener must use registered redirect URIs",
		);
		expect(() => getCallbackRedirectUriForPort(9999)).toThrow(
			"OpenAI Codex OAuth callback listener must use registered redirect URIs",
		);
	});
});

describe("OpenAI Codex OAuth callback listener", () => {
	test("rejects custom listener bindings unless explicitly allowed for tests", async () => {
		await expect(
			listenForCallback({
				expectedState: "state-123",
				ports: [0],
				timeoutMs: 1_000,
			} as unknown as Parameters<typeof listenForCallback>[0]),
		).rejects.toThrow("OpenAI Codex OAuth callback listener must use registered redirect URIs");
		await expect(
			listenForCallback({
				expectedState: "state-123",
				hostname: "127.0.0.1",
				ports: [1455],
				timeoutMs: 1_000,
			} as unknown as Parameters<typeof listenForCallback>[0]),
		).rejects.toThrow("OpenAI Codex OAuth callback listener must use registered redirect URIs");
		await expect(
			listenForCallback({
				expectedState: "state-123",
				ports: [1457],
				timeoutMs: 1_000,
			} as unknown as Parameters<typeof listenForCallback>[0]),
		).rejects.toThrow("OpenAI Codex OAuth callback listener must use registered redirect URIs");
		await expect(
			listenForCallback({
				expectedState: "state-123",
				ports: [9999],
				timeoutMs: 1_000,
			} as unknown as Parameters<typeof listenForCallback>[0]),
		).rejects.toThrow("OpenAI Codex OAuth callback listener must use registered redirect URIs");
	});

	test("rejects test-only custom bindings that look like production redirects", async () => {
		await expect(
			listenForCallback({
				expectedState: "state-123",
				hostname: "localhost",
				ports: [1455],
				timeoutMs: 1_000,
				allowUnregisteredRedirectUriForTests: true,
			}),
		).rejects.toThrow(
			"OpenAI Codex OAuth test callback listener cannot use registered redirect URIs",
		);
		await expect(
			listenForCallback({
				expectedState: "state-123",
				hostname: "localhost",
				ports: [1457],
				timeoutMs: 1_000,
				allowUnregisteredRedirectUriForTests: true,
			}),
		).rejects.toThrow(
			"OpenAI Codex OAuth test callback listener cannot use registered redirect URIs",
		);
	});

	test("falls back when the primary registered redirect does not reach this listener", async () => {
		const stoppedPorts: number[] = [];
		const probedUris: string[] = [];
		const listener = await createCallbackListenerForTests(
			{ expectedState: "state-123", timeoutMs: 1_000 },
			{
				bindServer({ port }) {
					return {
						port,
						stop: () => stoppedPorts.push(port),
					};
				},
				probeProductionRedirect: async ({ redirectUri }) => {
					probedUris.push(redirectUri);
					return redirectUri === OPENAI_CODEX_OAUTH.fallbackRedirectUri;
				},
			},
		);
		activeListeners.push(listener);

		expect(listener.redirectUri).toBe(OPENAI_CODEX_OAUTH.fallbackRedirectUri);
		expect(probedUris).toEqual([
			OPENAI_CODEX_OAUTH.primaryRedirectUri,
			OPENAI_CODEX_OAUTH.fallbackRedirectUri,
		]);
		expect(stoppedPorts).toEqual([1455]);
	});

	test("resolves once after a successful loopback callback and can be stopped again", async () => {
		const listener = await listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1_000,
			allowUnregisteredRedirectUriForTests: true,
		});
		activeListeners.push(listener);

		const response = await fetch(`${listener.redirectUri}?code=code-123&state=state-123`);
		const result = await listener.result;

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("OpenAI Codex authentication complete");
		expect(result).toEqual({ ok: true, code: "code-123" } satisfies CallbackValidationResult);
		expect(() => listener.stop()).not.toThrow();
	});

	test("does not let a second callback alter the first successful result", async () => {
		const listener = await listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1_000,
			allowUnregisteredRedirectUriForTests: true,
		});
		activeListeners.push(listener);

		const response = await fetch(`${listener.redirectUri}?code=first-code&state=state-123`);
		const result = await listener.result;

		expect(response.status).toBe(200);
		expect(result).toEqual({ ok: true, code: "first-code" } satisfies CallbackValidationResult);
		try {
			await fetch(`${listener.redirectUri}?code=second-code&state=state-123`);
		} catch {
			// The listener may already be stopped; the resolved result is the regression target.
		}
		await Bun.sleep(1);
		expect(await listener.result).toEqual({
			ok: true,
			code: "first-code",
		} satisfies CallbackValidationResult);
	});

	test("uses explicit test-only escape hatch for unregistered fallback ports", async () => {
		const occupied = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("occupied"),
		});
		try {
			const occupiedPort = occupied.port;
			if (occupiedPort === undefined) {
				throw new Error("occupied test server did not bind a port");
			}
			const listener = await listenForCallback({
				expectedState: "state-123",
				hostname: "127.0.0.1",
				ports: [occupiedPort, 0],
				timeoutMs: 1_000,
				allowUnregisteredRedirectUriForTests: true,
			});
			activeListeners.push(listener);

			expect(new URL(listener.redirectUri).port).not.toBe(String(occupiedPort));
		} finally {
			occupied.stop(true);
		}
	});

	test("cleans up on timeout", async () => {
		const listener = await listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1,
			allowUnregisteredRedirectUriForTests: true,
		});
		activeListeners.push(listener);

		await expect(listener.result).resolves.toMatchObject({
			ok: false,
			error: "OpenAI Codex OAuth callback timed out",
		} satisfies CallbackValidationResult);
	});

	test("cleans up on cancel", async () => {
		const listener = await listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1_000,
			allowUnregisteredRedirectUriForTests: true,
		});
		activeListeners.push(listener);

		listener.stop();

		await expect(listener.result).resolves.toMatchObject({
			ok: false,
			error: "OpenAI Codex OAuth callback listener was stopped",
		} satisfies CallbackValidationResult);
	});
});

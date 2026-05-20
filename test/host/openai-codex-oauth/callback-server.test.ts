import { afterEach, describe, expect, test } from "bun:test";
import {
	type CallbackValidationResult,
	listenForCallback,
	parseManualPasteback,
	validateCallbackRequest,
} from "@/host/openai-codex-oauth/callback-server";

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

describe("OpenAI Codex OAuth callback listener", () => {
	test("resolves once after a successful loopback callback and can be stopped again", async () => {
		const listener = listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1_000,
		});
		activeListeners.push(listener);

		const response = await fetch(`${listener.redirectUri}?code=code-123&state=state-123`);
		const result = await listener.result;

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("OpenAI Codex authentication complete");
		expect(result).toEqual({ ok: true, code: "code-123" } satisfies CallbackValidationResult);
		expect(() => listener.stop()).not.toThrow();
	});

	test("falls back when the first configured port is unavailable", () => {
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
			const listener = listenForCallback({
				expectedState: "state-123",
				hostname: "127.0.0.1",
				ports: [occupiedPort, 0],
				timeoutMs: 1_000,
			});
			activeListeners.push(listener);

			expect(new URL(listener.redirectUri).port).not.toBe(String(occupiedPort));
		} finally {
			occupied.stop(true);
		}
	});

	test("cleans up on timeout", async () => {
		const listener = listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1,
		});
		activeListeners.push(listener);

		await expect(listener.result).resolves.toMatchObject({
			ok: false,
			error: "OpenAI Codex OAuth callback timed out",
		} satisfies CallbackValidationResult);
	});

	test("cleans up on cancel", async () => {
		const listener = listenForCallback({
			expectedState: "state-123",
			ports: [0],
			timeoutMs: 1_000,
		});
		activeListeners.push(listener);

		listener.stop();

		await expect(listener.result).resolves.toMatchObject({
			ok: false,
			error: "OpenAI Codex OAuth callback listener was stopped",
		} satisfies CallbackValidationResult);
	});
});

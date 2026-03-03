import { describe, expect, test } from "bun:test";
import { retryLLMCall } from "../../src/llm/retry.ts";
import type { Response } from "../../src/llm/types.ts";

const dummyResponse: Response = {
	id: "test",
	model: "test",
	provider: "test",
	message: { role: "assistant", content: [] },
	finish_reason: { reason: "stop" },
	usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

describe("retryLLMCall", () => {
	test("returns result on first success", async () => {
		let calls = 0;
		const result = await retryLLMCall(async () => {
			calls++;
			return dummyResponse;
		});

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(1);
	});

	test("retries on transient error and succeeds", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Connection reset");
					(err as any).status = 500;
					throw err;
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("retries on timeout error", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Request timed out");
					err.name = "APIConnectionTimeoutError";
					throw err;
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("retries on rate limit (429)", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Rate limited");
					(err as any).status = 429;
					throw err;
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("does not retry on non-retryable error (401)", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Unauthorized");
					(err as any).status = 401;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect(caughtError).toBeDefined();
		expect((caughtError as Error).message).toBe("Unauthorized");
	});

	test("does not retry on non-retryable error (400)", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Bad request");
					(err as any).status = 400;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect(caughtError).toBeDefined();
	});

	test("throws after exhausting retries", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Server error");
					(err as any).status = 500;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(3); // 1 initial + 2 retries
		expect(caughtError).toBeDefined();
		expect((caughtError as Error).message).toBe("Server error");
	});

	test("calls onRetry callback before each retry", async () => {
		let calls = 0;
		const retryLog: { attempt: number; error: Error; delayMs: number }[] = [];

		await retryLLMCall(
			async () => {
				calls++;
				if (calls <= 2) {
					const err = new Error(`Fail ${calls}`);
					(err as any).status = 500;
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 3,
				baseDelayMs: 10,
				onRetry: (error, attempt, delayMs) => {
					retryLog.push({ attempt, error, delayMs });
				},
			},
		);

		expect(retryLog).toHaveLength(2);
		expect(retryLog[0]!.attempt).toBe(1);
		expect(retryLog[0]!.error.message).toBe("Fail 1");
		expect(retryLog[1]!.attempt).toBe(2);
		expect(retryLog[1]!.error.message).toBe("Fail 2");
	});

	test("respects abort signal during retry delay", async () => {
		const controller = new AbortController();
		let calls = 0;
		let caughtError: unknown;

		// Abort after a short delay
		setTimeout(() => controller.abort(), 50);

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Server error");
					(err as any).status = 500;
					throw err;
				},
				{
					maxRetries: 5,
					baseDelayMs: 200, // Long delay to ensure abort fires during it
					signal: controller.signal,
				},
			);
		} catch (err) {
			caughtError = err;
		}

		// Should have attempted at most 2 calls (initial + maybe one retry before abort)
		expect(calls).toBeLessThanOrEqual(2);
		expect(caughtError).toBeDefined();
	});

	test("retries errors without status code (network errors)", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					throw new Error("ECONNRESET");
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("does not retry AbortError", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					throw new DOMException("Aborted", "AbortError");
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect(caughtError).toBeInstanceOf(DOMException);
	});

	test("applies exponential backoff", async () => {
		const delays: number[] = [];
		let calls = 0;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("fail");
					(err as any).status = 500;
					throw err;
				},
				{
					maxRetries: 3,
					baseDelayMs: 100,
					jitter: false, // Disable jitter for predictable delay testing
					onRetry: (_error, _attempt, delayMs) => {
						delays.push(delayMs);
					},
				},
			);
		} catch {
			// Expected
		}

		expect(delays).toHaveLength(3);
		// baseDelay * 2^0, baseDelay * 2^1, baseDelay * 2^2
		expect(delays[0]).toBe(100);
		expect(delays[1]).toBe(200);
		expect(delays[2]).toBe(400);
	});
});

import { describe, expect, test } from "bun:test";
import { retryLLMCall } from "../../src/llm/retry.ts";
import { StreamReadTimeoutError } from "../../src/llm/stream-timeout.ts";

const dummyResponse = {
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

	test("respects abort signal during retry delay and throws AbortError", async () => {
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
		expect(caughtError).toBeInstanceOf(DOMException);
		expect((caughtError as DOMException).name).toBe("AbortError");
	});

	test("abort when signal already aborted throws AbortError, not original error", async () => {
		const controller = new AbortController();
		controller.abort();
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					const err = new Error("Server error");
					(err as any).status = 500;
					throw err;
				},
				{
					maxRetries: 5,
					baseDelayMs: 10,
					signal: controller.signal,
				},
			);
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(DOMException);
		expect((caughtError as DOMException).name).toBe("AbortError");
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

	test("caps delays at maxDelayMs", async () => {
		const delays: number[] = [];

		try {
			await retryLLMCall(
				async () => {
					const err = new Error("fail");
					(err as any).status = 500;
					throw err;
				},
				{
					maxRetries: 3,
					baseDelayMs: 100,
					maxDelayMs: 150,
					jitter: false,
					onRetry: (_error, _attempt, delayMs) => {
						delays.push(delayMs);
					},
				},
			);
		} catch {
			// Expected
		}

		expect(delays).toHaveLength(3);
		// 100, min(200,150)=150, min(400,150)=150
		expect(delays[0]).toBe(100);
		expect(delays[1]).toBe(150);
		expect(delays[2]).toBe(150);
	});

	test("error with retryable: false and no status code is not retried", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Non-retryable");
					(err as any).retryable = false;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect((caughtError as Error).message).toBe("Non-retryable");
	});

	test("error with retryable: true overrides non-retryable status code", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Bad request but retryable");
					(err as any).status = 400;
					(err as any).retryable = true;
					throw err;
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("does not retry on 413 (ContextLengthError)", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Context too long");
					(err as any).status = 413;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect((caughtError as Error).message).toBe("Context too long");
	});

	test("does not retry on 422 (InvalidRequestError)", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Invalid request");
					(err as any).status = 422;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect((caughtError as Error).message).toBe("Invalid request");
	});

	test("uses retry_after delay instead of computed backoff", async () => {
		const delays: number[] = [];
		let calls = 0;

		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Rate limited");
					(err as any).status = 429;
					(err as any).retry_after = 2; // 2 seconds
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 2,
				baseDelayMs: 100,
				maxDelayMs: 60_000,
				jitter: false,
				onRetry: (_error, _attempt, delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
		expect(delays).toHaveLength(1);
		expect(delays[0]).toBe(2000); // retry_after * 1000
	});

	test("throws immediately when retry_after exceeds maxDelayMs", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Rate limited");
					(err as any).status = 429;
					(err as any).retry_after = 120; // 120 seconds
					throw err;
				},
				{
					maxRetries: 3,
					baseDelayMs: 100,
					maxDelayMs: 60_000,
				},
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect((caughtError as Error).message).toBe("Rate limited");
	});

	test("jitter keeps delays within [baseDelay*0.5, baseDelay*1.5)", async () => {
		// Use a small baseDelay to keep the test fast. The jitter formula is
		// delay * (0.5 + Math.random()), so for baseDelay=10 on attempt 1
		// (multiplier 2^0 = 1), delays should be in [5, 15).
		const delays: number[] = [];

		for (let i = 0; i < 100; i++) {
			let calls = 0;
			await retryLLMCall(
				async () => {
					calls++;
					if (calls === 1) {
						const err = new Error("fail");
						(err as any).status = 500;
						throw err;
					}
					return dummyResponse;
				},
				{
					maxRetries: 1,
					baseDelayMs: 10,
					jitter: true,
					onRetry: (_error, _attempt, delayMs) => {
						delays.push(delayMs);
					},
				},
			);
		}

		expect(delays).toHaveLength(100);
		for (const delay of delays) {
			// baseDelay=10, attempt 1: delay = 10 * (0.5 + rand) => [5, 15)
			expect(delay).toBeGreaterThanOrEqual(5);
			expect(delay).toBeLessThan(15);
		}
	});

	test("maxRetries=0 calls fn once and throws on failure without retrying", async () => {
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
				{ maxRetries: 0, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect(caughtError).toBeDefined();
		expect((caughtError as Error).message).toBe("Server error");
	});

	test("retries StreamReadTimeoutError (retryable=true)", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					throw new StreamReadTimeoutError(30_000);
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("does not retry on 402 (Payment Required)", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					const err = new Error("Payment required");
					(err as any).status = 402;
					throw err;
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		expect(calls).toBe(1);
		expect((caughtError as Error).message).toBe("Payment required");
	});
});

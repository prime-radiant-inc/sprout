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

		try {
			await retryLLMCall(
				async () => {
					const err = new Error("fail");
					(err as any).status = 500;
					throw err;
				},
				{
					maxRetries: 3,
					baseDelayMs: 5,
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
		expect(delays[0]).toBe(5);
		expect(delays[1]).toBe(10);
		expect(delays[2]).toBe(20);
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
					baseDelayMs: 5,
					maxDelayMs: 8,
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
		// 5, min(10,8)=8, min(20,8)=8
		expect(delays[0]).toBe(5);
		expect(delays[1]).toBe(8);
		expect(delays[2]).toBe(8);
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
					(err as any).retry_after = 0.02; // 20ms
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 2,
				baseDelayMs: 5,
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
		expect(delays[0]).toBe(20); // retry_after * 1000
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
		// delay * (0.5 + Math.random()), so for baseDelay=2 on attempt 1
		// (multiplier 2^0 = 1), delays should be in [1, 3).
		const delays: number[] = [];

		for (let i = 0; i < 25; i++) {
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
					baseDelayMs: 2,
					jitter: true,
					onRetry: (_error, _attempt, delayMs) => {
						delays.push(delayMs);
					},
				},
			);
		}

		expect(delays).toHaveLength(25);
		for (const delay of delays) {
			// baseDelay=2, attempt 1: delay = 2 * (0.5 + rand) => [1, 3)
			expect(delay).toBeGreaterThanOrEqual(1);
			expect(delay).toBeLessThan(3);
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

	test("preserves status/retryable/retry_after properties on non-Error throws", async () => {
		let calls = 0;
		let caughtError: unknown;

		try {
			await retryLLMCall(
				async () => {
					calls++;
					// Throw a non-Error object with relevant properties
					throw { message: "weird error", status: 401, retryable: false, retry_after: 5 };
				},
				{ maxRetries: 2, baseDelayMs: 10 },
			);
		} catch (err) {
			caughtError = err;
		}

		// Should be wrapped in an Error
		expect(caughtError).toBeInstanceOf(Error);
		// Properties should be preserved from the source object
		expect((caughtError as any).status).toBe(401);
		expect((caughtError as any).retryable).toBe(false);
		expect((caughtError as any).retry_after).toBe(5);
		// retryable: false means no retry
		expect(calls).toBe(1);
	});

	test("retries non-Error throw with retryable: true and status preserved", async () => {
		let calls = 0;

		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					throw { message: "transient", status: 500, retryable: true };
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

	// retry_after: 0 means "not set" in our implementation — the code checks
	// `retryAfter > 0`, so 0 falls through to computed backoff.
	test("retry_after: 0 falls back to computed backoff", async () => {
		const delays: number[] = [];
		let calls = 0;

		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Rate limited");
					(err as any).status = 429;
					(err as any).retry_after = 0;
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 2,
				baseDelayMs: 5,
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
		// Should use computed backoff (5 * 2^0 = 5), not retry_after
		expect(delays[0]).toBe(5);
	});

	test("retry_after: -1 falls back to computed backoff", async () => {
		const delays: number[] = [];
		let calls = 0;

		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Rate limited");
					(err as any).status = 429;
					(err as any).retry_after = -1;
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 2,
				baseDelayMs: 5,
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
		// Should use computed backoff (5 * 2^0 = 5), not retry_after
		expect(delays[0]).toBe(5);
	});

	test("retries on 408 (Request Timeout)", async () => {
		let calls = 0;
		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Request Timeout");
					(err as any).status = 408;
					throw err;
				}
				return dummyResponse;
			},
			{ maxRetries: 2, baseDelayMs: 10 },
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
	});

	test("honors changing retry_after values across retries", async () => {
		const delays: number[] = [];
		let calls = 0;

		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Rate limited");
					(err as any).status = 429;
					(err as any).retry_after = 0.01; // 10ms
					throw err;
				}
				if (calls === 2) {
					const err = new Error("Rate limited again");
					(err as any).status = 429;
					(err as any).retry_after = 0.03; // 30ms
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 3,
				baseDelayMs: 100,
				maxDelayMs: 60_000,
				jitter: false,
				onRetry: (_error, _attempt, delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(3);
		expect(delays).toHaveLength(2);
		expect(delays[0]).toBe(10); // retry_after: 0.01 => 10ms
		expect(delays[1]).toBe(30); // retry_after: 0.03 => 30ms
	});

	test("throws on negative maxRetries", async () => {
		expect(retryLLMCall(async () => dummyResponse, { maxRetries: -1 })).rejects.toThrow(
			"maxRetries must be a non-negative finite number",
		);
	});

	test("throws on NaN maxRetries", async () => {
		expect(retryLLMCall(async () => dummyResponse, { maxRetries: NaN })).rejects.toThrow(
			"maxRetries must be a non-negative finite number",
		);
	});

	test("throws on Infinity maxRetries", async () => {
		expect(retryLLMCall(async () => dummyResponse, { maxRetries: Infinity })).rejects.toThrow(
			"maxRetries must be a non-negative finite number",
		);
	});

	test("throws on negative baseDelayMs", async () => {
		expect(retryLLMCall(async () => dummyResponse, { baseDelayMs: -1 })).rejects.toThrow(
			"baseDelayMs must be a non-negative finite number",
		);
	});

	test("throws on NaN baseDelayMs", async () => {
		expect(retryLLMCall(async () => dummyResponse, { baseDelayMs: NaN })).rejects.toThrow(
			"baseDelayMs must be a non-negative finite number",
		);
	});

	test("throws on Infinity baseDelayMs", async () => {
		expect(retryLLMCall(async () => dummyResponse, { baseDelayMs: Infinity })).rejects.toThrow(
			"baseDelayMs must be a non-negative finite number",
		);
	});

	test("throws on negative maxDelayMs", async () => {
		expect(retryLLMCall(async () => dummyResponse, { maxDelayMs: -1 })).rejects.toThrow(
			"maxDelayMs must be a non-negative finite number",
		);
	});

	test("throws on NaN maxDelayMs", async () => {
		expect(retryLLMCall(async () => dummyResponse, { maxDelayMs: NaN })).rejects.toThrow(
			"maxDelayMs must be a non-negative finite number",
		);
	});

	test("throws on Infinity maxDelayMs", async () => {
		expect(retryLLMCall(async () => dummyResponse, { maxDelayMs: Infinity })).rejects.toThrow(
			"maxDelayMs must be a non-negative finite number",
		);
	});

	test("throws on negative backoffMultiplier", async () => {
		expect(retryLLMCall(async () => dummyResponse, { backoffMultiplier: -1 })).rejects.toThrow(
			"backoffMultiplier must be a non-negative finite number",
		);
	});

	test("throws on NaN backoffMultiplier", async () => {
		expect(retryLLMCall(async () => dummyResponse, { backoffMultiplier: NaN })).rejects.toThrow(
			"backoffMultiplier must be a non-negative finite number",
		);
	});

	test("throws on Infinity backoffMultiplier", async () => {
		expect(
			retryLLMCall(async () => dummyResponse, { backoffMultiplier: Infinity }),
		).rejects.toThrow("backoffMultiplier must be a non-negative finite number");
	});

	test("jitter can exceed maxDelayMs but stays within [0.5*max, 1.5*max)", async () => {
		// Per spec: cap first, then jitter. Jitter is applied AFTER capping
		// so delays can exceed maxDelayMs — intentional for thundering-herd
		// desynchronization.
		const delays: number[] = [];
		const maxDelayMs = 2;

		for (let i = 0; i < 25; i++) {
			try {
				await retryLLMCall(
					async () => {
						const err = new Error("fail");
						(err as any).status = 500;
						throw err;
					},
					{
						maxRetries: 1,
						baseDelayMs: 100, // Larger than maxDelayMs to force capping
						maxDelayMs,
						jitter: true,
						onRetry: (_error, _attempt, delayMs) => {
							delays.push(delayMs);
						},
					},
				);
			} catch {
				// Expected
			}
		}

		expect(delays).toHaveLength(25);
		for (const delay of delays) {
			// capped = min(100, maxDelayMs), then jitter => maxDelayMs * [0.5, 1.5)
			expect(delay).toBeGreaterThanOrEqual(maxDelayMs * 0.5);
			expect(delay).toBeLessThan(maxDelayMs * 1.5);
		}
	});

	test("retries when retry_after * 1000 equals maxDelayMs exactly", async () => {
		// The code uses `>` not `>=`, so retry_after exactly at the boundary
		// should still retry. Use small values to keep the test fast.
		const delays: number[] = [];
		let calls = 0;

		const result = await retryLLMCall(
			async () => {
				calls++;
				if (calls === 1) {
					const err = new Error("Rate limited");
					(err as any).status = 429;
					(err as any).retry_after = 0.01; // 0.01 * 1000 = 10ms = maxDelayMs
					throw err;
				}
				return dummyResponse;
			},
			{
				maxRetries: 2,
				baseDelayMs: 5,
				maxDelayMs: 10,
				jitter: false,
				onRetry: (_error, _attempt, delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe(dummyResponse);
		expect(calls).toBe(2);
		expect(delays).toHaveLength(1);
		expect(delays[0]).toBe(10); // retry_after * 1000 = maxDelayMs exactly
	});
});

import { describe, expect, test } from "bun:test";
import { StreamReadTimeoutError, withStreamReadTimeout } from "../../src/llm/stream-timeout.ts";

/** Helper: create an async iterable that yields values with configurable delays. */
async function* delayedIterable<T>(items: { value: T; delayMs: number }[]): AsyncIterable<T> {
	for (const item of items) {
		await new Promise((resolve) => setTimeout(resolve, item.delayMs));
		yield item.value;
	}
}

describe("withStreamReadTimeout", () => {
	test("yields all items when no timeout occurs", async () => {
		const source = delayedIterable([
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
			{ value: "c", delayMs: 10 },
		]);

		const results: string[] = [];
		for await (const item of withStreamReadTimeout(source, 500)) {
			results.push(item);
		}

		expect(results).toEqual(["a", "b", "c"]);
	});

	test("throws StreamReadTimeoutError when gap between chunks exceeds timeout", async () => {
		const source = delayedIterable([
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
			{ value: "c", delayMs: 300 }, // This gap exceeds the 100ms timeout
		]);

		const results: string[] = [];
		let caughtError: unknown;

		try {
			for await (const item of withStreamReadTimeout(source, 100)) {
				results.push(item);
			}
		} catch (err) {
			caughtError = err;
		}

		expect(results).toEqual(["a", "b"]);
		expect(caughtError).toBeInstanceOf(StreamReadTimeoutError);
		expect((caughtError as StreamReadTimeoutError).timeoutMs).toBe(100);
	});

	test("throws StreamReadTimeoutError when first chunk takes too long", async () => {
		const source = delayedIterable([
			{ value: "a", delayMs: 300 }, // First chunk exceeds timeout
		]);

		let caughtError: unknown;
		try {
			for await (const _item of withStreamReadTimeout(source, 100)) {
				// Should not reach here
			}
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(StreamReadTimeoutError);
	});

	test("resets timer on each yielded chunk", async () => {
		// Each chunk arrives at 80ms intervals — under the 100ms timeout.
		// Total time is 240ms which would exceed a single 100ms timeout,
		// but each gap is within the limit.
		const source = delayedIterable([
			{ value: "a", delayMs: 80 },
			{ value: "b", delayMs: 80 },
			{ value: "c", delayMs: 80 },
		]);

		const results: string[] = [];
		for await (const item of withStreamReadTimeout(source, 100)) {
			results.push(item);
		}

		expect(results).toEqual(["a", "b", "c"]);
	});

	test("cleans up timer when source completes normally", async () => {
		const source = delayedIterable([{ value: "a", delayMs: 10 }]);

		for await (const _item of withStreamReadTimeout(source, 100)) {
			// consume
		}

		// If the timer wasn't cleaned up, this sleep would trigger it.
		// No error should occur.
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	test("cleans up timer when consumer breaks early", async () => {
		const source = delayedIterable([
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
			{ value: "c", delayMs: 10 },
		]);

		for await (const _item of withStreamReadTimeout(source, 100)) {
			break; // Consumer breaks after first item
		}

		// Timer should be cleaned up — no lingering timeout
		await new Promise((resolve) => setTimeout(resolve, 200));
	});

	test("throws AbortError when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const source = delayedIterable([{ value: "a", delayMs: 10 }]);
		let caughtError: unknown;

		try {
			for await (const _item of withStreamReadTimeout(source, 500, controller.signal)) {
				// Should not reach here
			}
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(DOMException);
		expect((caughtError as DOMException).name).toBe("AbortError");
	});

	test("throws AbortError when signal fires during iteration", async () => {
		const controller = new AbortController();
		const source = delayedIterable([
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
			{ value: "c", delayMs: 200 }, // Abort will fire during this gap
		]);

		setTimeout(() => controller.abort(), 50);

		const results: string[] = [];
		let caughtError: unknown;

		try {
			for await (const item of withStreamReadTimeout(source, 500, controller.signal)) {
				results.push(item);
			}
		} catch (err) {
			caughtError = err;
		}

		expect(results).toEqual(["a", "b"]);
		expect(caughtError).toBeInstanceOf(DOMException);
		expect((caughtError as DOMException).name).toBe("AbortError");
	});

	test("cleans up abort listener on normal completion", async () => {
		const controller = new AbortController();
		const source = delayedIterable([
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
		]);

		const results: string[] = [];
		for await (const item of withStreamReadTimeout(source, 500, controller.signal)) {
			results.push(item);
		}

		expect(results).toEqual(["a", "b"]);
		// Aborting after completion should not throw
		controller.abort();
	});

	test("does not false-timeout when consumer is slow to pull values", async () => {
		const source = delayedIterable([
			{ value: "a", delayMs: 10 },
			{ value: "b", delayMs: 10 },
		]);

		const results: string[] = [];
		for await (const item of withStreamReadTimeout(source, 100)) {
			results.push(item);
			// Simulate slow consumer — 150ms exceeds the 100ms timeout,
			// but the timer should be paused during yield.
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		expect(results).toEqual(["a", "b"]);
	});

	test("propagates source iterator errors and cleans up timer", async () => {
		// Source yields 2 items then throws a NetworkError
		async function* failingIterable(): AsyncIterable<string> {
			yield "a";
			yield "b";
			throw new Error("NetworkError: connection lost");
		}

		const controller = new AbortController();
		const results: string[] = [];
		let caughtError: unknown;

		try {
			for await (const item of withStreamReadTimeout(failingIterable(), 500, controller.signal)) {
				results.push(item);
			}
		} catch (err) {
			caughtError = err;
		}

		// The source error propagates to the consumer
		expect(results).toEqual(["a", "b"]);
		expect(caughtError).toBeInstanceOf(Error);
		expect((caughtError as Error).message).toBe("NetworkError: connection lost");

		// Timer is cleaned up — no lingering timeout fires after the error
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Abort listener is removed — aborting after error doesn't throw
		controller.abort();
	});

	test("throws Error when timeoutMs is zero", async () => {
		const source = delayedIterable([{ value: "a", delayMs: 10 }]);
		let caughtError: unknown;

		try {
			for await (const _item of withStreamReadTimeout(source, 0)) {
				// Should not reach here
			}
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(Error);
		expect((caughtError as Error).message).toBe("timeoutMs must be a positive finite number");
	});

	test("throws Error when timeoutMs is negative", async () => {
		const source = delayedIterable([{ value: "a", delayMs: 10 }]);
		let caughtError: unknown;

		try {
			for await (const _item of withStreamReadTimeout(source, -100)) {
				// Should not reach here
			}
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(Error);
		expect((caughtError as Error).message).toBe("timeoutMs must be a positive finite number");
	});

	test("throws Error when timeoutMs is NaN", async () => {
		const source = delayedIterable([{ value: "a", delayMs: 10 }]);
		let caughtError: unknown;

		try {
			for await (const _item of withStreamReadTimeout(source, NaN)) {
				// Should not reach here
			}
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(Error);
		expect((caughtError as Error).message).toBe("timeoutMs must be a positive finite number");
	});

	test("throws Error when timeoutMs is Infinity", async () => {
		const source = delayedIterable([{ value: "a", delayMs: 10 }]);
		let caughtError: unknown;

		try {
			for await (const _item of withStreamReadTimeout(source, Infinity)) {
				// Should not reach here
			}
		} catch (err) {
			caughtError = err;
		}

		expect(caughtError).toBeInstanceOf(Error);
		expect((caughtError as Error).message).toBe("timeoutMs must be a positive finite number");
	});

	test("swallows cleanup error when iterator.return() throws", async () => {
		// Custom async iterable whose return() method throws
		const throwingIterable: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				let yielded = false;
				return {
					async next() {
						if (!yielded) {
							yielded = true;
							return { value: "a", done: false as const };
						}
						// Stall to trigger timeout
						await new Promise((resolve) => setTimeout(resolve, 500));
						return { value: "b", done: false as const };
					},
					async return() {
						throw new Error("cleanup explosion");
					},
				};
			},
		};

		let caughtError: unknown;
		const results: string[] = [];
		try {
			for await (const item of withStreamReadTimeout(throwingIterable, 100)) {
				results.push(item);
			}
		} catch (err) {
			caughtError = err;
		}

		// Should get the timeout error, NOT the cleanup error
		expect(results).toEqual(["a"]);
		expect(caughtError).toBeInstanceOf(StreamReadTimeoutError);
		expect((caughtError as StreamReadTimeoutError).timeoutMs).toBe(100);
	});

	test("swallows cleanup error when consumer breaks and iterator.return() throws", async () => {
		// Custom async iterable whose return() method throws
		const throwingIterable: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				let count = 0;
				return {
					async next() {
						count++;
						return { value: `item-${count}`, done: false as const };
					},
					async return() {
						throw new Error("cleanup explosion on break");
					},
				};
			},
		};

		// Consumer breaks early — cleanup error should be swallowed
		const results: string[] = [];
		for await (const item of withStreamReadTimeout(throwingIterable, 500)) {
			results.push(item);
			break;
		}

		expect(results).toEqual(["item-1"]);
		// No error thrown — cleanup error was swallowed
	});

	test("handles empty source iterable without error", async () => {
		async function* emptyIterable(): AsyncIterable<string> {
			// yields nothing
		}

		const results: string[] = [];
		for await (const item of withStreamReadTimeout(emptyIterable(), 100)) {
			results.push(item);
		}

		expect(results).toEqual([]);

		// No lingering timeout fires
		await new Promise((resolve) => setTimeout(resolve, 200));
	});
});

describe("StreamReadTimeoutError", () => {
	test("has correct name and properties", () => {
		const error = new StreamReadTimeoutError(30000);
		expect(error.name).toBe("StreamReadTimeoutError");
		expect(error.timeoutMs).toBe(30000);
		expect(error.message).toContain("30000");
		expect(error).toBeInstanceOf(Error);
	});

	test("retryable property is true", () => {
		const error = new StreamReadTimeoutError(30000);
		expect(error.retryable).toBe(true);
	});
});

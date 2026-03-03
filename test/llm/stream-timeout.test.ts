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

/**
 * Stream read timeout utility.
 *
 * Per the unified LLM spec (Section 4, AdapterTimeout), the `stream_read`
 * timeout is the max time between consecutive stream events.
 * If no chunk arrives within the timeout, a StreamReadTimeoutError is thrown.
 */

/** Default stream read timeout in milliseconds. */
export const DEFAULT_STREAM_READ_TIMEOUT_MS = 120_000;

/**
 * Error thrown when the time between consecutive stream chunks exceeds
 * the configured stream_read timeout. Marked as retryable per spec
 * (StreamError is retryable), though callers should note that once
 * streaming has begun and partial data was delivered, the spec says
 * the stream emits an error rather than retrying automatically.
 */
export class StreamReadTimeoutError extends Error {
	override readonly name = "StreamReadTimeoutError";
	readonly retryable = true;
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Stream read timed out: no data received for ${timeoutMs}ms`);
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Wrap an async iterable with a per-chunk read timeout.
 *
 * Yields values from the source. If the time between any two consecutive
 * values (or before the first value) exceeds `timeoutMs`, throws a
 * StreamReadTimeoutError.
 *
 * The timer is properly cleaned up when:
 * - The source completes normally
 * - The consumer breaks out of the loop early
 * - A timeout fires
 * - The abort signal fires
 *
 * @param signal - Optional AbortSignal to cancel the stream. When aborted,
 *   the timer is cleared and an AbortError is thrown.
 */
export async function* withStreamReadTimeout<T>(
	source: AsyncIterable<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): AsyncGenerator<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("timeoutMs must be a positive finite number");
	}

	if (signal?.aborted) {
		throw new DOMException("Aborted", "AbortError");
	}

	const iterator = source[Symbol.asyncIterator]();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let timedOut = false;
	let rejectCurrent: ((err: Error) => void) | null = null;

	function startTimer(): void {
		clearTimer();
		timer = setTimeout(() => {
			timer = null;
			timedOut = true;
			if (rejectCurrent) {
				rejectCurrent(new StreamReadTimeoutError(timeoutMs));
			}
		}, timeoutMs);
	}

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function onAbort(): void {
		clearTimer();
		if (rejectCurrent) {
			rejectCurrent(new DOMException("Aborted", "AbortError"));
		}
	}

	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		startTimer();

		while (true) {
			if (signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}

			if (timedOut) {
				throw new StreamReadTimeoutError(timeoutMs);
			}

			// Race the iterator's next() against the timeout
			const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
				rejectCurrent = reject;
				iterator.next().then(resolve, reject);
			});

			rejectCurrent = null;

			if (result.done) {
				break;
			}

			// Clear timer before yielding — the consumer may be slow to pull
			// the next value, and the timer should not tick during that pause.
			clearTimer();
			yield result.value;
			// Restart timer after yield returns (consumer pulled the next value)
			startTimer();
		}
	} finally {
		clearTimer();
		rejectCurrent = null;
		signal?.removeEventListener("abort", onAbort);
		// Ensure the source iterator is closed if we exit early.
		// Race against a short timeout because a pending .next() call can
		// block .return() indefinitely for async generators.
		// Swallow cleanup errors to avoid masking the real error
		// (e.g., network error during HTTP teardown).
		let cleanupTimer: ReturnType<typeof setTimeout>;
		try {
			await Promise.race([
				iterator.return?.()?.then((v) => {
					clearTimeout(cleanupTimer);
					return v;
				}),
				new Promise((resolve) => {
					cleanupTimer = setTimeout(resolve, 1000);
				}),
			]);
		} catch {
			/* swallow cleanup error */
		}
	}
}

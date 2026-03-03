/**
 * Retry utility for LLM calls with exponential backoff.
 *
 * Per the unified LLM spec (RetryPolicy), transient errors (429, 500, 502,
 * 503, 504, 408, network errors, stream errors) are retried with exponential
 * backoff and jitter. Non-retryable errors (400, 401, 403, 404, 413, 422)
 * are thrown immediately.
 */

export interface RetryOptions {
	/** Maximum number of retries after the initial attempt. Default: 2. */
	maxRetries?: number;
	/** Base delay in ms before first retry. Default: 1000. */
	baseDelayMs?: number;
	/** Maximum delay cap in ms. Default: 60000. */
	maxDelayMs?: number;
	/** Backoff multiplier. Default: 2. */
	backoffMultiplier?: number;
	/** Whether to apply jitter to delays. Default: true. */
	jitter?: boolean;
	/** AbortSignal to cancel retries during delay. */
	signal?: AbortSignal;
	/** Callback invoked before each retry. */
	onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

/** HTTP status codes that should NOT be retried (client errors that won't succeed on retry). */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422]);

function isRetryable(error: unknown): boolean {
	// AbortError is never retried
	if (error instanceof DOMException && error.name === "AbortError") {
		return false;
	}

	// Honor explicit retryable property if present. Adapters and custom error
	// types (e.g. StreamReadTimeoutError) can set `.retryable` to override
	// status-code heuristics. This is intentional API surface.
	const retryableProp = (error as { retryable?: boolean }).retryable;
	if (retryableProp === true) return true;
	if (retryableProp === false) return false;

	// Fall back to status code heuristics
	const status = (error as { status?: number }).status;
	if (status !== undefined && NON_RETRYABLE_STATUSES.has(status)) {
		return false;
	}

	// No status code (network errors, timeout errors): retryable
	return true;
}

function computeDelay(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	backoffMultiplier: number,
	jitter: boolean,
): number {
	const delay = Math.min(baseDelayMs * backoffMultiplier ** (attempt - 1), maxDelayMs);
	if (!jitter) return delay;
	return delay * (0.5 + Math.random());
}

/**
 * Retry an async LLM call with exponential backoff.
 *
 * Calls `fn` once, then retries up to `maxRetries` times on transient errors.
 * Non-retryable errors (4xx client errors, AbortError) are thrown immediately.
 *
 * If the error carries a `retry_after` value (in seconds), that delay is used
 * instead of the computed backoff. If `retry_after` exceeds `maxDelayMs/1000`,
 * the error is thrown immediately without retrying.
 */
export async function retryLLMCall<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		maxRetries = 2,
		baseDelayMs = 1000,
		maxDelayMs = 60_000,
		backoffMultiplier = 2,
		jitter = true,
		signal,
		onRetry,
	} = options;

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			lastError = error;

			// Don't retry non-retryable errors or on the last attempt
			if (!isRetryable(error) || attempt === maxRetries) {
				throw error;
			}

			// Check for Retry-After header value (in seconds). Spec-compliant:
			// adapters should populate `retry_after` when extracting Retry-After
			// headers from provider responses (e.g. 429 rate-limit responses).
			const retryAfter = (error as { retry_after?: number }).retry_after;
			let delayMs: number;
			if (retryAfter !== undefined && retryAfter > 0) {
				const retryAfterMs = retryAfter * 1000;
				if (retryAfterMs > maxDelayMs) {
					// Retry-After exceeds our max delay — don't retry
					throw error;
				}
				delayMs = retryAfterMs;
			} else {
				delayMs = computeDelay(attempt + 1, baseDelayMs, maxDelayMs, backoffMultiplier, jitter);
			}

			onRetry?.(error, attempt + 1, delayMs);

			// Wait with abort support
			if (signal) {
				if (signal.aborted) throw new DOMException("Aborted", "AbortError");
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, delayMs);

					function onAbort() {
						clearTimeout(timer);
						reject(new DOMException("Aborted", "AbortError"));
					}
					signal.addEventListener("abort", onAbort, { once: true });
				});
			} else {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}

	// Should not reach here, but satisfy TypeScript
	throw lastError ?? new Error("retryLLMCall: unexpected state");
}

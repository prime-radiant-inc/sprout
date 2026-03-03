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
	/** Callback invoked before each retry. `attempt` is 1-indexed (1 = first retry). */
	onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

/** HTTP status codes that should NOT be retried (client errors that won't succeed on retry).
 * Note: 402 is not in the spec's explicit list but is included because payment
 * issues don't resolve on retry. */
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

	// Status code not in non-retryable set, or no status code: retryable
	return true;
}

// Cap first, then jitter — per spec Section 6.6:
//   delay = MIN(base_delay * (backoff_multiplier ^ n), max_delay)
//   IF jitter: delay = delay * RANDOM(0.5, 1.5)
// Jitter is applied AFTER capping so that retries desynchronize
// (thundering-herd prevention). This means jittered delays can exceed
// maxDelayMs — that's intentional per spec.
function computeDelay(
	attempt: number, // 0-indexed: 0 = first retry
	baseDelayMs: number,
	maxDelayMs: number,
	backoffMultiplier: number,
	jitter: boolean,
): number {
	const capped = Math.min(baseDelayMs * backoffMultiplier ** attempt, maxDelayMs);
	if (!jitter) return capped;
	return capped * (0.5 + Math.random());
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

	if (!Number.isFinite(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative finite number");
	if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new Error("baseDelayMs must be a non-negative finite number");
	if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) throw new Error("maxDelayMs must be a non-negative finite number");
	if (!Number.isFinite(backoffMultiplier) || backoffMultiplier < 0) throw new Error("backoffMultiplier must be a non-negative finite number");

	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const error = err instanceof Error ? err : new Error(
				typeof (err as any)?.message === "string" ? (err as any).message : String(err),
			);
			if (!(err instanceof Error) && typeof err === "object" && err !== null) {
				const source = err as Record<string, unknown>;
				if ("status" in source) (error as any).status = source.status;
				if ("retryable" in source) (error as any).retryable = source.retryable;
				if ("retry_after" in source) (error as any).retry_after = source.retry_after;
			}
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
				delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, backoffMultiplier, jitter);
			}

			// Check abort before calling onRetry (don't report a retry that won't happen)
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

			onRetry?.(error, attempt + 1, delayMs);

			// Wait with abort support
			if (signal) {
				await new Promise<void>((resolve, reject) => {
					function onAbort() {
						clearTimeout(timer);
						reject(new DOMException("Aborted", "AbortError"));
					}
					signal.addEventListener("abort", onAbort, { once: true });
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, delayMs);
				});
			} else {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
	}

	// Should not reach here, but satisfy TypeScript
	throw lastError ?? new Error("retryLLMCall: unexpected state");
}

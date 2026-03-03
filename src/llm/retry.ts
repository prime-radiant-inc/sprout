/**
 * Retry utility for LLM calls with exponential backoff.
 *
 * Per the unified LLM spec (RetryPolicy), transient errors (429, 500, 502,
 * 503, network errors, stream errors) are retried with exponential backoff
 * and jitter. Non-retryable errors (400, 401, 403, 404) are thrown immediately.
 */

import type { Response } from "./types.ts";

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

/** HTTP status codes that should NOT be retried. */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404]);

function isRetryable(error: unknown): boolean {
	// AbortError is never retried
	if (error instanceof DOMException && error.name === "AbortError") {
		return false;
	}

	// Check for non-retryable HTTP status codes
	const status = (error as { status?: number }).status;
	if (status !== undefined && NON_RETRYABLE_STATUSES.has(status)) {
		return false;
	}

	// Retryable statuses: 429, 500, 502, 503
	// No status code (network errors): retryable
	// Timeout errors (APIConnectionTimeoutError): retryable
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
	return delay * (0.5 + Math.random() * 0.5);
}

/**
 * Retry an async LLM call with exponential backoff.
 *
 * Calls `fn` once, then retries up to `maxRetries` times on transient errors.
 * Non-retryable errors (4xx client errors, AbortError) are thrown immediately.
 */
export async function retryLLMCall(
	fn: () => Promise<Response>,
	options: RetryOptions = {},
): Promise<Response> {
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

			const delayMs = computeDelay(attempt + 1, baseDelayMs, maxDelayMs, backoffMultiplier, jitter);

			onRetry?.(error, attempt + 1, delayMs);

			// Wait with abort support
			if (signal) {
				if (signal.aborted) throw lastError;
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					}, delayMs);

					function onAbort() {
						clearTimeout(timer);
						reject(lastError);
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

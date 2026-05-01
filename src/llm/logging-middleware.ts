import type { Logger } from "../host/logger.ts";
import type { Middleware } from "./client.ts";

/**
 * Client middleware that logs every LLM call with provider, model, latency, and token counts.
 *
 * Logs at info level on success, error level on failure.
 */
export function loggingMiddleware(logger: Logger): Middleware {
	return async (request, next) => {
		const start = performance.now();
		try {
			const response = await next(request);
			const latencyMs = Math.round(performance.now() - start);
			logger.info("llm", "LLM call completed", {
				provider: request.provider,
				model: request.model,
				purpose: request.metadata?.purpose,
				latencyMs,
				inputTokens: response.usage.input_tokens,
				totalInputTokens: response.usage.total_input_tokens,
				outputTokens: response.usage.output_tokens,
				cacheReadTokens: response.usage.cache_read_tokens,
				cacheWriteTokens: response.usage.cache_write_tokens,
				cacheWrite5mTokens: response.usage.cache_write_5m_tokens,
				cacheWrite1hTokens: response.usage.cache_write_1h_tokens,
				finishReason: response.finish_reason.reason,
				messageCount: request.messages.length,
				toolCount: request.tools?.length ?? 0,
			});
			return response;
		} catch (err) {
			const latencyMs = Math.round(performance.now() - start);
			logger.error("llm", "LLM call failed", {
				provider: request.provider,
				model: request.model,
				purpose: request.metadata?.purpose,
				latencyMs,
				error: err instanceof Error ? err.message : String(err),
				messageCount: request.messages.length,
				toolCount: request.tools?.length ?? 0,
			});
			throw err;
		}
	};
}

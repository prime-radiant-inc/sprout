import type OpenAI from "openai";
import type { ProviderKind } from "../../shared/provider-settings.ts";
import {
	ContentKind,
	type ContentPart,
	type FinishReason,
	type Response,
	type Usage,
} from "../types.ts";

/**
 * Wrap an OpenAI Responses reasoning item (encrypted_content and all) as an
 * opaque provider-state part, stored verbatim for byte-exact replay.
 */
export function reasoningStatePart(item: unknown, provider: ProviderKind): ContentPart {
	return {
		kind: ContentKind.PROVIDER_STATE,
		provider_state: {
			provider,
			block_type: "reasoning",
			data: item as Record<string, unknown>,
		},
	};
}

export function parseResponsesResponse(
	raw: OpenAI.Responses.Response,
	provider: ProviderKind,
): Response {
	const contentParts: import("../types.ts").ContentPart[] = [];
	let hasToolCalls = false;

	for (const item of raw.output) {
		if (item.type === "reasoning") {
			contentParts.push(reasoningStatePart(item, provider));
		} else if (item.type === "message") {
			for (const content of item.content) {
				if (content.type === "output_text") {
					contentParts.push({ kind: ContentKind.TEXT, text: content.text });
				}
			}
		} else if (item.type === "function_call") {
			hasToolCalls = true;
			contentParts.push({
				kind: ContentKind.TOOL_CALL,
				tool_call: {
					id: item.call_id,
					name: item.name,
					arguments: safeParseJSON(item.arguments),
				},
			});
		}
	}

	// Mirror the streaming path: only a completed terminal status with tool
	// calls is a tool-call stop — an "incomplete" (length) response carrying a
	// half-emitted tool call keeps "length" so the agent's recovery path fires.
	const terminalStatus = raw.status ?? "completed";
	const finishReason: FinishReason =
		hasToolCalls && terminalStatus === "completed"
			? { reason: "tool_calls", raw: raw.status ?? undefined }
			: mapOpenAIFinishReason(terminalStatus);

	return {
		id: raw.id,
		model: raw.model,
		provider,
		message: { role: "assistant", content: contentParts },
		finish_reason: finishReason,
		usage: parseResponsesUsage(raw.usage),
		raw: raw as unknown as Record<string, unknown>,
	};
}

export function parseResponsesUsage(usage: unknown): Usage {
	const raw = usage as
		| {
				input_tokens?: number;
				output_tokens?: number;
				output_tokens_details?: { reasoning_tokens?: number };
		  }
		| undefined;
	const rawInputTokens = raw?.input_tokens ?? 0;
	const cacheReadTokens = cachedInputTokens(raw) ?? 0;
	const outputTokens = raw?.output_tokens ?? 0;

	return {
		input_tokens: Math.max(0, rawInputTokens - cacheReadTokens),
		output_tokens: outputTokens,
		total_tokens: rawInputTokens + outputTokens,
		reasoning_tokens: raw?.output_tokens_details?.reasoning_tokens,
		cache_read_tokens: cacheReadTokens,
		total_input_tokens: rawInputTokens,
	};
}

export function cachedInputTokens(usage: unknown): number | undefined {
	const record = usage as
		| {
				input_tokens_details?: { cached_tokens?: number };
				prompt_tokens_details?: { cached_tokens?: number };
		  }
		| undefined;
	return (
		record?.input_tokens_details?.cached_tokens ?? record?.prompt_tokens_details?.cached_tokens
	);
}

export function mapOpenAIFinishReason(status: string): FinishReason {
	switch (status) {
		case "completed":
			return { reason: "stop", raw: status };
		case "incomplete":
			return { reason: "length", raw: status };
		case "failed":
			return { reason: "error", raw: status };
		default:
			return { reason: "other", raw: status };
	}
}

export function safeParseJSON(value: unknown): any {
	if (typeof value !== "string") {
		return { raw: value };
	}

	try {
		return JSON.parse(value);
	} catch {
		return { raw: value };
	}
}

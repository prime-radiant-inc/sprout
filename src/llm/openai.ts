import OpenAI from "openai";
import type { ProviderKind } from "../shared/provider-settings.ts";
import { asRecord } from "../util/record.ts";
import { parseResponsesResponse, safeParseJSON } from "./openai/responses-parse.ts";
import { buildResponsesInput, buildResponsesParams } from "./openai/responses-request.ts";
import { streamResponsesEvents } from "./openai/responses-stream.ts";
import {
	ContentKind,
	type FinishReason,
	type ProviderAdapter,
	type ProviderModel,
	type Request,
	type Response,
	type StreamEvent,
	type Usage,
} from "./types.ts";

export { parseResponsesResponse, safeParseJSON } from "./openai/responses-parse.ts";
export { buildResponsesInput, buildResponsesParams } from "./openai/responses-request.ts";

export interface OpenAIAdapterOptions {
	providerId?: string;
	kind?: ProviderKind;
	baseUrl?: string;
	headers?: Record<string, string>;
}

/**
 * OpenAI adapter using the Responses API (/v1/responses).
 * Required for reasoning token visibility and server-side conversation state.
 */
export class OpenAIAdapter implements ProviderAdapter {
	readonly name: string;
	readonly providerId: string;
	readonly kind: ProviderKind;
	private client: OpenAI;

	constructor(apiKey: string, options: string | OpenAIAdapterOptions = {}) {
		const normalized = typeof options === "string" ? { baseUrl: options } : options;
		this.kind = normalized.kind ?? "openai";
		this.name = this.kind;
		this.providerId = normalized.providerId ?? this.kind;
		this.client = new OpenAI({
			apiKey,
			baseURL: normalized.baseUrl,
			defaultHeaders: normalized.headers,
		});
	}

	async listModels(): Promise<ProviderModel[]> {
		const models: ProviderModel[] = [];
		const response = await this.client.models.list();
		for (const model of response.data) {
			if (this.kind === "openai" && !/^(gpt-|o\d)/.test(model.id)) continue;
			models.push({ id: model.id, label: model.id, source: "remote" });
		}
		return models;
	}

	async checkConnection(): Promise<{ ok: true } | { ok: false; message: string }> {
		try {
			await this.client.models.list();
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}

	async complete(request: Request): Promise<Response> {
		if (this.usesChatCompletions()) {
			const params = this.buildChatCompletionsParams(request);
			const raw = await this.client.chat.completions.create({ ...params, stream: false });
			return parseChatCompletionsResponse(raw, this.kind);
		}
		const input = buildResponsesInput(request);
		const params = buildResponsesParams(request, input);

		const raw = await this.client.responses.create({ ...params, stream: false });
		return parseResponsesResponse(raw, this.kind);
	}

	async *stream(request: Request): AsyncIterable<StreamEvent> {
		if (this.usesChatCompletions()) {
			yield* this.streamChatCompletions(request);
			return;
		}
		const input = buildResponsesInput(request);
		const params = buildResponsesParams(request, input);

		const stream = await this.client.responses.create({ ...params, stream: true });

		yield* streamResponsesEvents({ stream, request, provider: this.kind });
	}

	private usesChatCompletions(): boolean {
		return this.kind === "openai-compatible" || this.kind === "openrouter";
	}

	private async *streamChatCompletions(request: Request): AsyncIterable<StreamEvent> {
		const params = this.buildChatCompletionsParams(request);
		const stream = (await this.client.chat.completions.create({
			...params,
			stream: true,
		} as any)) as unknown as AsyncIterable<any>;

		yield { type: "stream_start" };

		let accumulatedText = "";
		const toolCalls = new Map<number, { id: string; name: string; args: string }>();
		let usage: Usage | undefined;
		let finalReason: FinishReason = { reason: "stop" };

		for await (const chunk of stream) {
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;
			if (typeof delta?.content === "string" && delta.content.length > 0) {
				accumulatedText += delta.content;
				yield { type: "text_delta", delta: delta.content };
			}
			for (const call of delta?.tool_calls ?? []) {
				const index = call.index ?? 0;
				const existing = toolCalls.get(index) ?? { id: "", name: "", args: "" };
				if (typeof call.id === "string") existing.id = call.id;
				if (typeof call.function?.name === "string") existing.name = call.function.name;
				if (typeof call.function?.arguments === "string") {
					existing.args += call.function.arguments;
					yield { type: "tool_call_delta", delta: call.function.arguments };
				}
				toolCalls.set(index, existing);
			}
			if (choice?.finish_reason) {
				finalReason = mapChatFinishReason(choice.finish_reason);
			}
			if (chunk.usage) {
				usage = parseChatUsage(chunk.usage);
			}
		}

		const contentParts: import("./types.ts").ContentPart[] = [];
		if (accumulatedText) {
			contentParts.push({ kind: ContentKind.TEXT, text: accumulatedText });
			yield { type: "text_end" };
		}
		for (const call of toolCalls.values()) {
			const toolCall = {
				id: call.id,
				name: call.name,
				arguments: safeParseJSON(call.args),
			};
			contentParts.push({ kind: ContentKind.TOOL_CALL, tool_call: toolCall });
			yield { type: "tool_call_end", tool_call: toolCall };
		}

		// Tool calls present usually means a clean tool-call stop, but a
		// truncated response can end mid-tool-call — keep "length" so the
		// agent's length-recovery path fires instead of executing garbage args.
		if (toolCalls.size > 0 && finalReason.reason !== "length") {
			finalReason = { reason: "tool_calls" };
		}
		const finalResponse: Response = {
			id: "",
			model: request.model,
			provider: this.kind,
			message: { role: "assistant", content: contentParts },
			finish_reason: finalReason,
			usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		};
		yield {
			type: "finish",
			finish_reason: finalReason,
			usage: finalResponse.usage,
			response: finalResponse,
		};
	}

	private buildChatCompletionsParams(request: Request): any {
		const params = buildChatCompletionsParams(request);
		if (this.kind === "openai-compatible" && params.think === undefined) {
			params.think = false;
		}
		return params;
	}
}

export function buildChatCompletionsParams(request: Request): any {
	const params: any = {
		model: request.model,
		messages: buildChatMessages(request),
	};
	const openaiOpts = asRecord(request.provider_options?.openai);
	const extraBody = asRecord(openaiOpts.extra_body);

	if (request.max_tokens) {
		params.max_tokens = request.max_tokens;
	}
	if (request.temperature !== undefined) {
		params.temperature = request.temperature;
	}
	if (request.top_p !== undefined) {
		params.top_p = request.top_p;
	}
	if (request.tools?.length) {
		params.tools = request.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}
	if (request.tool_choice) {
		if (
			request.tool_choice === "auto" ||
			request.tool_choice === "none" ||
			request.tool_choice === "required"
		) {
			params.tool_choice = request.tool_choice;
		} else {
			params.tool_choice = {
				type: "function",
				function: { name: request.tool_choice.name },
			};
		}
	}
	Object.assign(params, extraBody);

	return params;
}

function buildChatMessages(request: Request): any[] {
	const messages: any[] = [];

	for (const msg of request.messages) {
		if (msg.role === "system" || msg.role === "developer") {
			const text = textContent(msg.content);
			if (text) messages.push({ role: "system", content: text });
		} else if (msg.role === "user") {
			const text = textContent(msg.content);
			if (text) messages.push({ role: "user", content: text });
		} else if (msg.role === "assistant") {
			const text = textContent(msg.content);
			const toolCalls = msg.content
				.filter((part) => part.kind === ContentKind.TOOL_CALL && part.tool_call)
				.map((part) => ({
					id: part.tool_call!.id,
					type: "function",
					function: {
						name: part.tool_call!.name,
						arguments:
							typeof part.tool_call!.arguments === "string"
								? part.tool_call!.arguments
								: JSON.stringify(part.tool_call!.arguments),
					},
				}));
			messages.push({
				role: "assistant",
				content: text || null,
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		} else if (msg.role === "tool") {
			for (const part of msg.content) {
				if (part.kind !== ContentKind.TOOL_RESULT || !part.tool_result) continue;
				messages.push({
					role: "tool",
					tool_call_id: part.tool_result.tool_call_id,
					content:
						typeof part.tool_result.content === "string"
							? part.tool_result.content
							: JSON.stringify(part.tool_result.content),
				});
			}
		}
	}

	return messages;
}

function textContent(content: import("./types.ts").ContentPart[]): string {
	return content
		.filter((part) => part.kind === ContentKind.TEXT && part.text)
		.map((part) => part.text)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseChatCompletionsResponse(raw: any, provider: ProviderKind): Response {
	const choice = raw.choices?.[0];
	const message = choice?.message ?? {};
	const contentParts: import("./types.ts").ContentPart[] = [];
	if (typeof message.content === "string" && message.content.length > 0) {
		contentParts.push({ kind: ContentKind.TEXT, text: message.content });
	}
	for (const call of message.tool_calls ?? []) {
		contentParts.push({
			kind: ContentKind.TOOL_CALL,
			tool_call: {
				id: call.id,
				name: call.function?.name ?? "",
				arguments: safeParseJSON(call.function?.arguments ?? "{}"),
			},
		});
	}
	const mappedReason = mapChatFinishReason(choice?.finish_reason ?? "stop");
	const hasToolCalls =
		contentParts.some((part) => part.kind === ContentKind.TOOL_CALL) ||
		(message.tool_calls?.length ?? 0) > 0;
	// A truncated mid-tool-call response keeps "length" so the agent recovers
	// instead of executing the half-parsed arguments.
	const finishReason: FinishReason =
		hasToolCalls && mappedReason.reason !== "length"
			? { reason: "tool_calls", raw: choice?.finish_reason }
			: mappedReason;

	return {
		id: raw.id ?? "",
		model: raw.model ?? "",
		provider,
		message: { role: "assistant", content: contentParts },
		finish_reason: finishReason,
		usage: parseChatUsage(raw.usage),
		raw: raw as Record<string, unknown>,
	};
}

function parseChatUsage(usage: unknown): Usage {
	const raw = usage as
		| {
				prompt_tokens?: number;
				completion_tokens?: number;
				total_tokens?: number;
				prompt_tokens_details?: { cached_tokens?: number };
				completion_tokens_details?: { reasoning_tokens?: number };
		  }
		| undefined;
	const rawInputTokens = raw?.prompt_tokens ?? 0;
	const cacheReadTokens = raw?.prompt_tokens_details?.cached_tokens ?? 0;
	const outputTokens = raw?.completion_tokens ?? 0;
	return {
		input_tokens: Math.max(0, rawInputTokens - cacheReadTokens),
		output_tokens: outputTokens,
		total_tokens: raw?.total_tokens ?? rawInputTokens + outputTokens,
		reasoning_tokens: raw?.completion_tokens_details?.reasoning_tokens,
		cache_read_tokens: cacheReadTokens,
		total_input_tokens: rawInputTokens,
	};
}

function mapChatFinishReason(reason: string): FinishReason {
	switch (reason) {
		case "stop":
			return { reason: "stop", raw: reason };
		case "length":
			return { reason: "length", raw: reason };
		case "tool_calls":
		case "function_call":
			return { reason: "tool_calls", raw: reason };
		default:
			return { reason: "other", raw: reason };
	}
}

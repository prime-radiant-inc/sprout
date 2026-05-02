import OpenAI from "openai";
import type { ProviderKind } from "../shared/provider-settings.ts";
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

		yield { type: "stream_start" };

		let accumulatedText = "";
		const toolCalls = new Map<string, { id: string; name: string; args: string }>();
		let usage: Usage | undefined;

		for await (const event of stream) {
			if (event.type === "response.output_text.delta") {
				yield { type: "text_delta", delta: event.delta };
				accumulatedText += event.delta;
			} else if (event.type === "response.function_call_arguments.delta") {
				yield { type: "tool_call_delta", delta: event.delta };
			} else if (event.type === "response.output_item.done") {
				if (event.item.type === "message") {
					yield { type: "text_end" };
				} else if (event.item.type === "function_call") {
					const item = event.item;
					toolCalls.set(item.call_id, {
						id: item.call_id,
						name: item.name,
						args: item.arguments,
					});
					yield {
						type: "tool_call_end",
						tool_call: {
							id: item.call_id,
							name: item.name,
							arguments: safeParseJSON(item.arguments),
						},
					};
				}
			} else if (event.type === "response.completed") {
				const resp = event.response;
				const rawInputTokens = resp.usage?.input_tokens ?? 0;
				const cacheReadTokens = cachedInputTokens(resp.usage) ?? 0;
				const outputTokens = resp.usage?.output_tokens ?? 0;
				usage = {
					input_tokens: Math.max(0, rawInputTokens - cacheReadTokens),
					output_tokens: outputTokens,
					total_tokens: rawInputTokens + outputTokens,
					reasoning_tokens: (resp.usage as any)?.output_tokens_details?.reasoning_tokens,
					cache_read_tokens: cacheReadTokens,
					total_input_tokens: rawInputTokens,
				};
			}
		}

		// Build final response
		const contentParts: import("./types.ts").ContentPart[] = [];
		if (accumulatedText) {
			contentParts.push({ kind: ContentKind.TEXT, text: accumulatedText });
		}
		for (const tc of toolCalls.values()) {
			contentParts.push({
				kind: ContentKind.TOOL_CALL,
				tool_call: {
					id: tc.id,
					name: tc.name,
					arguments: safeParseJSON(tc.args),
				},
			});
		}

		const hasToolCalls = toolCalls.size > 0;
		const finishReason: FinishReason = hasToolCalls ? { reason: "tool_calls" } : { reason: "stop" };

		const finalResponse: Response = {
			id: "",
			model: request.model,
			provider: this.kind,
			message: { role: "assistant", content: contentParts },
			finish_reason: finishReason,
			usage: usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		};

		yield {
			type: "finish",
			finish_reason: finishReason,
			usage: finalResponse.usage,
			response: finalResponse,
		};
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

		if (toolCalls.size > 0) {
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

// ---------------------------------------------------------------------------
// Request building (Responses API format)
// ---------------------------------------------------------------------------

type ResponsesInput = OpenAI.Responses.ResponseInputItem[];

export function buildResponsesInput(request: Request): ResponsesInput {
	const input: ResponsesInput = [];

	for (const msg of request.messages) {
		if (msg.role === "system" || msg.role === "developer") {
			// System messages go to the `instructions` param, handled separately
			continue;
		}

		if (msg.role === "user") {
			const textParts = msg.content
				.filter((p) => p.kind === ContentKind.TEXT && p.text)
				.map((p) => ({ type: "input_text" as const, text: p.text! }));

			const imageParts = msg.content
				.filter((p) => p.kind === ContentKind.IMAGE && p.image)
				.map((p) => {
					if (p.image!.data) {
						const b64 = Buffer.from(p.image!.data).toString("base64");
						const mime = p.image!.media_type ?? "image/png";
						return {
							type: "input_image" as const,
							image_url: `data:${mime};base64,${b64}`,
						};
					}
					return {
						type: "input_image" as const,
						image_url: p.image!.url!,
					};
				});

			input.push({
				type: "message",
				role: "user",
				content: [...textParts, ...imageParts] as any,
			});
		} else if (msg.role === "assistant") {
			// Assistant messages: text and tool calls
			const textParts = msg.content.filter((p) => p.kind === ContentKind.TEXT && p.text);
			const toolCallParts = msg.content.filter(
				(p) => p.kind === ContentKind.TOOL_CALL && p.tool_call,
			);

			if (textParts.length > 0) {
				input.push({
					type: "message",
					role: "assistant",
					content: textParts.map((p) => ({
						type: "output_text" as const,
						text: p.text!,
					})) as any,
				});
			}

			for (const tc of toolCallParts) {
				input.push({
					type: "function_call",
					call_id: tc.tool_call!.id,
					name: tc.tool_call!.name,
					arguments:
						typeof tc.tool_call!.arguments === "string"
							? tc.tool_call!.arguments
							: JSON.stringify(tc.tool_call!.arguments),
				} as any);
			}
		} else if (msg.role === "tool") {
			// Tool results
			for (const part of msg.content) {
				if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
					input.push({
						type: "function_call_output",
						call_id: part.tool_result.tool_call_id,
						output:
							typeof part.tool_result.content === "string"
								? part.tool_result.content
								: JSON.stringify(part.tool_result.content),
					});
				}
			}
		}
	}

	return input;
}

export function buildResponsesParams(
	request: Request,
	input: ResponsesInput,
): OpenAI.Responses.ResponseCreateParams {
	// Extract system/developer messages for instructions
	const instructions = request.messages
		.filter((m) => m.role === "system" || m.role === "developer")
		.flatMap((m) => m.content.filter((p) => p.kind === ContentKind.TEXT).map((p) => p.text ?? ""))
		.join("\n");

	const params: OpenAI.Responses.ResponseCreateParams = {
		model: request.model,
		input,
	};

	if (instructions) {
		params.instructions = instructions;
	}

	if (request.max_tokens) {
		params.max_output_tokens = request.max_tokens;
	}

	if (request.temperature !== undefined) {
		params.temperature = request.temperature;
	}

	if (request.top_p !== undefined) {
		params.top_p = request.top_p;
	}

	if (request.tools?.length) {
		params.tools = request.tools.map((t) => ({
			type: "function" as const,
			name: t.name,
			description: t.description,
			parameters: t.parameters as any,
			strict: false,
		}));
	}

	if (request.tool_choice) {
		if (request.tool_choice === "auto") {
			params.tool_choice = "auto";
		} else if (request.tool_choice === "none") {
			params.tool_choice = "none";
		} else if (request.tool_choice === "required") {
			params.tool_choice = "required";
		} else if (typeof request.tool_choice === "object") {
			params.tool_choice = {
				type: "function",
				name: request.tool_choice.name,
			};
		}
	}

	// Reasoning effort passthrough
	if (request.reasoning_effort) {
		(params as any).reasoning = { effort: request.reasoning_effort };
	}

	const openaiOpts = asRecord(request.provider_options?.openai);
	if (typeof openaiOpts.prompt_cache_key === "string" && openaiOpts.prompt_cache_key.trim()) {
		(params as any).prompt_cache_key = openaiOpts.prompt_cache_key.trim();
	}
	if (
		openaiOpts.prompt_cache_retention === "in_memory" ||
		openaiOpts.prompt_cache_retention === "24h"
	) {
		(params as any).prompt_cache_retention = openaiOpts.prompt_cache_retention;
	}

	return params;
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

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseResponsesResponse(raw: OpenAI.Responses.Response, provider: ProviderKind): Response {
	const contentParts: import("./types.ts").ContentPart[] = [];
	let hasToolCalls = false;

	for (const item of raw.output) {
		if (item.type === "message") {
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

	const finishReason: FinishReason = hasToolCalls
		? { reason: "tool_calls", raw: raw.status ?? undefined }
		: mapOpenAIFinishReason(raw.status ?? "completed");
	const rawInputTokens = raw.usage?.input_tokens ?? 0;
	const cacheReadTokens = cachedInputTokens(raw.usage) ?? 0;
	const outputTokens = raw.usage?.output_tokens ?? 0;

	const usage: Usage = {
		input_tokens: Math.max(0, rawInputTokens - cacheReadTokens),
		output_tokens: outputTokens,
		total_tokens: rawInputTokens + outputTokens,
		reasoning_tokens: (raw.usage as any)?.output_tokens_details?.reasoning_tokens,
		cache_read_tokens: cacheReadTokens,
		total_input_tokens: rawInputTokens,
	};

	return {
		id: raw.id,
		model: raw.model,
		provider,
		message: { role: "assistant", content: contentParts },
		finish_reason: finishReason,
		usage,
		raw: raw as unknown as Record<string, unknown>,
	};
}

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
	const finishReason =
		contentParts.some((part) => part.kind === ContentKind.TOOL_CALL) ||
		message.tool_calls?.length > 0
			? ({ reason: "tool_calls", raw: choice?.finish_reason } as FinishReason)
			: mapChatFinishReason(choice?.finish_reason ?? "stop");

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

function cachedInputTokens(usage: unknown): number | undefined {
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

function mapOpenAIFinishReason(status: string): FinishReason {
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

function safeParseJSON(s: string): Record<string, unknown> {
	try {
		return JSON.parse(s);
	} catch {
		return { raw: s };
	}
}

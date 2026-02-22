import Anthropic from "@anthropic-ai/sdk";
import {
	ContentKind,
	type FinishReason,
	type Message,
	type ProviderAdapter,
	type Request,
	type Response,
	type StreamEvent,
	type Usage,
} from "./types.ts";

/**
 * Anthropic adapter using the native Messages API.
 * Supports extended thinking, prompt caching, and tool calling.
 */
export class AnthropicAdapter implements ProviderAdapter {
	readonly name = "anthropic";
	private client: Anthropic;

	constructor(apiKey: string, baseUrl?: string) {
		this.client = new Anthropic({
			apiKey,
			baseURL: baseUrl,
		});
	}

	async complete(request: Request): Promise<Response> {
		const { system, messages } = extractSystemAndMessages(request.messages);
		const anthropicRequest = buildAnthropicRequest(request, system, messages);

		const raw = await this.client.messages.create({
			...anthropicRequest,
			stream: false,
		});

		return parseAnthropicResponse(raw);
	}

	async *stream(request: Request): AsyncIterable<StreamEvent> {
		const { system, messages } = extractSystemAndMessages(request.messages);
		const anthropicRequest = buildAnthropicRequest(request, system, messages);

		const stream = this.client.messages.stream(anthropicRequest);

		yield { type: "stream_start" };

		for await (const event of stream) {
			if (event.type === "message_start") {
				// Token counts will come from the final message
			} else if (event.type === "content_block_start") {
				if (event.content_block.type === "text") {
					yield { type: "text_start" };
				} else if (event.content_block.type === "tool_use") {
					yield {
						type: "tool_call_start",
						tool_call: {
							id: event.content_block.id,
							name: event.content_block.name,
						},
					};
				} else if (event.content_block.type === "thinking") {
					yield { type: "reasoning_start" };
				}
			} else if (event.type === "content_block_delta") {
				if (event.delta.type === "text_delta") {
					yield { type: "text_delta", delta: event.delta.text };
				} else if (event.delta.type === "input_json_delta") {
					yield {
						type: "tool_call_delta",
						delta: event.delta.partial_json,
					};
				} else if (event.delta.type === "thinking_delta") {
					yield {
						type: "reasoning_delta",
						reasoning_delta: event.delta.thinking,
					};
				}
			} else if (event.type === "content_block_stop") {
				// We don't know which type stopped without tracking state,
				// but that's fine — consumers use start/delta/end lifecycle
			} else if (event.type === "message_delta") {
				// Usage will be gathered from finalMessage
			} else if (event.type === "message_stop") {
				// Final event — gather the full message
			}
		}

		// Get final message for the finish event
		const finalMessage = await stream.finalMessage();
		const response = parseAnthropicResponse(finalMessage);

		yield {
			type: "finish",
			finish_reason: response.finish_reason,
			usage: response.usage,
			response,
		};
	}
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface ExtractedMessages {
	system: string | undefined;
	messages: Message[];
}

function extractSystemAndMessages(messages: Message[]): ExtractedMessages {
	let system: string | undefined;
	const filtered: Message[] = [];

	for (const msg of messages) {
		if (msg.role === "system" || msg.role === "developer") {
			const text = msg.content
				.filter((p) => p.kind === ContentKind.TEXT)
				.map((p) => p.text ?? "")
				.join("\n");
			system = system ? `${system}\n${text}` : text;
		} else {
			filtered.push(msg);
		}
	}

	return { system, messages: filtered };
}

function buildAnthropicRequest(
	request: Request,
	system: string | undefined,
	messages: Message[],
): Anthropic.MessageCreateParams {
	const params: Anthropic.MessageCreateParams = {
		model: request.model,
		max_tokens: request.max_tokens ?? 4096,
		messages: convertMessages(messages),
	};

	if (system) {
		params.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
	}

	if (request.tools?.length) {
		params.tools = request.tools.map((t, i) => {
			const tool: Anthropic.Tool = {
				name: t.name,
				description: t.description,
				input_schema: t.parameters as Anthropic.Tool["input_schema"],
			};
			// Cache breakpoint on the last tool definition
			if (i === request.tools!.length - 1) {
				tool.cache_control = { type: "ephemeral" };
			}
			return tool;
		});
	}

	if (request.tool_choice) {
		if (request.tool_choice === "auto") {
			params.tool_choice = { type: "auto" };
		} else if (request.tool_choice === "required") {
			params.tool_choice = { type: "any" };
		} else if (request.tool_choice === "none") {
			// Anthropic: omit tools entirely
			params.tools = undefined;
		} else if (typeof request.tool_choice === "object") {
			params.tool_choice = { type: "tool", name: request.tool_choice.name };
		}
	}

	if (request.temperature !== undefined) {
		params.temperature = request.temperature;
	}

	if (request.stop_sequences) {
		params.stop_sequences = request.stop_sequences;
	}

	// Extended thinking and beta headers via provider_options
	const anthropicOpts = request.provider_options?.anthropic as Record<string, unknown> | undefined;
	if (anthropicOpts?.thinking) {
		(params as any).thinking = anthropicOpts.thinking;
		// Anthropic requires temperature to be unset when thinking is enabled
		delete (params as any).temperature;
	}
	if (anthropicOpts?.betas) {
		(params as any).betas = anthropicOpts.betas;
	}

	return params;
}

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
	const result: Anthropic.MessageParam[] = [];

	for (const msg of messages) {
		const role = msg.role === "tool" ? "user" : (msg.role as "user" | "assistant");
		const content = convertContentParts(msg);

		// Anthropic requires strict alternation — merge consecutive same-role messages
		if (result.length > 0 && result[result.length - 1]!.role === role) {
			const prev = result[result.length - 1]!;
			const prevContent = Array.isArray(prev.content)
				? prev.content
				: [{ type: "text" as const, text: prev.content }];
			const newContent = Array.isArray(content)
				? content
				: [{ type: "text" as const, text: content }];
			prev.content = [...prevContent, ...newContent];
		} else {
			result.push({ role, content });
		}
	}

	return result;
}

function convertContentParts(msg: Message): Anthropic.ContentBlockParam[] {
	const parts: Anthropic.ContentBlockParam[] = [];

	for (const part of msg.content) {
		if (part.kind === ContentKind.TEXT && part.text) {
			parts.push({ type: "text", text: part.text });
		} else if (part.kind === ContentKind.TOOL_CALL && part.tool_call) {
			parts.push({
				type: "tool_use",
				id: part.tool_call.id,
				name: part.tool_call.name,
				input:
					typeof part.tool_call.arguments === "string"
						? JSON.parse(part.tool_call.arguments)
						: part.tool_call.arguments,
			});
		} else if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
			parts.push({
				type: "tool_result",
				tool_use_id: part.tool_result.tool_call_id,
				content:
					typeof part.tool_result.content === "string"
						? part.tool_result.content
						: JSON.stringify(part.tool_result.content),
				is_error: part.tool_result.is_error || undefined,
			});
		} else if (part.kind === ContentKind.THINKING && part.thinking) {
			parts.push({
				type: "thinking",
				thinking: part.thinking.text,
				signature: part.thinking.signature ?? "",
			});
		} else if (part.kind === ContentKind.REDACTED_THINKING && part.thinking) {
			parts.push({
				type: "redacted_thinking",
				data: part.thinking.text,
			});
		} else if (part.kind === ContentKind.IMAGE && part.image) {
			if (part.image.data) {
				parts.push({
					type: "image",
					source: {
						type: "base64",
						media_type: (part.image.media_type ?? "image/png") as "image/png",
						data: Buffer.from(part.image.data).toString("base64"),
					},
				});
			} else if (part.image.url) {
				parts.push({
					type: "image",
					source: {
						type: "url",
						url: part.image.url,
					},
				});
			}
		}
	}

	return parts;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseAnthropicResponse(raw: Anthropic.Message): Response {
	const contentParts = parseContentBlocks(raw.content);

	const finishReason = mapFinishReason(raw.stop_reason);

	const usage: Usage = {
		input_tokens: raw.usage.input_tokens,
		output_tokens: raw.usage.output_tokens,
		total_tokens: raw.usage.input_tokens + raw.usage.output_tokens,
		cache_read_tokens: (raw.usage as any).cache_read_input_tokens,
		cache_write_tokens: (raw.usage as any).cache_creation_input_tokens,
	};

	return {
		id: raw.id,
		model: raw.model,
		provider: "anthropic",
		message: {
			role: "assistant",
			content: contentParts,
		},
		finish_reason: finishReason,
		usage,
		raw: raw as unknown as Record<string, unknown>,
	};
}

function parseContentBlocks(blocks: Anthropic.ContentBlock[]): import("./types.ts").ContentPart[] {
	return blocks.map((block) => {
		if (block.type === "text") {
			return { kind: ContentKind.TEXT, text: block.text };
		}
		if (block.type === "tool_use") {
			return {
				kind: ContentKind.TOOL_CALL,
				tool_call: {
					id: block.id,
					name: block.name,
					arguments: block.input as Record<string, unknown>,
				},
			};
		}
		if (block.type === "thinking") {
			return {
				kind: ContentKind.THINKING,
				thinking: {
					text: block.thinking,
					signature: block.signature,
				},
			};
		}
		if (block.type === "redacted_thinking") {
			return {
				kind: ContentKind.REDACTED_THINKING,
				thinking: {
					text: block.data,
					redacted: true,
				},
			};
		}
		return { kind: block.type as string, text: JSON.stringify(block) };
	});
}

function mapFinishReason(stopReason: string | null): FinishReason {
	switch (stopReason) {
		case "end_turn":
		case "stop_sequence":
			return { reason: "stop", raw: stopReason };
		case "max_tokens":
			return { reason: "length", raw: stopReason };
		case "tool_use":
			return { reason: "tool_calls", raw: stopReason };
		default:
			return { reason: "other", raw: stopReason ?? undefined };
	}
}

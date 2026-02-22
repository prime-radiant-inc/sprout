import OpenAI from "openai";
import {
	ContentKind,
	type FinishReason,
	type ProviderAdapter,
	type Request,
	type Response,
	type StreamEvent,
	type Usage,
} from "./types.ts";

/**
 * OpenAI adapter using the Responses API (/v1/responses).
 * Required for reasoning token visibility and server-side conversation state.
 */
export class OpenAIAdapter implements ProviderAdapter {
	readonly name = "openai";
	private client: OpenAI;

	constructor(apiKey: string, baseUrl?: string) {
		this.client = new OpenAI({
			apiKey,
			baseURL: baseUrl,
		});
	}

	async complete(request: Request): Promise<Response> {
		const input = buildResponsesInput(request);
		const params = buildResponsesParams(request, input);

		const raw = await this.client.responses.create({ ...params, stream: false });
		return parseResponsesResponse(raw);
	}

	async *stream(request: Request): AsyncIterable<StreamEvent> {
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
				usage = {
					input_tokens: resp.usage?.input_tokens ?? 0,
					output_tokens: resp.usage?.output_tokens ?? 0,
					total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
					reasoning_tokens: (resp.usage as any)?.output_tokens_details?.reasoning_tokens,
					cache_read_tokens: (resp.usage as any)?.prompt_tokens_details?.cached_tokens,
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
			provider: "openai",
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
}

// ---------------------------------------------------------------------------
// Request building (Responses API format)
// ---------------------------------------------------------------------------

type ResponsesInput = OpenAI.Responses.ResponseInputItem[];

function buildResponsesInput(request: Request): ResponsesInput {
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

function buildResponsesParams(
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

	return params;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseResponsesResponse(raw: OpenAI.Responses.Response): Response {
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

	const usage: Usage = {
		input_tokens: raw.usage?.input_tokens ?? 0,
		output_tokens: raw.usage?.output_tokens ?? 0,
		total_tokens: (raw.usage?.input_tokens ?? 0) + (raw.usage?.output_tokens ?? 0),
		reasoning_tokens: (raw.usage as any)?.output_tokens_details?.reasoning_tokens,
		cache_read_tokens: (raw.usage as any)?.prompt_tokens_details?.cached_tokens,
	};

	return {
		id: raw.id,
		model: raw.model,
		provider: "openai",
		message: { role: "assistant", content: contentParts },
		finish_reason: finishReason,
		usage,
		raw: raw as unknown as Record<string, unknown>,
	};
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

import type { Content, FunctionCall, GenerateContentConfig, Part } from "@google/genai";
import { GoogleGenAI } from "@google/genai";
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

// Gemini doesn't assign unique IDs to function calls.
// We generate synthetic ones and track the mapping.
let callIdCounter = 0;
function nextCallId(): string {
	return `call_gemini_${++callIdCounter}`;
}

// Map from synthetic call IDs to function names (for tool result round-trips)
const callIdToName = new Map<string, string>();

/**
 * Gemini adapter using the native Gemini API.
 * Supports tool calling, system instructions, and streaming.
 */
export class GeminiAdapter implements ProviderAdapter {
	readonly name = "gemini";
	private client: GoogleGenAI;

	constructor(apiKey: string) {
		this.client = new GoogleGenAI({ apiKey });
	}

	async complete(request: Request): Promise<Response> {
		const { systemInstruction, contents, config } = buildGeminiRequest(request);

		const result = await this.client.models.generateContent({
			model: request.model,
			contents,
			config: {
				...config,
				systemInstruction,
			},
		});

		return parseGeminiResponse(result, request.model);
	}

	async *stream(request: Request): AsyncIterable<StreamEvent> {
		const { systemInstruction, contents, config } = buildGeminiRequest(request);

		const stream = await this.client.models.generateContentStream({
			model: request.model,
			contents,
			config: {
				...config,
				systemInstruction,
			},
		});

		yield { type: "stream_start" };

		let accumulatedText = "";
		const toolCalls: import("./types.ts").ContentPart[] = [];
		let usage: Usage | undefined;

		for await (const chunk of stream) {
			if (chunk.candidates?.[0]?.content?.parts) {
				for (const part of chunk.candidates[0].content.parts) {
					if (part.text) {
						yield { type: "text_delta", delta: part.text };
						accumulatedText += part.text;
					}
					if (part.functionCall) {
						const callId = nextCallId();
						callIdToName.set(callId, part.functionCall.name!);
						toolCalls.push({
							kind: ContentKind.TOOL_CALL,
							tool_call: {
								id: callId,
								name: part.functionCall.name!,
								arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
							},
						});
						yield {
							type: "tool_call_start",
							tool_call: {
								id: callId,
								name: part.functionCall.name!,
								arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
							},
						};
						yield { type: "tool_call_end" };
					}
				}
			}

			if (chunk.usageMetadata) {
				usage = {
					input_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
					output_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
					total_tokens: chunk.usageMetadata.totalTokenCount ?? 0,
					reasoning_tokens: (chunk.usageMetadata as any).thoughtsTokenCount,
					cache_read_tokens: (chunk.usageMetadata as any).cachedContentTokenCount,
				};
			}
		}

		// Build final response
		const contentParts: import("./types.ts").ContentPart[] = [];
		if (accumulatedText) {
			contentParts.push({ kind: ContentKind.TEXT, text: accumulatedText });
		}
		contentParts.push(...toolCalls);

		const hasToolCalls = toolCalls.length > 0;
		const finishReason: FinishReason = hasToolCalls ? { reason: "tool_calls" } : { reason: "stop" };

		const finalResponse: Response = {
			id: "",
			model: request.model,
			provider: "gemini",
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
// Request building
// ---------------------------------------------------------------------------

interface GeminiRequest {
	systemInstruction: string | undefined;
	contents: Content[];
	config: GenerateContentConfig;
}

function buildGeminiRequest(request: Request): GeminiRequest {
	// Extract system instruction
	const systemParts = request.messages
		.filter((m) => m.role === "system" || m.role === "developer")
		.flatMap((m) => m.content.filter((p) => p.kind === ContentKind.TEXT).map((p) => p.text ?? ""));
	const systemInstruction = systemParts.length > 0 ? systemParts.join("\n") : undefined;

	// Convert non-system messages to Gemini contents
	const contents = convertToContents(
		request.messages.filter((m) => m.role !== "system" && m.role !== "developer"),
	);

	// Build config
	const config: GenerateContentConfig = {};

	if (request.max_tokens) {
		config.maxOutputTokens = request.max_tokens;
	}

	if (request.temperature !== undefined) {
		config.temperature = request.temperature;
	}

	if (request.top_p !== undefined) {
		config.topP = request.top_p;
	}

	if (request.stop_sequences) {
		config.stopSequences = request.stop_sequences;
	}

	if (request.tools?.length) {
		config.tools = [
			{
				functionDeclarations: request.tools.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters as any,
				})),
			},
		];
	}

	// Thinking config via provider_options
	const geminiOpts = request.provider_options?.gemini as Record<string, unknown> | undefined;
	if (geminiOpts?.thinkingConfig) {
		config.thinkingConfig = geminiOpts.thinkingConfig as any;
	}

	return { systemInstruction, contents, config };
}

function convertToContents(messages: Message[]): Content[] {
	const contents: Content[] = [];

	for (const msg of messages) {
		const role = msg.role === "assistant" ? "model" : "user";
		const parts = convertToParts(msg);

		// Gemini doesn't enforce strict alternation, but merge consecutive same-role
		if (contents.length > 0 && contents[contents.length - 1]!.role === role) {
			const prev = contents[contents.length - 1]!;
			prev.parts = [...(prev.parts ?? []), ...parts];
		} else {
			contents.push({ role, parts });
		}
	}

	return contents;
}

function convertToParts(msg: Message): Part[] {
	const parts: Part[] = [];

	if (msg.role === "tool") {
		// Tool results become functionResponse parts in a "user" message
		for (const part of msg.content) {
			if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
				const name = callIdToName.get(part.tool_result.tool_call_id) ?? "unknown";
				const content =
					typeof part.tool_result.content === "string"
						? { result: part.tool_result.content }
						: part.tool_result.content;
				parts.push({
					functionResponse: {
						name,
						response: content as Record<string, unknown>,
					},
				});
			}
		}
		return parts;
	}

	for (const part of msg.content) {
		if (part.kind === ContentKind.TEXT && part.text) {
			parts.push({ text: part.text });
		} else if (part.kind === ContentKind.IMAGE && part.image) {
			if (part.image.data) {
				parts.push({
					inlineData: {
						mimeType: part.image.media_type ?? "image/png",
						data: Buffer.from(part.image.data).toString("base64"),
					},
				});
			}
		} else if (part.kind === ContentKind.TOOL_CALL && part.tool_call) {
			parts.push({
				functionCall: {
					name: part.tool_call.name,
					args:
						typeof part.tool_call.arguments === "string"
							? JSON.parse(part.tool_call.arguments)
							: part.tool_call.arguments,
				} as FunctionCall,
			});
		}
	}

	return parts;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseGeminiResponse(raw: any, model: string): Response {
	const contentParts: import("./types.ts").ContentPart[] = [];
	let hasToolCalls = false;

	const candidate = raw.candidates?.[0];
	if (candidate?.content?.parts) {
		for (const part of candidate.content.parts) {
			if (part.text) {
				contentParts.push({ kind: ContentKind.TEXT, text: part.text });
			}
			if (part.functionCall) {
				hasToolCalls = true;
				const callId = nextCallId();
				callIdToName.set(callId, part.functionCall.name);
				contentParts.push({
					kind: ContentKind.TOOL_CALL,
					tool_call: {
						id: callId,
						name: part.functionCall.name,
						arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
					},
				});
			}
		}
	}

	const finishReason = hasToolCalls
		? ({ reason: "tool_calls" } as FinishReason)
		: mapGeminiFinishReason(candidate?.finishReason);

	const usage: Usage = {
		input_tokens: raw.usageMetadata?.promptTokenCount ?? 0,
		output_tokens: raw.usageMetadata?.candidatesTokenCount ?? 0,
		total_tokens: raw.usageMetadata?.totalTokenCount ?? 0,
		reasoning_tokens: raw.usageMetadata?.thoughtsTokenCount,
		cache_read_tokens: raw.usageMetadata?.cachedContentTokenCount,
	};

	return {
		id: "",
		model,
		provider: "gemini",
		message: { role: "assistant", content: contentParts },
		finish_reason: finishReason,
		usage,
		raw,
	};
}

function mapGeminiFinishReason(reason: string | undefined): FinishReason {
	switch (reason) {
		case "STOP":
			return { reason: "stop", raw: reason };
		case "MAX_TOKENS":
			return { reason: "length", raw: reason };
		case "SAFETY":
		case "RECITATION":
			return { reason: "content_filter", raw: reason };
		default:
			return { reason: "stop", raw: reason };
	}
}

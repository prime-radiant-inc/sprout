import type OpenAI from "openai";
import { asRecord } from "../../util/record.ts";
import { ContentKind, type Request } from "../types.ts";

export type ResponsesInput = OpenAI.Responses.ResponseInputItem[];

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
			// Assistant messages: opaque reasoning items, text, and tool calls.
			// Replay each part in its original captured order so reasoning items stay
			// adjacent to the call they precede; reasoning is replayed verbatim
			// (encrypted_content and all).
			for (const part of msg.content) {
				if (
					part.kind === ContentKind.PROVIDER_STATE &&
					part.provider_state?.block_type === "reasoning"
				) {
					input.push(part.provider_state.data as unknown as OpenAI.Responses.ResponseInputItem);
				} else if (part.kind === ContentKind.TEXT && part.text) {
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text" as const, text: part.text }],
					} as any);
				} else if (part.kind === ContentKind.TOOL_CALL && part.tool_call) {
					input.push({
						type: "function_call",
						call_id: part.tool_call.id,
						name: part.tool_call.name,
						arguments:
							typeof part.tool_call.arguments === "string"
								? part.tool_call.arguments
								: JSON.stringify(part.tool_call.arguments),
					} as any);
				}
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

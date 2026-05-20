import type OpenAI from "openai";
import type { ProviderKind } from "../../shared/provider-settings.ts";
import {
	ContentKind,
	type ContentPart,
	type FinishReason,
	type Request,
	type Response,
	type StreamEvent,
	type ToolCall,
	type Usage,
} from "../types.ts";
import { mapOpenAIFinishReason, parseResponsesUsage, safeParseJSON } from "./responses-parse.ts";

interface StreamResponsesOptions {
	stream: AsyncIterable<unknown>;
	request: Request;
	provider: ProviderKind;
}

interface ToolCallAccumulator {
	itemId: string;
	callId: string;
	name: string;
	args: string;
	sawArgumentDelta: boolean;
	argumentsDone: boolean;
	outputDone: boolean;
	emittedEnd: boolean;
}

export async function* streamResponsesEvents({
	stream,
	request,
	provider,
}: StreamResponsesOptions): AsyncIterable<StreamEvent> {
	yield { type: "stream_start" };

	let accumulatedText = "";
	let sawTextDelta = false;
	let textEnded = false;
	const toolCallsByItemId = new Map<string, ToolCallAccumulator>();
	const toolCallsByCallId = new Map<string, ToolCallAccumulator>();
	const toolCallOrder: ToolCallAccumulator[] = [];
	let completedResponse: OpenAI.Responses.Response | undefined;
	let usage: Usage | undefined;

	for await (const rawEvent of stream) {
		const event = asRecord(rawEvent);
		if (!event) continue;

		if (event.type === "response.output_text.delta") {
			const delta = stringValue(event.delta);
			if (delta === undefined) continue;
			accumulatedText += delta;
			sawTextDelta = true;
			textEnded = false;
			yield { type: "text_delta", delta };
		} else if (event.type === "response.output_text.done") {
			if (sawTextDelta && !textEnded) {
				textEnded = true;
				yield { type: "text_end" };
			}
		} else if (event.type === "response.output_item.added") {
			const item = asRecord(event.item);
			if (item?.type === "function_call") {
				updateToolCallFromItem(
					ensureToolCall({
						itemId: stringValue(item.id),
						callId: stringValue(item.call_id),
					}),
					item,
				);
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const delta = stringValue(event.delta);
			if (delta === undefined) continue;
			const call = ensureToolCall({ itemId: stringValue(event.item_id) });
			call.args += delta;
			call.sawArgumentDelta = true;
			yield { type: "tool_call_delta", delta };
		} else if (event.type === "response.function_call_arguments.done") {
			const call = ensureToolCall({ itemId: stringValue(event.item_id) });
			const args = stringValue(event.arguments);
			if (args !== undefined) {
				call.args = args;
			}
			call.argumentsDone = true;
			const doneEvent = maybeFinishToolCall(call);
			if (doneEvent) yield doneEvent;
		} else if (event.type === "response.output_item.done") {
			const item = asRecord(event.item);
			if (item?.type === "message") {
				if (sawTextDelta && !textEnded) {
					textEnded = true;
					yield { type: "text_end" };
				}
			} else if (item?.type === "function_call") {
				const call = ensureToolCall({
					itemId: stringValue(item.id),
					callId: stringValue(item.call_id),
				});
				updateToolCallFromItem(call, item);
				call.outputDone = true;
				const doneEvent = maybeFinishToolCall(call);
				if (doneEvent) yield doneEvent;
			}
		} else if (event.type === "response.completed") {
			completedResponse = event.response as OpenAI.Responses.Response | undefined;
			usage = parseResponsesUsage(completedResponse?.usage);
		}
	}

	if (sawTextDelta && !textEnded) {
		yield { type: "text_end" };
	}

	for (const call of toolCallOrder) {
		if (!call.emittedEnd) {
			yield finishToolCall(call);
		}
	}

	const contentParts: ContentPart[] = [];
	if (accumulatedText) {
		contentParts.push({ kind: ContentKind.TEXT, text: accumulatedText });
	}
	for (const call of toolCallOrder) {
		contentParts.push({ kind: ContentKind.TOOL_CALL, tool_call: toolCallFromAccumulator(call) });
	}

	const hasToolCalls = toolCallOrder.length > 0;
	const finishReason: FinishReason = hasToolCalls
		? { reason: "tool_calls", raw: completedResponse?.status ?? undefined }
		: mapOpenAIFinishReason(completedResponse?.status ?? "completed");

	const finalResponse: Response = {
		id: completedResponse?.id ?? "",
		model: completedResponse?.model ?? request.model,
		provider,
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

	function ensureToolCall({
		itemId,
		callId,
	}: {
		itemId?: string;
		callId?: string;
	}): ToolCallAccumulator {
		let call =
			(itemId ? toolCallsByItemId.get(itemId) : undefined) ??
			(callId ? toolCallsByCallId.get(callId) : undefined);
		if (!call) {
			const fallbackId = callId ?? itemId ?? "";
			call = {
				itemId: itemId ?? fallbackId,
				callId: fallbackId,
				name: "",
				args: "",
				sawArgumentDelta: false,
				argumentsDone: false,
				outputDone: false,
				emittedEnd: false,
			};
			toolCallOrder.push(call);
		}
		if (itemId) {
			call.itemId = itemId;
			toolCallsByItemId.set(itemId, call);
		}
		if (callId && call.callId !== callId) {
			toolCallsByCallId.delete(call.callId);
			call.callId = callId;
		}
		if (call.callId) {
			toolCallsByCallId.set(call.callId, call);
		}
		return call;
	}
}

function updateToolCallFromItem(call: ToolCallAccumulator, item: Record<string, unknown>): void {
	const callId = stringValue(item.call_id);
	if (callId) {
		call.callId = callId;
	}
	const name = stringValue(item.name);
	if (name) {
		call.name = name;
	}
	const args = stringValue(item.arguments);
	if (args !== undefined) {
		call.args = args;
	}
}

function maybeFinishToolCall(call: ToolCallAccumulator): StreamEvent | undefined {
	if (call.emittedEnd || !call.outputDone) return undefined;
	if (!call.argumentsDone && call.sawArgumentDelta) return undefined;
	if (!call.argumentsDone && call.args.length === 0) return undefined;
	return finishToolCall(call);
}

function finishToolCall(call: ToolCallAccumulator): StreamEvent {
	call.emittedEnd = true;
	return { type: "tool_call_end", tool_call: toolCallFromAccumulator(call) };
}

function toolCallFromAccumulator(call: ToolCallAccumulator): ToolCall {
	return {
		id: call.callId,
		name: call.name,
		arguments: safeParseJSON(call.args),
	};
}

function asRecord(value: unknown): Record<string, any> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, any>;
	}
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

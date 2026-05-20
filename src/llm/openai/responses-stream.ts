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
	outputIndex: string;
	callId: string;
	hasCallId: boolean;
	name: string;
	args: string;
	sawArgumentDelta: boolean;
	argumentsDone: boolean;
	hasArgumentsFromDoneItem: boolean;
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
	const toolCallsByOutputIndex = new Map<string, ToolCallAccumulator>();
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
						outputIndex: outputIndexValue(event.output_index),
					}),
					item,
				);
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const delta = stringValue(event.delta);
			if (delta === undefined) continue;
			const call = ensureToolCall({
				itemId: stringValue(event.item_id),
				outputIndex: outputIndexValue(event.output_index),
			});
			call.args += delta;
			call.sawArgumentDelta = true;
			yield { type: "tool_call_delta", delta };
		} else if (event.type === "response.function_call_arguments.done") {
			const call = ensureToolCall({
				itemId: stringValue(event.item_id),
				outputIndex: outputIndexValue(event.output_index),
			});
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
					outputIndex: outputIndexValue(event.output_index),
				});
				updateToolCallFromItem(call, item);
				if (stringValue(item.arguments) !== undefined) {
					call.hasArgumentsFromDoneItem = true;
				}
				call.outputDone = true;
				const doneEvent = maybeFinishToolCall(call);
				if (doneEvent) yield doneEvent;
			}
		} else if (
			event.type === "response.completed" ||
			event.type === "response.incomplete" ||
			event.type === "response.failed"
		) {
			completedResponse = event.response as OpenAI.Responses.Response | undefined;
			usage = parseResponsesUsage(completedResponse?.usage);
		}
	}

	if (sawTextDelta && !textEnded) {
		yield { type: "text_end" };
	}

	for (const call of toolCallOrder) {
		if (!call.emittedEnd && isCompleteToolCall(call)) {
			yield finishToolCall(call);
		}
	}

	const completeToolCalls = toolCallOrder.filter(isCompleteToolCall);
	const contentParts: ContentPart[] = [];
	if (accumulatedText) {
		contentParts.push({ kind: ContentKind.TEXT, text: accumulatedText });
	}
	for (const call of completeToolCalls) {
		contentParts.push({ kind: ContentKind.TOOL_CALL, tool_call: toolCallFromAccumulator(call) });
	}

	const terminalStatus = completedResponse?.status ?? "completed";
	const hasCompleteToolCalls = completeToolCalls.length > 0;
	const finishReason: FinishReason =
		hasCompleteToolCalls && terminalStatus === "completed"
			? { reason: "tool_calls", raw: completedResponse?.status ?? undefined }
			: mapOpenAIFinishReason(terminalStatus);

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
		outputIndex,
	}: {
		itemId?: string;
		callId?: string;
		outputIndex?: string;
	}): ToolCallAccumulator {
		const candidates = new Set<ToolCallAccumulator>();
		if (outputIndex) {
			const call = toolCallsByOutputIndex.get(outputIndex);
			if (call) candidates.add(call);
		}
		if (itemId) {
			const call = toolCallsByItemId.get(itemId);
			if (call) candidates.add(call);
		}
		if (callId) {
			const call = toolCallsByCallId.get(callId);
			if (call) candidates.add(call);
		}

		let call: ToolCallAccumulator | undefined;
		for (const candidate of candidates) {
			call = call ? mergeToolCalls(call, candidate) : candidate;
		}
		if (!call) {
			const fallbackId = callId ?? itemId ?? outputIndex ?? "";
			call = {
				itemId: itemId ?? "",
				outputIndex: outputIndex ?? "",
				callId: fallbackId,
				hasCallId: callId !== undefined,
				name: "",
				args: "",
				sawArgumentDelta: false,
				argumentsDone: false,
				hasArgumentsFromDoneItem: false,
				outputDone: false,
				emittedEnd: false,
			};
			toolCallOrder.push(call);
		}
		applyToolCallKeys(call, { itemId, callId, outputIndex });
		rebuildToolCallIndexes();
		return call;
	}

	function applyToolCallKeys(
		call: ToolCallAccumulator,
		{
			itemId,
			callId,
			outputIndex,
		}: {
			itemId?: string;
			callId?: string;
			outputIndex?: string;
		},
	): void {
		if (outputIndex) {
			call.outputIndex = outputIndex;
		}
		if (itemId) {
			call.itemId = itemId;
			if (!call.hasCallId && (!call.callId || call.callId === call.outputIndex)) {
				call.callId = itemId;
			}
		}
		if (callId) {
			call.callId = callId;
			call.hasCallId = true;
		} else if (!call.callId) {
			call.callId = itemId ?? outputIndex ?? "";
		}
	}

	function mergeToolCalls(
		first: ToolCallAccumulator,
		second: ToolCallAccumulator,
	): ToolCallAccumulator {
		if (first === second) return first;

		const firstIndex = toolCallOrder.indexOf(first);
		const secondIndex = toolCallOrder.indexOf(second);
		const target =
			firstIndex >= 0 && secondIndex >= 0 && firstIndex <= secondIndex ? first : second;
		const source = target === first ? second : first;

		if (!target.itemId && source.itemId) target.itemId = source.itemId;
		if (!target.outputIndex && source.outputIndex) target.outputIndex = source.outputIndex;
		if (!target.hasCallId && source.hasCallId) {
			target.callId = source.callId;
			target.hasCallId = true;
		} else if (!target.callId && source.callId) {
			target.callId = source.callId;
		}
		if (!target.name && source.name) target.name = source.name;
		if (source.argumentsDone && !target.argumentsDone) {
			target.args = source.args;
		} else if (!target.args && source.args) {
			target.args = source.args;
		}
		target.sawArgumentDelta ||= source.sawArgumentDelta;
		target.argumentsDone ||= source.argumentsDone;
		target.hasArgumentsFromDoneItem ||= source.hasArgumentsFromDoneItem;
		target.outputDone ||= source.outputDone;
		target.emittedEnd ||= source.emittedEnd;

		const sourceIndex = toolCallOrder.indexOf(source);
		if (sourceIndex >= 0) {
			toolCallOrder.splice(sourceIndex, 1);
		}
		return target;
	}

	function rebuildToolCallIndexes(): void {
		toolCallsByItemId.clear();
		toolCallsByCallId.clear();
		toolCallsByOutputIndex.clear();
		for (const call of toolCallOrder) {
			if (call.itemId) toolCallsByItemId.set(call.itemId, call);
			if (call.callId) toolCallsByCallId.set(call.callId, call);
			if (call.outputIndex) toolCallsByOutputIndex.set(call.outputIndex, call);
		}
	}
}

function updateToolCallFromItem(call: ToolCallAccumulator, item: Record<string, unknown>): void {
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
	if (call.emittedEnd || !isCompleteToolCall(call)) return undefined;
	return finishToolCall(call);
}

function isCompleteToolCall(call: ToolCallAccumulator): boolean {
	return call.outputDone && (call.argumentsDone || call.hasArgumentsFromDoneItem);
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

function outputIndexValue(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isInteger(value)) {
		return String(value);
	}
	return stringValue(value);
}

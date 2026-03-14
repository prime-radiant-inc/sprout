import type { SessionEvent } from "../../kernel/types.ts";
import type { Message, Usage } from "../../llm/types.ts";
import { messageToolCalls } from "../../llm/types.ts";
import type { PricingSnapshot } from "../pricing-cache.ts";
import { buildAtifMetrics } from "./costs.ts";
import type { AtifObservation, AtifStep, AtifToolCall } from "./types.ts";

export interface MapSessionEventToAtifStepOptions {
	stepId: number;
	event: SessionEvent;
	pricingSnapshot?: PricingSnapshot | null;
}

export function mapSessionEventToAtifStep(
	options: MapSessionEventToAtifStepOptions,
): AtifStep | null {
	const { event } = options;
	if (event.kind === "llm_chunk") return null;

	const step: AtifStep = {
		step_id: options.stepId,
		timestamp: new Date(event.timestamp).toISOString(),
		source: resolveStepSource(event),
		message: resolveStepMessage(event),
		extra: {
			sprout_event: event,
		},
	};

	if (event.kind === "plan_end") {
		const reasoning = event.data.reasoning;
		if (typeof reasoning === "string" && reasoning.length > 0) {
			step.reasoning_content = reasoning;
		}
		const toolCalls = extractToolCalls(event.data.assistant_message);
		if (toolCalls.length > 0) {
			step.tool_calls = toolCalls;
		}
	}

	if (event.kind === "llm_end") {
		const modelName = event.data.model;
		const providerId = event.data.provider;
		if (typeof modelName === "string" && modelName.length > 0) {
			step.model_name = modelName;
		}
		if (typeof modelName === "string" && typeof providerId === "string") {
			step.metrics = buildAtifMetrics({
				providerId,
				modelId: modelName,
				usage: buildUsage(event.data),
				pricingSnapshot: options.pricingSnapshot,
			});
		}
	}

	const observation = extractObservation(event);
	if (observation) {
		step.observation = observation;
	}

	return step;
}

function resolveStepSource(event: SessionEvent): AtifStep["source"] {
	if (event.kind === "perceive") {
		return "user";
	}
	if (event.kind === "plan_end") {
		return "agent";
	}
	return "system";
}

function resolveStepMessage(event: SessionEvent): string {
	if (event.kind === "perceive") {
		const goal = event.data.goal;
		if (typeof goal === "string" && goal.length > 0) return goal;
	}
	if (event.kind === "plan_end") {
		const text = event.data.text;
		if (typeof text === "string" && text.length > 0) return text;
	}
	const message = event.data.message;
	if (typeof message === "string" && message.length > 0) return message;
	const error = event.data.error;
	if (typeof error === "string" && error.length > 0) return error;
	const goal = event.data.goal;
	if (typeof goal === "string" && goal.length > 0) return goal;
	const summary = event.data.summary;
	if (typeof summary === "string" && summary.length > 0) return summary;
	return event.kind;
}

function extractToolCalls(message: unknown): AtifToolCall[] {
	if (!isMessage(message)) {
		return [];
	}
	return messageToolCalls(message).map((toolCall) => ({
		tool_call_id: toolCall.id,
		function_name: toolCall.name,
		arguments: toolCall.arguments,
	}));
}

function extractObservation(event: SessionEvent): AtifObservation | undefined {
	if (event.kind !== "primitive_end" && event.kind !== "act_end") {
		return undefined;
	}
	const toolResultMessage = extractToolResultMessage(event.data.tool_result_message);
	if (toolResultMessage) {
		return {
			results: [toolResultMessage],
		};
	}
	const output = event.data.output;
	if (typeof output === "string") {
		return {
			results: [{ content: output }],
		};
	}
	return undefined;
}

function extractToolResultMessage(message: unknown):
	| {
			source_call_id?: string;
			content?: string;
	  }
	| undefined {
	if (!isMessage(message)) {
		return undefined;
	}
	const sourceCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
	for (const part of message.content) {
		if (part.kind !== "tool_result" || !part.tool_result) continue;
		const content = part.tool_result.content;
		return {
			source_call_id: sourceCallId ?? part.tool_result.tool_call_id,
			content: typeof content === "string" ? content : JSON.stringify(content),
		};
	}
	return undefined;
}

function buildUsage(data: Record<string, unknown>): Usage & Record<string, unknown> {
	const usage: Usage & Record<string, unknown> = {
		input_tokens: readNumber(data.input_tokens),
		output_tokens: readNumber(data.output_tokens),
		total_tokens:
			readOptionalNumber(data.total_tokens) ??
			readNumber(data.input_tokens) + readNumber(data.output_tokens),
	};

	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "number") {
			usage[key] = value;
		}
	}

	return usage;
}

function readNumber(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function readOptionalNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function isMessage(value: unknown): value is Message {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Message;
	return Array.isArray(candidate.content);
}

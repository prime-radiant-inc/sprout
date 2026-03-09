import type { EventKind } from "../kernel/types.ts";
import type {
	Request as LLMRequest,
	Response as LLMResponse,
	Message,
	ToolCall,
	ToolDefinition,
} from "../llm/types.ts";
import { messageReasoning, messageText, messageToolCalls } from "../llm/types.ts";
import { getContextWindowSize } from "./context-window.ts";
import { buildPlanRequest } from "./plan.ts";

export interface ExecutePlanningTurnInput {
	turn: number;
	agentId: string;
	depth: number;
	systemPrompt: string;
	history: Message[];
	agentTools: ToolDefinition[];
	primitiveTools: ToolDefinition[];
	model: string;
	provider: string;
	thinking?: boolean | { budget_tokens: number };
	signal?: AbortSignal;
	emit: (kind: EventKind, agentId: string, depth: number, data: Record<string, unknown>) => void;
	requestPlanResponse: (opts: {
		request: LLMRequest;
		agentId: string;
		turn: number;
		signal: AbortSignal | undefined;
	}) => Promise<{ response: LLMResponse; latencyMs: number } | "interrupted">;
	logger: {
		debug(category: "llm", message: string, data?: Record<string, unknown>): void;
	};
}

export type PlanningTurnResult =
	| { kind: "interrupted" }
	| {
			kind: "success";
			response: LLMResponse;
			assistantMessage: Message;
			toolCalls: ToolCall[];
	  };

/**
 * Executes the planning phase for a single turn:
 * - emits plan_start and llm_start
 * - builds and sends plan request
 * - on success emits llm_end + plan_end and appends assistant message
 *
 * Abort/error event emission is handled in requestPlanResponse().
 */
export async function executePlanningTurn(
	input: ExecutePlanningTurnInput,
): Promise<PlanningTurnResult> {
	input.emit("plan_start", input.agentId, input.depth, { turn: input.turn });

	const request = buildPlanRequest({
		systemPrompt: input.systemPrompt,
		history: input.history,
		agentTools: input.agentTools,
		primitiveTools: input.primitiveTools,
		model: input.model,
		provider: input.provider,
		thinking: input.thinking,
	});

	input.emit("llm_start", input.agentId, input.depth, {
		model: input.model,
		provider: input.provider,
		turn: input.turn,
		message_count: input.history.length,
	});

	const planResult = await input.requestPlanResponse({
		request,
		agentId: input.agentId,
		turn: input.turn,
		signal: input.signal,
	});
	if (planResult === "interrupted") {
		return { kind: "interrupted" };
	}

	const { response, latencyMs } = planResult;
	input.emit("llm_end", input.agentId, input.depth, {
		model: input.model,
		provider: input.provider,
		input_tokens: response.usage?.input_tokens ?? 0,
		output_tokens: response.usage?.output_tokens ?? 0,
		cache_read_tokens: response.usage?.cache_read_tokens ?? 0,
		cache_write_tokens: response.usage?.cache_write_tokens ?? 0,
		latency_ms: latencyMs,
		finish_reason: response.finish_reason.reason,
	});

	const assistantMessage = response.message;
	input.history.push(assistantMessage);

	input.logger.debug("llm", "Plan response received", {
		model: input.model,
		provider: input.provider,
		turn: input.turn,
		inputTokens: response.usage?.input_tokens,
		outputTokens: response.usage?.output_tokens,
		finishReason: response.finish_reason.reason,
		messageCount: input.history.length,
	});

	input.emit("plan_end", input.agentId, input.depth, {
		turn: input.turn,
		finish_reason: response.finish_reason.reason,
		usage: response.usage,
		text: messageText(assistantMessage),
		reasoning: messageReasoning(assistantMessage),
		assistant_message: assistantMessage,
		context_tokens: response.usage?.input_tokens ?? 0,
		context_window_size: getContextWindowSize(input.model),
	});

	return {
		kind: "success",
		response,
		assistantMessage,
		toolCalls: messageToolCalls(assistantMessage),
	};
}

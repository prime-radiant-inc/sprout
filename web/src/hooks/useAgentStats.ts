import { useMemo } from "react";
import type { SessionEvent } from "@kernel/types.ts";

export type AgentState = "idle" | "calling_llm" | "executing_tool" | "delegating";

export interface AgentStats {
	agentId: string;
	depth: number;
	state: AgentState;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	currentTurn: number;
	/** Timestamp (Date.now()) when the current LLM call started, or null if not in a call. */
	llmCallStartedAt: number | null;
	/** Number of streaming chunks received so far in the current LLM call. */
	streamingChunks: number;
	/** Model name from the most recent llm_start event. */
	model: string;
}

function createDefaultStats(agentId: string, depth: number): AgentStats {
	return {
		agentId,
		depth,
		state: "idle",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		currentTurn: 0,
		llmCallStartedAt: null,
		streamingChunks: 0,
		model: "",
	};
}

function getOrCreate(map: Map<string, AgentStats>, agentId: string, depth: number): AgentStats {
	let stats = map.get(agentId);
	if (!stats) {
		stats = createDefaultStats(agentId, depth);
		map.set(agentId, stats);
	}
	return stats;
}

/**
 * Build per-agent stats from a list of session events.
 *
 * Scans for llm_start, llm_chunk, llm_end, primitive_start, primitive_end,
 * act_start, act_end, session_start, and session_end events to derive
 * each agent's current state, token usage, turn number, and LLM call timing.
 */
export function buildAgentStats(events: SessionEvent[]): Map<string, AgentStats> {
	const stats = new Map<string, AgentStats>();

	for (const event of events) {
		const s = getOrCreate(stats, event.agent_id, event.depth);

		switch (event.kind) {
			case "session_start":
				s.state = "idle";
				s.inputTokens = 0;
				s.outputTokens = 0;
				s.cacheReadTokens = 0;
				s.cacheWriteTokens = 0;
				s.currentTurn = 0;
				s.streamingChunks = 0;
				s.llmCallStartedAt = null;
				if (typeof event.data.model === "string") s.model = event.data.model;
				break;

			case "session_end":
				s.state = "idle";
				s.llmCallStartedAt = null;
				s.streamingChunks = 0;
				break;

			case "llm_start":
				s.state = "calling_llm";
				s.llmCallStartedAt = event.timestamp;
				s.streamingChunks = 0;
				if (typeof event.data.turn === "number") {
					s.currentTurn = event.data.turn;
				}
				if (typeof event.data.model === "string") {
					s.model = event.data.model;
				}
				break;

			case "llm_chunk":
				if (typeof event.data.chunks_so_far === "number") {
					s.streamingChunks = event.data.chunks_so_far;
				}
				break;

			case "llm_end":
				s.state = "idle";
				s.llmCallStartedAt = null;
				s.streamingChunks = 0;
				if (typeof event.data.input_tokens === "number") {
					s.inputTokens += event.data.input_tokens;
				}
				if (typeof event.data.output_tokens === "number") {
					s.outputTokens += event.data.output_tokens;
				}
				if (typeof event.data.cache_read_tokens === "number") {
					s.cacheReadTokens += event.data.cache_read_tokens;
				}
				if (typeof event.data.cache_write_tokens === "number") {
					s.cacheWriteTokens += event.data.cache_write_tokens;
				}
				break;

			case "primitive_start":
				s.state = "executing_tool";
				break;

			case "primitive_end":
				s.state = "idle";
				break;

			case "act_start":
				s.state = "delegating";
				break;

			case "act_end":
				s.state = "idle";
				break;

			case "interrupted":
				s.state = "idle";
				s.llmCallStartedAt = null;
				s.streamingChunks = 0;
				break;

			case "error":
				s.state = "idle";
				s.llmCallStartedAt = null;
				s.streamingChunks = 0;
				break;
		}
	}

	return stats;
}

// --- React hook ---

/**
 * React hook that builds per-agent stats from session events.
 */
export function useAgentStats(events: SessionEvent[]): Map<string, AgentStats> {
	return useMemo(() => buildAgentStats(events), [events]);
}

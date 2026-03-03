import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import { buildAgentStats, type AgentStats } from "./useAgentStats.ts";

// --- Helpers ---

let nextTs = 1000;

function makeEvent(
	kind: SessionEvent["kind"],
	agentId: string,
	depth: number,
	data: Record<string, unknown> = {},
): SessionEvent {
	return { kind, timestamp: nextTs++, agent_id: agentId, depth, data };
}

function resetTimestamps(): void {
	nextTs = 1000;
}

// --- Tests ---

describe("buildAgentStats", () => {
	describe("state tracking", () => {
		test("returns empty map with no events", () => {
			const stats = buildAgentStats([]);
			expect(stats.size).toBe(0);
		});

		test("agent starts idle on session_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")).toBeDefined();
			expect(stats.get("root")!.state).toBe("idle");
		});

		test("agent state becomes calling_llm on llm_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("plan_start", "root", 0, { turn: 1 }),
				makeEvent("llm_start", "root", 0, {
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					turn: 1,
					message_count: 2,
				}),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("calling_llm");
		});

		test("agent state returns to idle on llm_end when no tool calls follow", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("plan_start", "root", 0, { turn: 1 }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("llm_end", "root", 0, { model: "claude", provider: "anthropic", input_tokens: 100, output_tokens: 50, latency_ms: 500, finish_reason: "stop" }),
				makeEvent("plan_end", "root", 0, { turn: 1 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
		});

		test("agent state becomes executing_tool on primitive_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "child-1", 1, { model: "claude" }),
				makeEvent("llm_start", "child-1", 1, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("llm_end", "child-1", 1, { model: "claude", provider: "anthropic", input_tokens: 100, output_tokens: 50, latency_ms: 200, finish_reason: "tool_calls" }),
				makeEvent("primitive_start", "child-1", 1, { name: "read_file", args: {} }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("child-1")!.state).toBe("executing_tool");
		});

		test("agent state returns to idle on primitive_end", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "child-1", 1, { model: "claude" }),
				makeEvent("primitive_start", "child-1", 1, { name: "read_file" }),
				makeEvent("primitive_end", "child-1", 1, { name: "read_file", success: true }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("child-1")!.state).toBe("idle");
		});

		test("parent agent state becomes delegating on act_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("delegating");
		});

		test("parent state returns to idle on act_end", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", success: true, child_id: "child-1" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
		});

		test("agent state becomes idle on session_end", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("session_end", "root", 0, { success: true }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
		});
	});

	describe("token counting", () => {
		test("accumulates tokens from llm_end events", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_end", "root", 0, { model: "claude", provider: "anthropic", input_tokens: 100, output_tokens: 50, latency_ms: 200, finish_reason: "stop" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.inputTokens).toBe(100);
			expect(stats.get("root")!.outputTokens).toBe(50);
		});

		test("accumulates tokens across multiple llm_end events", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_end", "root", 0, { input_tokens: 100, output_tokens: 50, latency_ms: 200, finish_reason: "tool_calls" }),
				makeEvent("llm_end", "root", 0, { input_tokens: 200, output_tokens: 80, latency_ms: 300, finish_reason: "stop" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.inputTokens).toBe(300);
			expect(stats.get("root")!.outputTokens).toBe(130);
		});

		test("tracks tokens per agent independently", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("session_start", "child-1", 1, { model: "claude" }),
				makeEvent("llm_end", "root", 0, { input_tokens: 500, output_tokens: 200, latency_ms: 100, finish_reason: "stop" }),
				makeEvent("llm_end", "child-1", 1, { input_tokens: 100, output_tokens: 30, latency_ms: 50, finish_reason: "stop" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.inputTokens).toBe(500);
			expect(stats.get("root")!.outputTokens).toBe(200);
			expect(stats.get("child-1")!.inputTokens).toBe(100);
			expect(stats.get("child-1")!.outputTokens).toBe(30);
		});
	});

	describe("turn tracking", () => {
		test("tracks current turn from llm_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 3, message_count: 10 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.currentTurn).toBe(3);
		});

		test("updates turn as turns progress", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { turn: 1 }),
				makeEvent("llm_end", "root", 0, { input_tokens: 100, output_tokens: 50, latency_ms: 100, finish_reason: "tool_calls" }),
				makeEvent("llm_start", "root", 0, { turn: 2 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.currentTurn).toBe(2);
		});
	});

	describe("LLM call timing", () => {
		test("records llm call start timestamp on llm_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.llmCallStartedAt).toBeDefined();
			expect(typeof stats.get("root")!.llmCallStartedAt).toBe("number");
		});

		test("clears llm call start timestamp on llm_end", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { turn: 1 }),
				makeEvent("llm_end", "root", 0, { input_tokens: 100, output_tokens: 50, latency_ms: 200, finish_reason: "stop" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.llmCallStartedAt).toBeNull();
		});
	});

	describe("agent name and depth tracking", () => {
		test("extracts agent name from session_start model data", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.agentId).toBe("root");
			expect(stats.get("root")!.depth).toBe(0);
		});

		test("creates stats entry on first event for an agent", () => {
			resetTimestamps();
			const events = [
				makeEvent("llm_start", "some-agent", 2, { turn: 1 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("some-agent")).toBeDefined();
			expect(stats.get("some-agent")!.depth).toBe(2);
		});
	});

	describe("llm_chunk tracking", () => {
		test("updates streaming token count from llm_chunk", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { turn: 1 }),
				makeEvent("llm_chunk", "root", 0, { chunks_so_far: 15, elapsed_ms: 500 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.streamingChunks).toBe(15);
		});

		test("clears streaming tokens on llm_end", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { turn: 1 }),
				makeEvent("llm_chunk", "root", 0, { chunks_so_far: 15, elapsed_ms: 500 }),
				makeEvent("llm_end", "root", 0, { input_tokens: 100, output_tokens: 50, latency_ms: 1000, finish_reason: "stop" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.streamingChunks).toBe(0);
		});
	});

	describe("model tracking", () => {
		test("records model from llm_start", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude-3-opus" }),
				makeEvent("llm_start", "root", 0, { model: "claude-haiku-4-5-20251001", provider: "anthropic", turn: 1, message_count: 2 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.model).toBe("claude-haiku-4-5-20251001");
		});
	});

	describe("interrupted event handling", () => {
		test("interrupted event after llm_start resets state to idle", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("interrupted", "root", 0, { message: "Agent interrupted during LLM call", turns: 1 }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
			expect(stats.get("root")!.llmCallStartedAt).toBeNull();
			expect(stats.get("root")!.streamingChunks).toBe(0);
		});

		test("llm_end with finish_reason 'error' resets state to idle", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("llm_end", "root", 0, { model: "claude", provider: "anthropic", input_tokens: 0, output_tokens: 0, latency_ms: 50, finish_reason: "error" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
			expect(stats.get("root")!.llmCallStartedAt).toBeNull();
			expect(stats.get("root")!.streamingChunks).toBe(0);
		});

		test("llm_end with finish_reason 'interrupted' resets state to idle", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("llm_chunk", "root", 0, { chunks_so_far: 5, elapsed_ms: 200 }),
				makeEvent("llm_end", "root", 0, { model: "claude", provider: "anthropic", input_tokens: 0, output_tokens: 0, latency_ms: 100, finish_reason: "interrupted" }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
			expect(stats.get("root")!.llmCallStartedAt).toBeNull();
			expect(stats.get("root")!.streamingChunks).toBe(0);
		});
	});

	describe("session_end handling", () => {
		test("session_end resets agent state even mid-LLM-call", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("llm_start", "root", 0, { model: "claude", provider: "anthropic", turn: 1, message_count: 2 }),
				makeEvent("llm_chunk", "root", 0, { chunks_so_far: 10, elapsed_ms: 500 }),
				makeEvent("session_end", "root", 0, { success: true }),
			];
			const stats = buildAgentStats(events);
			expect(stats.get("root")!.state).toBe("idle");
			expect(stats.get("root")!.llmCallStartedAt).toBeNull();
			expect(stats.get("root")!.streamingChunks).toBe(0);
		});
	});
});

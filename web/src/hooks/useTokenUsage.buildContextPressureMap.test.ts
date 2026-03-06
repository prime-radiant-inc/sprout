import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@kernel/types.ts";
import { buildContextPressureMap } from "./useTokenUsage.ts";

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

// --- buildContextPressureMap ---

describe("buildContextPressureMap", () => {
	test("returns empty map when no events", () => {
		const result = buildContextPressureMap([]);
		expect(result.size).toBe(0);
	});

	test("returns empty map when no plan_end events", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("ignores non-plan_end events", () => {
		resetTimestamps();
		const events = [
			makeEvent("perceive", "root", 0, { goal: "Work" }),
			makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit", child_id: "child-1" }),
			makeEvent("act_end", "root", 0, { agent_name: "editor", child_id: "child-1", success: true }),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("picks up context data from a single plan_end event", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_tokens: 50000,
				context_window_size: 200000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(1);
		expect(result.get("agent-1")).toEqual({
			contextTokens: 50000,
			contextWindowSize: 200000,
			percent: 25,
		});
	});

	test("picks up the last plan_end per agent_id (latest value wins)", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_tokens: 50000,
				context_window_size: 200000,
			}),
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 800, output_tokens: 300 },
				context_tokens: 120000,
				context_window_size: 200000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(1);
		expect(result.get("agent-1")).toEqual({
			contextTokens: 120000,
			contextWindowSize: 200000,
			percent: 60,
		});
	});

	test("skips entries where context_window_size is 0", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_tokens: 50000,
				context_window_size: 0,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("skips entries where context_tokens is not a number", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_tokens: "not-a-number",
				context_window_size: 200000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("skips entries where context_window_size is not a number", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_tokens: 50000,
				context_window_size: "bad",
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("skips entries where context_tokens is missing", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_window_size: 200000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("skips entries where context_window_size is missing", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				usage: { input_tokens: 500, output_tokens: 200 },
				context_tokens: 50000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(0);
	});

	test("correctly computes percent as Math.round((ct / cws) * 100)", () => {
		resetTimestamps();
		const events = [
			// 1/3 = 33.33... → rounds to 33
			makeEvent("plan_end", "agent-a", 1, {
				context_tokens: 1,
				context_window_size: 3,
			}),
			// 2/3 = 66.66... → rounds to 67
			makeEvent("plan_end", "agent-b", 1, {
				context_tokens: 2,
				context_window_size: 3,
			}),
			// 170000/200000 = 85 → exactly 85
			makeEvent("plan_end", "agent-c", 1, {
				context_tokens: 170000,
				context_window_size: 200000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.get("agent-a")?.percent).toBe(33);
		expect(result.get("agent-b")?.percent).toBe(67);
		expect(result.get("agent-c")?.percent).toBe(85);
	});

	test("builds map for multiple agents", () => {
		resetTimestamps();
		const events = [
			makeEvent("plan_end", "agent-1", 1, {
				context_tokens: 50000,
				context_window_size: 200000,
			}),
			makeEvent("plan_end", "agent-2", 2, {
				context_tokens: 100000,
				context_window_size: 128000,
			}),
		];
		const result = buildContextPressureMap(events);
		expect(result.size).toBe(2);
		expect(result.get("agent-1")).toEqual({
			contextTokens: 50000,
			contextWindowSize: 200000,
			percent: 25,
		});
		expect(result.get("agent-2")).toEqual({
			contextTokens: 100000,
			contextWindowSize: 128000,
			percent: 78,
		});
	});
});

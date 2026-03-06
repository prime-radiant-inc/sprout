import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@kernel/types.ts";
import type { AgentTreeNode } from "../../hooks/useAgentTree.ts";
import { groupEvents } from "../groupEvents.ts";

// --- Helpers ---

function makeEvent(
	kind: SessionEvent["kind"],
	data: Record<string, unknown> = {},
	overrides: Partial<SessionEvent> = {},
): SessionEvent {
	return {
		kind,
		timestamp: 1000,
		agent_id: "root",
		depth: 0,
		data,
		...overrides,
	};
}

function makeTree(overrides: Partial<AgentTreeNode> = {}): AgentTreeNode {
	return {
		agentId: "root",
		agentName: "root",
		depth: 0,
		status: "running",
		goal: "",
		children: [],
		...overrides,
	};
}

// --- Grouping ---

describe("groupEvents", () => {
	describe("grouping consecutive plan_end events", () => {
		test("groups consecutive plan_end events from same agent", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "first" }, { timestamp: 1000 }),
				makeEvent("plan_end", { text: "second" }, { timestamp: 1001 }),
				makeEvent("plan_end", { text: "third" }, { timestamp: 1002 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(3);
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(false);
			expect(result[1]!.isFirstInGroup).toBe(false);
			expect(result[1]!.isLastInGroup).toBe(false);
			expect(result[2]!.isFirstInGroup).toBe(false);
			expect(result[2]!.isLastInGroup).toBe(true);
		});
	});

	describe("group breaks on agent_id change", () => {
		test("breaks group when agent_id changes", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "a" }, { agent_id: "agent-1", timestamp: 1000 }),
				makeEvent("plan_end", { text: "b" }, { agent_id: "agent-1", timestamp: 1001 }),
				makeEvent("plan_end", { text: "c" }, { agent_id: "agent-2", timestamp: 1002 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(3);
			// First group: agent-1
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(false);
			expect(result[1]!.isFirstInGroup).toBe(false);
			expect(result[1]!.isLastInGroup).toBe(true);
			// Second group: agent-2
			expect(result[2]!.isFirstInGroup).toBe(true);
			expect(result[2]!.isLastInGroup).toBe(true);
		});
	});

	describe("group breaks on intervening tool call", () => {
		test("breaks group when tool call intervenes between plan_end events", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "before" }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "exec" }, { timestamp: 1001 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { timestamp: 1002 }),
				makeEvent("plan_end", { text: "after" }, { timestamp: 1003 }),
			];
			const result = groupEvents(events);
			// primitive_start is skipped, so we get: plan_end, primitive_end, plan_end
			expect(result).toHaveLength(3);
			expect(result[0]!.event.kind).toBe("plan_end");
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(true);
			expect(result[1]!.event.kind).toBe("primitive_end");
			expect(result[1]!.isFirstInGroup).toBe(true);
			expect(result[1]!.isLastInGroup).toBe(true);
			expect(result[2]!.event.kind).toBe("plan_end");
			expect(result[2]!.isFirstInGroup).toBe(true);
			expect(result[2]!.isLastInGroup).toBe(true);
		});
	});

	describe("group breaks on >60s gap", () => {
		test("breaks group when >60 seconds pass between events", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "a" }, { timestamp: 1000 }),
				makeEvent("plan_end", { text: "b" }, { timestamp: 2000 }),
				makeEvent("plan_end", { text: "c" }, { timestamp: 63000 }), // >60s after b
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(3);
			// First group: a + b
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(false);
			expect(result[1]!.isFirstInGroup).toBe(false);
			expect(result[1]!.isLastInGroup).toBe(true);
			// Second group: c (time gap)
			expect(result[2]!.isFirstInGroup).toBe(true);
			expect(result[2]!.isLastInGroup).toBe(true);
		});

		test("exactly 60 seconds between events does NOT break the group", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "a" }, { timestamp: 1000 }),
				makeEvent("plan_end", { text: "b" }, { timestamp: 61000 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(2);
			// 61000 - 1000 = 60000ms exactly = not > 60_000
			expect(result[0]!.isLastInGroup).toBe(false);
			expect(result[1]!.isFirstInGroup).toBe(false);
		});

		test("61 seconds between events DOES break the group", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "a" }, { timestamp: 1000 }),
				makeEvent("plan_end", { text: "b" }, { timestamp: 62000 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(2);
			// 62000 - 1000 = 61000ms > 60_000
			expect(result[0]!.isLastInGroup).toBe(true);
			expect(result[1]!.isFirstInGroup).toBe(true);
		});
	});

	describe("standalone events", () => {
		test("returns isFirstInGroup=true and isLastInGroup=true for tool calls", () => {
			const events: SessionEvent[] = [
				makeEvent("primitive_start", { name: "exec" }, { timestamp: 1000 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { timestamp: 1001 }),
				makeEvent("primitive_start", { name: "read" }, { timestamp: 1002 }),
				makeEvent("primitive_end", { name: "read", success: true }, { timestamp: 1003 }),
			];
			const result = groupEvents(events);
			// primitive_start events are skipped
			expect(result).toHaveLength(2);
			expect(result[0]!.event.kind).toBe("primitive_end");
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(true);
			expect(result[1]!.event.kind).toBe("primitive_end");
			expect(result[1]!.isFirstInGroup).toBe(true);
			expect(result[1]!.isLastInGroup).toBe(true);
		});

		test("act_start and act_end are standalone", () => {
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "child", goal: "work" }, { timestamp: 1000 }),
				makeEvent("act_end", { agent_name: "child", success: true }, { timestamp: 2000 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(2);
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(true);
			expect(result[1]!.isFirstInGroup).toBe(true);
			expect(result[1]!.isLastInGroup).toBe(true);
		});

		test("plan_delta is standalone", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_start", {}, { timestamp: 1000 }),
				makeEvent("plan_delta", { text: "Hello " }, { timestamp: 1001 }),
				makeEvent("plan_delta", { text: "world" }, { timestamp: 1002 }),
			];
			const result = groupEvents(events);
			// plan_start is skipped, plan_delta collapses to one entry
			expect(result).toHaveLength(1);
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(true);
		});
	});

	describe("agent filtering", () => {
		test("filters events by agentFilter + descendants", () => {
			const tree = makeTree({
				agentId: "root",
				children: [
					makeTree({ agentId: "child-1", children: [makeTree({ agentId: "grandchild" })] }),
					makeTree({ agentId: "child-2" }),
				],
			});
			const events: SessionEvent[] = [
				makeEvent("perceive", { goal: "root goal" }, { agent_id: "root" }),
				makeEvent("perceive", { goal: "child-1 goal" }, { agent_id: "child-1" }),
				makeEvent("perceive", { goal: "grandchild goal" }, { agent_id: "grandchild" }),
				makeEvent("perceive", { goal: "child-2 goal" }, { agent_id: "child-2" }),
			];
			const result = groupEvents(events, "child-1", tree);
			expect(result).toHaveLength(2);
			expect(result[0]!.event.agent_id).toBe("child-1");
			expect(result[1]!.event.agent_id).toBe("grandchild");
		});
	});

	describe("plan_delta accumulation", () => {
		test("plan_delta events from different agents are tracked independently", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_delta", { text: "hello " }, { agent_id: "agent-a", timestamp: 1001 }),
				makeEvent("plan_delta", { text: "world " }, { agent_id: "agent-b", timestamp: 1002 }),
				makeEvent("plan_delta", { text: "from A" }, { agent_id: "agent-a", timestamp: 1003 }),
				makeEvent("plan_delta", { text: "from B" }, { agent_id: "agent-b", timestamp: 1004 }),
			];
			const result = groupEvents(events);

			// Should have exactly 2 entries (one per agent, collapsed)
			expect(result).toHaveLength(2);

			const entryA = result.find((g) => g.event.agent_id === "agent-a");
			const entryB = result.find((g) => g.event.agent_id === "agent-b");
			expect(entryA).toBeTruthy();
			expect(entryB).toBeTruthy();
			expect(entryA!.streamingText).toBe("hello from A");
			expect(entryB!.streamingText).toBe("world from B");
		});

		test("accumulates plan_delta text into streamingText", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_start", {}, { timestamp: 1000 }),
				makeEvent("plan_delta", { text: "Hello " }, { timestamp: 1001 }),
				makeEvent("plan_delta", { text: "world" }, { timestamp: 1002 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(1);
			expect(result[0]!.streamingText).toBe("Hello world");
		});

		test("clears streaming buffer on plan_end", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_start", {}, { timestamp: 1000 }),
				makeEvent("plan_delta", { text: "first stream" }, { timestamp: 1001 }),
				makeEvent("plan_end", { text: "final" }, { timestamp: 1002 }),
				makeEvent("plan_start", {}, { timestamp: 1003 }),
				makeEvent("plan_delta", { text: "second" }, { timestamp: 1004 }),
			];
			const result = groupEvents(events);
			// plan_start events are skipped
			// Result: plan_delta("first stream"), plan_end("final"), plan_delta("second")
			const deltas = result.filter((r) => r.event.kind === "plan_delta");
			expect(deltas).toHaveLength(2);
			expect(deltas[0]!.streamingText).toBe("first stream");
			// Buffer cleared on plan_end, so second stream starts fresh
			expect(deltas[1]!.streamingText).toBe("second");
		});
	});

	describe("duration tracking", () => {
		test("computes duration for primitive_start/end pairs", () => {
			const events: SessionEvent[] = [
				makeEvent("primitive_start", { name: "exec" }, { timestamp: 1000 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { timestamp: 2500 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(1);
			expect(result[0]!.event.kind).toBe("primitive_end");
			expect(result[0]!.durationMs).toBe(1500);
		});

		test("computes duration for act_start/end pairs", () => {
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "alpha" }, { timestamp: 1000 }),
				makeEvent("act_end", { agent_name: "alpha", success: true }, { timestamp: 4000 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(2);
			expect(result[1]!.event.kind).toBe("act_end");
			expect(result[1]!.durationMs).toBe(3000);
		});

		test("computes duration for plan_start/end pairs", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_start", {}, { timestamp: 1000 }),
				makeEvent("plan_end", { text: "done" }, { timestamp: 1800 }),
			];
			const result = groupEvents(events);
			// plan_start is skipped
			expect(result).toHaveLength(1);
			expect(result[0]!.event.kind).toBe("plan_end");
			expect(result[0]!.durationMs).toBe(800);
		});
	});

	describe("invisible events", () => {
		test("skips all invisible event kinds", () => {
			const events: SessionEvent[] = [
				makeEvent("context_update", { context_tokens: 500 }),
				makeEvent("exit_hint", {}),
				makeEvent("session_start", { model: "gpt-4o" }),
				makeEvent("session_end", {}),
				makeEvent("recall", { agents: [] }),
				makeEvent("verify", { success: true }),
				makeEvent("learn_signal", { signal: "positive" }),
				makeEvent("learn_end", {}),
				makeEvent("log", { level: "info", message: "test" }),
				makeEvent("perceive", { goal: "visible" }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(1);
			expect(result[0]!.event.kind).toBe("perceive");
		});
	});

	describe("grouping consecutive perceive events", () => {
		test("groups consecutive perceive events from same agent", () => {
			const events: SessionEvent[] = [
				makeEvent("perceive", { goal: "first" }, { timestamp: 1000 }),
				makeEvent("perceive", { goal: "second" }, { timestamp: 1001 }),
				makeEvent("perceive", { goal: "third" }, { timestamp: 1002 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(3);
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(false);
			expect(result[1]!.isFirstInGroup).toBe(false);
			expect(result[1]!.isLastInGroup).toBe(false);
			expect(result[2]!.isFirstInGroup).toBe(false);
			expect(result[2]!.isLastInGroup).toBe(true);
		});
	});

	describe("delegation merging", () => {
		/** Helper: builds a tree with a root and one child for delegation tests. */
		function treePlusChild(childId: string, childName = "worker"): AgentTreeNode {
			return makeTree({
				agentId: "root",
				children: [
					makeTree({ agentId: childId, agentName: childName, depth: 1 }),
				],
			});
		}

		test("act_start followed by act_end produces single merged event", () => {
			const childId = "child-abc";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "do stuff", child_id: childId }, { timestamp: 1000 }),
				// Child events in between
				makeEvent("plan_end", { text: "thinking" }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				makeEvent("primitive_start", { name: "write_file", args: { path: "foo.ts" } }, { agent_id: childId, timestamp: 1800, depth: 1 }),
				makeEvent("primitive_end", { name: "write_file", success: true }, { agent_id: childId, timestamp: 2000, depth: 1 }),
				// act_end for the delegation
				makeEvent("act_end", { agent_name: "worker", child_id: childId, success: true, turns: 3, goal: "do stuff" }, { timestamp: 3000 }),
			];
			// No agentFilter → parent view
			const result = groupEvents(events, undefined, tree);

			// Should produce a single delegation entry (the act_end, with duration)
			const delegations = result.filter(
				(g) => g.event.kind === "act_start" || g.event.kind === "act_end",
			);
			expect(delegations).toHaveLength(1);
			expect(delegations[0]!.event.kind).toBe("act_end");
			expect(delegations[0]!.durationMs).toBe(2000);
		});

		test("running delegation appears as act_start with livePeek", () => {
			const childId = "child-xyz";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "do stuff", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "write_file", args: { path: "foo.ts" } }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				makeEvent("primitive_end", { name: "write_file", success: true }, { agent_id: childId, timestamp: 2000, depth: 1 }),
			];
			// No act_end → delegation is still running
			const result = groupEvents(events, undefined, tree);

			const delegations = result.filter(
				(g) => g.event.kind === "act_start" || g.event.kind === "act_end",
			);
			expect(delegations).toHaveLength(1);
			expect(delegations[0]!.event.kind).toBe("act_start");
			expect(delegations[0]!.livePeek).toBe("write_file foo.ts");
		});

		test("child events are filtered from parent view", () => {
			const childId = "child-filter";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("perceive", { goal: "root goal" }, { agent_id: "root", timestamp: 500 }),
				makeEvent("act_start", { agent_name: "worker", goal: "child task", child_id: childId }, { timestamp: 1000 }),
				// These child events should NOT appear in parent view
				makeEvent("perceive", { goal: "child goal" }, { agent_id: childId, timestamp: 1100, depth: 1 }),
				makeEvent("plan_end", { text: "child thinking" }, { agent_id: childId, timestamp: 1200, depth: 1 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { agent_id: childId, timestamp: 1300, depth: 1 }),
				makeEvent("act_end", { agent_name: "worker", child_id: childId, success: true, turns: 2, goal: "child task" }, { timestamp: 2000 }),
			];
			const result = groupEvents(events, undefined, tree);

			// Only root perceive + merged delegation card
			expect(result).toHaveLength(2);
			expect(result[0]!.event.kind).toBe("perceive");
			expect(result[0]!.event.agent_id).toBe("root");
			expect(result[1]!.event.kind).toBe("act_end");
		});

		test("main view suppresses depth>0 events even without known child_id", () => {
			const tree = makeTree();
			const events: SessionEvent[] = [
				makeEvent("perceive", { goal: "root goal" }, { agent_id: "root", depth: 0, timestamp: 1000 }),
				// Simulates resumed/shared deep-agent events without a local act_start handshake
				makeEvent("plan_end", { text: "deep reply" }, { agent_id: "deep-agent", depth: 2, timestamp: 1001 }),
				makeEvent("perceive", { goal: "still deep" }, { agent_id: "deep-agent", depth: 2, timestamp: 1002 }),
				makeEvent("plan_end", { text: "root reply" }, { agent_id: "root", depth: 0, timestamp: 1003 }),
			];
			const result = groupEvents(events, undefined, tree);
			expect(result).toHaveLength(2);
			expect(result[0]!.event.agent_id).toBe("root");
			expect(result[0]!.event.kind).toBe("perceive");
			expect(result[1]!.event.agent_id).toBe("root");
			expect(result[1]!.event.kind).toBe("plan_end");
		});

		test("main view suppresses depth>0 events even when agent_id matches root", () => {
			const tree = makeTree();
			const events: SessionEvent[] = [
				makeEvent("perceive", { goal: "root goal" }, { agent_id: "root", depth: 0, timestamp: 1000 }),
				// Misattributed deep events (same agent_id as root) should still be hidden.
				makeEvent("perceive", { goal: "leaked user prompt" }, { agent_id: "root", depth: 3, timestamp: 1001 }),
				makeEvent("plan_end", { text: "leaked assistant reply" }, { agent_id: "root", depth: 3, timestamp: 1002 }),
				makeEvent("plan_end", { text: "root reply" }, { agent_id: "root", depth: 0, timestamp: 1003 }),
			];
			const result = groupEvents(events, undefined, tree);
			expect(result).toHaveLength(2);
			expect(result[0]!.event.data.goal).toBe("root goal");
			expect(result[1]!.event.data.text).toBe("root reply");
		});

		test("child events still appear when agentFilter matches child", () => {
			const childId = "child-visible";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("perceive", { goal: "root goal" }, { agent_id: "root", timestamp: 500 }),
				makeEvent("act_start", { agent_name: "worker", goal: "child task", child_id: childId }, { timestamp: 1000 }),
				makeEvent("perceive", { goal: "child goal" }, { agent_id: childId, timestamp: 1100, depth: 1 }),
				makeEvent("plan_end", { text: "child plan" }, { agent_id: childId, timestamp: 1200, depth: 1 }),
				makeEvent("act_end", { agent_name: "worker", child_id: childId, success: true, turns: 1, goal: "child task" }, { timestamp: 2000 }),
			];
			// Filter to child agent → should see child's events normally
			const result = groupEvents(events, childId, tree);

			// Should see child's perceive and plan_end (not root's perceive or act_start/act_end)
			expect(result).toHaveLength(2);
			expect(result[0]!.event.agent_id).toBe(childId);
			expect(result[0]!.event.kind).toBe("perceive");
			expect(result[1]!.event.agent_id).toBe(childId);
			expect(result[1]!.event.kind).toBe("plan_end");
		});

		test("livePeek from plan_end shows truncated text", () => {
			const childId = "child-peek-plan";
			const tree = treePlusChild(childId);
			const longText = "A".repeat(100);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "task", child_id: childId }, { timestamp: 1000 }),
				makeEvent("plan_end", { text: longText }, { agent_id: childId, timestamp: 1500, depth: 1 }),
			];
			const result = groupEvents(events, undefined, tree);

			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeek).toBeTruthy();
			// Should be truncated to ~60 chars
			expect(delegation!.livePeek!.length).toBeLessThanOrEqual(63); // 60 + "..."
			expect(delegation!.livePeek!.endsWith("...")).toBe(true);
		});

		test("delegation merging preserves duration on act_end", () => {
			const childId = "child-dur";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "task", child_id: childId }, { timestamp: 1000 }),
				makeEvent("act_end", { agent_name: "worker", child_id: childId, success: true, turns: 5, goal: "task" }, { timestamp: 4000 }),
			];
			const result = groupEvents(events, undefined, tree);

			expect(result).toHaveLength(1);
			expect(result[0]!.event.kind).toBe("act_end");
			expect(result[0]!.durationMs).toBe(3000);
		});
	});

	describe("session_end clears pending delegations", () => {
		function treePlusChild(childId: string, childName = "worker"): AgentTreeNode {
			return makeTree({
				agentId: "root",
				children: [
					makeTree({ agentId: childId, agentName: childName, depth: 1 }),
				],
			});
		}

		test("session_end clears pendingActStarts so they are not stale", () => {
			const childId = "child-stale";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "do stuff", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				// Session ends without act_end — simulates a crash
				makeEvent("session_end", { success: false }, { timestamp: 2000 }),
			];
			const result = groupEvents(events, undefined, tree);

			// The pending delegation should still appear (with its peek info)
			const delegations = result.filter(
				(g) => g.event.kind === "act_start" || g.event.kind === "act_end",
			);
			expect(delegations).toHaveLength(1);
			expect(delegations[0]!.event.kind).toBe("act_start");
			expect(delegations[0]!.livePeek).toBe("exec");
		});
	});

	describe("group breaks on kind change", () => {
		test("breaks group when event kind changes between groupable types", () => {
			const events: SessionEvent[] = [
				makeEvent("plan_end", { text: "a" }, { timestamp: 1000 }),
				makeEvent("plan_end", { text: "b" }, { timestamp: 1001 }),
				makeEvent("perceive", { goal: "c" }, { timestamp: 1002 }),
				makeEvent("perceive", { goal: "d" }, { timestamp: 1003 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(4);
			// First group: plan_end
			expect(result[0]!.isFirstInGroup).toBe(true);
			expect(result[0]!.isLastInGroup).toBe(false);
			expect(result[1]!.isFirstInGroup).toBe(false);
			expect(result[1]!.isLastInGroup).toBe(true);
			// Second group: perceive
			expect(result[2]!.isFirstInGroup).toBe(true);
			expect(result[2]!.isLastInGroup).toBe(false);
			expect(result[3]!.isFirstInGroup).toBe(false);
			expect(result[3]!.isLastInGroup).toBe(true);
		});
	});

	describe("primitive_end args from primitive_start", () => {
		test("attaches args from primitive_start to primitive_end GroupedEvent", () => {
			const events: SessionEvent[] = [
				makeEvent("primitive_start", { name: "read_file", args: { path: "/foo.ts" } }, { timestamp: 1000 }),
				makeEvent("primitive_end", { name: "read_file", success: true }, { timestamp: 1500 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(1);
			expect(result[0]!.event.kind).toBe("primitive_end");
			expect(result[0]!.args).toEqual({ path: "/foo.ts" });
		});

		test("args is undefined when primitive_start has no args", () => {
			const events: SessionEvent[] = [
				makeEvent("primitive_start", { name: "exec" }, { timestamp: 1000 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { timestamp: 1500 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(1);
			expect(result[0]!.args).toBeUndefined();
		});

		test("matches args by agent_id + tool name", () => {
			const events: SessionEvent[] = [
				makeEvent("primitive_start", { name: "exec", args: { command: "ls" } }, { agent_id: "a", timestamp: 1000 }),
				makeEvent("primitive_start", { name: "exec", args: { command: "pwd" } }, { agent_id: "b", timestamp: 1001 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { agent_id: "b", timestamp: 1002 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { agent_id: "a", timestamp: 1003 }),
			];
			const result = groupEvents(events);
			expect(result).toHaveLength(2);
			// agent b ended first
			expect(result[0]!.event.agent_id).toBe("b");
			expect(result[0]!.args).toEqual({ command: "pwd" });
			// agent a ended second
			expect(result[1]!.event.agent_id).toBe("a");
			expect(result[1]!.args).toEqual({ command: "ls" });
		});
	});

	describe("livePeek extractArgSummary", () => {
		function treePlusChild(childId: string, childName = "worker"): AgentTreeNode {
			return makeTree({
				agentId: "root",
				children: [
					makeTree({ agentId: childId, agentName: childName, depth: 1 }),
				],
			});
		}

		test("livePeek shows command for exec tool", () => {
			const childId = "child-exec";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "run cmd", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "exec", args: { command: "ls -la" } }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { agent_id: childId, timestamp: 2000, depth: 1 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeek).toBe("exec ls -la");
		});

		test("livePeek shows pattern for grep tool", () => {
			const childId = "child-grep";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "search", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "grep", args: { pattern: "TODO" } }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				makeEvent("primitive_end", { name: "grep", success: true }, { agent_id: childId, timestamp: 2000, depth: 1 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeek).toBe("grep TODO");
		});

		test("livePeek shows pattern for glob tool", () => {
			const childId = "child-glob";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "find files", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "glob", args: { pattern: "**/*.ts" } }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				makeEvent("primitive_end", { name: "glob", success: true }, { agent_id: childId, timestamp: 2000, depth: 1 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeek).toBe("glob **/*.ts");
		});

		test("livePeek falls back to tool name when no recognized arg", () => {
			const childId = "child-custom";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "custom", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "fetch", args: { url: "http://example.com" } }, { agent_id: childId, timestamp: 1500, depth: 1 }),
				makeEvent("primitive_end", { name: "fetch", success: true }, { agent_id: childId, timestamp: 2000, depth: 1 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeek).toBe("fetch");
		});
	});

	describe("livePeekTools", () => {
		function treePlusChild(childId: string, childName = "worker"): AgentTreeNode {
			return makeTree({
				agentId: "root",
				children: [
					makeTree({ agentId: childId, agentName: childName, depth: 1 }),
				],
			});
		}

		test("populates livePeekTools from primitive_start/end pairs", () => {
			const childId = "child-tools";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "work", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "read_file", args: { path: "a.ts" } }, { agent_id: childId, timestamp: 1100, depth: 1 }),
				makeEvent("primitive_end", { name: "read_file", success: true }, { agent_id: childId, timestamp: 1200, depth: 1 }),
				makeEvent("primitive_start", { name: "exec", args: { command: "test" } }, { agent_id: childId, timestamp: 1300, depth: 1 }),
				makeEvent("primitive_end", { name: "exec", success: false }, { agent_id: childId, timestamp: 1400, depth: 1 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeekTools).toHaveLength(2);
			expect(delegation!.livePeekTools![0]).toEqual({ name: "read_file", args: "a.ts", success: true });
			expect(delegation!.livePeekTools![1]).toEqual({ name: "exec", args: "test", success: false });
		});

		test("keeps only last 3 tool calls", () => {
			const childId = "child-many-tools";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "work", child_id: childId }, { timestamp: 1000 }),
			];
			// Generate 5 tool call pairs
			for (let i = 1; i <= 5; i++) {
				events.push(
					makeEvent("primitive_start", { name: "read_file", args: { path: `file${i}.ts` } }, { agent_id: childId, timestamp: 1000 + i * 100, depth: 1 }),
					makeEvent("primitive_end", { name: "read_file", success: true }, { agent_id: childId, timestamp: 1000 + i * 100 + 50, depth: 1 }),
				);
			}
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeekTools).toHaveLength(3);
			// Should keep the last 3 (file3, file4, file5)
			expect(delegation!.livePeekTools![0]!.args).toBe("file3.ts");
			expect(delegation!.livePeekTools![1]!.args).toBe("file4.ts");
			expect(delegation!.livePeekTools![2]!.args).toBe("file5.ts");
		});

		test("livePeekTools attaches to pending delegation entries", () => {
			const childId = "child-pending";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "work", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "write_file", args: { path: "out.ts" } }, { agent_id: childId, timestamp: 1100, depth: 1 }),
				makeEvent("primitive_end", { name: "write_file", success: true }, { agent_id: childId, timestamp: 1200, depth: 1 }),
				// No act_end — delegation still running
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.livePeekTools).toBeDefined();
			expect(delegation!.livePeekTools).toHaveLength(1);
			expect(delegation!.livePeekTools![0]).toEqual({ name: "write_file", args: "out.ts", success: true });
		});
	});

	describe("session_end marks abandoned delegations", () => {
		function treePlusChild(childId: string, childName = "worker"): AgentTreeNode {
			return makeTree({
				agentId: "root",
				children: [
					makeTree({ agentId: childId, agentName: childName, depth: 1 }),
				],
			});
		}

		test("sets abandoned flag on pending delegations at session_end", () => {
			const childId = "child-abandoned";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "work", child_id: childId }, { timestamp: 1000 }),
				makeEvent("primitive_start", { name: "exec", args: { command: "build" } }, { agent_id: childId, timestamp: 1100, depth: 1 }),
				makeEvent("primitive_end", { name: "exec", success: true }, { agent_id: childId, timestamp: 1200, depth: 1 }),
				makeEvent("session_end", { success: false }, { timestamp: 2000 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find((g) => g.event.kind === "act_start");
			expect(delegation).toBeTruthy();
			expect(delegation!.abandoned).toBe(true);
		});

		test("completed delegations are NOT marked as abandoned", () => {
			const childId = "child-completed";
			const tree = treePlusChild(childId);
			const events: SessionEvent[] = [
				makeEvent("act_start", { agent_name: "worker", goal: "work", child_id: childId }, { timestamp: 1000 }),
				makeEvent("act_end", { agent_name: "worker", child_id: childId, success: true, turns: 2, goal: "work" }, { timestamp: 2000 }),
				makeEvent("session_end", { success: true }, { timestamp: 3000 }),
			];
			const result = groupEvents(events, undefined, tree);
			const delegation = result.find(
				(g) => g.event.kind === "act_start" || g.event.kind === "act_end",
			);
			expect(delegation).toBeTruthy();
			expect(delegation!.abandoned).toBeUndefined();
		});
	});
});

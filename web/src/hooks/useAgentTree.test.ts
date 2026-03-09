import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@kernel/types.ts";
import { buildAgentTree, getDescendantIds } from "./useAgentTree.ts";

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
//
// IMPORTANT: act_start/act_end events are emitted by the PARENT agent.
// So event.agent_id is the parent, event.depth is the parent's depth,
// and data.agent_name is the child being spawned.

describe("buildAgentTree", () => {
	describe("empty / minimal input", () => {
		test("returns default root node with no events", () => {
			const { tree } = buildAgentTree([]);

			expect(tree).toEqual({
				agentId: "root",
				agentName: "root",
				depth: 0,
				status: "running",
				goal: "",
				children: [],
			});
		});

		test("returns root with goal from perceive event", () => {
			const events = [makeEvent("perceive", "root", 0, { goal: "Fix the bug" })];
			const { tree } = buildAgentTree(events);

			expect(tree.agentId).toBe("root");
			expect(tree.agentName).toBe("root");
			expect(tree.depth).toBe(0);
			expect(tree.goal).toBe("Fix the bug");
			expect(tree.status).toBe("running");
			expect(tree.children).toEqual([]);
		});
	});

	describe("root agent identity", () => {
		test("uses agent_id from first depth-0 event as root id", () => {
			const events = [makeEvent("perceive", "main-agent", 0, { goal: "Hello" })];
			const { tree } = buildAgentTree(events);

			expect(tree.agentId).toBe("main-agent");
		});

		test("root status becomes completed on session_end", () => {
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("perceive", "root", 0, { goal: "Do work" }),
				makeEvent("session_end", "root", 0),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.status).toBe("completed");
		});

		test("root status becomes failed on session_end with success: false", () => {
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("perceive", "root", 0, { goal: "Do work" }),
				makeEvent("session_end", "root", 0, { success: false }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.status).toBe("failed");
		});
	});

	describe("single child agent", () => {
		test("act_start creates a child node with running status", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Fix everything" }),
				// Parent (root, depth=0) dispatches child "code-editor"
				makeEvent("act_start", "root", 0, {
					agent_name: "code-editor",
					goal: "Edit file.ts",
				}),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(1);
			const child = tree.children[0]!;
			expect(child.agentId).toBe("code-editor");
			expect(child.agentName).toBe("code-editor");
			expect(child.depth).toBe(1);
			expect(child.goal).toBe("Edit file.ts");
			expect(child.status).toBe("running");
			expect(child.children).toEqual([]);
		});

		test("act_end marks child as completed with success=true", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Fix everything" }),
				makeEvent("act_start", "root", 0, {
					agent_name: "code-editor",
					goal: "Edit file.ts",
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "code-editor",
					goal: "Edit file.ts",
					success: true,
					turns: 3,
				}),
			];
			const { tree } = buildAgentTree(events);

			const child = tree.children[0]!;
			expect(child.status).toBe("completed");
			expect(child.turns).toBe(3);
		});

		test("act_end marks child as failed with success=false", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Fix everything" }),
				makeEvent("act_start", "root", 0, {
					agent_name: "code-editor",
					goal: "Edit file.ts",
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "code-editor",
					goal: "Edit file.ts",
					success: false,
					turns: 1,
				}),
			];
			const { tree } = buildAgentTree(events);

			const child = tree.children[0]!;
			expect(child.status).toBe("failed");
			expect(child.turns).toBe(1);
		});

		test("computes durationMs from act_start to act_end timestamps", () => {
			const events: SessionEvent[] = [
				makeEvent("perceive", "root", 0, { goal: "Do work" }),
				{ kind: "act_start", timestamp: 5000, agent_id: "root", depth: 0, data: { agent_name: "editor", goal: "Edit" } },
				{ kind: "act_end", timestamp: 8500, agent_id: "root", depth: 0, data: { agent_name: "editor", goal: "Edit", success: true, turns: 2 } },
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children[0]!.durationMs).toBe(3500);
		});
	});

	describe("multiple children at same depth", () => {
		test("sequential act_start events create sibling children", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Build feature" }),
				// Root dispatches code-reader, then code-editor
				makeEvent("act_start", "root", 0, { agent_name: "code-reader", goal: "Read config" }),
				makeEvent("act_end", "root", 0, { agent_name: "code-reader", goal: "Read config", success: true, turns: 1 }),
				makeEvent("act_start", "root", 0, { agent_name: "code-editor", goal: "Write code" }),
				makeEvent("act_end", "root", 0, { agent_name: "code-editor", goal: "Write code", success: true, turns: 2 }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(2);
			expect(tree.children[0]!.agentId).toBe("code-reader");
			expect(tree.children[0]!.agentName).toBe("code-reader");
			expect(tree.children[1]!.agentId).toBe("code-editor");
			expect(tree.children[1]!.agentName).toBe("code-editor");
		});
	});

	describe("nested agents (depth > 1)", () => {
		test("depth-2 agent becomes child of depth-1 agent", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Build it" }),
				// Root (depth 0) dispatches planner
				makeEvent("act_start", "root", 0, { agent_name: "planner", goal: "Plan work" }),
				// Planner (depth 1) dispatches editor
				makeEvent("act_start", "planner", 1, { agent_name: "editor", goal: "Edit file" }),
				makeEvent("act_end", "planner", 1, { agent_name: "editor", goal: "Edit file", success: true, turns: 1 }),
				makeEvent("act_end", "root", 0, { agent_name: "planner", goal: "Plan work", success: true, turns: 5 }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(1);
			const planner = tree.children[0]!;
			expect(planner.agentId).toBe("planner");
			expect(planner.children).toHaveLength(1);

			const editor = planner.children[0]!;
			expect(editor.agentId).toBe("editor");
			expect(editor.depth).toBe(2);
			expect(editor.status).toBe("completed");
		});

		test("depth-3 agent nests properly", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Deep work" }),
				makeEvent("act_start", "root", 0, { agent_name: "depth-one", goal: "Level 1" }),
				makeEvent("act_start", "depth-one", 1, { agent_name: "depth-two", goal: "Level 2" }),
				makeEvent("act_start", "depth-two", 2, { agent_name: "depth-three", goal: "Level 3" }),
				makeEvent("act_end", "depth-two", 2, { agent_name: "depth-three", goal: "Level 3", success: true, turns: 1 }),
				makeEvent("act_end", "depth-one", 1, { agent_name: "depth-two", goal: "Level 2", success: true, turns: 2 }),
				makeEvent("act_end", "root", 0, { agent_name: "depth-one", goal: "Level 1", success: true, turns: 3 }),
			];
			const { tree } = buildAgentTree(events);

			const d1 = tree.children[0]!;
			expect(d1.agentId).toBe("depth-one");
			expect(d1.children).toHaveLength(1);

			const d2 = d1.children[0]!;
			expect(d2.agentId).toBe("depth-two");
			expect(d2.children).toHaveLength(1);

			const d3 = d2.children[0]!;
			expect(d3.agentId).toBe("depth-three");
			expect(d3.depth).toBe(3);
			expect(d3.children).toEqual([]);
		});
	});

	describe("concurrent delegations (parallel children)", () => {
		test("sub-agents parent correctly when siblings are concurrent", () => {
			resetTimestamps();
			// Root spawns A and B concurrently. A then spawns C.
			// C should be a child of A, not B, even though B was the last
			// node registered at depth 1 in the path array.
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Concurrent work" }),
				makeEvent("act_start", "root", 0, {
					agent_name: "agent-a",
					goal: "Task A",
					child_id: "ID_A",
				}),
				makeEvent("act_start", "root", 0, {
					agent_name: "agent-b",
					goal: "Task B",
					child_id: "ID_B",
				}),
				// Agent A (child_id ID_A, at depth 1) spawns agent C
				makeEvent("act_start", "ID_A", 1, {
					agent_name: "agent-c",
					goal: "Sub-task C",
					child_id: "ID_C",
				}),
				makeEvent("act_end", "ID_A", 1, {
					agent_name: "agent-c",
					child_id: "ID_C",
					success: true,
					turns: 1,
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "agent-b",
					child_id: "ID_B",
					success: true,
					turns: 2,
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "agent-a",
					child_id: "ID_A",
					success: true,
					turns: 3,
				}),
			];
			const { tree } = buildAgentTree(events);

			// Root should have two children: A and B
			expect(tree.children).toHaveLength(2);
			const agentA = tree.children[0]!;
			const agentB = tree.children[1]!;
			expect(agentA.agentId).toBe("ID_A");
			expect(agentB.agentId).toBe("ID_B");

			// C should be a child of A, NOT of B
			expect(agentA.children).toHaveLength(1);
			expect(agentA.children[0]!.agentId).toBe("ID_C");
			expect(agentA.children[0]!.agentName).toBe("agent-c");
			expect(agentA.children[0]!.depth).toBe(2);

			// B should have no children
			expect(agentB.children).toHaveLength(0);
		});

		test("deep nesting with concurrent siblings at each level", () => {
			resetTimestamps();
			// Root spawns A and B. A spawns C and D. C spawns E.
			// All should nest correctly regardless of interleaving.
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Deep concurrent" }),
				makeEvent("act_start", "root", 0, {
					agent_name: "a",
					goal: "A",
					child_id: "ID_A",
				}),
				makeEvent("act_start", "root", 0, {
					agent_name: "b",
					goal: "B",
					child_id: "ID_B",
				}),
				makeEvent("act_start", "ID_A", 1, {
					agent_name: "c",
					goal: "C",
					child_id: "ID_C",
				}),
				makeEvent("act_start", "ID_A", 1, {
					agent_name: "d",
					goal: "D",
					child_id: "ID_D",
				}),
				makeEvent("act_start", "ID_C", 2, {
					agent_name: "e",
					goal: "E",
					child_id: "ID_E",
				}),
				makeEvent("act_end", "ID_C", 2, { child_id: "ID_E", success: true }),
				makeEvent("act_end", "ID_A", 1, { child_id: "ID_C", success: true }),
				makeEvent("act_end", "ID_A", 1, { child_id: "ID_D", success: true }),
				makeEvent("act_end", "root", 0, { child_id: "ID_B", success: true }),
				makeEvent("act_end", "root", 0, { child_id: "ID_A", success: true }),
			];
			const { tree } = buildAgentTree(events);

			// Root → [A, B]
			expect(tree.children).toHaveLength(2);
			const a = tree.children[0]!;
			const b = tree.children[1]!;
			expect(a.agentId).toBe("ID_A");
			expect(b.agentId).toBe("ID_B");
			expect(b.children).toHaveLength(0);

			// A → [C, D]
			expect(a.children).toHaveLength(2);
			const c = a.children[0]!;
			const d = a.children[1]!;
			expect(c.agentId).toBe("ID_C");
			expect(d.agentId).toBe("ID_D");
			expect(d.children).toHaveLength(0);

			// C → [E]
			expect(c.children).toHaveLength(1);
			expect(c.children[0]!.agentId).toBe("ID_E");
			expect(c.children[0]!.depth).toBe(3);
		});
	});

	describe("mixed active and completed agents", () => {
		test("completed and running agents coexist", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Multi-task" }),
				makeEvent("act_start", "root", 0, { agent_name: "reader", goal: "Read" }),
				makeEvent("act_end", "root", 0, { agent_name: "reader", goal: "Read", success: true, turns: 1 }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit" }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(2);
			expect(tree.children[0]!.status).toBe("completed");
			expect(tree.children[1]!.status).toBe("running");
		});
	});

	describe("same agent_name appearing multiple times", () => {
		test("second act_start with same agent_name creates a disambiguated node", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Retry work" }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "First attempt" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", goal: "First attempt", success: false, turns: 1 }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Second attempt" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", goal: "Second attempt", success: true, turns: 2 }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(2);
			expect(tree.children[0]!.agentId).toBe("editor");
			expect(tree.children[0]!.goal).toBe("First attempt");
			expect(tree.children[0]!.status).toBe("failed");
			expect(tree.children[1]!.agentId).toBe("editor#2");
			expect(tree.children[1]!.goal).toBe("Second attempt");
			expect(tree.children[1]!.status).toBe("completed");
		});
	});

	describe("events without act_start/act_end are ignored for tree", () => {
		test("plan_start, plan_end, etc. do not create tree nodes", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Work" }),
				makeEvent("plan_start", "root", 0, { turn: 1 }),
				makeEvent("plan_delta", "root", 0, { text: "thinking" }),
				makeEvent("plan_end", "root", 0, { turn: 1 }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", goal: "Edit", success: true, turns: 1 }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(1);
			expect(tree.children[0]!.agentId).toBe("editor");
		});
	});

	describe("getDescendantIds", () => {
		test("returns all descendant agent IDs including self", () => {
			resetTimestamps();
			const { tree } = buildAgentTree([
				makeEvent("perceive", "root-agent", 0, { goal: "Go" }),
				makeEvent("act_start", "root-agent", 0, { agent_name: "editor", goal: "Edit" }),
				makeEvent("act_start", "editor", 1, { agent_name: "writer", goal: "Write" }),
				makeEvent("act_end", "editor", 1, { agent_name: "writer", success: true }),
				makeEvent("act_end", "root-agent", 0, { agent_name: "editor", success: true }),
				makeEvent("act_start", "root-agent", 0, { agent_name: "runner", goal: "Run" }),
				makeEvent("act_end", "root-agent", 0, { agent_name: "runner", success: true }),
			]);

			const ids = getDescendantIds(tree, "editor");
			expect(ids).toContain("editor");
			expect(ids).toContain("writer");
			expect(ids).not.toContain("runner");
			expect(ids).not.toContain("root-agent");
		});

		test("returns null when agentId not found", () => {
			const { tree } = buildAgentTree([makeEvent("perceive", "root", 0, { goal: "Go" })]);
			expect(getDescendantIds(tree, "nonexistent")).toBeNull();
		});

		test("returns just self for leaf agent", () => {
			resetTimestamps();
			const { tree } = buildAgentTree([
				makeEvent("perceive", "root-agent", 0, { goal: "Go" }),
				makeEvent("act_start", "root-agent", 0, { agent_name: "leaf", goal: "Do" }),
				makeEvent("act_end", "root-agent", 0, { agent_name: "leaf", success: true }),
			]);
			const ids = getDescendantIds(tree, "leaf");
			expect(ids).toEqual(new Set(["leaf"]));
		});
	});

	describe("act_end without turns", () => {
		test("handles missing turns gracefully", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Work" }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Edit" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", goal: "Edit", success: true }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children[0]!.status).toBe("completed");
			expect(tree.children[0]!.turns).toBeUndefined();
		});
	});

	describe("child_id based tree building", () => {
		test("uses child_id from act_start for node agentId", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Work" }),
				makeEvent("act_start", "root", 0, {
					agent_name: "editor",
					goal: "Edit file",
					child_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "editor",
					goal: "Edit file",
					child_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
					success: true,
					turns: 2,
				}),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(1);
			const child = tree.children[0]!;
			expect(child.agentId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
			expect(child.agentName).toBe("editor");
			expect(child.status).toBe("completed");
			expect(child.turns).toBe(2);
		});

		test("same agent_name with different child_ids produces distinct nodes", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Retry" }),
				makeEvent("act_start", "root", 0, {
					agent_name: "editor",
					goal: "First",
					child_id: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "editor",
					child_id: "AAAAAAAAAAAAAAAAAAAAAAAAAA",
					success: false,
				}),
				makeEvent("act_start", "root", 0, {
					agent_name: "editor",
					goal: "Second",
					child_id: "BBBBBBBBBBBBBBBBBBBBBBBBBB",
				}),
				makeEvent("act_end", "root", 0, {
					agent_name: "editor",
					child_id: "BBBBBBBBBBBBBBBBBBBBBBBBBB",
					success: true,
				}),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(2);
			expect(tree.children[0]!.agentId).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAA");
			expect(tree.children[1]!.agentId).toBe("BBBBBBBBBBBBBBBBBBBBBBBBBB");
			expect(tree.children[0]!.agentName).toBe("editor");
			expect(tree.children[1]!.agentName).toBe("editor");
		});

		test("falls back to name disambiguation when child_id absent", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Legacy" }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "First" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", success: false }),
				makeEvent("act_start", "root", 0, { agent_name: "editor", goal: "Second" }),
				makeEvent("act_end", "root", 0, { agent_name: "editor", success: true }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.children).toHaveLength(2);
			expect(tree.children[0]!.agentId).toBe("editor");
			expect(tree.children[1]!.agentId).toBe("editor#2");
		});
	});

	describe("session_start resets root status", () => {
		test("root status resets to running on session_start after being completed", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("perceive", "root", 0, { goal: "First task" }),
				makeEvent("session_end", "root", 0, { success: true }),
				// Second session starts
				makeEvent("session_start", "root", 0, { model: "claude" }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.status).toBe("running");
		});

		test("root status resets to running on session_start after being failed", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("session_end", "root", 0, { success: false }),
				makeEvent("session_start", "root", 0, { model: "claude" }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.status).toBe("running");
		});
	});

	describe("root goal updates on subsequent perceive events", () => {
		test("goal updates on continue() with new perceive", () => {
			resetTimestamps();
			const events = [
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("perceive", "root", 0, { goal: "First task" }),
				makeEvent("session_end", "root", 0, { success: true }),
				makeEvent("session_start", "root", 0, { model: "claude" }),
				makeEvent("perceive", "root", 0, { goal: "Second task" }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.goal).toBe("Second task");
		});

		test("first perceive sets the goal", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "root", 0, { goal: "Initial goal" }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.goal).toBe("Initial goal");
		});
	});

	describe("root agentName derived from agent_id", () => {
		test("sets agentName from first depth-0 event agent_id", () => {
			resetTimestamps();
			const events = [
				makeEvent("perceive", "my-agent", 0, { goal: "Hello" }),
			];
			const { tree } = buildAgentTree(events);

			expect(tree.agentId).toBe("my-agent");
			expect(tree.agentName).toBe("my-agent");
		});
	});
});

import { describe, expect, test } from "bun:test";
import type {
	ActResult,
	AgentConstraints,
	AgentSpec,
	Delegation,
	EventKind,
	LearnSignal,
	Memory,
	Perception,
	PrimitiveResult,
	RecallResult,
	RoutingRule,
	SessionEvent,
	VerifyResult,
} from "../../src/kernel/types.ts";

describe("kernel types", () => {
	test("AgentSpec can be constructed with required fields", () => {
		const spec: AgentSpec = {
			name: "code-reader",
			description: "Find and return relevant code from files",
			system_prompt: "You help find specific code.",
			model: "fast",
			capabilities: ["read_file", "grep", "glob"],
			constraints: {
				max_turns: 50,
				max_depth: 3,
				timeout_ms: 300000,
				can_spawn: true,
				can_learn: false,
			},
			tags: ["core", "reading"],
			version: 1,
		};
		expect(spec.name).toBe("code-reader");
		expect(spec.constraints.max_turns).toBe(50);
	});

	test("AgentConstraints has sensible defaults documented in types", () => {
		// Verify the type allows partial construction with defaults
		const constraints: AgentConstraints = {
			max_turns: 50,
			max_depth: 3,
			timeout_ms: 300000,
			can_spawn: true,
			can_learn: false,
		};
		expect(constraints.max_depth).toBe(3);
	});

	test("Perception captures inputs and environment state", () => {
		const perception: Perception = {
			inputs: [{ role: "user", content: "Fix the bug" }],
			env_state: { working_dir: "/tmp", git_branch: "main" },
			timestamp: Date.now(),
		};
		expect(perception.inputs).toHaveLength(1);
	});

	test("RecallResult contains agents, memories, and routing hints", () => {
		const result: RecallResult = {
			agents: [],
			memories: [],
			routing_hints: [],
		};
		expect(result.agents).toEqual([]);
	});

	test("Delegation captures agent name, goal, and optional hints", () => {
		const delegation: Delegation = {
			agent_name: "code-editor",
			goal: "Fix the null check on line 23",
			hints: ["The file is src/auth/login.ts"],
		};
		expect(delegation.goal).toContain("null check");
	});

	test("Delegation works without hints", () => {
		const delegation: Delegation = {
			agent_name: "code-reader",
			goal: "Find the auth middleware",
		};
		expect(delegation.hints).toBeUndefined();
	});

	test("ActResult captures goal outcome with stumble metrics", () => {
		const result: ActResult = {
			agent_name: "code-editor",
			goal: "Fix the null check",
			output: "Fixed successfully",
			success: true,
			stumbles: 0,
			turns: 3,
		};
		expect(result.success).toBe(true);
		expect(result.stumbles).toBe(0);
	});

	test("VerifyResult captures success and stumble state", () => {
		const result: VerifyResult = {
			success: true,
			stumbled: false,
			output: "All good",
		};
		expect(result.stumbled).toBe(false);
	});

	test("LearnSignal captures stumble details", () => {
		const signal: LearnSignal = {
			kind: "error",
			goal: "Run tests",
			agent_name: "command-runner",
			details: {
				agent_name: "command-runner",
				goal: "Run tests",
				output: "pytest: command not found",
				success: false,
				stumbles: 1,
				turns: 1,
			},
			session_id: "session-123",
			timestamp: Date.now(),
		};
		expect(signal.kind).toBe("error");
	});

	test("Memory tracks content with confidence decay metadata", () => {
		const memory: Memory = {
			id: "mem-001",
			content: "This project uses vitest, not pytest",
			tags: ["testing", "vitest"],
			source: "learn-session-42",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 3,
			confidence: 0.85,
		};
		expect(memory.confidence).toBe(0.85);
	});

	test("RoutingRule captures agent preference with strength", () => {
		const rule: RoutingRule = {
			id: "rule-001",
			condition: "Go project testing",
			preference: "test-runner-go",
			strength: 0.8,
			source: "learn-session-55",
		};
		expect(rule.strength).toBe(0.8);
	});

	test("PrimitiveResult captures output, success, and optional error", () => {
		const success: PrimitiveResult = {
			output: "file contents here",
			success: true,
		};
		expect(success.error).toBeUndefined();

		const failure: PrimitiveResult = {
			output: "",
			success: false,
			error: "File not found: /nonexistent",
		};
		expect(failure.error).toContain("not found");
	});

	test("SessionEvent carries kind, agent context, and data", () => {
		const event: SessionEvent = {
			kind: "plan_start",
			timestamp: Date.now(),
			agent_id: "root",
			depth: 0,
			data: { model: "claude-opus-4-6" },
		};
		expect(event.kind).toBe("plan_start");
		expect(event.depth).toBe(0);
	});

	test("EventKind covers all loop phases", () => {
		const kinds: EventKind[] = [
			"session_start",
			"session_end",
			"perceive",
			"recall",
			"plan_start",
			"plan_delta",
			"plan_end",
			"act_start",
			"act_end",
			"primitive_start",
			"primitive_end",
			"verify",
			"learn_signal",
			"learn_start",
			"learn_mutation",
			"learn_end",
			"steering",
			"warning",
			"error",
		];
		expect(kinds).toHaveLength(19);
	});
});

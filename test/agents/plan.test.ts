import { describe, expect, test } from "bun:test";
import {
	buildDelegateTool,
	buildPlanRequest,
	buildSystemPrompt,
	parsePlanResponse,
	primitivesForAgent,
	renderAgentsForPrompt,
} from "../../src/agents/plan.ts";
import type { AgentSpec, Memory, RoutingRule } from "../../src/kernel/types.ts";
import { Msg } from "../../src/llm/types.ts";

const testAgent: AgentSpec = {
	name: "code-reader",
	description: "Find and return relevant code",
	system_prompt: "You help find code.",
	model: "fast",
	capabilities: ["read_file", "grep", "glob"],
	constraints: {
		max_turns: 50,
		max_depth: 3,
		timeout_ms: 300000,
		can_spawn: true,
		can_learn: false,
	},
	tags: ["core"],
	version: 1,
};

describe("buildDelegateTool", () => {
	test("creates a single delegate tool with agent_name enum", () => {
		const agents: AgentSpec[] = [
			testAgent,
			{ ...testAgent, name: "code-editor", description: "Edit code files" },
		];
		const tool = buildDelegateTool(agents);
		expect(tool.name).toBe("delegate");
		expect(tool.description).toContain("Delegate");
		const props = (tool.parameters as any).properties;
		expect(props.agent_name).toBeDefined();
		expect(props.agent_name.enum).toEqual(["code-reader", "code-editor"]);
		expect(props.goal).toBeDefined();
		expect(props.goal.type).toBe("string");
		expect(props.hints).toBeDefined();
		expect(props.hints.type).toBe("array");
		expect((tool.parameters as any).required).toEqual(["agent_name", "goal"]);
	});

	test("omits enum when no agents provided", () => {
		const tool = buildDelegateTool([]);
		const props = (tool.parameters as any).properties;
		expect(props.agent_name.enum).toBeUndefined();
	});
});

describe("renderAgentsForPrompt", () => {
	test("renders agents as XML block", () => {
		const agents: AgentSpec[] = [
			testAgent,
			{ ...testAgent, name: "code-editor", description: "Edit code files" },
		];
		const result = renderAgentsForPrompt(agents);
		expect(result).toContain("<agents>");
		expect(result).toContain('name="code-reader"');
		expect(result).toContain("Find and return relevant code");
		expect(result).toContain('name="code-editor"');
		expect(result).toContain("Edit code files");
		expect(result).toContain("</agents>");
	});

	test("returns empty string for no agents", () => {
		expect(renderAgentsForPrompt([])).toBe("");
	});
});

describe("primitivesForAgent", () => {
	const allNames = [
		"read_file",
		"write_file",
		"edit_file",
		"apply_patch",
		"exec",
		"grep",
		"glob",
		"fetch",
	];

	test("filters primitives by capabilities", () => {
		const names = primitivesForAgent(["read_file", "grep"], allNames, "anthropic");
		expect(names).toContain("read_file");
		expect(names).toContain("grep");
		expect(names).not.toContain("write_file");
		expect(names).not.toContain("exec");
	});

	test("swaps edit_file for apply_patch on OpenAI", () => {
		const names = primitivesForAgent(["read_file", "edit_file"], allNames, "openai");
		expect(names).toContain("apply_patch");
		expect(names).not.toContain("edit_file");
	});

	test("keeps edit_file for Anthropic", () => {
		const names = primitivesForAgent(["read_file", "edit_file"], allNames, "anthropic");
		expect(names).toContain("edit_file");
		expect(names).not.toContain("apply_patch");
	});

	test("keeps edit_file for Gemini", () => {
		const names = primitivesForAgent(["read_file", "edit_file"], allNames, "gemini");
		expect(names).toContain("edit_file");
		expect(names).not.toContain("apply_patch");
	});

	test("ignores capabilities not in allPrimitiveNames", () => {
		const names = primitivesForAgent(["read_file", "nonexistent_tool"], allNames, "anthropic");
		expect(names).toEqual(["read_file"]);
	});
});

describe("buildSystemPrompt", () => {
	test("includes agent system prompt and environment context", () => {
		const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0");
		expect(prompt).toContain("You help find code.");
		expect(prompt).toContain("/tmp/test");
		expect(prompt).toContain("darwin");
		expect(prompt).toContain("Darwin 25.0");
		expect(prompt).toContain("<environment>");
		expect(prompt).toContain("</environment>");
	});

	test("includes rendered memories in system prompt", () => {
		const memories: Memory[] = [
			{
				id: "m1",
				content: "this project uses vitest",
				tags: ["testing"],
				source: "test",
				created: Date.now(),
				last_used: Date.now(),
				use_count: 1,
				confidence: 1.0,
			},
		];
		const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0", {
			memories,
		});
		expect(prompt).toContain("<memories>");
		expect(prompt).toContain("this project uses vitest");
		expect(prompt).toContain("</memories>");
	});

	test("includes rendered routing hints in system prompt", () => {
		const routingHints: RoutingRule[] = [
			{
				id: "r1",
				condition: "Go testing",
				preference: "test-runner-go",
				strength: 0.8,
				source: "test",
			},
		];
		const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0", {
			routingHints,
		});
		expect(prompt).toContain("<routing_hints>");
		expect(prompt).toContain("Go testing");
		expect(prompt).toContain("test-runner-go");
		expect(prompt).toContain("</routing_hints>");
	});

	test("omits memory/routing sections when empty", () => {
		const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0");
		expect(prompt).not.toContain("<memories>");
		expect(prompt).not.toContain("<routing_hints>");
	});

	test("includes project docs when provided", () => {
		const prompt = buildSystemPrompt(
			testAgent,
			"/tmp/test",
			"darwin",
			"Darwin 25.0",
			undefined,
			undefined,
			"Follow the coding standards in this project.",
		);
		expect(prompt).toContain("<project-instructions>");
		expect(prompt).toContain("Follow the coding standards in this project.");
		expect(prompt).toContain("</project-instructions>");
	});

	test("omits project docs section when not provided", () => {
		const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0");
		expect(prompt).not.toContain("<project-instructions>");
	});

	test("includes genome postscripts after agent prompt and before environment", () => {
		const workerSpec: AgentSpec = {
			...testAgent,
			constraints: { ...testAgent.constraints, can_spawn: false },
		};
		const postscripts = { global: "Be concise.", orchestrator: "", worker: "No fluff.", agent: "Reader-specific." };
		const prompt = buildSystemPrompt(
			workerSpec,
			"/tmp/test",
			"darwin",
			"Darwin 25.0",
			undefined,
			undefined,
			undefined,
			postscripts,
		);
		expect(prompt).toContain("Be concise.");
		expect(prompt).toContain("No fluff.");
		expect(prompt).toContain("Reader-specific.");
		// Postscripts should come before environment
		const postscriptIdx = prompt.indexOf("Be concise.");
		const envIdx = prompt.indexOf("<environment>");
		expect(postscriptIdx).toBeLessThan(envIdx);
	});

	test("uses orchestrator postscript for agents with can_spawn", () => {
		const orchestratorSpec: AgentSpec = {
			...testAgent,
			name: "root",
			constraints: { ...testAgent.constraints, can_spawn: true },
		};
		const postscripts = { global: "Global.", orchestrator: "Orchestrator rule.", worker: "Worker rule.", agent: "" };
		const prompt = buildSystemPrompt(
			orchestratorSpec,
			"/tmp/test",
			"darwin",
			"Darwin 25.0",
			undefined,
			undefined,
			undefined,
			postscripts,
		);
		expect(prompt).toContain("Global.");
		expect(prompt).toContain("Orchestrator rule.");
		expect(prompt).not.toContain("Worker rule.");
	});

	test("omits postscript section when all parts are empty", () => {
		const postscripts = { global: "", orchestrator: "", worker: "", agent: "" };
		const prompt = buildSystemPrompt(
			testAgent,
			"/tmp/test",
			"darwin",
			"Darwin 25.0",
			undefined,
			undefined,
			undefined,
			postscripts,
		);
		// Should not have double newlines between prompt and environment
		expect(prompt).toContain("You help find code.\n\n<environment>");
	});
});

describe("buildPlanRequest", () => {
	test("builds a valid LLM Request", () => {
		const delegateTool = buildDelegateTool([testAgent]);
		const req = buildPlanRequest({
			systemPrompt: "You are a test agent.",
			history: [],
			agentTools: [delegateTool],
			primitiveTools: [],
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
		});
		expect(req.model).toBe("claude-haiku-4-5-20251001");
		expect(req.provider).toBe("anthropic");
		expect(req.messages[0]!.role).toBe("system");
		expect(req.tools).toHaveLength(1);
		expect(req.tools![0]!.name).toBe("delegate");
		expect(req.tool_choice).toBe("auto");
		expect(req.max_tokens).toBe(16384);
	});

	test("includes history messages after system", () => {
		const history = [Msg.user("hello"), Msg.assistant("hi")];
		const req = buildPlanRequest({
			systemPrompt: "System prompt.",
			history,
			agentTools: [],
			primitiveTools: [],
			model: "gpt-4.1-mini",
			provider: "openai",
		});
		expect(req.messages).toHaveLength(3); // system + 2 history
		expect(req.messages[1]!.role).toBe("user");
		expect(req.messages[2]!.role).toBe("assistant");
	});
});

describe("parsePlanResponse", () => {
	test("identifies delegate calls vs primitive calls", () => {
		const toolCalls = [
			{
				id: "call_1",
				name: "delegate",
				arguments: { agent_name: "code-reader", goal: "find auth code", hints: ["check src/auth"] },
			},
			{ id: "call_2", name: "exec", arguments: { command: "ls" } },
		];
		const result = parsePlanResponse(toolCalls);
		expect(result.delegations).toHaveLength(1);
		expect(result.delegations[0]!.call_id).toBe("call_1");
		expect(result.delegations[0]!.agent_name).toBe("code-reader");
		expect(result.delegations[0]!.goal).toBe("find auth code");
		expect(result.delegations[0]!.hints).toEqual(["check src/auth"]);
		expect(result.primitiveCalls).toHaveLength(1);
		expect(result.primitiveCalls[0]!.name).toBe("exec");
	});

	test("returns empty arrays when no tool calls", () => {
		const result = parsePlanResponse([]);
		expect(result.delegations).toHaveLength(0);
		expect(result.primitiveCalls).toHaveLength(0);
	});

	test("returns error for delegation missing agent_name", () => {
		const toolCalls = [{ id: "call_1", name: "delegate", arguments: { goal: "find code" } }];
		const result = parsePlanResponse(toolCalls);
		expect(result.delegations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.call_id).toBe("call_1");
		expect(result.errors[0]!.error).toContain("agent_name");
	});

	test("returns error for delegation missing goal argument", () => {
		const toolCalls = [
			{ id: "call_1", name: "delegate", arguments: { agent_name: "code-reader" } },
		];
		const result = parsePlanResponse(toolCalls);
		expect(result.delegations).toHaveLength(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.error).toContain("missing required 'goal'");
	});

	test("ignores non-array hints", () => {
		const toolCalls = [
			{
				id: "call_1",
				name: "delegate",
				arguments: { agent_name: "code-reader", goal: "find code", hints: "not an array" },
			},
		];
		const result = parsePlanResponse(toolCalls);
		expect(result.delegations[0]!.hints).toBeUndefined();
	});
});

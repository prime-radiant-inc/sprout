import { describe, expect, test } from "bun:test";
import {
	agentAsTool,
	buildPlanRequest,
	buildSystemPrompt,
	parsePlanResponse,
	primitivesForAgent,
} from "../../src/agents/plan.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
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

describe("agentAsTool", () => {
	test("converts AgentSpec to ToolDefinition with goal/hints params", () => {
		const tool = agentAsTool(testAgent);
		expect(tool.name).toBe("code-reader");
		expect(tool.description).toBe("Find and return relevant code");
		const props = (tool.parameters as any).properties;
		expect(props.goal).toBeDefined();
		expect(props.goal.type).toBe("string");
		expect(props.hints).toBeDefined();
		expect(props.hints.type).toBe("array");
		expect((tool.parameters as any).required).toEqual(["goal"]);
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
});

describe("buildPlanRequest", () => {
	test("builds a valid LLM Request", () => {
		const agentTool = agentAsTool(testAgent);
		const req = buildPlanRequest({
			systemPrompt: "You are a test agent.",
			history: [],
			agentTools: [agentTool],
			primitiveTools: [],
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
		});
		expect(req.model).toBe("claude-haiku-4-5-20251001");
		expect(req.provider).toBe("anthropic");
		expect(req.messages[0]!.role).toBe("system");
		expect(req.tools).toHaveLength(1);
		expect(req.tools![0]!.name).toBe("code-reader");
		expect(req.tool_choice).toBe("auto");
		expect(req.max_tokens).toBe(4096);
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
	test("identifies agent delegations vs primitive calls", () => {
		const agentNames = new Set(["code-reader", "code-editor"]);
		const toolCalls = [
			{
				id: "call_1",
				name: "code-reader",
				arguments: { goal: "find auth code", hints: ["check src/auth"] },
			},
			{ id: "call_2", name: "exec", arguments: { command: "ls" } },
		];
		const result = parsePlanResponse(toolCalls, agentNames);
		expect(result.delegations).toHaveLength(1);
		expect(result.delegations[0]!.agent_name).toBe("code-reader");
		expect(result.delegations[0]!.goal).toBe("find auth code");
		expect(result.delegations[0]!.hints).toEqual(["check src/auth"]);
		expect(result.primitiveCalls).toHaveLength(1);
		expect(result.primitiveCalls[0]!.name).toBe("exec");
	});

	test("returns empty arrays when no tool calls", () => {
		const result = parsePlanResponse([], new Set(["code-reader"]));
		expect(result.delegations).toHaveLength(0);
		expect(result.primitiveCalls).toHaveLength(0);
	});
});

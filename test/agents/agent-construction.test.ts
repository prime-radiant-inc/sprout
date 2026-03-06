import { describe, expect, test } from "bun:test";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { createAgentFixture, leafSpec, rootSpec } from "./fixtures.ts";

describe("Agent construction and tool resolution", () => {
	test("global depth rail allows agents at depth 8", () => {
		expect(() =>
			createAgentFixture({
				spec: rootSpec,
				availableAgents: [rootSpec, leafSpec],
				depth: 8,
			}),
		).not.toThrow();
	});

	test("global depth rail rejects agents deeper than 8", () => {
		expect(() =>
			createAgentFixture({
				spec: rootSpec,
				availableAgents: [rootSpec, leafSpec],
				depth: 9,
			}),
		).toThrow(/depth/i);
	});

	test("resolves single delegate tool from agents list", () => {
		const { agent } = createAgentFixture({
			spec: rootSpec,
			availableAgents: [rootSpec, leafSpec],
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("delegate");
		expect(names).not.toContain("leaf");
		expect(names).not.toContain("root");
	});

	test("delegating agent does not get primitive tools", () => {
		const mixedSpec: AgentSpec = {
			name: "mixed",
			description: "Has both agents and primitive tools",
			system_prompt: "You do things.",
			model: "fast",
			tools: ["read_file", "grep"],
			agents: ["leaf"],
			constraints: { ...leafSpec.constraints, max_turns: 5 },
			tags: [],
			version: 1,
		};
		const { agent } = createAgentFixture({
			spec: mixedSpec,
			availableAgents: [mixedSpec, leafSpec],
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("delegate");
		expect(names).not.toContain("read_file");
		expect(names).not.toContain("grep");
	});

	test("resolves primitive tools from tools list", () => {
		const { agent } = createAgentFixture({
			spec: leafSpec,
			availableAgents: [rootSpec, leafSpec],
			depth: 1,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
		expect(names).toContain("exec");
		expect(names).not.toContain("root");
		expect(names).not.toContain("leaf");
	});

	test("excludes delegate tool when can_spawn is false", () => {
		const noSpawnSpec: AgentSpec = {
			...rootSpec,
			tools: ["read_file"],
			constraints: { ...rootSpec.constraints, can_spawn: false },
		};
		const { agent } = createAgentFixture({
			spec: noSpawnSpec,
			availableAgents: [rootSpec, leafSpec],
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).not.toContain("delegate");
		expect(names).not.toContain("leaf");
	});

	test("delegate tool has agent_name/goal/hints parameters", () => {
		const { agent } = createAgentFixture({
			spec: rootSpec,
			availableAgents: [rootSpec, leafSpec],
		});
		const tools = agent.resolvedTools();
		const delegateTool = tools.find((t) => t.name === "delegate");
		expect(delegateTool).toBeDefined();
		const props = (delegateTool!.parameters as any).properties;
		expect(props.agent_name).toBeDefined();
		expect(props.agent_name.enum).toBeUndefined();
		expect(props.agent_name.description).toContain("leaf");
		expect(props.goal).toBeDefined();
		expect(props.hints).toBeDefined();
	});

	test("primitive tools have correct descriptions", () => {
		const { agent } = createAgentFixture({
			spec: leafSpec,
			availableAgents: [],
		});
		const tools = agent.resolvedTools();
		const readTool = tools.find((t) => t.name === "read_file");
		expect(readTool).toBeDefined();
		expect(readTool!.description).toContain("Read");
		expect(readTool!.parameters).toBeDefined();
	});

	test("depth defaults to 0", () => {
		const { agent } = createAgentFixture({
			spec: rootSpec,
			availableAgents: [leafSpec],
		});
		expect(agent.resolvedTools().map((t) => t.name)).toContain("delegate");
	});
});

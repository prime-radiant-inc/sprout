import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { Agent } from "../../src/agents/agent.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

describe("Agent", () => {
	const rootSpec: AgentSpec = {
		name: "root",
		description: "Test root",
		system_prompt: "You decompose tasks.",
		model: "fast",
		capabilities: ["leaf"],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 10 },
		tags: [],
		version: 1,
	};

	const leafSpec: AgentSpec = {
		name: "leaf",
		description: "Test leaf",
		system_prompt: "You do things.",
		model: "fast",
		capabilities: ["read_file", "write_file", "exec"],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
		tags: [],
		version: 1,
	};

	test("constructor validates max_depth", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		expect(
			() =>
				new Agent({
					spec: rootSpec,
					env,
					client,
					primitiveRegistry: registry,
					availableAgents: [],
					depth: 5,
				}),
		).toThrow(/depth/i);
	});

	test("resolves agent tools from capabilities", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		// Root's capabilities include "leaf", which is an agent name
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("leaf");
		// Should NOT include root itself
		expect(names).not.toContain("root");
	});

	test("resolves primitive tools from capabilities", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 1,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
		expect(names).toContain("exec");
		// Should not include agent tools (leaf has no agent capabilities)
		expect(names).not.toContain("root");
		expect(names).not.toContain("leaf");
	});

	test("excludes agent tools when can_spawn is false", () => {
		const noSpawnSpec: AgentSpec = {
			...rootSpec,
			constraints: { ...rootSpec.constraints, can_spawn: false },
		};
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: noSpawnSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		// "leaf" is in capabilities but can_spawn is false, so no agent tools
		expect(names).not.toContain("leaf");
		expect(names).not.toContain("root");
	});

	test("agent tool has goal/hints parameters", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const leafTool = tools.find((t) => t.name === "leaf");
		expect(leafTool).toBeDefined();
		const props = (leafTool!.parameters as any).properties;
		expect(props.goal).toBeDefined();
		expect(props.hints).toBeDefined();
	});

	test("primitive tools have correct descriptions", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
		});
		const tools = agent.resolvedTools();
		const readTool = tools.find((t) => t.name === "read_file");
		expect(readTool).toBeDefined();
		expect(readTool!.description).toContain("Read");
		expect(readTool!.parameters).toBeDefined();
	});

	test("depth defaults to 0", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		// Should not throw — depth defaults to 0, max_depth is 3
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [leafSpec],
		});
		expect(agent.resolvedTools().map((t) => t.name)).toContain("leaf");
	});
});

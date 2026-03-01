import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";

describe("save_agent primitive", () => {
	let tempDir: string;
	let genome: Genome;
	let registry: ReturnType<typeof createPrimitiveRegistry>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-save-agent-"));
		genome = new Genome(tempDir);
		await genome.init();
		const env = new LocalExecutionEnvironment(tempDir);
		registry = createPrimitiveRegistry(env, { genome, agentName: "qm-fabricator" });
	});

	test("save_agent is registered when genomeContext is provided", () => {
		expect(registry.names()).toContain("save_agent");
	});

	test("save_agent is NOT registered without genomeContext", () => {
		const env = new LocalExecutionEnvironment(tempDir);
		const plainRegistry = createPrimitiveRegistry(env);
		expect(plainRegistry.names()).not.toContain("save_agent");
	});

	test("saves a valid agent and registers it in the genome", async () => {
		const yaml = `
name: test-agent
description: "A test agent"
model: fast
tools:
  - read_file
constraints:
  max_turns: 10
  max_depth: 0
  can_spawn: false
  timeout_ms: 30000
tags:
  - test
system_prompt: |
  You are a test agent.
version: 1
`;

		const result = await registry.execute("save_agent", { yaml });
		expect(result.success).toBe(true);
		expect(result.output).toContain("test-agent");
		expect(result.output).toContain("immediately");

		// Verify it's in the genome's in-memory map
		const agents = genome.allAgents();
		const saved = agents.find((a) => a.name === "test-agent");
		expect(saved).toBeDefined();
		expect(saved!.description).toBe("A test agent");
		expect(saved!.model).toBe("fast");
		expect(saved!.tools).toEqual(["read_file"]);
		expect(saved!.agents).toEqual([]);
		expect(saved!.constraints.can_spawn).toBe(false);
	});

	test("applies default constraints for missing fields", async () => {
		const yaml = `
name: minimal-agent
description: "Minimal"
model: fast
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { yaml });
		expect(result.success).toBe(true);

		const agents = genome.allAgents();
		const saved = agents.find((a) => a.name === "minimal-agent");
		expect(saved).toBeDefined();
		expect(saved!.tools).toEqual([]);
		expect(saved!.tags).toEqual([]);
		expect(saved!.constraints.max_turns).toBe(50); // default
		expect(saved!.constraints.max_depth).toBe(3); // default
	});

	test("rejects YAML missing required name field", async () => {
		const yaml = `
description: "No name"
model: fast
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { yaml });
		expect(result.success).toBe(false);
		expect(result.error).toContain("name");
	});

	test("rejects YAML missing required model field", async () => {
		const yaml = `
name: bad-agent
description: "No model"
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { yaml });
		expect(result.success).toBe(false);
		expect(result.error).toContain("model");
	});

	test("rejects YAML missing required system_prompt field", async () => {
		const yaml = `
name: bad-agent
description: "No prompt"
model: fast
`;

		const result = await registry.execute("save_agent", { yaml });
		expect(result.success).toBe(false);
		expect(result.error).toContain("system_prompt");
	});

	test("rejects empty yaml parameter", async () => {
		const result = await registry.execute("save_agent", { yaml: "" });
		expect(result.success).toBe(false);
	});
});

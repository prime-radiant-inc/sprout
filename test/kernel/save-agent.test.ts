import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("save_agent is registered when genomeContext is provided", () => {
		expect(registry.names()).toContain("save_agent");
	});

	test("save_agent is NOT registered without genomeContext", () => {
		const env = new LocalExecutionEnvironment(tempDir);
		const plainRegistry = createPrimitiveRegistry(env);
		expect(plainRegistry.names()).not.toContain("save_agent");
	});

	test("save_agent is not registered in eval mode", () => {
		const env = new LocalExecutionEnvironment(tempDir);
		const evalRegistry = createPrimitiveRegistry(
			env,
			{ genome, agentName: "qm-fabricator" },
			{ evalMode: true },
		);
		expect(evalRegistry.names()).not.toContain("save_agent");
	});

	test("saves a valid agent and registers it in the genome", async () => {
		const spec = `
name: test-agent
description: "A test agent"
model: fast
tools:
  - read_file
constraints:
  max_turns: 10
  can_spawn: false
  timeout_ms: 30000
tags:
  - test
system_prompt: |
  You are a test agent.
version: 1
`;

		const result = await registry.execute("save_agent", { spec });
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
		const spec = `
name: minimal-agent
description: "Minimal"
model: fast
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(true);

		const agents = genome.allAgents();
		const saved = agents.find((a) => a.name === "minimal-agent");
		expect(saved).toBeDefined();
		expect(saved!.tools).toEqual([]);
		expect(saved!.tags).toEqual([]);
		expect(saved!.constraints.max_turns).toBe(50); // default
		expect("max_depth" in saved!.constraints).toBe(false);
	});

	test("rejects YAML missing required name field", async () => {
		const spec = `
description: "No name"
model: fast
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(false);
		expect(result.error).toContain("name");
	});

	test("rejects YAML missing required model field", async () => {
		const spec = `
name: bad-agent
description: "No model"
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(false);
		expect(result.error).toContain("model");
	});

	test("rejects YAML missing required system_prompt field", async () => {
		const spec = `
name: bad-agent
description: "No prompt"
model: fast
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(false);
		expect(result.error).toContain("system_prompt");
	});

	test("rejects empty spec parameter", async () => {
		const result = await registry.execute("save_agent", { spec: "" });
		expect(result.success).toBe(false);
	});

	test("rejects removed constraint keys", async () => {
		const spec = `
name: legacy-depth-agent
description: "Uses removed max_depth"
model: fast
constraints:
  max_depth: 3
system_prompt: |
  Do things.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(false);
		expect(result.error).toContain("max_depth");
	});

	test("falls back to capabilities when tools and agents are missing", async () => {
		const spec = `
name: legacy-agent
description: "Uses capabilities"
model: fast
capabilities:
  - read_file
  - grep
  - code-editor/edit
system_prompt: |
  You are a legacy agent.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(true);

		const agents = genome.allAgents();
		const saved = agents.find((a) => a.name === "legacy-agent");
		expect(saved).toBeDefined();
		expect(saved!.tools).toEqual(["read_file", "grep"]);
		expect(saved!.agents).toEqual(["code-editor/edit"]);
	});

	test("tools and agents take precedence over capabilities", async () => {
		const spec = `
name: explicit-agent
description: "Has both tools and capabilities"
model: fast
tools:
  - exec
agents:
  - helper/assist
capabilities:
  - read_file
  - other/delegate
system_prompt: |
  You are an explicit agent.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(true);

		const agents = genome.allAgents();
		const saved = agents.find((a) => a.name === "explicit-agent");
		expect(saved).toBeDefined();
		expect(saved!.tools).toEqual(["exec"]);
		expect(saved!.agents).toEqual(["helper/assist"]);
	});

	test("rejects agent name that shadows a kernel primitive", async () => {
		const spec = `
name: read_file
description: "Trying to shadow a primitive"
model: fast
system_prompt: |
  I shadow read_file.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(false);
		expect(result.error).toContain("kernel primitive");
	});

	test("preserves thinking field when present", async () => {
		const spec = `
name: thinker-agent
description: "An agent that thinks"
model: best
thinking:
  budget_tokens: 4096
system_prompt: |
  You think deeply.
`;

		const result = await registry.execute("save_agent", { spec });
		expect(result.success).toBe(true);

		const agents = genome.allAgents();
		const saved = agents.find((a) => a.name === "thinker-agent");
		expect(saved).toBeDefined();
		expect(saved!.thinking).toEqual({ budget_tokens: 4096 });
	});
});

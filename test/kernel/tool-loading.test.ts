import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { buildAgentToolPrimitives } from "../../src/kernel/tool-loading.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent",
		system_prompt: overrides.system_prompt ?? "You are a test agent.",
		model: overrides.model ?? "fast",
		capabilities: overrides.capabilities ?? ["read_file"],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

describe("tool loading", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-tool-load-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("buildAgentToolPrimitives returns empty array for no tools", () => {
		const prims = buildAgentToolPrimitives([]);
		expect(prims).toEqual([]);
	});

	test("buildAgentToolPrimitives creates primitives from tool definitions", async () => {
		const root = join(tempDir, "build-prims");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "editor" }));

		await genome.saveAgentTool("editor", {
			name: "hello",
			description: "Print hello",
			script: '#!/bin/bash\necho "hello world"',
			interpreter: "bash",
		});

		const toolDefs = await genome.loadAgentTools("editor");
		const prims = buildAgentToolPrimitives(toolDefs);

		expect(prims).toHaveLength(1);
		expect(prims[0]!.name).toBe("hello");
		expect(prims[0]!.description).toBe("Print hello");
	});

	test("executing a loaded tool runs the script", async () => {
		const root = join(tempDir, "exec-tool");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		await genome.saveAgentTool("runner", {
			name: "greet",
			description: "Print a greeting",
			script: '#!/bin/bash\necho "hello $1"',
			interpreter: "bash",
		});

		const toolDefs = await genome.loadAgentTools("runner");
		const prims = buildAgentToolPrimitives(toolDefs);
		const env = new LocalExecutionEnvironment(tempDir);

		const result = await prims[0]!.execute({ args: "world" }, env);
		expect(result.success).toBe(true);
		expect(result.output).toContain("hello world");
	});

	test("loaded tool uses specified interpreter", async () => {
		const root = join(tempDir, "interp-tool");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		await genome.saveAgentTool("runner", {
			name: "node-tool",
			description: "Run node script",
			script: 'console.log("from node")',
			interpreter: "node",
		});

		const toolDefs = await genome.loadAgentTools("runner");
		const prims = buildAgentToolPrimitives(toolDefs);
		const env = new LocalExecutionEnvironment(tempDir);

		const result = await prims[0]!.execute({}, env);
		expect(result.success).toBe(true);
		expect(result.output).toContain("from node");
	});

	test("loaded tool passes args as positional parameters", async () => {
		const root = join(tempDir, "args-tool");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		await genome.saveAgentTool("runner", {
			name: "echo-args",
			description: "Echo arguments",
			script: '#!/bin/bash\necho "arg1=$1 arg2=$2"',
			interpreter: "bash",
		});

		const toolDefs = await genome.loadAgentTools("runner");
		const prims = buildAgentToolPrimitives(toolDefs);
		const env = new LocalExecutionEnvironment(tempDir);

		const result = await prims[0]!.execute({ args: "foo bar" }, env);
		expect(result.success).toBe(true);
		expect(result.output).toContain("arg1=foo arg2=bar");
	});

	test("loaded tool reports non-zero exit as failure", async () => {
		const root = join(tempDir, "fail-tool");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec({ name: "runner" }));

		await genome.saveAgentTool("runner", {
			name: "fail-tool",
			description: "Always fails",
			script: "#!/bin/bash\nexit 1",
			interpreter: "bash",
		});

		const toolDefs = await genome.loadAgentTools("runner");
		const prims = buildAgentToolPrimitives(toolDefs);
		const env = new LocalExecutionEnvironment(tempDir);

		const result = await prims[0]!.execute({}, env);
		expect(result.success).toBe(false);
	});
});

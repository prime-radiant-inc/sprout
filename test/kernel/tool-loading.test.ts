import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

	describe("sprout-internal tools", () => {
		test("executes a sprout-internal tool and returns its result", async () => {
			const root = join(tempDir, "internal-tool");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "runner" }));

			const toolDir = join(root, "agents", "runner", "tools");
			await mkdir(toolDir, { recursive: true });
			const toolPath = join(toolDir, "hello-internal");
			await writeFile(
				toolPath,
				`---
name: hello-internal
description: A test internal tool
interpreter: sprout-internal
---
export default async function(ctx) {
  return {
    output: "hello from " + ctx.agentName,
    success: true,
  };
}
`,
			);

			const toolDefs = await genome.loadAgentTools("runner");
			expect(toolDefs).toHaveLength(1);
			expect(toolDefs[0]!.interpreter).toBe("sprout-internal");

			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({}, env);
			expect(result.success).toBe(true);
			expect(result.output).toBe("hello from runner");
		});

		test("sprout-internal tool receives parsed args", async () => {
			const root = join(tempDir, "internal-args");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "runner" }));

			const toolDir = join(root, "agents", "runner", "tools");
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(toolDir, "echo-args"),
				`---
name: echo-args
description: Echo args back
interpreter: sprout-internal
---
export default async function(ctx) {
  return {
    output: JSON.stringify(ctx.args),
    success: true,
  };
}
`,
			);

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({ args: '{"name":"test","count":3}' }, env);
			expect(result.success).toBe(true);
			const parsed = JSON.parse(result.output);
			expect(parsed.name).toBe("test");
			expect(parsed.count).toBe(3);
		});

		test("sprout-internal tool wraps thrown errors", async () => {
			const root = join(tempDir, "internal-error");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "runner" }));

			const toolDir = join(root, "agents", "runner", "tools");
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(toolDir, "throw-tool"),
				`---
name: throw-tool
description: Always throws
interpreter: sprout-internal
---
export default async function(ctx) {
  throw new Error("intentional failure");
}
`,
			);

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({}, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("intentional failure");
		});

		test("sprout-internal tool with invalid JSON args receives empty object", async () => {
			const root = join(tempDir, "internal-bad-json");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "runner" }));

			const toolDir = join(root, "agents", "runner", "tools");
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(toolDir, "check-args"),
				`---
name: check-args
description: Check args
interpreter: sprout-internal
---
export default async function(ctx) {
  return {
    output: JSON.stringify(ctx.args),
    success: true,
  };
}
`,
			);

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({ args: "not valid json" }, env);
			expect(result.success).toBe(true);
			expect(JSON.parse(result.output)).toEqual({});
		});
	});
});

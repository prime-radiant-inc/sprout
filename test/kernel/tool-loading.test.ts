import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
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
		tools: overrides.tools ?? ["read_file"],
		agents: overrides.agents ?? [],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

describe("tool loading", () => {
	let tempDir: string;
	let genomeTemplateDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-tool-load-"));
		genomeTemplateDir = join(tempDir, "__genome-template");
		const template = new Genome(genomeTemplateDir);
		await template.init();
		for (const name of ["runner", "editor"]) {
			await template.addAgent(makeSpec({ name }));
		}
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function setupGenome(name: string): Promise<{ root: string; genome: Genome }> {
		const root = join(tempDir, name);
		await cp(genomeTemplateDir, root, { recursive: true });
		return { root, genome: new Genome(root) };
	}

	test("buildAgentToolPrimitives returns empty array for no tools", () => {
		const prims = buildAgentToolPrimitives([]);
		expect(prims).toEqual([]);
	});

	test("buildAgentToolPrimitives creates primitives from tool definitions", async () => {
		const { genome } = await setupGenome("build-prims");

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
		const { genome } = await setupGenome("exec-tool");

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
		const { genome } = await setupGenome("interp-tool");

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
		const { genome } = await setupGenome("args-tool");

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
		const { genome } = await setupGenome("fail-tool");

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
			const { genome } = await setupGenome("internal-tool");

			await genome.saveAgentTool("runner", {
				name: "hello-internal",
				description: "A test internal tool",
				interpreter: "sprout-internal",
				script: `export default async function(ctx) {
  return { output: "hello from " + ctx.agentName, success: true };
}`,
			});

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
			const { genome } = await setupGenome("internal-args");

			await genome.saveAgentTool("runner", {
				name: "echo-args",
				description: "Echo args back",
				interpreter: "sprout-internal",
				script: `export default async function(ctx) {
  return { output: JSON.stringify(ctx.args), success: true };
}`,
			});

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
			const { genome } = await setupGenome("internal-error");

			await genome.saveAgentTool("runner", {
				name: "throw-tool",
				description: "Always throws",
				interpreter: "sprout-internal",
				script: `export default async function(ctx) {
  throw new Error("intentional failure");
}`,
			});

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
			const { genome } = await setupGenome("internal-bad-json");

			await genome.saveAgentTool("runner", {
				name: "check-args",
				description: "Check args",
				interpreter: "sprout-internal",
				script: `export default async function(ctx) {
  return { output: JSON.stringify(ctx.args), success: true };
}`,
			});

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

		test("returns error when InternalToolContext is missing", async () => {
			const { genome } = await setupGenome("sprout-internal-no-ctx");

			await genome.saveAgentTool("runner", {
				name: "needs-ctx",
				description: "Needs context",
				interpreter: "sprout-internal",
				script: `export default async function(ctx) {
  return { output: "ok", success: true };
}`,
			});

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			// No InternalToolContext passed
			const prims = buildAgentToolPrimitives(toolDefs);

			const result = await prims[0]!.execute({ args: "{}" }, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("InternalToolContext");
		});
	});

	describe("error diagnostic helpers", () => {
		test("extractLineFromStack extracts line number from stack trace", () => {
			const { extractLineFromStack } = require("../../src/kernel/tool-loading.ts");
			const tempPath = "/tmp/some-tool.12345.abc123.ts";
			const err = new Error("Unexpected token");
			err.stack = `SyntaxError: Unexpected token\n    at ${tempPath}:5:10\n    at Module._compile`;
			expect(extractLineFromStack(err, tempPath)).toBe(5);
		});

		test("extractLineFromStack returns null when path not in stack", () => {
			const { extractLineFromStack } = require("../../src/kernel/tool-loading.ts");
			const err = new Error("fail");
			err.stack = "Error: fail\n    at /other/path.ts:10:1";
			expect(extractLineFromStack(err, "/tmp/some-tool.ts")).toBeNull();
		});

		test("extractLineFromStack returns null for non-Error values", () => {
			const { extractLineFromStack } = require("../../src/kernel/tool-loading.ts");
			expect(extractLineFromStack("just a string", "/tmp/foo.ts")).toBeNull();
		});

		test("getSourceContext shows lines around target with marker", () => {
			const { getSourceContext } = require("../../src/kernel/tool-loading.ts");
			const lines = [
				"const a = 1;",
				"const b = 2;",
				"const c = INVALID;",
				"const d = 4;",
				"const e = 5;",
			];
			const result = getSourceContext(lines, 3, 1);
			expect(result).toContain("> ");
			expect(result).toContain("   3 |");
			expect(result).toContain("const c = INVALID;");
			// Should include context lines
			expect(result).toContain("   2 |");
			expect(result).toContain("   4 |");
			// Should NOT include line 1 or 5 with contextSize=1
			expect(result).not.toContain("   1 |");
			expect(result).not.toContain("   5 |");
		});

		test("getSourceContext handles edge cases at start of file", () => {
			const { getSourceContext } = require("../../src/kernel/tool-loading.ts");
			const lines = ["line1", "line2", "line3"];
			const result = getSourceContext(lines, 1, 2);
			// Line 1 is target, context goes 2 before (clamped to 0) and 2 after
			expect(result).toContain(">    1 |");
			expect(result).toContain("   2 |");
			expect(result).toContain("   3 |");
		});

		test("formatImportError includes tool name and message", () => {
			const { formatImportError } = require("../../src/kernel/tool-loading.ts");
			const err = new Error("Unexpected token");
			const result = formatImportError("my-tool", err, [], "/tmp/fake.ts");
			expect(result).toContain("Tool 'my-tool' failed to load:");
			expect(result).toContain("Unexpected token");
		});

		test("formatImportError includes source context when line found", () => {
			const { formatImportError } = require("../../src/kernel/tool-loading.ts");
			const tempPath = "/tmp/tool.12345.ts";
			const err = new Error("bad syntax");
			err.stack = `SyntaxError: bad syntax\n    at ${tempPath}:2:5`;
			const lines = ["const ok = 1;", "const bad = @@@;", "const fine = 3;"];
			const result = formatImportError("my-tool", err, lines, tempPath);
			expect(result).toContain("Tool 'my-tool' failed to load: bad syntax");
			expect(result).toContain("const bad = @@@;");
		});

		test("formatRuntimeError replaces temp path with original path in stack", () => {
			const { formatRuntimeError } = require("../../src/kernel/tool-loading.ts");
			const tempPath = "/tmp/tool.12345.abc.ts";
			const originalPath = "/genome/tools/my-tool.ts";
			const err = new Error("runtime boom");
			err.stack = `Error: runtime boom\n    at doThing (${tempPath}:10:5)\n    at ${tempPath}:20:1`;
			const result = formatRuntimeError("my-tool", err, tempPath, originalPath);
			expect(result).toContain("Tool 'my-tool' threw an error: runtime boom");
			expect(result).toContain(originalPath);
			expect(result).not.toContain(tempPath);
		});
	});

	describe("sprout-internal error diagnostics", () => {
		test("missing default export gives clear error message", async () => {
			const { genome } = await setupGenome("no-default-export");

			await genome.saveAgentTool("runner", {
				name: "no-export",
				description: "Missing default export",
				interpreter: "sprout-internal",
				script: `export function notDefault() { return { output: "oops", success: true }; }`,
			});

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({}, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("does not export a default function");
		});

		test("import error includes tool name and source context", async () => {
			const { genome } = await setupGenome("import-error");

			await genome.saveAgentTool("runner", {
				name: "bad-import",
				description: "Has syntax error",
				interpreter: "sprout-internal",
				script: `const x = ;\nexport default async function(ctx) { return { output: "ok", success: true }; }`,
			});

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({}, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("Tool 'bad-import' failed to load:");
		});

		test("runtime error includes cleaned stack trace", async () => {
			const { genome } = await setupGenome("runtime-error-stack");

			await genome.saveAgentTool("runner", {
				name: "runtime-fail",
				description: "Throws at runtime",
				interpreter: "sprout-internal",
				script: `export default async function(ctx) {
  throw new Error("runtime failure");
}`,
			});

			const toolDefs = await genome.loadAgentTools("runner");
			const env = new LocalExecutionEnvironment(tempDir);
			const prims = buildAgentToolPrimitives(toolDefs, {
				genome,
				env,
				agentName: "runner",
			});

			const result = await prims[0]!.execute({}, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("Tool 'runtime-fail' threw an error: runtime failure");
		});
	});
});

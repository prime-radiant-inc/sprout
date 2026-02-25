import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome, git } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
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

describe("workspace primitives", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-ws-prims-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("save_tool", () => {
		test("is registered when genomeContext is provided", async () => {
			const root = join(tempDir, "save-tool-reg");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "editor",
			});

			expect(registry.names()).toContain("save_tool");
		});

		test("is not registered when genomeContext is absent", () => {
			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env);

			expect(registry.names()).not.toContain("save_tool");
		});

		test("writes tool file with frontmatter and commits", async () => {
			const root = join(tempDir, "save-tool-exec");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "editor",
			});

			const result = await registry.execute("save_tool", {
				name: "lint-fix",
				description: "Run linter and auto-fix",
				script: "#!/bin/bash\neslint --fix .",
				interpreter: "bash",
			});

			expect(result.success).toBe(true);

			// Verify file was written
			const toolPath = join(root, "agents", "editor", "tools", "lint-fix");
			const content = await readFile(toolPath, "utf-8");
			expect(content).toContain("name: lint-fix");
			expect(content).toContain("eslint --fix .");

			// Verify executable
			const s = await stat(toolPath);
			expect(s.mode & 0o111).toBeGreaterThan(0);

			// Verify git committed
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
		});

		test("defaults interpreter to bash", async () => {
			const root = join(tempDir, "save-tool-default-interp");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "runner" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "runner",
			});

			const result = await registry.execute("save_tool", {
				name: "test-run",
				description: "Run tests",
				script: "npm test",
			});

			expect(result.success).toBe(true);

			const toolPath = join(root, "agents", "runner", "tools", "test-run");
			const content = await readFile(toolPath, "utf-8");
			expect(content).toContain("interpreter: bash");
		});

		test("returns error for missing required params", async () => {
			const root = join(tempDir, "save-tool-missing");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "editor",
			});

			const result = await registry.execute("save_tool", {
				name: "missing-script",
				description: "No script provided",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("script");
		});
	});

	describe("save_file", () => {
		test("is registered when genomeContext is provided", async () => {
			const root = join(tempDir, "save-file-reg");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "editor",
			});

			expect(registry.names()).toContain("save_file");
		});

		test("is not registered when genomeContext is absent", () => {
			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env);

			expect(registry.names()).not.toContain("save_file");
		});

		test("writes file and commits", async () => {
			const root = join(tempDir, "save-file-exec");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "editor",
			});

			const result = await registry.execute("save_file", {
				name: "style-guide.md",
				content: "# Style Guide\n\nUse tabs.",
			});

			expect(result.success).toBe(true);

			// Verify file was written
			const filePath = join(root, "agents", "editor", "files", "style-guide.md");
			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("# Style Guide\n\nUse tabs.");

			// Verify git committed
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
		});

		test("returns error for missing required params", async () => {
			const root = join(tempDir, "save-file-missing");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const env = new LocalExecutionEnvironment(tempDir);
			const registry = createPrimitiveRegistry(env, {
				genome,
				agentName: "editor",
			});

			const result = await registry.execute("save_file", {
				name: "notes.md",
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain("content");
		});
	});
});

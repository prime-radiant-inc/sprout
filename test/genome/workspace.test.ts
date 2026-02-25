import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome, git } from "../../src/genome/genome.ts";
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

describe("Genome workspace", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-workspace-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("agentDir", () => {
		test("returns path to agent directory", () => {
			const genome = new Genome("/fake/genome");
			expect(genome.agentDir("editor")).toBe("/fake/genome/agents/editor");
		});
	});

	describe("saveAgentTool", () => {
		test("writes tool file with YAML frontmatter and makes executable", async () => {
			const root = join(tempDir, "save-tool");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			await genome.saveAgentTool("editor", {
				name: "lint-fix",
				description: "Run linter and auto-fix",
				script: '#!/bin/bash\ncd "$1" && eslint --fix .',
				interpreter: "bash",
			});

			const toolPath = join(root, "agents", "editor", "tools", "lint-fix");
			const content = await readFile(toolPath, "utf-8");

			// Check YAML frontmatter
			expect(content).toMatch(/^---\n/);
			expect(content).toContain("name: lint-fix");
			expect(content).toContain("description: Run linter and auto-fix");
			expect(content).toContain("interpreter: bash");
			expect(content).toMatch(/---\n#!/); // frontmatter ends before script

			// Check script body is present
			expect(content).toContain('cd "$1" && eslint --fix .');

			// Check executable permission
			const s = await stat(toolPath);
			expect(s.mode & 0o111).toBeGreaterThan(0);
		});

		test("defaults interpreter to bash", async () => {
			const root = join(tempDir, "save-tool-default");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "runner" }));

			await genome.saveAgentTool("runner", {
				name: "test-run",
				description: "Run tests",
				script: "#!/bin/bash\nnpm test",
			});

			const toolPath = join(root, "agents", "runner", "tools", "test-run");
			const content = await readFile(toolPath, "utf-8");
			expect(content).toContain("interpreter: bash");
		});

		test("git commits the tool", async () => {
			const root = join(tempDir, "save-tool-git");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			await genome.saveAgentTool("editor", {
				name: "format",
				description: "Format code",
				script: "#!/bin/bash\nprettier --write .",
			});

			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: save tool 'format' for agent 'editor'");
		});
	});

	describe("saveAgentFile", () => {
		test("writes file to agent files directory", async () => {
			const root = join(tempDir, "save-file");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			await genome.saveAgentFile("editor", {
				name: "style-guide.md",
				content: "# Style Guide\n\nUse tabs for indentation.",
			});

			const filePath = join(root, "agents", "editor", "files", "style-guide.md");
			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("# Style Guide\n\nUse tabs for indentation.");
		});

		test("git commits the file", async () => {
			const root = join(tempDir, "save-file-git");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			await genome.saveAgentFile("editor", {
				name: "notes.md",
				content: "Some notes",
			});

			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: save file 'notes.md' for agent 'editor'");
		});
	});

	describe("loadAgentTools", () => {
		test("returns empty array when no tools directory exists", async () => {
			const root = join(tempDir, "load-tools-empty");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const tools = await genome.loadAgentTools("editor");
			expect(tools).toEqual([]);
		});

		test("parses tool files and returns tool definitions", async () => {
			const root = join(tempDir, "load-tools");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			await genome.saveAgentTool("editor", {
				name: "lint-fix",
				description: "Run linter",
				script: "#!/bin/bash\neslint --fix .",
				interpreter: "bash",
			});
			await genome.saveAgentTool("editor", {
				name: "format",
				description: "Format code",
				script: "#!/bin/bash\nprettier --write .",
				interpreter: "bash",
			});

			const tools = await genome.loadAgentTools("editor");
			expect(tools).toHaveLength(2);

			const names = tools.map((t) => t.name);
			expect(names).toContain("lint-fix");
			expect(names).toContain("format");

			const lintTool = tools.find((t) => t.name === "lint-fix")!;
			expect(lintTool.description).toBe("Run linter");
			expect(lintTool.interpreter).toBe("bash");
			expect(lintTool.scriptPath).toContain("agents/editor/tools/lint-fix");
		});
	});

	describe("listAgentFiles", () => {
		test("returns empty array when no files directory exists", async () => {
			const root = join(tempDir, "list-files-empty");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			const files = await genome.listAgentFiles("editor");
			expect(files).toEqual([]);
		});

		test("returns file names and sizes", async () => {
			const root = join(tempDir, "list-files");
			const genome = new Genome(root);
			await genome.init();
			await genome.addAgent(makeSpec({ name: "editor" }));

			await genome.saveAgentFile("editor", {
				name: "style-guide.md",
				content: "# Style Guide\n\nUse tabs.",
			});
			await genome.saveAgentFile("editor", {
				name: "config.yaml",
				content: "key: value",
			});

			const files = await genome.listAgentFiles("editor");
			expect(files).toHaveLength(2);

			const names = files.map((f) => f.name);
			expect(names).toContain("style-guide.md");
			expect(names).toContain("config.yaml");

			const styleFile = files.find((f) => f.name === "style-guide.md")!;
			expect(styleFile.size).toBeGreaterThan(0);
		});
	});
});

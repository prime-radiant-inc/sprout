import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
		tools: overrides.tools ?? ["read_file"],
		agents: overrides.agents ?? [],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

describe("Genome workspace", () => {
	let tempDir: string;
	let genomeTemplateDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-workspace-"));
		genomeTemplateDir = join(tempDir, "__genome-template");
		const template = new Genome(genomeTemplateDir);
		await template.init();
		for (const name of ["editor", "runner", "task-manager", "reader", "mcp"]) {
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

	describe("agentDir", () => {
		test("returns path to agent directory", () => {
			const genome = new Genome("/fake/genome");
			expect(genome.agentDir("editor")).toBe("/fake/genome/agents/editor");
		});
	});

	describe("saveAgentTool", () => {
		test("writes tool file with YAML frontmatter and makes executable", async () => {
			const { root, genome } = await setupGenome("save-tool");

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
			const { root, genome } = await setupGenome("save-tool-default");

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
			const { root, genome } = await setupGenome("save-tool-git");

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
			const { root, genome } = await setupGenome("save-file");

			await genome.saveAgentFile("editor", {
				name: "style-guide.md",
				content: "# Style Guide\n\nUse tabs for indentation.",
			});

			const filePath = join(root, "agents", "editor", "files", "style-guide.md");
			const content = await readFile(filePath, "utf-8");
			expect(content).toBe("# Style Guide\n\nUse tabs for indentation.");
		});

		test("git commits the file", async () => {
			const { root, genome } = await setupGenome("save-file-git");

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
			const { genome } = await setupGenome("load-tools-empty");

			const tools = await genome.loadAgentTools("editor");
			expect(tools).toEqual([]);
		});

		test("parses tool files and returns tool definitions", async () => {
			const { genome } = await setupGenome("load-tools");

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

		test("tools include provenance field", async () => {
			const { genome } = await setupGenome("load-tools-provenance");

			await genome.saveAgentTool("editor", {
				name: "lint-fix",
				description: "Run linter",
				script: "#!/bin/bash\neslint --fix .",
				interpreter: "bash",
			});

			const tools = await genome.loadAgentTools("editor");
			expect(tools[0]!.provenance).toBe("genome");
		});
	});

	describe("listAgentFiles", () => {
		test("returns empty array when no files directory exists", async () => {
			const { genome } = await setupGenome("list-files-empty");

			const files = await genome.listAgentFiles("editor");
			expect(files).toEqual([]);
		});

		test("returns file names and sizes", async () => {
			const { genome } = await setupGenome("list-files");

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

	describe("loadAgentToolsWithRoot", () => {
		test("loads tools from bootstrap when genome has none", async () => {
			const { genome } = await setupGenome("two-layer-bootstrap-only");

			const rootDir = join(tempDir, "bootstrap-two-layer-1");
			const toolDir = join(rootDir, "task-manager", "tools");
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(toolDir, "task-cli"),
				'---\nname: task-cli\ndescription: Manage tasks\ninterpreter: bash\n---\necho "hello"',
			);

			const tools = await genome.loadAgentToolsWithRoot("task-manager", rootDir);
			expect(tools).toHaveLength(1);
			expect(tools[0]!.name).toBe("task-cli");
			expect(tools[0]!.provenance).toBe("root");
		});

		test("genome tool overrides bootstrap tool with same name", async () => {
			const { genome } = await setupGenome("two-layer-override");

			await genome.saveAgentTool("task-manager", {
				name: "task-cli",
				description: "Genome version of task CLI",
				script: 'echo "genome"',
				interpreter: "bash",
			});

			const rootDir = join(tempDir, "bootstrap-two-layer-2");
			const toolDir = join(rootDir, "task-manager", "tools");
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(toolDir, "task-cli"),
				'---\nname: task-cli\ndescription: Bootstrap version\ninterpreter: bash\n---\necho "bootstrap"',
			);

			const tools = await genome.loadAgentToolsWithRoot("task-manager", rootDir);
			expect(tools).toHaveLength(1);
			expect(tools[0]!.name).toBe("task-cli");
			expect(tools[0]!.provenance).toBe("genome");
			expect(tools[0]!.description).toBe("Genome version of task CLI");
		});

		test("merges genome and bootstrap tools without collision", async () => {
			const { genome } = await setupGenome("two-layer-merge");

			await genome.saveAgentTool("editor", {
				name: "genome-tool",
				description: "Only in genome",
				script: 'echo "genome"',
				interpreter: "bash",
			});

			const rootDir = join(tempDir, "bootstrap-two-layer-3");
			const toolDir = join(rootDir, "editor", "tools");
			await mkdir(toolDir, { recursive: true });
			await writeFile(
				join(toolDir, "bootstrap-tool"),
				'---\nname: bootstrap-tool\ndescription: Only in bootstrap\ninterpreter: bash\n---\necho "bootstrap"',
			);

			const tools = await genome.loadAgentToolsWithRoot("editor", rootDir);
			expect(tools).toHaveLength(2);
			const names = tools.map((t) => t.name);
			expect(names).toContain("genome-tool");
			expect(names).toContain("bootstrap-tool");
		});

		test("returns empty when neither directory has tools", async () => {
			const { genome } = await setupGenome("two-layer-empty");

			const rootDir = join(tempDir, "bootstrap-two-layer-empty");
			await mkdir(rootDir, { recursive: true });

			const tools = await genome.loadAgentToolsWithRoot("reader", rootDir);
			expect(tools).toEqual([]);
		});

		test("finds tools in nested tree structure", async () => {
			const { genome } = await setupGenome("two-layer-tree");

			// Use the real root/ directory which has task-manager tools nested at
			// root/agents/utility/agents/task-manager/tools/
			const rootDir = join(import.meta.dir, "../../root");
			const tools = await genome.loadAgentToolsWithRoot("task-manager", rootDir);

			// task-manager has tools in the real tree
			const names = tools.map((t) => t.name);
			expect(names).toContain("task-cli");
			expect(tools.find((t) => t.name === "task-cli")!.provenance).toBe("root");
		});

		test("finds tools in nested tree structure for mcp agent", async () => {
			const { genome } = await setupGenome("two-layer-tree-mcp");

			const rootDir = join(import.meta.dir, "../../root");
			const tools = await genome.loadAgentToolsWithRoot("mcp", rootDir);

			const names = tools.map((t) => t.name);
			expect(names).toContain("sprout-mcp");
			expect(tools.find((t) => t.name === "sprout-mcp")!.provenance).toBe("root");
		});
	});
});

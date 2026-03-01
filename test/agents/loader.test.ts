import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findRootToolsDir,
	loadAgentSpec,
	loadRootAgents,
} from "../../src/agents/loader.ts";
import { serializeAgentSpec } from "../../src/genome/genome.ts";

describe("loadAgentSpec", () => {
	test("loads a valid YAML agent spec", async () => {
		const path = join(tmpdir(), `root-spec-${Date.now()}.yaml`);
		await writeFile(
			path,
			"name: root\ndescription: Root agent\nsystem_prompt: You are root\nmodel: best\ncapabilities:\n  - reader\n  - editor\n  - command-runner\nconstraints:\n  max_turns: 200\n  max_depth: 5\n  can_learn: true\ntags:\n  - core\nversion: 2\n",
		);
		const spec = await loadAgentSpec(path);
		expect(spec.name).toBe("root");
		expect(spec.description).toBeTruthy();
		expect(spec.system_prompt).toBeTruthy();
		expect(spec.model).toBe("best");
		expect(spec.capabilities).toContain("reader");
		expect(spec.capabilities).toContain("editor");
		expect(spec.capabilities).toContain("command-runner");
		expect(spec.constraints.max_turns).toBe(200);
		expect(spec.constraints.max_depth).toBe(5);
		expect(spec.constraints.can_learn).toBe(true);
		expect(spec.tags).toContain("core");
		expect(spec.version).toBe(2);
	});

	test("applies default constraints for missing fields", async () => {
		const path = join(tmpdir(), `reader-spec-${Date.now()}.yaml`);
		await writeFile(
			path,
			"name: reader\ndescription: Read files\nsystem_prompt: You read\nmodel: fast\ncapabilities:\n  - read_file\n  - grep\n  - glob\nversion: 2\n",
		);
		const spec = await loadAgentSpec(path);
		expect(spec.constraints.timeout_ms).toBe(300000);
	});

	test("throws on missing file", async () => {
		expect(loadAgentSpec("/nonexistent.yaml")).rejects.toThrow();
	});

	test("throws on YAML missing required fields", async () => {
		const badPath = join(tmpdir(), `bad-spec-${Date.now()}.yaml`);
		await writeFile(badPath, "capabilities:\n  - read_file\n");
		expect(loadAgentSpec(badPath)).rejects.toThrow(/missing or invalid 'name'/);
	});

	test("preserves thinking field when present as boolean", async () => {
		const path = join(tmpdir(), `thinking-bool-${Date.now()}.yaml`);
		await writeFile(
			path,
			"name: thinker\ndescription: thinks\nsystem_prompt: think hard\nmodel: best\nthinking: true\n",
		);
		const spec = await loadAgentSpec(path);
		expect(spec.thinking).toBe(true);
	});

	test("preserves thinking field when present as object", async () => {
		const path = join(tmpdir(), `thinking-obj-${Date.now()}.yaml`);
		await writeFile(
			path,
			"name: thinker\ndescription: thinks\nsystem_prompt: think hard\nmodel: best\nthinking:\n  budget_tokens: 5000\n",
		);
		const spec = await loadAgentSpec(path);
		expect(spec.thinking).toEqual({ budget_tokens: 5000 });
	});

	test("thinking is undefined when not present", async () => {
		const path = join(tmpdir(), `no-thinking-${Date.now()}.yaml`);
		await writeFile(
			path,
			"name: reader\ndescription: Read files\nsystem_prompt: You read\nmodel: fast\ncapabilities:\n  - read_file\n",
		);
		const spec = await loadAgentSpec(path);
		expect(spec.thinking).toBeUndefined();
	});
});

describe("serializeAgentSpec", () => {
	function makeReaderYaml(): string {
		return "name: reader\ndescription: Read files\nsystem_prompt: You read\nmodel: fast\ncapabilities:\n  - read_file\n  - grep\n  - glob\nversion: 2\n";
	}

	test("round-trips thinking: true through serialize and load", async () => {
		const srcPath = join(tmpdir(), `serialize-src-${Date.now()}.yaml`);
		await writeFile(srcPath, makeReaderYaml());
		const spec = await loadAgentSpec(srcPath);
		spec.thinking = true;
		const outPath = join(tmpdir(), `serialize-thinking-${Date.now()}.yaml`);
		await writeFile(outPath, serializeAgentSpec(spec));
		const loaded = await loadAgentSpec(outPath);
		expect(loaded.thinking).toBe(true);
	});

	test("round-trips thinking: { budget_tokens } through serialize and load", async () => {
		const srcPath = join(tmpdir(), `serialize-src-obj-${Date.now()}.yaml`);
		await writeFile(srcPath, makeReaderYaml());
		const spec = await loadAgentSpec(srcPath);
		spec.thinking = { budget_tokens: 8000 };
		const outPath = join(tmpdir(), `serialize-thinking-obj-${Date.now()}.yaml`);
		await writeFile(outPath, serializeAgentSpec(spec));
		const loaded = await loadAgentSpec(outPath);
		expect(loaded.thinking).toEqual({ budget_tokens: 8000 });
	});

	test("omits thinking field when undefined", async () => {
		const srcPath = join(tmpdir(), `serialize-no-thinking-${Date.now()}.yaml`);
		await writeFile(srcPath, makeReaderYaml());
		const spec = await loadAgentSpec(srcPath);
		const yaml = serializeAgentSpec(spec);
		expect(yaml).not.toContain("thinking");
	});
});

describe("findRootToolsDir", () => {
	test("returns nested path for agent in tree", async () => {
		const rootDir = join(import.meta.dir, "../../root");
		const dir = await findRootToolsDir(rootDir, "task-manager");
		expect(dir).toContain("agents/utility/agents/task-manager/tools");
	});

	test("returns nested path for mcp agent in tree", async () => {
		const rootDir = join(import.meta.dir, "../../root");
		const dir = await findRootToolsDir(rootDir, "mcp");
		expect(dir).toContain("agents/utility/agents/mcp/tools");
	});

	test("falls back to flat path for unknown agent", async () => {
		const rootDir = join(import.meta.dir, "../../root");
		const dir = await findRootToolsDir(rootDir, "nonexistent-agent");
		expect(dir).toBe(join(rootDir, "nonexistent-agent", "tools"));
	});
});

describe("loadRootAgents", () => {
	test("loads all root agents", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		expect(agents.length).toBeGreaterThanOrEqual(15);
		const names = agents.map((a) => a.name);
		expect(names).toContain("root");
		expect(names).toContain("reader");
		expect(names).toContain("editor");
		expect(names).toContain("command-runner");
		expect(names).toContain("web-reader");
		expect(names).toContain("mcp");
		expect(names).toContain("quartermaster");
		expect(names).toContain("qm-indexer");
		expect(names).toContain("qm-planner");
		expect(names).toContain("qm-fabricator");
		expect(names).toContain("tech-lead");
		expect(names).toContain("engineer");
		expect(names).toContain("spec-reviewer");
		expect(names).toContain("quality-reviewer");
		expect(names).toContain("architect");
		expect(names).toContain("verifier");
		expect(names).toContain("debugger");
		expect(names).toContain("task-manager");
	});

	test("all agents have valid constraints and system prompts", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		for (const agent of agents) {
			expect(agent.constraints.max_turns).toBeGreaterThan(0);
			expect(agent.constraints.max_depth).toBeGreaterThanOrEqual(0);
			expect(agent.system_prompt.length).toBeGreaterThan(0);
		}
	});

	test("leaf agents cannot spawn subagents", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const orchestrators = [
			"root",
			"quartermaster",
			"qm-indexer",
			"tech-lead",
			"engineer",
			"spec-reviewer",
			"quality-reviewer",
			"architect",
			"verifier",
			"debugger",
		];
		const leaves = agents.filter((a) => !orchestrators.includes(a.name));
		for (const leaf of leaves) {
			expect(leaf.constraints.can_spawn).toBe(false);
		}
	});

	test("qm-indexer has write path constraints and no exec", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const indexer = agents.find((a) => a.name === "qm-indexer");
		expect(indexer).toBeDefined();
		expect(indexer!.constraints.allowed_write_paths).toEqual([
			"~/.local/share/sprout-genome/capability-index.yaml",
		]);
		expect(indexer!.tools).not.toContain("exec");
		expect(indexer!.agents).toContain("utility/mcp");
		expect(indexer!.tools).toContain("write_file");
		expect(indexer!.constraints.can_spawn).toBe(true);
		expect(indexer!.constraints.max_depth).toBe(1);
	});
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findRootToolsDir, loadRootAgents } from "../../src/agents/loader.ts";

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

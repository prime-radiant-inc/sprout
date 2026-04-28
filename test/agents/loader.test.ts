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
		expect(names).toContain("qm-session-analyst");
		expect(names).toContain("qm-sprout-architect");
		expect(names).toContain("qm-session-doctor");
		expect(names).toContain("tech-lead");
		expect(names).toContain("engineer");
		expect(names).toContain("spec-reviewer");
		expect(names).toContain("quality-reviewer");
		expect(names).toContain("architect");
		expect(names).toContain("verifier");
		expect(names).toContain("debugger");
		expect(names).toContain("task-manager");
		expect(names).toContain("the-balcony");
	});

	test("all agents have valid constraints and system prompts", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		for (const agent of agents) {
			expect(agent.constraints.max_turns).toBeGreaterThan(0);
			expect("max_depth" in agent.constraints).toBe(false);
			expect(agent.system_prompt.length).toBeGreaterThan(0);
		}
	});

	test("root only explicitly delegates to approved utility leaves", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const root = agents.find((a) => a.name === "root");
		expect(root).toBeDefined();
		expect(root!.tools).toEqual([]);
		expect(root!.agents).toContain("utility/reader");
		expect(root!.agents).not.toContain("utility/editor");
		expect(root!.agents).not.toContain("utility/command-runner");
	});

	test("root attaches The Balcony as a non-steering observer", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const root = agents.find((a) => a.name === "root");
		const balcony = agents.find((a) => a.name === "the-balcony");

		expect(root?.observers?.[0]).toEqual({
			agent: "the-balcony",
			target: "root",
			events: [
				"perceive",
				"steering",
				"plan_end",
				"warning",
				"error",
				"primitive_end",
				"act_end",
				"compaction",
				"interrupted",
			],
			trigger: { every: 1, event: "plan_end" },
			delivery: { max_events: 16, max_chars: 5000 },
		});
		expect(root?.observers?.map((observer) => observer.events.slice(0, 2))).toEqual([
			["perceive", "steering"],
			["perceive", "steering"],
		]);
		expect(balcony?.tools).toEqual([]);
		expect(balcony?.agents).toEqual([]);
		expect(balcony?.tags).toContain("observer");
		expect(balcony?.tags).toContain("commentary");
	});

	test("leaf agents cannot spawn subagents", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const orchestrators = [
			"root",
			"quartermaster",
			"qm-indexer",
			"qm-planner",
			"qm-fabricator",
			"qm-reconciler",
			"qm-session-analyst",
			"qm-sprout-architect",
			"qm-session-doctor",
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

	test("qm-fabricator has write path constraints and correct tools", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const fabricator = agents.find((a) => a.name === "qm-fabricator");
		expect(fabricator).toBeDefined();
		expect(fabricator!.constraints.allowed_write_paths).toEqual([
			"~/.local/share/sprout-genome/agents/*/tools/**",
		]);
		expect(fabricator!.tools).not.toContain("exec");
		expect(fabricator!.tools).toContain("save_agent");
		// Template variable should be present for runtime expansion
		expect(fabricator!.system_prompt).toContain("{{SPROUT_ROOT}}");
		expect(fabricator!.system_prompt).not.toContain("root/agents/");
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
		expect("max_depth" in indexer!.constraints).toBe(false);
	});

	test("QM self-awareness agents are context sinks without direct primitives", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const analyst = agents.find((a) => a.name === "qm-session-analyst");
		const architect = agents.find((a) => a.name === "qm-sprout-architect");
		const doctor = agents.find((a) => a.name === "qm-session-doctor");

		expect(analyst).toBeDefined();
		expect(analyst!.tools).toEqual([]);
		expect(analyst!.agents).toEqual(["utility/reader", "utility/command-runner", "utility/editor"]);
		expect(analyst!.constraints.can_spawn).toBe(true);
		expect("max_depth" in analyst!.constraints).toBe(false);

		expect(architect).toBeDefined();
		expect(architect!.tools).toEqual([]);
		expect(architect!.agents).toEqual(["utility/reader", "project-explorer"]);
		expect(architect!.constraints.can_spawn).toBe(true);
		expect("max_depth" in architect!.constraints).toBe(false);

		expect(doctor).toBeDefined();
		expect(doctor!.tools).toEqual([]);
		expect(doctor!.agents).toEqual(["utility/reader", "utility/command-runner"]);
		expect(doctor!.constraints.can_spawn).toBe(true);
		expect("max_depth" in doctor!.constraints).toBe(false);
	});

	test("root is the only root spec with subcortical recall enabled", async () => {
		const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
		const enabled = agents.filter((agent) => {
			const config = agent.subcortical_recall;
			return config === true || (typeof config === "object" && config.enabled !== false);
		});
		expect(enabled.map((agent) => agent.name)).toEqual(["root"]);
		expect(enabled[0]!.subcortical_recall).toEqual({ enabled: true, max_tokens: 1024 });
	});
});

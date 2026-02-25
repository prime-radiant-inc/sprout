import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentSpec, loadBootstrapAgents } from "../../src/agents/loader.ts";

describe("loadAgentSpec", () => {
	test("loads a valid YAML agent spec", async () => {
		const spec = await loadAgentSpec(join(import.meta.dir, "../../bootstrap/root.yaml"));
		expect(spec.name).toBe("root");
		expect(spec.description).toBeTruthy();
		expect(spec.system_prompt).toBeTruthy();
		expect(spec.model).toBe("best");
		expect(spec.capabilities).toContain("reader");
		expect(spec.capabilities).toContain("editor");
		expect(spec.capabilities).toContain("command-runner");
		expect(spec.constraints.max_turns).toBe(200);
		expect(spec.constraints.max_depth).toBe(3);
		expect(spec.constraints.can_learn).toBe(true);
		expect(spec.tags).toContain("core");
		expect(spec.version).toBe(2);
	});

	test("applies default constraints for missing fields", async () => {
		// reader doesn't specify timeout_ms, should get default
		const spec = await loadAgentSpec(join(import.meta.dir, "../../bootstrap/reader.yaml"));
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
});

describe("loadBootstrapAgents", () => {
	test("loads all 10 bootstrap agents", async () => {
		const agents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
		expect(agents).toHaveLength(10);
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
	});

	test("all agents have valid constraints", async () => {
		const agents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
		for (const agent of agents) {
			expect(agent.constraints.max_turns).toBeGreaterThan(0);
			expect(agent.constraints.max_depth).toBeGreaterThanOrEqual(0);
			expect(agent.capabilities.length).toBeGreaterThan(0);
			expect(agent.system_prompt.length).toBeGreaterThan(0);
		}
	});

	test("leaf agents cannot spawn subagents", async () => {
		const agents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
		const orchestrators = ["root", "quartermaster"];
		const leaves = agents.filter((a) => !orchestrators.includes(a.name));
		for (const leaf of leaves) {
			expect(leaf.constraints.can_spawn).toBe(false);
		}
	});
});

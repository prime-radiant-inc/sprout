import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentTreeEntry, loadRootAgents, scanAgentTree } from "../../src/agents/loader.ts";
import { resolveAgentDelegates } from "../../src/agents/resolver.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";

const ROOT_DIR = join(process.cwd(), "root");
const READ_MEMORY_TOOLS = [
	"memory.search",
	"memory.get",
	"memory.trace_links",
	"memory.entity_query",
	"memory.find_by_segment",
] as const;
const WRITE_MEMORY_TOOLS = [
	"memory.annotate",
	"memory.archive",
	"memory.link",
	"memory.consolidate",
] as const;

function byName(specs: AgentSpec[], name: string): AgentSpec {
	const spec = specs.find((item) => item.name === name);
	if (!spec) throw new Error(`missing spec ${name}`);
	return spec;
}

function byPath(tree: Map<string, AgentTreeEntry>, path: string): AgentSpec {
	const entry = tree.get(path);
	if (!entry) throw new Error(`missing tree path ${path}`);
	return entry.spec;
}

function delegates(
	tree: Map<string, AgentTreeEntry>,
	spec: AgentSpec,
	selfPath: string,
	children: string[] = [],
): string[] {
	return resolveAgentDelegates(tree, spec.name, selfPath, children, spec.agents).map(
		(item) => item.spec.name,
	);
}

describe("archivist root agent wiring", () => {
	test("archivist has bounded memory read and write tools", async () => {
		const specs = await loadRootAgents(ROOT_DIR);
		const archivist = byName(specs, "archivist");

		for (const tool of READ_MEMORY_TOOLS) {
			expect(archivist.tools).toContain(tool);
		}
		for (const tool of WRITE_MEMORY_TOOLS) {
			expect(archivist.tools).toContain(tool);
		}
		expect(archivist.tools).toContain("memory.synthesize_answer");
		expect(archivist.agents).toEqual([]);
		expect(archivist.constraints.max_turns).toBe(8);
		expect(archivist.constraints.can_spawn).toBe(false);
		expect(archivist.constraints.can_learn).toBe(false);
	});

	test("read-only memory tools are broad but write tools remain archivist-only", async () => {
		const specs = await loadRootAgents(ROOT_DIR);
		for (const name of ["engineer", "architect", "debugger", "verifier"]) {
			const spec = byName(specs, name);
			for (const tool of READ_MEMORY_TOOLS) {
				expect(spec.tools).toContain(tool);
			}
		}

		for (const spec of specs) {
			if (spec.name === "archivist") continue;
			for (const tool of WRITE_MEMORY_TOOLS) {
				expect(spec.tools).not.toContain(tool);
			}
		}
	});

	test("only approved agents can delegate to archivist", async () => {
		const specs = await loadRootAgents(ROOT_DIR);
		const tree = await scanAgentTree(ROOT_DIR);
		const topLevelChildren = [...tree.keys()].filter((path) => !path.includes("/"));
		const root = byName(specs, "root");

		expect(delegates(tree, root, "", topLevelChildren)).toContain("archivist");

		for (const path of [
			"quartermaster",
			"quartermaster/qm-fabricator",
			"quartermaster/qm-planner",
			"quartermaster/qm-reconciler",
			"architect",
			"debugger",
		]) {
			const spec = byPath(tree, path);
			expect(spec.constraints.can_spawn).toBe(true);
			expect(delegates(tree, spec, path)).toContain("archivist");
		}

		for (const path of ["tech-lead/engineer", "verifier"]) {
			const spec = byPath(tree, path);
			expect(delegates(tree, spec, path)).not.toContain("archivist");
		}
	});

	test("archivist prompt file preserves the query and mutation policy", async () => {
		const prompt = await readFile(join(ROOT_DIR, "prompts", "archivist_system.txt"), "utf-8");

		expect(prompt).toContain("Query strategy");
		expect(prompt).toContain("Cite every factual claim");
		expect(prompt).toContain("Archive and consolidation require explicit user confirmation");
		expect(prompt).toContain("covered by surfaced memories");
	});
});

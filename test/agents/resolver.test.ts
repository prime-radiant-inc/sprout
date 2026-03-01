import { describe, expect, test } from "bun:test";
import { resolveAgentDelegates } from "../../src/agents/resolver.ts";
import type { AgentTreeEntry } from "../../src/agents/loader.ts";
import { makeSpec } from "../helpers/make-spec.ts";

function entry(
	name: string,
	path: string,
	children: string[] = [],
): AgentTreeEntry {
	return {
		spec: makeSpec({ name, description: `The ${name} agent` }),
		path,
		children,
		diskPath: `/fake/${path}.md`,
	};
}

describe("resolveAgentDelegates", () => {
	const tree = new Map<string, AgentTreeEntry>([
		[
			"tech-lead",
			entry("tech-lead", "tech-lead", ["engineer", "spec-reviewer"]),
		],
		["tech-lead/engineer", entry("engineer", "tech-lead/engineer")],
		[
			"tech-lead/spec-reviewer",
			entry("spec-reviewer", "tech-lead/spec-reviewer"),
		],
		[
			"quartermaster",
			entry("quartermaster", "quartermaster", ["qm-fabricator"]),
		],
		[
			"quartermaster/qm-fabricator",
			entry("qm-fabricator", "quartermaster/qm-fabricator"),
		],
		["utility/reader", entry("reader", "utility/reader")],
		["utility/task-manager", entry("task-manager", "utility/task-manager")],
		["project-explorer", entry("project-explorer", "project-explorer")],
	]);

	test("returns auto-discovered children for root (no selfPath)", () => {
		// Root agent has no path in the tree; its children are the top-level entries.
		// Top-level bare names match tree keys directly when selfPath is empty.
		const topLevelChildren = ["tech-lead", "quartermaster", "project-explorer"];
		const result = resolveAgentDelegates(
			tree,
			"root",
			"",
			topLevelChildren,
			["utility/task-manager"],
		);

		const names = result.map((d) => d.spec.name);
		expect(names).toContain("tech-lead");
		expect(names).toContain("quartermaster");
		expect(names).toContain("project-explorer");
		expect(names).toContain("task-manager");
		expect(names).toHaveLength(4);
	});

	test("returns auto-discovered children for orchestrator", () => {
		// tech-lead has children ["engineer", "spec-reviewer"] (bare names)
		// Full tree keys are "tech-lead/engineer", "tech-lead/spec-reviewer"
		const result = resolveAgentDelegates(
			tree,
			"tech-lead",
			"tech-lead",
			["engineer", "spec-reviewer"],
			[],
		);
		const names = result.map((d) => d.spec.name);
		expect(names).toContain("engineer");
		expect(names).toContain("spec-reviewer");
		expect(names).toHaveLength(2);
	});

	test("includes explicit agent references by path", () => {
		const result = resolveAgentDelegates(
			tree,
			"quartermaster",
			"quartermaster",
			["qm-fabricator"],
			["utility/reader", "project-explorer"],
		);
		const names = result.map((d) => d.spec.name);
		expect(names).toContain("qm-fabricator");
		expect(names).toContain("reader");
		expect(names).toContain("project-explorer");
		expect(names).toHaveLength(3);
	});

	test("skips unresolvable paths without crashing", () => {
		const result = resolveAgentDelegates(
			tree,
			"root",
			"",
			[],
			["nonexistent/agent"],
		);
		expect(result).toHaveLength(0);
	});

	test("does not include self in results", () => {
		// If selfPath appears in children or agentRefs, it should be excluded
		const result = resolveAgentDelegates(
			tree,
			"tech-lead",
			"tech-lead",
			["engineer"],
			["tech-lead"],
		);
		const names = result.map((d) => d.spec.name);
		expect(names).not.toContain("tech-lead");
		expect(names).toContain("engineer");
		expect(names).toHaveLength(1);
	});

	test("deduplicates agents appearing in both children and refs", () => {
		const result = resolveAgentDelegates(
			tree,
			"tech-lead",
			"tech-lead",
			["engineer"],
			["tech-lead/engineer"],
		);
		const names = result.map((d) => d.spec.name);
		expect(names).toEqual(["engineer"]);
	});

	test("result includes correct paths", () => {
		const result = resolveAgentDelegates(
			tree,
			"tech-lead",
			"tech-lead",
			["engineer", "spec-reviewer"],
			[],
		);
		const paths = result.map((d) => d.path);
		expect(paths).toContain("tech-lead/engineer");
		expect(paths).toContain("tech-lead/spec-reviewer");
	});
});

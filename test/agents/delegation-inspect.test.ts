import { describe, expect, test } from "bun:test";
import {
	inspectStaticDelegations,
	inspectTreeDelegations,
} from "../../src/agents/delegation-inspect.ts";
import type { AgentTreeEntry } from "../../src/agents/loader.ts";
import { makeSpec } from "../helpers/make-spec.ts";

function entry(name: string, path: string, children: string[] = []): AgentTreeEntry {
	return {
		spec: makeSpec({ name, description: `${name} agent` }),
		path,
		children,
		diskPath: `/fake/${path}.md`,
	};
}

describe("inspectTreeDelegations", () => {
	test("returns deterministic source labels for children and explicit refs", () => {
		const tree = new Map<string, AgentTreeEntry>([
			["tech-lead", entry("tech-lead", "tech-lead", ["engineer", "reviewer"])],
			["tech-lead/engineer", entry("engineer", "tech-lead/engineer")],
			["tech-lead/reviewer", entry("reviewer", "tech-lead/reviewer")],
			["utility/reader", entry("reader", "utility/reader")],
		]);

		const result = inspectTreeDelegations({
			tree,
			selfName: "tech-lead",
			selfPath: "tech-lead",
			childNames: ["engineer", "reviewer"],
			agentRefs: ["utility/reader", "tech-lead/engineer", "missing/agent"],
		});

		expect(result).toEqual([
			{
				agent_name: "engineer",
				source: "tree_child",
				requested_ref: "engineer",
				resolved_path: "tech-lead/engineer",
			},
			{
				agent_name: "reviewer",
				source: "tree_child",
				requested_ref: "reviewer",
				resolved_path: "tech-lead/reviewer",
			},
			{
				agent_name: "reader",
				source: "explicit_ref",
				requested_ref: "utility/reader",
				resolved_path: "utility/reader",
			},
		]);
	});
});

describe("inspectStaticDelegations", () => {
	test("explains exact refs and path fallback refs", () => {
		const available = [
			makeSpec({ name: "reader", description: "Reads files" }),
			makeSpec({ name: "task-manager", description: "Tracks tasks" }),
		];

		const result = inspectStaticDelegations({
			selfName: "root",
			agentRefs: ["reader", "utility/task-manager", "missing/agent", "reader"],
			availableAgents: available,
		});

		expect(result).toEqual([
			{
				agent_name: "reader",
				source: "explicit_ref",
				requested_ref: "reader",
				resolved_path: "reader",
			},
			{
				agent_name: "task-manager",
				source: "resolved_path_fallback",
				requested_ref: "utility/task-manager",
				resolved_path: "task-manager",
			},
		]);
	});
});

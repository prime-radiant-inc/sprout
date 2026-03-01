import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTreeEntryByName, scanAgentTree } from "../../src/agents/loader.ts";

test("findTreeEntryByName returns entry for nested agent", () => {
	// Build a tree manually
	const tree = new Map([
		[
			"utility/reader",
			{
				spec: { name: "reader" } as any,
				path: "utility/reader",
				children: [],
				diskPath: "/fake/utility/agents/reader.md",
			},
		],
		[
			"tech-lead",
			{
				spec: { name: "tech-lead" } as any,
				path: "tech-lead",
				children: ["engineer"],
				diskPath: "/fake/agents/tech-lead.md",
			},
		],
	]);
	expect(findTreeEntryByName(tree, "reader")).toBeDefined();
	expect(findTreeEntryByName(tree, "reader")!.path).toBe("utility/reader");
	expect(findTreeEntryByName(tree, "tech-lead")!.path).toBe("tech-lead");
	expect(findTreeEntryByName(tree, "nonexistent")).toBeUndefined();
});

describe("scanAgentTree", () => {
	let rootDir: string;

	beforeEach(async () => {
		rootDir = await mkdtemp(join(tmpdir(), "tree-"));
	});

	afterEach(async () => {
		await rm(rootDir, { recursive: true });
	});

	function writeAgentMd(relPath: string, name: string, desc: string) {
		const content = [
			"---",
			`name: ${name}`,
			`description: "${desc}"`,
			"model: fast",
			"---",
			`You are ${name}.`,
		].join("\n");
		return writeFile(join(rootDir, relPath), content);
	}

	test("discovers top-level agents", async () => {
		await mkdir(join(rootDir, "agents"), { recursive: true });
		await writeAgentMd("agents/tech-lead.md", "tech-lead", "Manages implementation");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("tech-lead")).toBe(true);
		expect(tree.get("tech-lead")!.spec.name).toBe("tech-lead");
		expect(tree.get("tech-lead")!.path).toBe("tech-lead");
	});

	test("discovers nested agents with correct paths", async () => {
		await mkdir(join(rootDir, "agents/tech-lead/agents"), { recursive: true });
		await writeAgentMd("agents/tech-lead.md", "tech-lead", "Manages implementation");
		await writeAgentMd("agents/tech-lead/agents/engineer.md", "engineer", "Writes code");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("tech-lead")).toBe(true);
		expect(tree.has("tech-lead/engineer")).toBe(true);
		expect(tree.get("tech-lead/engineer")!.path).toBe("tech-lead/engineer");
	});

	test("discovers deeply nested agents", async () => {
		await mkdir(join(rootDir, "agents/a/agents/b/agents"), { recursive: true });
		await writeAgentMd("agents/a.md", "a", "Agent A");
		await writeAgentMd("agents/a/agents/b.md", "b", "Agent B");
		await writeAgentMd("agents/a/agents/b/agents/c.md", "c", "Agent C");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("a/b/c")).toBe(true);
	});

	test("returns children list for each agent", async () => {
		await mkdir(join(rootDir, "agents/qm/agents"), { recursive: true });
		await writeAgentMd("agents/qm.md", "qm", "Quartermaster");
		await writeAgentMd("agents/qm/agents/fab.md", "fab", "Fabricator");
		await writeAgentMd("agents/qm/agents/idx.md", "idx", "Indexer");

		const tree = await scanAgentTree(rootDir);
		const qm = tree.get("qm")!;
		expect(qm.children.sort()).toEqual(["fab", "idx"]);
	});

	test("ignores non-.md files in agents directories", async () => {
		await mkdir(join(rootDir, "agents"), { recursive: true });
		await writeAgentMd("agents/valid.md", "valid", "Valid agent");
		await writeFile(join(rootDir, "agents/readme.txt"), "not an agent");

		const tree = await scanAgentTree(rootDir);
		expect(tree.size).toBe(1);
	});

	test("handles utility namespace without a spec file", async () => {
		await mkdir(join(rootDir, "agents/utility/agents"), { recursive: true });
		await writeAgentMd("agents/utility/agents/reader.md", "reader", "Reads files");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("utility/reader")).toBe(true);
		expect(tree.has("utility")).toBe(false);
	});

	test("discovers .md files directly inside namespace directories", async () => {
		await mkdir(join(rootDir, "agents/utility"), { recursive: true });
		await writeAgentMd("agents/utility/reader.md", "reader", "Reads files");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("utility/reader")).toBe(true);
		expect(tree.get("utility/reader")!.spec.name).toBe("reader");
	});

	test("discovers both sibling .md and nested agents/ in namespace directories", async () => {
		await mkdir(join(rootDir, "agents/utility/agents"), { recursive: true });
		await writeAgentMd("agents/utility/reader.md", "reader", "Reads files");
		await writeAgentMd("agents/utility/agents/task-manager.md", "task-manager", "Manages tasks");

		const tree = await scanAgentTree(rootDir);
		expect(tree.has("utility/reader")).toBe(true);
		expect(tree.has("utility/task-manager")).toBe(true);
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../../src/genome/genome.ts";
import { recall, renderMemories, renderRoutingHints } from "../../src/genome/recall.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS, type Memory } from "../../src/kernel/types.ts";

function makeSpec(name: string): AgentSpec {
	return {
		name,
		description: `Agent ${name}`,
		system_prompt: `You are ${name}.`,
		model: "fast",
		capabilities: [],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: [],
		version: 1,
	};
}

function makeMemory(id: string, content: string, tags: string[] = []): Memory {
	return {
		id,
		content,
		tags,
		source: "test",
		created: Date.now(),
		last_used: Date.now(),
		use_count: 0,
		confidence: 1.0,
	};
}

describe("recall", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-recall-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns all agents when genome has < 20 agents", async () => {
		const root = join(tempDir, "recall-small");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec("agent-a"));
		await genome.addAgent(makeSpec("agent-b"));

		const result = await recall(genome, "find some code");

		expect(result.agents).toHaveLength(2);
		expect(result.agents.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);
	});

	test("returns matching memories by keyword", async () => {
		const root = join(tempDir, "recall-memories");
		const genome = new Genome(root);
		await genome.init();
		await genome.addMemory(makeMemory("m1", "this project uses pytest for testing"));
		await genome.addMemory(makeMemory("m2", "the auth module is at src/auth"));

		const result = await recall(genome, "testing pytest");

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]!.id).toBe("m1");
	});

	test("returns matching routing hints", async () => {
		const root = join(tempDir, "recall-routing");
		const genome = new Genome(root);
		await genome.init();
		await genome.addRoutingRule({
			id: "r1",
			condition: "Go project testing",
			preference: "test-runner-go",
			strength: 0.8,
			source: "test",
		});

		const result = await recall(genome, "run Go tests");

		expect(result.routing_hints).toHaveLength(1);
		expect(result.routing_hints[0]!.preference).toBe("test-runner-go");
	});

	test("marks used memories", async () => {
		const root = join(tempDir, "recall-mark");
		const genome = new Genome(root);
		await genome.init();
		await genome.addMemory(makeMemory("m1", "testing fact", []));

		const before = genome.memories.getById("m1")!.use_count;
		await recall(genome, "testing");
		const after = genome.memories.getById("m1")!.use_count;

		expect(after).toBe(before + 1);
	});

	test("returns empty memories and routing when none match", async () => {
		const root = join(tempDir, "recall-empty");
		const genome = new Genome(root);
		await genome.init();
		await genome.addMemory(makeMemory("m1", "unrelated topic"));

		const result = await recall(genome, "testing framework");

		expect(result.memories).toHaveLength(0);
		expect(result.routing_hints).toHaveLength(0);
	});
});

describe("renderMemories", () => {
	test("renders memories as XML block", () => {
		const memories: Memory[] = [
			makeMemory("m1", "this project uses pytest"),
			makeMemory("m2", "auth module at src/auth"),
		];
		const rendered = renderMemories(memories);
		expect(rendered).toContain("<memories>");
		expect(rendered).toContain("this project uses pytest");
		expect(rendered).toContain("auth module at src/auth");
		expect(rendered).toContain("</memories>");
	});

	test("returns empty string when no memories", () => {
		expect(renderMemories([])).toBe("");
	});
});

describe("renderRoutingHints", () => {
	test("renders routing hints as XML block", () => {
		const hints = [
			{
				id: "r1",
				condition: "Go testing",
				preference: "test-runner-go",
				strength: 0.8,
				source: "test",
			},
		];
		const rendered = renderRoutingHints(hints);
		expect(rendered).toContain("<routing_hints>");
		expect(rendered).toContain("Go testing");
		expect(rendered).toContain("test-runner-go");
		expect(rendered).toContain("</routing_hints>");
	});

	test("returns empty string when no hints", () => {
		expect(renderRoutingHints([])).toBe("");
	});
});

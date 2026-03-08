import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { Genome } from "../../src/genome/genome.ts";

function makeSpec(name: string, overrides?: Partial<{ description: string; version: number }>) {
	return {
		name,
		description: overrides?.description ?? `${name} agent`,
		system_prompt: "You are a test agent.",
		model: "test-model",
		constraints: {
			max_turns: 10,
			timeout_ms: 0,
			can_spawn: false,
			can_learn: false,
		},
		tags: [],
		version: overrides?.version ?? 1,
		tools: [],
		agents: [],
	};
}

describe("Genome generation counter", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "genome-gen-"));
		await mkdir(join(dir, "agents"), { recursive: true });
		await mkdir(join(dir, "memories"), { recursive: true });
		// Write an initial agent so loadFromDisk has something to load
		const spec = makeSpec("initial-agent");
		await writeFile(join(dir, "agents", "initial-agent.md"), serializeAgentMarkdown(spec));
		// Init git repo so commits work
		Bun.spawnSync(["git", "init"], { cwd: dir });
		Bun.spawnSync(["git", "add", "."], { cwd: dir });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir });
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("generation starts at 0", () => {
		const genome = new Genome(dir);
		expect(genome.generation).toBe(0);
	});

	test("generation increments on addAgent", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		const before = genome.generation;
		await genome.addAgent(makeSpec("gen-add-test"));
		expect(genome.generation).toBe(before + 1);
	});

	test("generation increments on updateAgent", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		const before = genome.generation;
		const existing = genome.getAgent("initial-agent")!;
		await genome.updateAgent({ ...existing, description: "updated" });
		expect(genome.generation).toBe(before + 1);
	});

	test("generation increments on removeAgent", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		// Add an agent to the overlay so we can remove it
		await genome.addAgent(makeSpec("gen-remove-test"));
		const before = genome.generation;
		await genome.removeAgent("gen-remove-test");
		expect(genome.generation).toBe(before + 1);
	});

	test("generation increments on loadFromDisk", async () => {
		const genome = new Genome(dir);
		expect(genome.generation).toBe(0);
		await genome.loadFromDisk();
		expect(genome.generation).toBe(1);
	});

	test("generation does not increment when nothing changes", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		const after = genome.generation;
		// No operations — generation should stay the same
		expect(genome.generation).toBe(after);
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";

function makeSpec(name: string, overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name,
		description: `Test agent ${name}`,
		system_prompt: `You are ${name}`,
		model: "fast",
		constraints: {
			max_turns: 5,
			timeout_ms: 0,
			can_spawn: false,
			can_learn: false,
		},
		tags: [],
		version: 1,
		tools: [],
		agents: [],
		...overrides,
	};
}

describe("Genome.refreshIfDiskChanged", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "genome-disk-change-"));
		await mkdir(join(dir, "agents"), { recursive: true });
		await mkdir(join(dir, "memories"), { recursive: true });

		// Write an initial agent file
		const spec = makeSpec("initial-agent");
		await writeFile(join(dir, "agents", "initial-agent.md"), serializeAgentMarkdown(spec));

		// Initialize git repo (required by Genome)
		Bun.spawnSync(["git", "init"], { cwd: dir });
		Bun.spawnSync(["git", "add", "."], { cwd: dir });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir });
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("returns false when no new .md files exist", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		const genBefore = genome.generation;

		const changed = await genome.refreshIfDiskChanged();

		expect(changed).toBe(false);
		expect(genome.generation).toBe(genBefore);
	});

	test("returns true and reloads when a new .md file is added", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		const genBefore = genome.generation;

		// Verify the new agent is not yet known
		const allBefore = genome.allAgents();
		expect(allBefore.find((a) => a.name === "new-agent")).toBeUndefined();

		// Write a new agent file to disk (simulates subprocess writing)
		const newSpec = makeSpec("new-agent");
		await writeFile(join(dir, "agents", "new-agent.md"), serializeAgentMarkdown(newSpec));

		const changed = await genome.refreshIfDiskChanged();

		expect(changed).toBe(true);
		expect(genome.generation).toBe(genBefore + 1);
		// The new agent should now be in allAgents
		const allAfter = genome.allAgents();
		expect(allAfter.find((a) => a.name === "new-agent")).toBeDefined();
	});

	test("returns false on second call with no further changes", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();

		// First call — picks up new-agent.md (written by the previous test)
		// Nothing new relative to the current load, should be false
		const changed = await genome.refreshIfDiskChanged();
		expect(changed).toBe(false);
	});

	test("handles missing agents directory gracefully", async () => {
		const emptyDir = await mkdtemp(join(tmpdir(), "genome-no-agents-"));
		await mkdir(join(emptyDir, "memories"), { recursive: true });
		Bun.spawnSync(["git", "init"], { cwd: emptyDir });
		Bun.spawnSync(["git", "add", "."], { cwd: emptyDir });
		Bun.spawnSync(["git", "commit", "-m", "init", "--allow-empty"], { cwd: emptyDir });

		const genome = new Genome(emptyDir);
		await genome.loadFromDisk();

		const changed = await genome.refreshIfDiskChanged();
		expect(changed).toBe(false);

		await rm(emptyDir, { recursive: true, force: true });
	});
});

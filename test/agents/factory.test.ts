import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createAgent } from "../../src/agents/factory.ts";
import { Genome } from "../../src/genome/genome.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

describe("createAgent", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates agent with fresh genome from bootstrap", async () => {
		const genomePath = join(tempDir, "factory-fresh");
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
		});

		expect(result.agent).toBeDefined();
		expect(result.agent.spec.name).toBe("root");
		expect(result.genome).toBeDefined();
		expect(result.genome.agentCount()).toBe(4);
	});

	test("creates agent with existing genome", async () => {
		// First, set up a genome
		const genomePath = join(tempDir, "factory-existing");
		const genome = new Genome(genomePath);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		// Now create agent from existing genome
		const result = await createAgent({
			genomePath,
			workDir: tempDir,
		});

		expect(result.agent).toBeDefined();
		expect(result.genome.agentCount()).toBe(4);
	});

	test("uses specified root agent name", async () => {
		const genomePath = join(tempDir, "factory-root");
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
			rootAgent: "code-editor",
		});

		expect(result.agent.spec.name).toBe("code-editor");
	});

	test("throws if root agent not found", async () => {
		const genomePath = join(tempDir, "factory-missing");
		await expect(
			createAgent({
				genomePath,
				bootstrapDir: join(import.meta.dir, "../../bootstrap"),
				workDir: tempDir,
				rootAgent: "nonexistent",
			}),
		).rejects.toThrow(/not found/);
	});
});

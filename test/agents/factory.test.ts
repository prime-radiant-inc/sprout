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
		expect(result.genome.agentCount()).toBe(5);
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
		expect(result.genome.agentCount()).toBe(5);
	});

	test("uses specified root agent name", async () => {
		const genomePath = join(tempDir, "factory-root");
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
			rootAgent: "editor",
		});

		expect(result.agent.spec.name).toBe("editor");
	});

	test("accepts and forwards sessionId to agent", async () => {
		const genomePath = join(tempDir, "factory-sessionid");
		const customId = "CUSTOM_SESSION_ID_123456";
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
			sessionId: customId,
		});
		expect(result.agent).toBeDefined();
		expect(result.model).toBeTruthy();
		expect(result.provider).toBeTruthy();
		expect(result.events).toBeDefined();
		expect(result.client).toBeDefined();
	});

	test("model option overrides agent spec model", async () => {
		const genomePath = join(tempDir, "factory-model-override");
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
			model: "claude-sonnet-4-6",
		});

		// The root agent spec uses "best", but model override should win
		expect(result.model).toBe("claude-sonnet-4-6");
		expect(result.provider).toBe("anthropic");
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

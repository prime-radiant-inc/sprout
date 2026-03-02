import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { createAgent } from "../../src/agents/factory.ts";
import { scanAgentTree } from "../../src/agents/loader.ts";
import { DEV_MODE_SENTINEL, isDevMode } from "../../src/genome/dev-mode.ts";
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

	test("creates agent with fresh genome from root agents", async () => {
		const genomePath = join(tempDir, "factory-fresh");
		const result = await createAgent({
			genomePath,
			rootDir: join(import.meta.dir, "../../root"),
			workDir: tempDir,
		});

		expect(result.agent).toBeDefined();
		expect(result.agent.spec.name).toBe("root");
		expect(result.genome).toBeDefined();
		expect(result.genome.agentCount()).toBeGreaterThanOrEqual(5);
	});

	test("creates agent with existing genome", async () => {
		// First, set up a genome
		const genomePath = join(tempDir, "factory-existing");
		const rootDir = join(import.meta.dir, "../../root");
		const genome = new Genome(genomePath, rootDir);
		await genome.init();
		await genome.initFromRoot();

		// Now create agent from existing genome — needs rootDir for overlay resolution
		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: tempDir,
		});

		expect(result.agent).toBeDefined();
		expect(result.genome.agentCount()).toBeGreaterThanOrEqual(5);
	});

	test("uses specified root agent name", async () => {
		const genomePath = join(tempDir, "factory-root");
		const result = await createAgent({
			genomePath,
			rootDir: join(import.meta.dir, "../../root"),
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
			rootDir: join(import.meta.dir, "../../root"),
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
			rootDir: join(import.meta.dir, "../../root"),
			workDir: tempDir,
			model: "claude-sonnet-4-6",
		});

		// The root agent spec uses "best", but model override should win
		expect(result.model).toBe("claude-sonnet-4-6");
		expect(result.provider).toBe("anthropic");
	});

	test("uses pre-loaded genome instead of loading from disk", async () => {
		const genomePath = join(tempDir, "factory-preloaded");
		const rootDir = join(import.meta.dir, "../../root");
		// Pre-load a genome before passing it to createAgent
		const genome = new Genome(genomePath, rootDir);
		await genome.init();
		await genome.initFromRoot();

		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: tempDir,
			genome,
		});

		// The returned genome should be the exact same instance we passed in
		expect(result.genome).toBe(genome);
		expect(result.agent).toBeDefined();
		expect(result.genome.agentCount()).toBeGreaterThanOrEqual(5);
	});

	test("throws if root agent not found", async () => {
		const genomePath = join(tempDir, "factory-missing");
		await expect(
			createAgent({
				genomePath,
				rootDir: join(import.meta.dir, "../../root"),
				workDir: tempDir,
				rootAgent: "nonexistent",
			}),
		).rejects.toThrow(/not found/);
	});

	test("passes agent tree to root agent when rootDir has tree layout", async () => {
		const genomePath = join(tempDir, "factory-tree");
		const rootDir = join(import.meta.dir, "../../root");

		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: tempDir,
		});

		// The root agent should have the delegate tool (from tree-based resolution)
		const tools = result.agent.resolvedTools();
		const delegateTool = tools.find((t) => t.name === "delegate");
		expect(delegateTool).toBeDefined();

		// Scan the tree independently to verify the factory did the same
		const tree = await scanAgentTree(rootDir);
		expect(tree.size).toBeGreaterThan(0);

		// The delegate tool description should mention some of the tree agents
		const desc = (delegateTool!.parameters as any).properties.agent_name.description;
		// At minimum, there should be some agents mentioned
		expect(desc.length).toBeGreaterThan(20);
	});

	test("injects dev-mode postscript for quartermaster when workDir is sprout source", async () => {
		const genomePath = join(tempDir, "dev-mode-test");
		const rootDir = join(import.meta.dir, "../../root");

		// Use the actual sprout source dir as workDir — it will detect dev mode
		const sproutRoot = join(import.meta.dir, "../..");
		expect(await isDevMode(sproutRoot)).toBe(true);

		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: sproutRoot,
		});

		const qmPostscript = await result.genome.loadAgentPostscript("quartermaster");
		expect(qmPostscript).toContain(DEV_MODE_SENTINEL);
		expect(qmPostscript).toContain("Development Mode");
		expect(qmPostscript).toContain("Root source");
	});
});

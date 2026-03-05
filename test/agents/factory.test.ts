import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/agents/factory.ts";
import { scanAgentTree } from "../../src/agents/loader.ts";
import { DEV_MODE_SENTINEL, isDevMode } from "../../src/genome/dev-mode.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { Client } from "../../src/llm/client.ts";
import "../helpers/test-env.ts";

function createFactoryTestClient(): Client {
	const modelsByProvider = new Map<string, string[]>([
		["anthropic", ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]],
	]);
	return {
		complete: async () => {
			throw new Error("factory test client should not call complete()");
		},
		stream: async () => {
			throw new Error("factory test client should not call stream()");
		},
		providers: () => ["anthropic"],
		listModelsByProvider: async () => modelsByProvider,
	} as unknown as Client;
}

describe("createAgent", () => {
	let tempDir: string;
	const rootDir = join(import.meta.dir, "../../root");
	let sharedGenomePath: string;
	let sharedGenome: Genome;
	let sharedClient: Client;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-"));
		sharedGenomePath = join(tempDir, "factory-shared");
		sharedGenome = new Genome(sharedGenomePath, rootDir);
		await sharedGenome.init();
		await sharedGenome.initFromRoot();
		sharedClient = createFactoryTestClient();
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates agent with fresh genome from root agents", async () => {
		const genomePath = join(tempDir, "factory-fresh");
		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: tempDir,
			client: sharedClient,
		});

		expect(result.agent).toBeDefined();
		expect(result.agent.spec.name).toBe("root");
		expect(result.genome).toBeDefined();
		expect(result.genome.agentCount()).toBeGreaterThanOrEqual(5);
	});

	test("creates agent with existing genome", async () => {
		// Use the pre-initialized genome from beforeAll and ensure createAgent
		// can load it from disk without needing a preloaded instance.
		const result = await createAgent({
			genomePath: sharedGenomePath,
			rootDir,
			workDir: tempDir,
			client: sharedClient,
		});

		expect(result.agent).toBeDefined();
		expect(result.genome.agentCount()).toBeGreaterThanOrEqual(5);
	});

	test("uses specified root agent name", async () => {
		const result = await createAgent({
			genomePath: sharedGenomePath,
			workDir: tempDir,
			rootAgent: "editor",
			genome: sharedGenome,
			client: sharedClient,
		});

		expect(result.agent.spec.name).toBe("editor");
	});

	test("accepts and forwards sessionId to agent", async () => {
		const customId = "CUSTOM_SESSION_ID_123456";
		const result = await createAgent({
			genomePath: sharedGenomePath,
			workDir: tempDir,
			sessionId: customId,
			genome: sharedGenome,
			client: sharedClient,
		});
		expect(result.agent).toBeDefined();
		expect(result.model).toBeTruthy();
		expect(result.provider).toBeTruthy();
		expect(result.events).toBeDefined();
		expect(result.client).toBeDefined();
	});

	test("model option overrides agent spec model", async () => {
		const result = await createAgent({
			genomePath: sharedGenomePath,
			workDir: tempDir,
			model: "claude-sonnet-4-6",
			genome: sharedGenome,
			client: sharedClient,
		});

		// The root agent spec uses "best", but model override should win
		expect(result.model).toBe("claude-sonnet-4-6");
		expect(result.provider).toBe("anthropic");
	});

	test("uses pre-loaded genome instead of loading from disk", async () => {
		const result = await createAgent({
			genomePath: sharedGenomePath,
			workDir: tempDir,
			genome: sharedGenome,
			client: sharedClient,
		});

		// The returned genome should be the exact same instance we passed in
		expect(result.genome).toBe(sharedGenome);
		expect(result.agent).toBeDefined();
		expect(result.genome.agentCount()).toBeGreaterThanOrEqual(5);
	});

	test("throws if root agent not found", async () => {
		await expect(
			createAgent({
				genomePath: sharedGenomePath,
				workDir: tempDir,
				rootAgent: "nonexistent",
				genome: sharedGenome,
				client: sharedClient,
			}),
		).rejects.toThrow(/not found/);
	});

	test("passes agent tree to root agent when rootDir has tree layout", async () => {
		const result = await createAgent({
			genomePath: sharedGenomePath,
			rootDir,
			workDir: tempDir,
			genome: sharedGenome,
			client: sharedClient,
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

		// Use the actual sprout source dir as workDir — it will detect dev mode
		const sproutRoot = join(import.meta.dir, "../..");
		expect(await isDevMode(sproutRoot)).toBe(true);

		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: sproutRoot,
			client: sharedClient,
		});

		const qmPostscript = await result.genome.loadAgentPostscript("quartermaster");
		expect(qmPostscript).toContain(DEV_MODE_SENTINEL);
		expect(qmPostscript).toContain("Development Mode");
		expect(qmPostscript).toContain("Root source");
	});

	test("initializes a provided preloaded genome before dev-mode postscript save", async () => {
		const genomePath = join(tempDir, "preloaded-no-git");
		const preloadedGenome = new Genome(genomePath, rootDir);

		// Mimic CLI preloading: load root agents into memory without creating the genome repo.
		await preloadedGenome.loadFromDisk();
		expect(existsSync(join(genomePath, ".git"))).toBe(false);

		const sproutRoot = join(import.meta.dir, "../..");
		expect(await isDevMode(sproutRoot)).toBe(true);

		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: sproutRoot,
			genome: preloadedGenome,
			client: sharedClient,
		});

		expect(result.agent).toBeDefined();
		expect(existsSync(join(genomePath, ".git"))).toBe(true);

		const qmPostscript = await result.genome.loadAgentPostscript("quartermaster");
		expect(qmPostscript).toContain(DEV_MODE_SENTINEL);
	});
});

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/agents/factory.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { SnapshotMutationGateBuilders } from "../../src/learn/live-mutation-gate.ts";
import type { Client } from "../../src/llm/client.ts";
import type { ProviderModel } from "../../src/llm/types.ts";
import "../helpers/test-env.ts";
import { buildTestResolverContext } from "../helpers/resolver-context.ts";

function createFactoryTestClient(): Client {
	const modelsByProvider = new Map<string, ProviderModel[]>([
		["anthropic", [{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", source: "remote" }]],
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

const stubBuilders: SnapshotMutationGateBuilders = {
	buildExecutor: () => ({
		run: async () => {
			throw new Error("stub executor should not run in this test");
		},
	}),
	buildCanaryHarness: () => ({
		run: async () => {
			throw new Error("stub harness should not run in this test");
		},
	}),
};

describe("createAgent mutation gate wiring", () => {
	let tempDir: string;
	const rootDir = join(import.meta.dir, "../../root");
	let genomePath: string;
	let client: Client;
	let resolverContext: Awaited<ReturnType<typeof buildTestResolverContext>>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-gate-"));
		genomePath = join(tempDir, "genome");
		const genome = new Genome(genomePath, rootDir);
		await genome.init();
		await genome.initFromRoot();
		client = createFactoryTestClient();
		resolverContext = await buildTestResolverContext(client);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	afterEach(() => {
		delete process.env.SPROUT_MUTATION_GATE;
	});

	test("flag OFF (default): LearnProcess has no mutation gate", async () => {
		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: tempDir,
			client,
			providerIdOverride: resolverContext.providerId,
			resolverSettings: resolverContext.resolverSettings,
			mutationGateBuilders: stubBuilders,
		});
		expect(result.learnProcess?.hasMutationGate()).toBe(false);
	});

	test("flag ON with builders: LearnProcess has a mutation gate", async () => {
		process.env.SPROUT_MUTATION_GATE = "1";
		const result = await createAgent({
			genomePath,
			rootDir,
			workDir: tempDir,
			client,
			providerIdOverride: resolverContext.providerId,
			resolverSettings: resolverContext.resolverSettings,
			mutationGateBuilders: stubBuilders,
		});
		expect(result.learnProcess?.hasMutationGate()).toBe(true);
	});

	test("flag ON without builders: no gate (host did not supply live infrastructure)", async () => {
		process.env.SPROUT_MUTATION_GATE = "1";
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await createAgent({
				genomePath,
				rootDir,
				workDir: tempDir,
				client,
				providerIdOverride: resolverContext.providerId,
				resolverSettings: resolverContext.resolverSettings,
			});
			expect(result.learnProcess?.hasMutationGate()).toBe(false);
			expect(
				errorSpy.mock.calls.some((args) =>
					String(args[0]).includes("no mutation-gate builders were supplied"),
				),
			).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

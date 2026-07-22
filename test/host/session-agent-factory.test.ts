import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { EventBus } from "../../src/host/event-bus.ts";
import { defaultFactory } from "../../src/host/session-agent-factory.ts";
import { Msg, type ProviderModel, type Response } from "../../src/llm/types.ts";
import { ulid } from "../../src/util/ulid.ts";

/**
 * `defaultFactory`'s `runMemoryMaintenance` field gates on the same
 * `collapseModels` resolution as `collapseMemory` (spec: "the same condition
 * that gates collapseMemory") plus the memoryMaintenance setting. These tests
 * exercise the real factory (not a stub), mirroring
 * session-controller.test.ts's "default factory forwards resolver settings"
 * pattern: a minimal on-disk root spec + a synthetic client.
 */

async function writeRootSpec(rootDir: string): Promise<void> {
	await mkdir(rootDir, { recursive: true });
	await writeFile(
		join(rootDir, "root.md"),
		[
			"---",
			'name: "root"',
			'description: "Test root"',
			"model: best",
			'tools: ["read_file"]',
			"---",
			"You are a test root.",
			"",
		].join("\n"),
	);
}

const PROVIDER_ID = "anthropic";
const MODEL_ID = "claude-sonnet-4-6";

function makeClient(vcrReplay = false) {
	const modelsByProvider = new Map<string, ProviderModel[]>([
		[
			PROVIDER_ID,
			[
				{ id: MODEL_ID, label: MODEL_ID, source: "remote" },
				{ id: "consolidation-model", label: "Consolidation", source: "remote" },
				{ id: "entity-gc-model", label: "Entity GC", source: "remote" },
			],
		],
	]);
	const response: Response = {
		id: "mock-response",
		model: MODEL_ID,
		provider: PROVIDER_ID,
		message: Msg.assistant("done"),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	};
	return {
		...(vcrReplay ? { __sproutVcrMode: "replay" } : {}),
		providers: () => [PROVIDER_ID],
		listModelsByProvider: async () => modelsByProvider,
		complete: async (): Promise<Response> => response,
		stream: async function* () {
			yield { type: "finish", response } as any;
		},
	} as any;
}

function fullCollapseResolverSettings(overrides: Record<string, unknown> = {}) {
	return createResolverSettings(
		[{ id: PROVIDER_ID, enabled: true }],
		{ best: { providerId: PROVIDER_ID, modelId: MODEL_ID } },
		{
			summary: { providerId: PROVIDER_ID, modelId: MODEL_ID },
			extraction: { providerId: PROVIDER_ID, modelId: MODEL_ID },
			relationship: { providerId: PROVIDER_ID, modelId: MODEL_ID },
			consolidation: { providerId: PROVIDER_ID, modelId: "consolidation-model" },
			entityGc: { providerId: PROVIDER_ID, modelId: "entity-gc-model" },
			...overrides,
		},
	);
}

describe("defaultFactory memory maintenance wiring", () => {
	test("auto (default) + non-eval + collapse models configured attaches a working runMemoryMaintenance", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-maintenance-auto-"));
		try {
			const rootDir = join(tempDir, "root-spec");
			await writeRootSpec(rootDir);
			const genomePath = join(tempDir, "genome");

			const result = await defaultFactory({
				genomePath,
				rootDir,
				workDir: tempDir,
				sessionId: ulid(),
				events: new EventBus(),
				resolverSettings: fullCollapseResolverSettings(),
				client: makeClient(),
			});

			expect(typeof result.collapseMemory).toBe("function");
			expect(typeof result.runMemoryMaintenance).toBe("function");

			const maintenance = await result.runMemoryMaintenance!();
			expect(maintenance).toEqual({
				merged: 0,
				rejected: 0,
				skipped: 0,
				entityGcMerged: 0,
				entityGcRejected: 0,
				entityGcSkipped: 0,
			});
			const state = JSON.parse(
				await readFile(join(genomePath, ".cache", "memory-maintenance-state.json"), "utf-8"),
			);
			expect(typeof state.lastCheckedAt).toBe("number");
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("memoryMaintenance: manual disables runMemoryMaintenance even with collapse models configured", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-maintenance-manual-"));
		try {
			const rootDir = join(tempDir, "root-spec");
			await writeRootSpec(rootDir);

			const result = await defaultFactory({
				genomePath: join(tempDir, "genome"),
				rootDir,
				workDir: tempDir,
				sessionId: ulid(),
				events: new EventBus(),
				resolverSettings: fullCollapseResolverSettings(),
				client: makeClient(),
				memoryMaintenance: "manual",
			});

			expect(typeof result.collapseMemory).toBe("function");
			expect(result.runMemoryMaintenance).toBeUndefined();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("evalMode disables both collapseMemory and runMemoryMaintenance", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-maintenance-eval-"));
		try {
			const rootDir = join(tempDir, "root-spec");
			await writeRootSpec(rootDir);

			const result = await defaultFactory({
				genomePath: join(tempDir, "genome"),
				rootDir,
				workDir: tempDir,
				sessionId: ulid(),
				events: new EventBus(),
				resolverSettings: fullCollapseResolverSettings(),
				client: makeClient(),
				evalMode: true,
			});

			expect(result.collapseMemory).toBeUndefined();
			expect(result.runMemoryMaintenance).toBeUndefined();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("VCR replay clients disable both collapseMemory and runMemoryMaintenance (no collapse models configured)", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-maintenance-vcr-"));
		try {
			const rootDir = join(tempDir, "root-spec");
			await writeRootSpec(rootDir);

			const result = await defaultFactory({
				genomePath: join(tempDir, "genome"),
				rootDir,
				workDir: tempDir,
				sessionId: ulid(),
				events: new EventBus(),
				resolverSettings: fullCollapseResolverSettings(),
				client: makeClient(true),
			});

			expect(result.collapseMemory).toBeUndefined();
			expect(result.runMemoryMaintenance).toBeUndefined();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

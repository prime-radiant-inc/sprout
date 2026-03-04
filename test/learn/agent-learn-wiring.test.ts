import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { createAgent } from "../../src/agents/factory.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import { Client } from "../../src/llm/client.ts";
import type { ProviderAdapter, Request, Response, StreamEvent } from "../../src/llm/types.ts";
import "../helpers/test-env.ts";

function fakeAdapter(name: string, models: string[]): ProviderAdapter {
	return {
		name,
		async complete(_request: Request): Promise<Response> {
			throw new Error("not implemented");
		},
		stream(_request: Request): AsyncIterable<StreamEvent> {
			throw new Error("not implemented");
		},
		async listModels(): Promise<string[]> {
			return models;
		},
	};
}

describe("Agent-Learn wiring", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-learn-wiring-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("Agent accepts optional learnProcess in options", async () => {
		const genomeDir = join(tempDir, "genome-accept");
		const genome = new Genome(genomeDir, join(import.meta.dir, "../../root"));
		await genome.init();
		await genome.initFromRoot();

		const events = new AgentEventEmitter();
		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const learnProcess = new LearnProcess({ genome, metrics, events });

		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);

		const rootSpec = genome.getAgent("root")!;
		expect(rootSpec).toBeDefined();

		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			learnProcess,
		});

		expect(agent).toBeDefined();
	});

	test("createAgent factory creates and returns learnProcess", async () => {
		const genomePath = join(tempDir, "genome-factory");
		const client = new Client({
			providers: {
				anthropic: fakeAdapter("anthropic", ["claude-opus-4-6", "claude-sonnet-4-6"]),
			},
		});

		const result = await createAgent({
			genomePath,
			rootDir: join(import.meta.dir, "../../root"),
			workDir: tempDir,
			client,
		});

		expect(result.learnProcess).toBeDefined();
		expect(result.learnProcess).toBeInstanceOf(LearnProcess);
	});
});

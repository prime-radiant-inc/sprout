import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { LearnSignal } from "../../src/kernel/types.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import { Client } from "../../src/llm/client.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

describe("Learn Integration", () => {
	let tempDir: string;
	let client: Client;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-learn-int-"));
		client = Client.fromEnv();
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("failure signal produces a genome mutation via LLM", async () => {
		const genomeDir = join(tempDir, "genome-failure");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		// Verify starting state
		expect(genome.agentCount()).toBe(5);
		expect(genome.memories.all().length).toBe(0);
		expect(genome.allRoutingRules().length).toBe(0);

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events, client });

		const signal: LearnSignal = {
			kind: "failure",
			goal: "Run the project's test suite",
			agent_name: "command-runner",
			details: {
				agent_name: "command-runner",
				goal: "Run the project's test suite",
				output: "Error: command not found: pytest. This project uses vitest.",
				success: false,
				stumbles: 1,
				turns: 1,
				timed_out: false,
			},
			session_id: "int-test-1",
			timestamp: Date.now(),
		};

		learn.push(signal);
		const result = await learn.processNext();

		expect(result).toBe("applied");

		// Verify learn_mutation event was emitted
		const collected = events.collected();
		const mutationEvents = collected.filter((e) => e.kind === "learn_mutation");
		expect(mutationEvents.length).toBe(1);

		// Verify genome grew: at least one of memories, routing rules, or agents increased
		const memoryCount = genome.memories.all().length;
		const routingCount = genome.allRoutingRules().length;
		const agentCount = genome.agentCount();
		const grew = memoryCount > 0 || routingCount > 0 || agentCount > 4;
		expect(grew).toBe(true);
	}, 60_000);

	test("skipped signal does not mutate genome", async () => {
		const genomeDir = join(tempDir, "genome-skip");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events, client });

		// One-off error signal: kind "error" with 0 prior occurrences should be skipped
		const signal: LearnSignal = {
			kind: "error",
			goal: "Read a config file",
			agent_name: "code-reader",
			details: {
				agent_name: "code-reader",
				goal: "Read a config file",
				output: "Error: ENOENT no such file",
				success: false,
				stumbles: 1,
				turns: 1,
				timed_out: false,
			},
			session_id: "int-test-2",
			timestamp: Date.now(),
		};

		learn.push(signal);
		const result = await learn.processNext();

		expect(result).toBe("skipped");

		// Verify genome unchanged
		expect(genome.memories.all().length).toBe(0);
		expect(genome.allRoutingRules().length).toBe(0);
		expect(genome.agentCount()).toBe(5);
	}, 30_000);
});

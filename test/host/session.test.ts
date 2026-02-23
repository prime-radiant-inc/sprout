import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import { submitGoal } from "../../src/host/session.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import {
	type AgentSpec,
	DEFAULT_CONSTRAINTS,
	type LearnSignal,
	type SessionEvent,
} from "../../src/kernel/types.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";

const leafSpec: AgentSpec = {
	name: "leaf",
	description: "Test leaf",
	system_prompt: "You do things.",
	model: "fast",
	capabilities: ["read_file", "write_file", "exec"],
	constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
	tags: [],
	version: 1,
};

function makeMockClient(): Client {
	const mockResponse: Response = {
		id: "mock-1",
		model: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		message: Msg.assistant("Done!"),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	};
	return {
		providers: () => ["anthropic"],
		complete: async () => mockResponse,
	} as unknown as Client;
}

function makeSignal(overrides: Partial<LearnSignal> = {}): LearnSignal {
	return {
		kind: overrides.kind ?? "failure",
		goal: overrides.goal ?? "test goal",
		agent_name: overrides.agent_name ?? "test-agent",
		details: overrides.details ?? {
			agent_name: "test-agent",
			goal: "test goal",
			output: "error output",
			success: false,
			stumbles: 1,
			timed_out: false,
			turns: 3,
		},
		session_id: overrides.session_id ?? "session-1",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

describe("submitGoal", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-session-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("yields session_start and session_end events", async () => {
		const mockClient = makeMockClient();
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		const collected: SessionEvent[] = [];
		for await (const event of submitGoal("test goal", { agent, events })) {
			collected.push(event);
		}

		const kinds = collected.map((e) => e.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");
		// session_start should come before session_end
		expect(kinds.indexOf("session_start")).toBeLessThan(kinds.indexOf("session_end"));
	});

	test("drains learn queue after agent completes", async () => {
		const genomeDir = join(tempDir, "genome");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const mockClient = makeMockClient();
		const events = new AgentEventEmitter();
		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		// No LLM client on learnProcess — processNext will return "skipped" after dequeue
		const learnProcess = new LearnProcess({ genome, metrics, events });

		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		// Pre-load queue with a signal
		learnProcess.push(makeSignal());
		learnProcess.push(makeSignal({ kind: "failure", agent_name: "other-agent" }));
		expect(learnProcess.queueSize()).toBe(2);

		const collected: SessionEvent[] = [];
		for await (const event of submitGoal("test goal", { agent, events, learnProcess })) {
			collected.push(event);
		}

		// Queue should be fully drained
		expect(learnProcess.queueSize()).toBe(0);
	});

	test("works without learnProcess", async () => {
		const mockClient = makeMockClient();
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		const collected: SessionEvent[] = [];
		for await (const event of submitGoal("test goal", { agent, events })) {
			collected.push(event);
		}

		// Should complete without errors and still have events
		expect(collected.length).toBeGreaterThan(0);
		const kinds = collected.map((e) => e.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");
	});
});

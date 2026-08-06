import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { CanaryHarness } from "../../src/learn/canary-suite.ts";
import { exampleCanaries } from "../../src/learn/canary-suite.ts";
import type { EvalArm, EvalTask, ExecOutcome, TaskExecutor } from "../../src/learn/eval-harness.ts";
import type { LearnMutation, MutationGate } from "../../src/learn/learn-process.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import { evaluateMutationForAdoption } from "../../src/learn/mutation-gate.ts";
import type { Client } from "../../src/llm/client.ts";
import type { ProviderModel, Response } from "../../src/llm/types.ts";
import { seedMemories } from "../helpers/genome-seed.ts";
import { buildTestResolverContext } from "../helpers/resolver-context.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

const ROOT_DIR = join(import.meta.dir, "../../root");

function makeMockClient(responseText: string): Client {
	const modelsByProvider = new Map<string, ProviderModel[]>([
		["anthropic", [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" }]],
	]);
	const response: Response = {
		id: "mock",
		model: "test",
		provider: "anthropic",
		message: { role: "assistant", content: [{ kind: "text", text: responseText }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	};
	return {
		providers: () => ["anthropic"],
		listModelsByProvider: async () => modelsByProvider,
		complete: async () => response,
	} as unknown as Client;
}

const gateTasks: EvalTask[] = [
	{
		id: "sap-1",
		tier: "sap",
		goal: "g1",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
	{
		id: "sap-2",
		tier: "sap",
		goal: "g2",
		verify: (o) => ({ passed: !o.errored, stumbles: o.stumbles }),
	},
];

function scriptedExecutor(script: Record<string, number[]>): TaskExecutor {
	const cursor = new Map<string, number>();
	return {
		async run(task): Promise<ExecOutcome> {
			const samples = script[task.id] ?? [0];
			const i = cursor.get(task.id) ?? 0;
			cursor.set(task.id, i + 1);
			return {
				output: "",
				errored: false,
				stumbles: samples[i % samples.length] ?? 0,
				providerPayloads: ["clean"],
				didExec: false,
				success: true,
			};
		},
	};
}

function arm(script: Record<string, number[]>): EvalArm {
	return { tasks: gateTasks, executor: scriptedExecutor(script) };
}

const cleanCanaryHarness: CanaryHarness = {
	async run() {
		return { output: "ok", errored: false, providerPayloads: ["clean"], didExec: false };
	},
};

const IMPROVED = { "sap-1": [0, 0, 0, 0, 0, 0], "sap-2": [0, 0, 0, 0, 0, 0] };
const BASELINE = { "sap-1": [3, 3, 3, 3, 3, 3], "sap-2": [3, 3, 3, 3, 3, 3] };
const IDENTICAL = { "sap-1": [1, 0, 1, 0, 1, 0], "sap-2": [0, 1, 0, 1, 0, 1] };

/**
 * A gate that delegates to the REAL chokepoint. `improves(mutation)` selects
 * whether that mutation's candidate arm significantly beats the baseline — the
 * loop must honor whatever the real evaluateMutationForAdoption decides.
 */
function realGate(improves: boolean | ((m: LearnMutation) => boolean)): MutationGate {
	const decide = typeof improves === "function" ? improves : () => improves;
	return {
		async evaluate(mutation: LearnMutation) {
			const wins = decide(mutation);
			const result = await evaluateMutationForAdoption({
				candidateArm: arm(wins ? IMPROVED : IDENTICAL),
				baselineArm: arm(wins ? BASELINE : IDENTICAL),
				canaries: exampleCanaries,
				candidateCanaryHarness: cleanCanaryHarness,
				baselineCanaryHarness: cleanCanaryHarness,
				runs: 6,
			});
			return { adopt: result.adopt, reason: result.reason };
		},
	};
}

describe("LearnProcess adoption chokepoint wiring", () => {
	let tempDir: string;
	let templateDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-gate-wiring-"));
		templateDir = join(tempDir, "__template");
		const template = new Genome(templateDir, ROOT_DIR);
		await template.init();
		await template.initFromRoot();
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function setup(name: string, gate: MutationGate) {
		const genomeDir = join(tempDir, name);
		await cp(templateDir, genomeDir, { recursive: true });
		const genome = createTestGenome(genomeDir, ROOT_DIR);
		await genome.loadFromDisk();
		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const events = new AgentEventEmitter();
		const learn = new LearnProcess({
			genome,
			metrics,
			events,
			pendingEvaluationsPath: join(genomeDir, "metrics", "pending-evaluations.json"),
			mutationGate: gate,
		});
		return { genome, events, learn };
	}

	test("adoptMutation applies an agent mutation when the real A/B gate accepts", async () => {
		const { genome, learn } = await setup("adopt-accept", realGate(true));
		const before = genome.allRoutingRules().length;
		const applied = await learn.adoptMutation({
			type: "create_routing_rule",
			condition: "gate accepts",
			preference: "code-editor",
			strength: 0.8,
		});
		expect(applied).toBe(true);
		expect(genome.allRoutingRules().length).toBe(before + 1);
	});

	test("adoptMutation does NOT apply when the real A/B gate rejects (genome unchanged)", async () => {
		const { genome, learn } = await setup("adopt-reject", realGate(false));
		const before = genome.allRoutingRules().length;
		const applied = await learn.adoptMutation({
			type: "create_routing_rule",
			condition: "gate rejects",
			preference: "code-editor",
			strength: 0.8,
		});
		expect(applied).toBe(false);
		expect(genome.allRoutingRules().length).toBe(before);
	});

	test("the learn loop does not adopt an agent mutation that fails the gate", async () => {
		const genomeDir = join(tempDir, "loop-reject");
		await cp(templateDir, genomeDir, { recursive: true });
		const genome = createTestGenome(genomeDir, ROOT_DIR);
		await genome.loadFromDisk();
		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const events = new AgentEventEmitter();
		const client = makeMockClient(
			'{"type":"create_routing_rule","condition":"loop rejects","preference":"x","strength":0.8}',
		);
		const resolverContext = await buildTestResolverContext(client);
		const learn = new LearnProcess({
			genome,
			metrics,
			events,
			client,
			pendingEvaluationsPath: join(genomeDir, "metrics", "pending-evaluations.json"),
			modelsByProvider: resolverContext.modelsByProvider,
			resolverSettings: resolverContext.resolverSettings,
			mutationGate: realGate(false),
		});
		const before = genome.allRoutingRules().length;
		learn.push({
			kind: "failure",
			goal: "do x",
			agent_name: "root",
			details: {
				agent_name: "root",
				goal: "do x",
				output: "failed",
				success: false,
				stumbles: 1,
				turns: 3,
				timed_out: false,
			},
			session_id: "s1",
			timestamp: Date.now(),
		});
		await learn.processNext();
		expect(genome.allRoutingRules().length).toBe(before);
		expect(genome.allRoutingRules().some((r) => r.condition === "loop rejects")).toBe(false);
	});

	function emitRecurringCell(events: AgentEventEmitter, code: string, times: number): void {
		for (let i = 0; i < times; i++) {
			events.emit("cell_end", "root", 0, { code, success: true });
		}
	}

	test("a fabricated program proposal routes through the chokepoint and is REJECTED when it does not improve", async () => {
		const { genome, learn, events } = await setup("fab-reject", realGate(false));
		emitRecurringCell(events, 'return bind("x", 1);', 3);
		const before = genome.allPrograms().length;
		const adopted = await learn.runQuartermaster();
		expect(adopted).toBe(false);
		expect(genome.allPrograms().length).toBe(before);
		// The gate was consulted for the fabrication proposal.
		const gateEvents = events
			.collected()
			.filter((e) => e.kind === "learn_mutation" && e.data.mutation_type === "adoption_gate");
		expect(gateEvents.some((e) => e.data.proposed === "create_program")).toBe(true);
	});

	test("a fabricated program is adopted when the chokepoint accepts", async () => {
		// Realistic gate: fabrication improves; retiring dead code does not.
		const { genome, learn, events } = await setup(
			"fab-accept",
			realGate((m) => m.type === "create_program"),
		);
		emitRecurringCell(events, 'return bind("y", 2);', 3);
		const adopted = await learn.runQuartermaster();
		expect(adopted).toBe(true);
		// The recurring cell shape was fabricated into a program and adopted.
		expect(genome.allPrograms().some((p) => p.provenance === "fabricated-from-pattern")).toBe(true);
	});

	test("a quartermaster-only cycle labels learn_end as quartermaster, not memory extraction", async () => {
		// No memories extract and no mutation reasons out — only the
		// quartermaster fabricates. The learn_end label must say so instead of
		// claiming a memory extraction that never happened.
		const genomeDir = join(tempDir, "fab-label");
		await cp(templateDir, genomeDir, { recursive: true });
		const genome = createTestGenome(genomeDir, ROOT_DIR);
		await genome.loadFromDisk();
		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const events = new AgentEventEmitter();
		const client = makeMockClient("[]");
		const resolverContext = await buildTestResolverContext(client);
		const learn = new LearnProcess({
			genome,
			metrics,
			events,
			client,
			pendingEvaluationsPath: join(genomeDir, "metrics", "pending-evaluations.json"),
			modelsByProvider: resolverContext.modelsByProvider,
			resolverSettings: resolverContext.resolverSettings,
			mutationGate: realGate((m) => m.type === "create_program"),
		});
		emitRecurringCell(events, 'return bind("z", 3);', 3);
		learn.push({
			kind: "failure",
			goal: "do z",
			agent_name: "root",
			details: {
				agent_name: "root",
				goal: "do z",
				output: "failed",
				success: false,
				stumbles: 1,
				turns: 3,
				timed_out: false,
			},
			session_id: "s1",
			timestamp: Date.now(),
		});

		const result = await learn.processNext();

		expect(result).toBe("applied");
		const learnEnd = events.collected().findLast((event) => event.kind === "learn_end");
		expect(learnEnd?.data.mutation_type).toBe("quartermaster");
		expect(learnEnd?.data.extracted_memories).toBe(false);
	});

	test("a never-delegated overlay agent routes a retire_agent proposal through the chokepoint", async () => {
		const { genome, learn, events } = await setup(
			"agent-retire",
			realGate((m) => m.type === "retire_agent"),
		);
		await genome.addAgent({
			name: "deadwood",
			description: "Never delegated to",
			system_prompt: "You are unused.",
			model: "test-provider:test-model",
			constraints: { max_turns: 10, timeout_ms: 0, can_spawn: false, can_learn: false },
			tags: [],
			version: 1,
			tools: ["read_file"],
			agents: [],
		});
		expect(genome.isOverlay("deadwood")).toBe(true);

		const adopted = await learn.runQuartermaster();
		expect(adopted).toBe(true);
		expect(genome.getAgent("deadwood")).toBeUndefined();

		const gateEvents = events
			.collected()
			.filter((e) => e.kind === "learn_mutation" && e.data.mutation_type === "adoption_gate");
		expect(gateEvents.some((e) => e.data.proposed === "retire_agent")).toBe(true);
	});

	test("a retire_agent proposal the gate rejects leaves the agent in the genome", async () => {
		const { genome, learn } = await setup("agent-retire-reject", realGate(false));
		await genome.addAgent({
			name: "spared",
			description: "Never delegated to",
			system_prompt: "You are unused but the gate says keep.",
			model: "test-provider:test-model",
			constraints: { max_turns: 10, timeout_ms: 0, can_spawn: false, can_learn: false },
			tags: [],
			version: 1,
			tools: ["read_file"],
			agents: [],
		});
		const adopted = await learn.runQuartermaster();
		expect(adopted).toBe(false);
		expect(genome.getAgent("spared")).toBeDefined();
	});

	test("a delegated-to overlay agent is never proposed for retirement", async () => {
		const { genome, learn, events } = await setup("agent-keep-delegated", realGate(true));
		await genome.addAgent({
			name: "workhorse",
			description: "Delegated to this session",
			system_prompt: "You do work.",
			model: "test-provider:test-model",
			constraints: { max_turns: 10, timeout_ms: 0, can_spawn: false, can_learn: false },
			tags: [],
			version: 1,
			tools: ["read_file"],
			agents: [],
		});
		events.emit("act_end", "root", 0, { agent_name: "workhorse", success: true });

		await learn.runQuartermaster();
		expect(genome.getAgent("workhorse")).toBeDefined();
	});

	test("a stale never-used low-confidence memory routes a retire_memory proposal through the chokepoint", async () => {
		const { genome, learn, events } = await setup(
			"memory-retire",
			realGate((m) => m.type === "retire_memory"),
		);
		const staleCreated = Date.now() - 60 * 24 * 60 * 60 * 1000;
		await seedMemories(genome, {
			id: "stale-memory-1",
			content: "A stale, never-used, low-confidence memory.",
			tags: [],
			source: "test",
			created: staleCreated,
			last_used: staleCreated,
			use_count: 0,
			confidence: 0.2,
		});

		const adopted = await learn.runQuartermaster();
		expect(adopted).toBe(true);
		const retired = genome.memories.getById("stale-memory-1");
		expect(retired?.archived_at).toBeDefined();

		const gateEvents = events
			.collected()
			.filter((e) => e.kind === "learn_mutation" && e.data.mutation_type === "adoption_gate");
		expect(gateEvents.some((e) => e.data.proposed === "retire_memory")).toBe(true);
	});

	test("a retire_memory proposal the gate rejects leaves the memory active", async () => {
		const { genome, learn } = await setup("memory-retire-reject", realGate(false));
		const staleCreated = Date.now() - 60 * 24 * 60 * 60 * 1000;
		await seedMemories(genome, {
			id: "stale-memory-2",
			content: "Stale but the gate says keep.",
			tags: [],
			source: "test",
			created: staleCreated,
			last_used: staleCreated,
			use_count: 0,
			confidence: 0.2,
		});
		const adopted = await learn.runQuartermaster();
		expect(adopted).toBe(false);
		expect(genome.memories.getById("stale-memory-2")?.archived_at).toBeUndefined();
	});

	test("runQuartermaster is inert without a gate (fabrication never bypasses the gate)", async () => {
		const genomeDir = join(tempDir, "no-gate");
		await cp(templateDir, genomeDir, { recursive: true });
		const genome = createTestGenome(genomeDir, ROOT_DIR);
		await genome.loadFromDisk();
		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();
		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });
		emitRecurringCell(events, 'return bind("z", 3);', 3);
		const before = genome.allPrograms().length;
		expect(await learn.runQuartermaster()).toBe(false);
		expect(genome.allPrograms().length).toBe(before);
	});
});

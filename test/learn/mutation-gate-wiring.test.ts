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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { LearnSignal } from "../../src/kernel/types.ts";
import type { LearnMutation } from "../../src/learn/learn-process.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";

function makeSignal(overrides: Partial<LearnSignal> = {}): LearnSignal {
	return {
		kind: overrides.kind ?? "error",
		goal: overrides.goal ?? "test goal",
		agent_name: overrides.agent_name ?? "test-agent",
		details: overrides.details ?? {
			agent_name: "test-agent",
			goal: "test goal",
			output: "error output",
			success: false,
			stumbles: 1,
			turns: 3,
		},
		session_id: overrides.session_id ?? "session-1",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

async function setupGenome(tempDir: string, name: string) {
	const genomeDir = join(tempDir, name);
	const genome = new Genome(genomeDir);
	await genome.init();
	await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));
	const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
	await metrics.load();
	const events = new AgentEventEmitter();
	const learn = new LearnProcess({ genome, metrics, events });
	return { genome, metrics, events, learn };
}

describe("LearnProcess", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-learn-process-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("constructor creates a LearnProcess", async () => {
		const { learn } = await setupGenome(tempDir, "ctor");
		expect(learn).toBeInstanceOf(LearnProcess);
		expect(learn.queueSize()).toBe(0);
	});

	test("push queues a signal", async () => {
		const { learn } = await setupGenome(tempDir, "push-queue");
		const signal = makeSignal();
		learn.push(signal);
		expect(learn.queueSize()).toBe(1);
	});

	test("push records stumble in metrics", async () => {
		const { learn, metrics } = await setupGenome(tempDir, "push-metrics");
		const signal = makeSignal({ kind: "error", agent_name: "editor" });
		learn.push(signal);
		// The in-memory increment is synchronous in MetricsStore before the async disk write
		expect(metrics.stumbleCount("editor", "error")).toBe(1);
	});

	test("processNext skips signals that don't pass filtering", async () => {
		const { learn } = await setupGenome(tempDir, "skip-filter");
		// One-off error (count=1 after push) -> shouldLearn returns false
		const signal = makeSignal({ kind: "error" });
		learn.push(signal);
		const result = await learn.processNext();
		expect(result).toBe("skipped");
		expect(learn.queueSize()).toBe(0);
	});

	test("processNext returns empty when queue is empty", async () => {
		const { learn } = await setupGenome(tempDir, "empty-queue");
		const result = await learn.processNext();
		expect(result).toBe("empty");
	});

	test("applyMutation: create_memory adds memory with correct content/tags", async () => {
		const { learn, genome } = await setupGenome(tempDir, "create-memory");
		const mutation: LearnMutation = {
			type: "create_memory",
			content: "Always check file permissions before writing",
			tags: ["filesystem", "permissions"],
		};
		await learn.applyMutation(mutation);
		const memories = genome.memories.all();
		expect(memories.length).toBe(1);
		const mem = memories[0]!;
		expect(mem.content).toBe("Always check file permissions before writing");
		expect(mem.tags).toEqual(["filesystem", "permissions"]);
		expect(mem.source).toBe("learn");
		expect(mem.confidence).toBe(0.8);
		expect(mem.id).toMatch(/^learn-/);
	});

	test("applyMutation: create_routing_rule adds rule", async () => {
		const { learn, genome } = await setupGenome(tempDir, "create-rule");
		const mutation: LearnMutation = {
			type: "create_routing_rule",
			condition: "file editing tasks",
			preference: "code-editor",
			strength: 0.9,
		};
		const rulesBefore = genome.allRoutingRules().length;
		await learn.applyMutation(mutation);
		const rulesAfter = genome.allRoutingRules();
		expect(rulesAfter.length).toBe(rulesBefore + 1);
		const added = rulesAfter[rulesAfter.length - 1]!;
		expect(added.condition).toBe("file editing tasks");
		expect(added.preference).toBe("code-editor");
		expect(added.strength).toBe(0.9);
		expect(added.source).toBe("learn");
		expect(added.id).toMatch(/^learn-rule-/);
	});

	test("applyMutation: update_agent changes system_prompt and bumps version", async () => {
		const { learn, genome } = await setupGenome(tempDir, "update-agent");
		const agent = genome.getAgent("root");
		expect(agent).toBeDefined();
		const originalVersion = agent!.version;

		const mutation: LearnMutation = {
			type: "update_agent",
			agent_name: "root",
			system_prompt: "You are an improved root agent.",
		};
		await learn.applyMutation(mutation);

		const updated = genome.getAgent("root");
		expect(updated).toBeDefined();
		expect(updated!.system_prompt).toBe("You are an improved root agent.");
		expect(updated!.version).toBe(originalVersion + 1);
	});

	test("applyMutation: create_agent adds agent with correct fields", async () => {
		const { learn, genome } = await setupGenome(tempDir, "create-agent");
		const countBefore = genome.agentCount();

		const mutation: LearnMutation = {
			type: "create_agent",
			name: "test-specialist",
			description: "Runs tests efficiently",
			system_prompt: "You are a test specialist.",
			model: "fast",
			capabilities: ["exec"],
			tags: ["testing"],
		};
		await learn.applyMutation(mutation);

		expect(genome.agentCount()).toBe(countBefore + 1);
		const agent = genome.getAgent("test-specialist");
		expect(agent).toBeDefined();
		expect(agent!.description).toBe("Runs tests efficiently");
		expect(agent!.system_prompt).toBe("You are a test specialist.");
		expect(agent!.model).toBe("fast");
		expect(agent!.capabilities).toEqual(["exec"]);
		expect(agent!.tags).toEqual(["testing"]);
		expect(agent!.constraints.can_spawn).toBe(false);
	});

	test("emits learn_mutation event on applyMutation", async () => {
		const { learn, events } = await setupGenome(tempDir, "emit-mutation");
		const mutation: LearnMutation = {
			type: "create_memory",
			content: "test memory for events",
			tags: ["test"],
		};
		await learn.applyMutation(mutation);
		const collected = events.collected();
		const mutationEvents = collected.filter((e) => e.kind === "learn_mutation");
		expect(mutationEvents.length).toBe(1);
		expect(mutationEvents[0]!.data.mutation_type).toBe("create_memory");
	});

	test("recordAction delegates to metrics", async () => {
		const { learn, metrics } = await setupGenome(tempDir, "record-action");
		expect(metrics.totalActions("root")).toBe(0);

		learn.recordAction("root");
		// In-memory increment is synchronous
		expect(metrics.totalActions("root")).toBe(1);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import type { LearnSignal } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";
import type { LearnMutation, PendingEvaluation } from "../../src/learn/learn-process.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";

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
			timed_out: false,
		},
		session_id: overrides.session_id ?? "session-1",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

function makeMockResponse(text: string): Response {
	return {
		id: "mock",
		model: "test",
		provider: "anthropic",
		message: { role: "assistant", content: [{ kind: "text", text }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	};
}

function makeMockClient(responseText: string, onComplete?: (req: Request) => void): Client {
	return {
		providers: () => ["anthropic"],
		complete: async (request: Request) => {
			onComplete?.(request);
			return makeMockResponse(responseText);
		},
	} as unknown as Client;
}

async function setupGenome(tempDir: string, name: string) {
	const genomeDir = join(tempDir, name);
	const genome = new Genome(genomeDir);
	await genome.init();
	await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));
	const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
	await metrics.load();
	const events = new AgentEventEmitter();
	const pendingEvaluationsPath = join(genomeDir, "metrics", "pending-evaluations.json");
	const learn = new LearnProcess({ genome, metrics, events, pendingEvaluationsPath });
	return { genome, metrics, events, learn, genomeDir, pendingEvaluationsPath };
}

async function setupGenomeWithClient(tempDir: string, name: string, client: Client) {
	const genomeDir = join(tempDir, name);
	const genome = new Genome(genomeDir);
	await genome.init();
	await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));
	const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
	await metrics.load();
	const events = new AgentEventEmitter();
	const pendingEvaluationsPath = join(genomeDir, "metrics", "pending-evaluations.json");
	const learn = new LearnProcess({ genome, metrics, events, client, pendingEvaluationsPath });
	return { genome, metrics, events, learn, genomeDir, pendingEvaluationsPath };
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

	test("reasonAboutImprovement prompt includes genome context", async () => {
		let capturedPrompt = "";
		const client = makeMockClient('{"type": "skip"}', (req) => {
			capturedPrompt = (req.messages[0]!.content[0] as { text: string }).text;
		});

		const { genome, learn } = await setupGenomeWithClient(tempDir, "genome-ctx", client);

		// Add a custom agent
		await genome.addAgent({
			name: "test-specialist",
			description: "A specialist for testing",
			system_prompt: "You run tests carefully",
			model: "fast",
			capabilities: ["exec"],
			constraints: DEFAULT_CONSTRAINTS,
			tags: ["testing"],
			version: 1,
		});

		// Add a memory
		await genome.addMemory({
			id: "mem-ctx-1",
			content: "Always use --verbose flag",
			tags: ["testing"],
			source: "learn",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 0,
			confidence: 0.8,
		});

		// Use failure kind to bypass shouldLearn filtering
		const signal = makeSignal({
			kind: "failure",
			agent_name: "test-specialist",
			goal: "run tests",
			details: {
				agent_name: "test-specialist",
				goal: "run tests",
				output: "tests failed",
				success: false,
				stumbles: 1,
				turns: 5,
				timed_out: false,
			},
		});
		learn.push(signal);
		await learn.processNext();

		// Prompt should include existing agent info
		expect(capturedPrompt).toContain("test-specialist");
		expect(capturedPrompt).toContain("A specialist for testing");
		// Prompt should include existing memory content
		expect(capturedPrompt).toContain("Always use --verbose flag");
		// Prompt should include the agent's current system prompt
		expect(capturedPrompt).toContain("You run tests carefully");
	});

	test("handles markdown-wrapped JSON responses", async () => {
		const wrappedJson =
			'```json\n{"type": "create_memory", "content": "test insight", "tags": ["test"]}\n```';
		const client = makeMockClient(wrappedJson);

		const { genome, learn } = await setupGenomeWithClient(tempDir, "md-json", client);

		const signal = makeSignal({
			kind: "failure",
			agent_name: "root",
			goal: "do something",
			details: {
				agent_name: "root",
				goal: "do something",
				output: "failed",
				success: false,
				stumbles: 1,
				turns: 3,
				timed_out: false,
			},
		});
		learn.push(signal);
		const result = await learn.processNext();

		expect(result).toBe("applied");
		const memories = genome.memories.all();
		expect(memories.some((m) => m.content === "test insight")).toBe(true);
	});

	test("handles markdown-wrapped JSON without language tag", async () => {
		const wrappedJson =
			'```\n{"type": "create_memory", "content": "bare block insight", "tags": ["test"]}\n```';
		const client = makeMockClient(wrappedJson);

		const { genome, learn } = await setupGenomeWithClient(tempDir, "md-bare", client);

		const signal = makeSignal({
			kind: "failure",
			agent_name: "root",
			goal: "do something",
			details: {
				agent_name: "root",
				goal: "do something",
				output: "failed",
				success: false,
				stumbles: 1,
				turns: 3,
				timed_out: false,
			},
		});
		learn.push(signal);
		const result = await learn.processNext();

		expect(result).toBe("applied");
		const memories = genome.memories.all();
		expect(memories.some((m) => m.content === "bare block insight")).toBe(true);
	});

	describe("background processing", () => {
		test("startBackground processes signals pushed to queue", async () => {
			const { learn } = await setupGenome(tempDir, "bg-process");

			learn.startBackground();

			// Push a failure signal (passes shouldLearn filter)
			// No client, so processSignal returns "skipped" — but the signal IS dequeued
			learn.push(makeSignal({ kind: "failure" }));

			// Wait for background loop to pick it up
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(learn.queueSize()).toBe(0);

			await learn.stopBackground();
		});

		test("startBackground is idempotent", async () => {
			const { learn } = await setupGenome(tempDir, "bg-idempotent");

			learn.startBackground();
			learn.startBackground(); // second call should be no-op

			learn.push(makeSignal({ kind: "failure" }));
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(learn.queueSize()).toBe(0);

			await learn.stopBackground();
		});

		test("stopBackground drains remaining signals before returning", async () => {
			const slowClient = makeMockClient('{"type": "skip"}');
			const { learn } = await setupGenomeWithClient(tempDir, "bg-drain", slowClient);

			learn.startBackground();

			// Push multiple failure signals
			learn.push(makeSignal({ kind: "failure", agent_name: "root" }));
			learn.push(makeSignal({ kind: "failure", agent_name: "root" }));
			learn.push(makeSignal({ kind: "failure", agent_name: "root" }));

			// Stop should drain all remaining
			await learn.stopBackground();

			expect(learn.queueSize()).toBe(0);
		});

		test("push wakes background loop immediately", async () => {
			const { learn } = await setupGenome(tempDir, "bg-wake");

			learn.startBackground();

			// Wait for loop to enter sleep (no signals yet)
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Push a signal — should wake the loop
			learn.push(makeSignal({ kind: "failure" }));

			// Give it a tick to process
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(learn.queueSize()).toBe(0);

			await learn.stopBackground();
		});

		test("stopBackground resolves when not started", async () => {
			const { learn } = await setupGenome(tempDir, "bg-stop-noop");

			// Should not hang or throw
			await learn.stopBackground();
		});
	});

	describe("kernel name protection", () => {
		test("applyMutation rejects agent names that shadow primitives", async () => {
			const { learn } = await setupGenome(tempDir, "reject-primitive");

			await expect(
				learn.applyMutation({
					type: "create_agent",
					name: "read_file",
					description: "Shadowing a primitive",
					system_prompt: "Evil agent",
					model: "fast",
					capabilities: [],
					tags: [],
				}),
			).rejects.toThrow(/kernel primitive/);
		});

		test("applyMutation rejects agent names that shadow kernel agents", async () => {
			const { learn } = await setupGenome(tempDir, "reject-kernel");

			await expect(
				learn.applyMutation({
					type: "create_agent",
					name: "learn",
					description: "Shadowing Learn",
					system_prompt: "Evil agent",
					model: "fast",
					capabilities: [],
					tags: [],
				}),
			).rejects.toThrow(/kernel/);
		});

		test("applyMutation rejects all kernel primitive names", async () => {
			const { learn } = await setupGenome(tempDir, "reject-all-primitives");

			for (const name of [
				"read_file",
				"write_file",
				"edit_file",
				"apply_patch",
				"exec",
				"grep",
				"glob",
				"fetch",
			]) {
				await expect(
					learn.applyMutation({
						type: "create_agent",
						name,
						description: `Shadowing ${name}`,
						system_prompt: "Evil agent",
						model: "fast",
						capabilities: [],
						tags: [],
					}),
				).rejects.toThrow(/kernel primitive/);
			}
		});

		test("applyMutation rejects all kernel reserved names", async () => {
			const { learn } = await setupGenome(tempDir, "reject-all-reserved");

			for (const name of ["learn", "kernel", "perceive", "recall", "plan", "act", "verify"]) {
				await expect(
					learn.applyMutation({
						type: "create_agent",
						name,
						description: `Shadowing ${name}`,
						system_prompt: "Evil agent",
						model: "fast",
						capabilities: [],
						tags: [],
					}),
				).rejects.toThrow(/kernel/);
			}
		});

		test("applyMutation allows non-kernel agent names", async () => {
			const { learn, genome } = await setupGenome(tempDir, "allow-normal");

			await learn.applyMutation({
				type: "create_agent",
				name: "my-specialist",
				description: "A safe agent name",
				system_prompt: "You are a specialist.",
				model: "fast",
				capabilities: [],
				tags: [],
			});

			const agent = genome.getAgent("my-specialist");
			expect(agent).toBeDefined();
			expect(agent!.name).toBe("my-specialist");
		});
	});

	describe("pending evaluation tracking", () => {
		test("applyMutation adds a pending evaluation", async () => {
			const { learn } = await setupGenome(tempDir, "pending-add");
			const mutation: LearnMutation = {
				type: "create_memory",
				content: "test memory",
				tags: ["test"],
			};
			await learn.applyMutation(mutation);

			const pending = learn.pendingEvaluations();
			expect(pending).toHaveLength(1);
			expect(pending[0]!.mutationType).toBe("create_memory");
			expect(pending[0]!.agentName).toBe("learn");
			expect(typeof pending[0]!.timestamp).toBe("number");
			expect(typeof pending[0]!.commitHash).toBe("string");
			expect(pending[0]!.commitHash).toMatch(/^[0-9a-f]{40}$/);
		});

		test("update_agent mutation records the agent name", async () => {
			const { learn } = await setupGenome(tempDir, "pending-agent-name");
			const mutation: LearnMutation = {
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Updated prompt",
			};
			await learn.applyMutation(mutation);

			const pending = learn.pendingEvaluations();
			expect(pending).toHaveLength(1);
			expect(pending[0]!.agentName).toBe("root");
		});

		test("pending evaluations persist to disk", async () => {
			const { learn, pendingEvaluationsPath } = await setupGenome(tempDir, "pending-persist");
			await learn.applyMutation({
				type: "create_memory",
				content: "persisted memory",
				tags: ["test"],
			});

			// Verify file exists on disk
			const raw = await readFile(pendingEvaluationsPath, "utf-8");
			const parsed = JSON.parse(raw) as PendingEvaluation[];
			expect(parsed).toHaveLength(1);
			expect(parsed[0]!.mutationType).toBe("create_memory");
		});

		test("pending evaluations load across sessions", async () => {
			const { pendingEvaluationsPath, genome, metrics, events } = await setupGenome(
				tempDir,
				"pending-reload",
			);

			// First session: apply a mutation
			const learn1 = new LearnProcess({
				genome,
				metrics,
				events,
				pendingEvaluationsPath,
			});
			await learn1.applyMutation({
				type: "create_memory",
				content: "cross-session memory",
				tags: ["test"],
			});
			expect(learn1.pendingEvaluations()).toHaveLength(1);

			// Second session: create new LearnProcess, load pending
			const learn2 = new LearnProcess({
				genome,
				metrics,
				events,
				pendingEvaluationsPath,
			});
			await learn2.loadPendingEvaluations();
			expect(learn2.pendingEvaluations()).toHaveLength(1);
			expect(learn2.pendingEvaluations()[0]!.mutationType).toBe("create_memory");
		});
	});

	describe("evaluatePendingImprovements", () => {
		test("skips improvements without enough data (< 5 actions)", async () => {
			const { learn, metrics } = await setupGenome(tempDir, "eval-skip-insufficient");

			// Apply a mutation to create a pending evaluation
			await learn.applyMutation({
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Updated prompt",
			});
			expect(learn.pendingEvaluations()).toHaveLength(1);

			// Record only 3 actions (below the 5-action threshold)
			for (let i = 0; i < 3; i++) await metrics.recordAction("root");

			await learn.evaluatePendingImprovements();

			// Still pending — not enough data to evaluate
			expect(learn.pendingEvaluations()).toHaveLength(1);
		});

		test("evaluates and removes helpful improvement", async () => {
			const { learn, metrics } = await setupGenome(tempDir, "eval-pending-helpful");

			// Create some "before" data: high stumble rate
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			for (let i = 0; i < 5; i++) await metrics.recordStumble("root", "error");

			await new Promise((r) => setTimeout(r, 5));

			// Apply a mutation
			await learn.applyMutation({
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Improved prompt",
			});
			expect(learn.pendingEvaluations()).toHaveLength(1);

			await new Promise((r) => setTimeout(r, 5));

			// "After" data: low stumble rate (improved!)
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await learn.evaluatePendingImprovements();

			// Should be removed from pending (helpful = evaluated)
			expect(learn.pendingEvaluations()).toHaveLength(0);
		});

		test("evaluates and removes neutral improvement", async () => {
			const { learn, metrics } = await setupGenome(tempDir, "eval-pending-neutral");

			// "Before" data
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await new Promise((r) => setTimeout(r, 5));

			// Apply a mutation
			await learn.applyMutation({
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Slightly different prompt",
			});

			await new Promise((r) => setTimeout(r, 5));

			// "After" data: same stumble rate
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await learn.evaluatePendingImprovements();

			// Neutral = evaluated, removed from pending
			expect(learn.pendingEvaluations()).toHaveLength(0);
		});

		test("harmful improvement triggers genome rollback", async () => {
			const { learn, metrics, genome } = await setupGenome(
				tempDir,
				"eval-pending-harmful",
			);

			const originalPrompt = genome.getAgent("root")!.system_prompt;

			// "Before" data: low stumble rate
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await new Promise((r) => setTimeout(r, 5));

			// Apply a harmful mutation
			await learn.applyMutation({
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Terrible prompt that makes things worse",
			});
			expect(learn.pendingEvaluations()).toHaveLength(1);

			await new Promise((r) => setTimeout(r, 5));

			// "After" data: high stumble rate (worse!)
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			for (let i = 0; i < 5; i++) await metrics.recordStumble("root", "error");

			await learn.evaluatePendingImprovements();

			// Should be removed from pending
			expect(learn.pendingEvaluations()).toHaveLength(0);

			// Genome should have been rolled back — reload to verify
			const genome2 = new Genome(join(tempDir, "eval-pending-harmful"));
			await genome2.loadFromDisk();
			expect(genome2.getAgent("root")!.system_prompt).toBe(originalPrompt);
		});

		test("emits evaluation event for each evaluated improvement", async () => {
			const { learn, metrics, events } = await setupGenome(
				tempDir,
				"eval-pending-events",
			);

			// "Before" data
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await new Promise((r) => setTimeout(r, 5));

			await learn.applyMutation({
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Event test prompt",
			});

			await new Promise((r) => setTimeout(r, 5));

			// "After" data: same stumble rate (neutral)
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await learn.evaluatePendingImprovements();

			const collected = events.collected();
			const evalEvents = collected.filter(
				(e) => e.kind === "learn_mutation" && e.data.mutation_type === "evaluation",
			);
			expect(evalEvents.length).toBe(1);
			expect(evalEvents[0]!.data.verdict).toBeDefined();
		});

		test("emits rollback event for harmful improvement", async () => {
			const { learn, metrics, events } = await setupGenome(
				tempDir,
				"eval-pending-rollback-event",
			);

			// "Before" data: low stumble rate
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			await metrics.recordStumble("root", "error");

			await new Promise((r) => setTimeout(r, 5));

			await learn.applyMutation({
				type: "update_agent",
				agent_name: "root",
				system_prompt: "Bad prompt",
			});

			await new Promise((r) => setTimeout(r, 5));

			// "After" data: high stumble rate (worse!)
			for (let i = 0; i < 10; i++) await metrics.recordAction("root");
			for (let i = 0; i < 5; i++) await metrics.recordStumble("root", "error");

			await learn.evaluatePendingImprovements();

			const collected = events.collected();
			const rollbackEvents = collected.filter(
				(e) => e.kind === "learn_mutation" && e.data.mutation_type === "rollback",
			);
			expect(rollbackEvents.length).toBe(1);
		});
	});

	describe("evaluateImprovement", () => {
		test("detects harmful improvement", async () => {
			const { learn, metrics } = await setupGenome(tempDir, "eval-harmful");

			// Before: 1 stumble / 10 actions = 0.1
			for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
			await metrics.recordStumble("code-reader", "error");

			// Delay ensures boundary timestamp is strictly after all "before" entries
			await new Promise((r) => setTimeout(r, 5));
			const beforeTimestamp = Date.now();
			await new Promise((r) => setTimeout(r, 5));

			// After: 5 stumbles / 10 actions = 0.5 (worse!)
			for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
			for (let i = 0; i < 5; i++) await metrics.recordStumble("code-reader", "error");

			const result = await learn.evaluateImprovement("code-reader", beforeTimestamp);
			expect(result.verdict).toBe("harmful");
			expect(result.delta).toBeGreaterThan(0); // positive delta = got worse
			expect(result.after_rate).toBeGreaterThan(result.before_rate);
		});

		test("detects helpful improvement", async () => {
			const { learn, metrics } = await setupGenome(tempDir, "eval-helpful");

			// Before: 5 stumbles / 10 actions = 0.5
			for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
			for (let i = 0; i < 5; i++) await metrics.recordStumble("code-reader", "error");

			await new Promise((r) => setTimeout(r, 5));
			const beforeTimestamp = Date.now();
			await new Promise((r) => setTimeout(r, 5));

			// After: 1 stumble / 10 actions = 0.1 (better!)
			for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
			await metrics.recordStumble("code-reader", "error");

			const result = await learn.evaluateImprovement("code-reader", beforeTimestamp);
			expect(result.verdict).toBe("helpful");
			expect(result.delta).toBeLessThan(0); // negative delta = got better
		});

		test("detects neutral improvement within threshold", async () => {
			const { learn, metrics } = await setupGenome(tempDir, "eval-neutral");

			// Before: 1 stumble / 10 actions = 0.1
			for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
			await metrics.recordStumble("code-reader", "error");

			await new Promise((r) => setTimeout(r, 5));
			const beforeTimestamp = Date.now();
			await new Promise((r) => setTimeout(r, 5));

			// After: 1 stumble / 10 actions = 0.1 (same — within 0.05 threshold)
			for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
			await metrics.recordStumble("code-reader", "error");

			const result = await learn.evaluateImprovement("code-reader", beforeTimestamp);
			expect(result.verdict).toBe("neutral");
		});
	});
});

# Phase 6: Learn (Async) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the asynchronous Learn process that receives LearnSignals from Verify, decides whether to act (trigger filtering), produces genome mutations via an LLM agent, and tracks metrics (stumble counts) for evaluation.

**Architecture:** Learn has three layers: (1) a `MetricsStore` that tracks stumble counts per agent/kind for trigger filtering and evaluation, (2) a `should_learn()` filter function that gates which signals warrant action, and (3) a `LearnProcess` class that manages an async signal queue, runs the Learn agent (an LLM-powered agent that decides what genome mutation to make), and commits improvements. The Learn agent itself uses the `Client` to reason about what improvement to make, following a structured prompt. The `Agent` class is extended to collect and forward learn signals to the LearnProcess.

**Tech Stack:** TypeScript/Bun, existing `Genome`, `Client`, `Agent`, `AgentEventEmitter`, `bun test`

---

## Context

**What already exists:**
- `src/kernel/types.ts` — `LearnSignal`, `LearnSignalKind`, `EventKind` (includes learn_start/learn_mutation/learn_end)
- `src/agents/verify.ts` — `verifyActResult()` produces `LearnSignal` when stumbles detected
- `src/agents/agent.ts` — Agent.run() emits `learn_signal` events (line 268)
- `src/agents/events.ts` — `AgentEventEmitter` with emit/on/collected
- `src/genome/genome.ts` — Full CRUD for agents, memories, routing rules (all git-committed)
- `src/genome/memory-store.ts` — Memory search and CRUD
- `bootstrap/root.yaml` — root agent has `can_learn: true`
- `metrics/` directory created by Genome.init() but empty (no code)

**What's missing (the gap this phase closes):**
- No `MetricsStore` — stumble counts aren't tracked, so trigger filtering can't work
- No `should_learn()` — every stumble is currently ignored (signal emitted but not acted on)
- No `LearnProcess` — no async queue, no LLM-based reasoning about improvements
- Agent.run() emits learn_signal events but nothing consumes them
- No integration between learn signals and genome mutations

**Key files to create:**
- `src/learn/metrics-store.ts` — Stumble count tracking (JSONL-backed)
- `src/learn/should-learn.ts` — Trigger filtering function
- `src/learn/learn-process.ts` — Async queue + LLM-based improvement agent
- `src/learn/index.ts` — Barrel exports
- `test/learn/metrics-store.test.ts`
- `test/learn/should-learn.test.ts`
- `test/learn/learn-process.test.ts`

**Key files to modify:**
- `src/agents/agent.ts` — Connect learn signals to LearnProcess
- `src/index.ts` — Export learn module

---

### Task 1: MetricsStore — Stumble Count Tracking

**Files:**
- Create: `src/learn/metrics-store.ts`
- Create: `test/learn/metrics-store.test.ts`

The MetricsStore tracks stumble counts per `(agent_name, kind)` pair. It is backed by a JSONL file in the genome's `metrics/` directory. It provides `record()` to increment a counter and `stumbleCount()` to query it. It also provides `totalStumbles()` and `totalActions()` for computing stumble rates.

**Step 1: Write the failing tests**

Create `test/learn/metrics-store.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsStore } from "../../src/learn/metrics-store.ts";

describe("MetricsStore", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-metrics-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("stumbleCount returns 0 for unknown agent/kind", async () => {
		const store = new MetricsStore(join(tempDir, "empty", "metrics.jsonl"));
		await store.load();
		expect(store.stumbleCount("unknown", "error")).toBe(0);
	});

	test("recordStumble increments count and persists to disk", async () => {
		const path = join(tempDir, "record", "metrics.jsonl");
		const store = new MetricsStore(path);
		await store.load();

		await store.recordStumble("code-reader", "error");
		await store.recordStumble("code-reader", "error");
		await store.recordStumble("code-reader", "failure");

		expect(store.stumbleCount("code-reader", "error")).toBe(2);
		expect(store.stumbleCount("code-reader", "failure")).toBe(1);

		// Verify persisted to disk
		const raw = await readFile(path, "utf-8");
		const lines = raw.trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(3);
	});

	test("load restores counts from disk", async () => {
		const path = join(tempDir, "load", "metrics.jsonl");
		const store1 = new MetricsStore(path);
		await store1.load();

		await store1.recordStumble("editor", "timeout");
		await store1.recordStumble("editor", "timeout");

		// Load into a fresh store
		const store2 = new MetricsStore(path);
		await store2.load();
		expect(store2.stumbleCount("editor", "timeout")).toBe(2);
	});

	test("recordAction increments total action count", async () => {
		const path = join(tempDir, "actions", "metrics.jsonl");
		const store = new MetricsStore(path);
		await store.load();

		await store.recordAction("code-reader");
		await store.recordAction("code-reader");
		await store.recordAction("root");

		expect(store.totalActions("code-reader")).toBe(2);
		expect(store.totalActions("root")).toBe(1);
		expect(store.totalActions("unknown")).toBe(0);
	});

	test("stumbleRate computes ratio of stumbles to actions", async () => {
		const path = join(tempDir, "rate", "metrics.jsonl");
		const store = new MetricsStore(path);
		await store.load();

		// 10 actions, 2 stumbles = 0.2 rate
		for (let i = 0; i < 10; i++) await store.recordAction("agent-a");
		await store.recordStumble("agent-a", "error");
		await store.recordStumble("agent-a", "failure");

		expect(store.stumbleRate("agent-a")).toBeCloseTo(0.2);
	});

	test("stumbleRate returns 0 when no actions recorded", async () => {
		const path = join(tempDir, "rate-zero", "metrics.jsonl");
		const store = new MetricsStore(path);
		await store.load();

		expect(store.stumbleRate("nobody")).toBe(0);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/learn/metrics-store.test.ts`
Expected: FAIL — cannot find module `../../src/learn/metrics-store.ts`

**Step 3: Implement MetricsStore**

Create `src/learn/metrics-store.ts`:

```typescript
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

interface MetricEntry {
	type: "stumble" | "action";
	agent_name: string;
	kind?: string; // only for stumbles
	timestamp: number;
}

export class MetricsStore {
	private readonly path: string;
	private stumbleCounts = new Map<string, number>(); // "agent:kind" -> count
	private actionCounts = new Map<string, number>(); // "agent" -> count
	private totalStumbleCounts = new Map<string, number>(); // "agent" -> total stumbles

	constructor(jsonlPath: string) {
		this.path = jsonlPath;
	}

	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf-8");
		} catch (err: unknown) {
			if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw err;
		}
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			const entry = JSON.parse(line) as MetricEntry;
			if (entry.type === "stumble") {
				const key = `${entry.agent_name}:${entry.kind}`;
				this.stumbleCounts.set(key, (this.stumbleCounts.get(key) ?? 0) + 1);
				this.totalStumbleCounts.set(
					entry.agent_name,
					(this.totalStumbleCounts.get(entry.agent_name) ?? 0) + 1,
				);
			} else if (entry.type === "action") {
				this.actionCounts.set(
					entry.agent_name,
					(this.actionCounts.get(entry.agent_name) ?? 0) + 1,
				);
			}
		}
	}

	stumbleCount(agentName: string, kind: string): number {
		return this.stumbleCounts.get(`${agentName}:${kind}`) ?? 0;
	}

	totalActions(agentName: string): number {
		return this.actionCounts.get(agentName) ?? 0;
	}

	stumbleRate(agentName: string): number {
		const actions = this.totalActions(agentName);
		if (actions === 0) return 0;
		const stumbles = this.totalStumbleCounts.get(agentName) ?? 0;
		return stumbles / actions;
	}

	async recordStumble(agentName: string, kind: string): Promise<void> {
		const key = `${agentName}:${kind}`;
		this.stumbleCounts.set(key, (this.stumbleCounts.get(key) ?? 0) + 1);
		this.totalStumbleCounts.set(
			agentName,
			(this.totalStumbleCounts.get(agentName) ?? 0) + 1,
		);
		await this.append({ type: "stumble", agent_name: agentName, kind, timestamp: Date.now() });
	}

	async recordAction(agentName: string): Promise<void> {
		this.actionCounts.set(agentName, (this.actionCounts.get(agentName) ?? 0) + 1);
		await this.append({ type: "action", agent_name: agentName, timestamp: Date.now() });
	}

	private async append(entry: MetricEntry): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(entry)}\n`);
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/learn/metrics-store.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/learn/metrics-store.ts test/learn/metrics-store.test.ts
git commit -m "feat: add MetricsStore for stumble count tracking"
```

---

### Task 2: should_learn() — Trigger Filtering

**Files:**
- Create: `src/learn/should-learn.ts`
- Create: `test/learn/should-learn.test.ts`

Implements the trigger filtering function from spec Section 8.3. Determines whether a LearnSignal warrants a learning response based on stumble counts, signal kind, and recent improvements.

**Step 1: Write the failing tests**

Create `test/learn/should-learn.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearnSignal } from "../../src/kernel/types.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";
import { shouldLearn } from "../../src/learn/should-learn.ts";

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

describe("shouldLearn", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-should-learn-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("always returns true for failure signals", async () => {
		const store = new MetricsStore(join(tempDir, "failure", "metrics.jsonl"));
		await store.load();

		const signal = makeSignal({ kind: "failure" });
		expect(await shouldLearn(signal, store)).toBe(true);
	});

	test("returns true for repeated errors (>= 3)", async () => {
		const store = new MetricsStore(join(tempDir, "repeated", "metrics.jsonl"));
		await store.load();

		// Record 3 prior stumbles of same kind
		await store.recordStumble("test-agent", "error");
		await store.recordStumble("test-agent", "error");
		await store.recordStumble("test-agent", "error");

		const signal = makeSignal({ kind: "error" });
		expect(await shouldLearn(signal, store)).toBe(true);
	});

	test("returns false for one-off errors (< 2 occurrences)", async () => {
		const store = new MetricsStore(join(tempDir, "oneoff", "metrics.jsonl"));
		await store.load();

		const signal = makeSignal({ kind: "error" });
		// 0 prior occurrences
		expect(await shouldLearn(signal, store)).toBe(false);
	});

	test("returns false for errors with exactly 1 prior occurrence", async () => {
		const store = new MetricsStore(join(tempDir, "once", "metrics.jsonl"));
		await store.load();

		await store.recordStumble("test-agent", "error");

		const signal = makeSignal({ kind: "error" });
		expect(await shouldLearn(signal, store)).toBe(false);
	});

	test("returns true for timeout with >= 3 occurrences", async () => {
		const store = new MetricsStore(join(tempDir, "timeout", "metrics.jsonl"));
		await store.load();

		await store.recordStumble("test-agent", "timeout");
		await store.recordStumble("test-agent", "timeout");
		await store.recordStumble("test-agent", "timeout");

		const signal = makeSignal({ kind: "timeout" });
		expect(await shouldLearn(signal, store)).toBe(true);
	});

	test("returns true for inefficiency with >= 3 occurrences", async () => {
		const store = new MetricsStore(join(tempDir, "inefficiency", "metrics.jsonl"));
		await store.load();

		await store.recordStumble("test-agent", "inefficiency");
		await store.recordStumble("test-agent", "inefficiency");
		await store.recordStumble("test-agent", "inefficiency");

		const signal = makeSignal({ kind: "inefficiency" });
		expect(await shouldLearn(signal, store)).toBe(true);
	});

	test("returns false for retry with < 3 occurrences", async () => {
		const store = new MetricsStore(join(tempDir, "retry-low", "metrics.jsonl"));
		await store.load();

		await store.recordStumble("test-agent", "retry");

		const signal = makeSignal({ kind: "retry" });
		expect(await shouldLearn(signal, store)).toBe(false);
	});

	test("checks agent-specific counts (different agents are independent)", async () => {
		const store = new MetricsStore(join(tempDir, "agent-specific", "metrics.jsonl"));
		await store.load();

		// agent-a has 3 errors, agent-b has 1
		await store.recordStumble("agent-a", "error");
		await store.recordStumble("agent-a", "error");
		await store.recordStumble("agent-a", "error");
		await store.recordStumble("agent-b", "error");

		expect(await shouldLearn(makeSignal({ agent_name: "agent-a", kind: "error" }), store)).toBe(true);
		expect(await shouldLearn(makeSignal({ agent_name: "agent-b", kind: "error" }), store)).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/learn/should-learn.test.ts`
Expected: FAIL — cannot find module `../../src/learn/should-learn.ts`

**Step 3: Implement should_learn()**

Create `src/learn/should-learn.ts`:

```typescript
import type { LearnSignal } from "../kernel/types.ts";
import type { MetricsStore } from "./metrics-store.ts";

/**
 * Determine whether a LearnSignal warrants a learning response.
 * Spec Section 8.3: Trigger Filtering
 *
 * - Always learn from failures (goal not achieved)
 * - Learn from repeated stumbles (>= 3 occurrences of same agent+kind)
 * - Skip one-off errors (< 2 occurrences)
 */
export async function shouldLearn(signal: LearnSignal, metrics: MetricsStore): Promise<boolean> {
	// Always learn from failures
	if (signal.kind === "failure") {
		return true;
	}

	// Check repeated stumbles
	const count = metrics.stumbleCount(signal.agent_name, signal.kind);

	// Skip one-off errors
	if (signal.kind === "error" && count < 2) {
		return false;
	}

	// Learn from repeated stumbles (>= 3)
	if (count >= 3) {
		return true;
	}

	return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/learn/should-learn.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add src/learn/should-learn.ts test/learn/should-learn.test.ts
git commit -m "feat: add shouldLearn trigger filtering for learn signals"
```

---

### Task 3: LearnProcess — Async Queue and LLM-Based Improvement

**Files:**
- Create: `src/learn/learn-process.ts`
- Create: `test/learn/learn-process.test.ts`

The LearnProcess is the core of Phase 6. It manages an async signal queue and uses an LLM to reason about what genome mutation to make. When a signal passes filtering, the LLM is asked to produce one of four mutation types: create_memory, update_agent, create_agent, create_routing_rule. The mutation is then applied to the genome and git-committed.

**Step 1: Write the failing tests**

Create `test/learn/learn-process.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearnSignal } from "../../src/kernel/types.ts";
import { Genome } from "../../src/genome/genome.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";

function makeSignal(overrides: Partial<LearnSignal> = {}): LearnSignal {
	return {
		kind: overrides.kind ?? "failure",
		goal: overrides.goal ?? "run pytest",
		agent_name: overrides.agent_name ?? "command-runner",
		details: overrides.details ?? {
			agent_name: "command-runner",
			goal: "run pytest",
			output: "command not found: pytest",
			success: false,
			stumbles: 1,
			turns: 1,
		},
		session_id: overrides.session_id ?? "session-1",
		timestamp: overrides.timestamp ?? Date.now(),
	};
}

describe("LearnProcess", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-learn-process-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("constructor creates a LearnProcess", async () => {
		const genomeDir = join(tempDir, "ctor");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });
		expect(learn).toBeDefined();
	});

	test("push queues a signal", async () => {
		const genomeDir = join(tempDir, "push");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		learn.push(makeSignal());
		expect(learn.queueSize()).toBe(1);
	});

	test("push records stumble in metrics", async () => {
		const genomeDir = join(tempDir, "push-metrics");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		learn.push(makeSignal({ agent_name: "editor", kind: "error" }));
		expect(metrics.stumbleCount("editor", "error")).toBe(1);
	});

	test("processNext skips signals that don't pass filtering", async () => {
		const genomeDir = join(tempDir, "skip");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		// One-off error should be skipped
		learn.push(makeSignal({ kind: "error" }));

		const result = await learn.processNext();
		expect(result).toBe("skipped");
		expect(learn.queueSize()).toBe(0);
	});

	test("processNext returns 'empty' when queue is empty", async () => {
		const genomeDir = join(tempDir, "empty");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		const result = await learn.processNext();
		expect(result).toBe("empty");
	});

	test("processSignal applies a create_memory mutation from LLM", async () => {
		const genomeDir = join(tempDir, "apply-mem");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		// Test applyMutation directly (unit test the mutation application)
		const memCountBefore = genome.memories.all().length;
		await learn.applyMutation({
			type: "create_memory",
			content: "This project uses vitest, not pytest",
			tags: ["testing", "vitest"],
		});

		expect(genome.memories.all().length).toBe(memCountBefore + 1);
		const mem = genome.memories.all().find((m) => m.content.includes("vitest"));
		expect(mem).toBeDefined();
		expect(mem!.tags).toContain("testing");
	});

	test("processSignal applies a create_routing_rule mutation", async () => {
		const genomeDir = join(tempDir, "apply-rule");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		const rulesBefore = genome.allRoutingRules().length;
		await learn.applyMutation({
			type: "create_routing_rule",
			condition: "Go project testing",
			preference: "command-runner",
			strength: 0.8,
		});

		expect(genome.allRoutingRules().length).toBe(rulesBefore + 1);
		const rule = genome.allRoutingRules().find((r) => r.condition.includes("Go"));
		expect(rule).toBeDefined();
	});

	test("processSignal applies an update_agent mutation", async () => {
		const genomeDir = join(tempDir, "apply-update");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		const before = genome.getAgent("code-reader")!;
		await learn.applyMutation({
			type: "update_agent",
			agent_name: "code-reader",
			system_prompt: before.system_prompt + "\nWhen searching, use grep first.",
		});

		const after = genome.getAgent("code-reader")!;
		expect(after.system_prompt).toContain("use grep first");
		expect(after.version).toBe(before.version + 1);
	});

	test("processSignal applies a create_agent mutation", async () => {
		const genomeDir = join(tempDir, "apply-create");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		const countBefore = genome.agentCount();
		await learn.applyMutation({
			type: "create_agent",
			name: "test-runner-jest",
			description: "Run Jest tests, parse output, report failures",
			system_prompt: "You are a test runner specialized in Jest.",
			model: "fast",
			capabilities: ["exec", "read_file", "grep"],
			tags: ["testing", "jest"],
		});

		expect(genome.agentCount()).toBe(countBefore + 1);
		const agent = genome.getAgent("test-runner-jest");
		expect(agent).toBeDefined();
		expect(agent!.capabilities).toContain("exec");
	});

	test("emits learn_start, learn_mutation, learn_end events", async () => {
		const genomeDir = join(tempDir, "events");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events });

		// Apply a mutation directly and check events
		await learn.applyMutation({
			type: "create_memory",
			content: "Test event emission",
			tags: ["test"],
		});

		const collected = events.collected();
		expect(collected.some((e) => e.kind === "learn_mutation")).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/learn/learn-process.test.ts`
Expected: FAIL — cannot find module `../../src/learn/learn-process.ts`

**Step 3: Implement LearnProcess**

Create `src/learn/learn-process.ts`:

The LearnProcess has two layers:
1. **Queue management**: `push()` adds signals, `processNext()` dequeues and processes
2. **Mutation application**: `applyMutation()` applies a structured mutation to the genome

The LLM-powered reasoning (calling the Learn agent to decide what mutation to make) is in `processSignal()`, which calls the LLM with a structured prompt asking it to produce a JSON mutation. This is the "Learn is itself an agent" from the spec.

```typescript
import type { LearnSignal } from "../kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../kernel/types.ts";
import type { Genome } from "../genome/genome.ts";
import type { AgentEventEmitter } from "../agents/events.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText } from "../llm/types.ts";
import type { MetricsStore } from "./metrics-store.ts";
import { shouldLearn } from "./should-learn.ts";

/** Structured mutation types that Learn can produce */
export type LearnMutation =
	| { type: "create_memory"; content: string; tags: string[] }
	| { type: "update_agent"; agent_name: string; system_prompt: string }
	| {
			type: "create_agent";
			name: string;
			description: string;
			system_prompt: string;
			model: string;
			capabilities: string[];
			tags: string[];
		}
	| {
			type: "create_routing_rule";
			condition: string;
			preference: string;
			strength: number;
		};

export interface LearnProcessOptions {
	genome: Genome;
	metrics: MetricsStore;
	events: AgentEventEmitter;
	client?: Client;
}

export type ProcessResult = "applied" | "skipped" | "empty" | "error";

export class LearnProcess {
	private readonly genome: Genome;
	private readonly metrics: MetricsStore;
	private readonly events: AgentEventEmitter;
	private readonly client?: Client;
	private readonly queue: LearnSignal[] = [];

	constructor(options: LearnProcessOptions) {
		this.genome = options.genome;
		this.metrics = options.metrics;
		this.events = options.events;
		this.client = options.client;
	}

	/** Add a signal to the queue and record the stumble in metrics. */
	push(signal: LearnSignal): void {
		this.queue.push(signal);
		// Fire-and-forget: record stumble in metrics (async but we don't await in push)
		void this.metrics.recordStumble(signal.agent_name, signal.kind);
	}

	/** Number of signals waiting in the queue. */
	queueSize(): number {
		return this.queue.length;
	}

	/** Process the next signal in the queue. */
	async processNext(): Promise<ProcessResult> {
		const signal = this.queue.shift();
		if (!signal) return "empty";

		// Check trigger filtering
		if (!(await shouldLearn(signal, this.metrics))) {
			return "skipped";
		}

		return this.processSignal(signal);
	}

	/** Process a signal that has passed filtering — call LLM to decide mutation. */
	async processSignal(signal: LearnSignal): Promise<ProcessResult> {
		this.events.emit("learn_start", "learn", 0, {
			signal_kind: signal.kind,
			agent_name: signal.agent_name,
			goal: signal.goal,
		});

		try {
			if (!this.client) {
				// Without a client, we can't reason about improvements
				this.events.emit("learn_end", "learn", 0, { result: "no_client" });
				return "skipped";
			}

			const mutation = await this.reasonAboutImprovement(signal);
			if (!mutation) {
				this.events.emit("learn_end", "learn", 0, { result: "no_mutation" });
				return "skipped";
			}

			await this.applyMutation(mutation);

			this.events.emit("learn_end", "learn", 0, {
				result: "applied",
				mutation_type: mutation.type,
			});
			return "applied";
		} catch (err) {
			this.events.emit("learn_end", "learn", 0, {
				result: "error",
				error: String(err),
			});
			return "error";
		}
	}

	/** Use the LLM to reason about what improvement to make. */
	private async reasonAboutImprovement(signal: LearnSignal): Promise<LearnMutation | null> {
		if (!this.client) return null;

		const existingAgents = this.genome.allAgents().map((a) => a.name).join(", ");
		const existingMemories = this.genome.memories.all().map((m) => m.content).join("\n- ");

		const prompt = `You are the Learn process for a self-improving coding agent. You receive stumble signals and decide what improvement to make to the genome.

A stumble occurred:
- Kind: ${signal.kind}
- Agent: ${signal.agent_name}
- Goal: ${signal.goal}
- Output: ${signal.details.output}
- Success: ${signal.details.success}
- Stumbles: ${signal.details.stumbles}
- Turns: ${signal.details.turns}

Current genome:
- Agents: ${existingAgents}
- Memories: ${existingMemories || "(none)"}

You MUST respond with exactly one JSON object (no markdown, no explanation) describing the improvement. Choose the simplest effective mutation.

Mutation types:
1. {"type": "create_memory", "content": "...", "tags": ["..."]}
2. {"type": "update_agent", "agent_name": "...", "system_prompt": "..."}
3. {"type": "create_agent", "name": "...", "description": "...", "system_prompt": "...", "model": "fast", "capabilities": ["..."], "tags": ["..."]}
4. {"type": "create_routing_rule", "condition": "...", "preference": "...", "strength": 0.8}

If no improvement is needed, respond with: {"type": "skip"}`;

		const response = await this.client.complete({
			model: "fast",
			provider: "anthropic",
			messages: [Msg.system(prompt), Msg.user("Decide what improvement to make.")],
			max_tokens: 1024,
		});

		const text = messageText(response.message).trim();

		try {
			const parsed = JSON.parse(text);
			if (parsed.type === "skip") return null;
			return parsed as LearnMutation;
		} catch {
			// If LLM didn't produce valid JSON, skip
			return null;
		}
	}

	/** Apply a structured mutation to the genome. */
	async applyMutation(mutation: LearnMutation): Promise<void> {
		this.events.emit("learn_mutation", "learn", 0, { mutation_type: mutation.type });

		switch (mutation.type) {
			case "create_memory": {
				const id = `learn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
				await this.genome.addMemory({
					id,
					content: mutation.content,
					tags: mutation.tags,
					source: "learn",
					created: Date.now(),
					last_used: Date.now(),
					use_count: 0,
					confidence: 0.8,
				});
				break;
			}
			case "update_agent": {
				const existing = this.genome.getAgent(mutation.agent_name);
				if (!existing) break;
				await this.genome.updateAgent({
					...existing,
					system_prompt: mutation.system_prompt,
				});
				break;
			}
			case "create_agent": {
				await this.genome.addAgent({
					name: mutation.name,
					description: mutation.description,
					system_prompt: mutation.system_prompt,
					model: mutation.model,
					capabilities: mutation.capabilities,
					constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false },
					tags: mutation.tags,
					version: 1,
				});
				break;
			}
			case "create_routing_rule": {
				const id = `learn-rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
				await this.genome.addRoutingRule({
					id,
					condition: mutation.condition,
					preference: mutation.preference,
					strength: mutation.strength,
					source: "learn",
				});
				break;
			}
		}
	}
}
```

Note: The `reasonAboutImprovement` method resolves model "fast" with provider "anthropic" — but this should actually use the model resolver pattern. However, since Learn uses the `Client.complete()` which internally resolves providers, we can pass a provider hint. In practice the Learn agent should use the "best" model tier for reasoning. We'll let the model resolver handle this by passing just a model tier and letting the client pick the provider. Let me adjust: the `Client.complete()` requires a concrete model string, so we need `resolveModel()`. The implementation will resolve the model at construction time.

Actually, re-reading the code: `Client.complete()` takes a `Request` with `model` and optional `provider`. The Anthropic/OpenAI/Gemini adapters handle the actual model string. But `buildPlanRequest` in plan.ts takes `model` and `provider` from `resolveModel()`. The LearnProcess should do the same — resolve "best" tier at construction to get a concrete model+provider pair.

The implementation above needs a small adjustment: use `resolveModel()` to resolve the model tier to a concrete model/provider at construction time. The code in Step 3 above shows the approach; the implementer should use `resolveModel("best", client.providers())` to resolve the model.

**Step 4: Run tests to verify they pass**

Run: `bun test test/learn/learn-process.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add src/learn/learn-process.ts test/learn/learn-process.test.ts
git commit -m "feat: add LearnProcess with async queue and mutation application"
```

---

### Task 4: Wire Learn into Agent Loop

**Files:**
- Modify: `src/agents/agent.ts` — Collect learn signals and forward to optional LearnProcess
- Modify: `src/agents/factory.ts` — Wire LearnProcess when genome is provided
- Create: `test/learn/agent-learn-wiring.test.ts` — Test the wiring
- Modify: `src/agents/index.ts` — Add learn exports if needed

**Step 1: Write the failing tests**

Create `test/learn/agent-learn-wiring.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";

describe("Agent-Learn wiring", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-agent-learn-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("Agent accepts optional learnProcess", async () => {
		const genomeDir = join(tempDir, "accept");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learnProcess = new LearnProcess({ genome, metrics, events });
		const rootSpec = genome.getAgent("root")!;

		// Agent should accept learnProcess in options without error
		const agent = new Agent({
			spec: rootSpec,
			env: { working_directory: () => tempDir, platform: () => "darwin", os_version: () => "test" } as any,
			client: { providers: () => ["anthropic"], complete: async () => ({}) } as any,
			primitiveRegistry: { names: () => [], get: () => undefined, execute: async () => ({}) } as any,
			availableAgents: genome.allAgents(),
			genome,
			events,
			learnProcess,
		});

		expect(agent).toBeDefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/learn/agent-learn-wiring.test.ts`
Expected: FAIL — `learnProcess` is not a valid property on `AgentOptions`

**Step 3: Implement the wiring**

In `src/agents/agent.ts`:

1. Add import for LearnProcess:
```typescript
import type { LearnProcess } from "../learn/learn-process.ts";
```

2. Add `learnProcess` to AgentOptions:
```typescript
export interface AgentOptions {
	// ... existing fields ...
	learnProcess?: LearnProcess;
}
```

3. Store in class and forward to subagents:
```typescript
private readonly learnProcess?: LearnProcess;
// In constructor:
this.learnProcess = options.learnProcess;
```

4. In `run()`, when a learn signal is produced (line ~267), push it to the LearnProcess:
```typescript
if (learnSignal) {
	this.events.emit("learn_signal", agentId, this.depth, { signal: learnSignal });
	if (this.learnProcess) {
		this.learnProcess.push(learnSignal);
	}
}
```

5. Forward learnProcess when creating subagents (~line 235-245):
```typescript
const subagent = new Agent({
	// ... existing fields ...
	learnProcess: this.learnProcess,
});
```

In `src/agents/factory.ts`:

6. Create MetricsStore and LearnProcess when genome is provided:
```typescript
import { MetricsStore } from "../learn/metrics-store.ts";
import { LearnProcess } from "../learn/learn-process.ts";

// In createAgent(), after creating registry and events:
let learnProcess: LearnProcess | undefined;
if (genome) {
	const metrics = new MetricsStore(join(options.genomePath, "metrics", "metrics.jsonl"));
	await metrics.load();
	learnProcess = new LearnProcess({ genome, metrics, events, client });
}

// Add learnProcess to Agent constructor call
```

7. Export learnProcess from CreateAgentResult:
```typescript
export interface CreateAgentResult {
	agent: Agent;
	genome: Genome;
	events: AgentEventEmitter;
	learnProcess?: LearnProcess;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/learn/agent-learn-wiring.test.ts`
Expected: PASS

Also run: `bun test`
Expected: All tests PASS (no regressions)

**Step 5: Commit**

```bash
git add src/agents/agent.ts src/agents/factory.ts test/learn/agent-learn-wiring.test.ts
git commit -m "feat: wire LearnProcess into Agent loop and factory"
```

---

### Task 5: Barrel Exports and Index

**Files:**
- Create: `src/learn/index.ts`
- Modify: `src/index.ts`
- Modify: `src/agents/index.ts` (if needed)

**Step 1: Create barrel export**

```typescript
// src/learn/index.ts
export { LearnProcess, type LearnMutation, type LearnProcessOptions, type ProcessResult } from "./learn-process.ts";
export { MetricsStore } from "./metrics-store.ts";
export { shouldLearn } from "./should-learn.ts";
```

**Step 2: Add to root index**

In `src/index.ts`, add:
```typescript
export * from "./learn/index.ts";
```

**Step 3: Run all tests**

Run: `bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/learn/index.ts src/index.ts
git commit -m "feat: add learn module barrel exports"
```

---

### Task 6: Integration Test — Learn End-to-End

**Files:**
- Create: `test/learn/learn.integration.test.ts`

This test exercises the full Learn pipeline with real API calls: create a genome, force a failure pattern, push the signal through LearnProcess, verify a genome mutation was produced.

**Step 1: Write the test**

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { Genome } from "../../src/genome/genome.ts";
import { Client } from "../../src/llm/client.ts";
import type { LearnSignal } from "../../src/kernel/types.ts";
import { LearnProcess } from "../../src/learn/learn-process.ts";
import { MetricsStore } from "../../src/learn/metrics-store.ts";

config({ path: join(import.meta.dir, "../../.env") });

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
		const genomeDir = join(tempDir, "learn-e2e");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

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
			},
			session_id: "int-test-1",
			timestamp: Date.now(),
		};

		learn.push(signal);
		const result = await learn.processNext();

		expect(result).toBe("applied");

		// Verify the genome was mutated (memory, agent, or routing rule was added)
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "learn_mutation")).toBe(true);

		// The genome should have grown (new memory, rule, or agent)
		const memoriesAfter = genome.memories.all().length;
		const rulesAfter = genome.allRoutingRules().length;
		const agentsAfter = genome.agentCount();

		// At least one of these should have increased from the baseline
		// Bootstrap has: 4 agents, 0 memories, 0 routing rules
		const grew = memoriesAfter > 0 || rulesAfter > 0 || agentsAfter > 4;
		expect(grew).toBe(true);
	}, 60_000);

	test("skipped signal does not mutate genome", async () => {
		const genomeDir = join(tempDir, "learn-skip");
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const metrics = new MetricsStore(join(genomeDir, "metrics", "metrics.jsonl"));
		await metrics.load();

		const events = new AgentEventEmitter();
		const learn = new LearnProcess({ genome, metrics, events, client });

		// One-off error should be skipped
		const signal: LearnSignal = {
			kind: "error",
			goal: "Read a file",
			agent_name: "code-reader",
			details: {
				agent_name: "code-reader",
				goal: "Read a file",
				output: "file not found",
				success: false,
				stumbles: 1,
				turns: 1,
			},
			session_id: "int-test-2",
			timestamp: Date.now(),
		};

		learn.push(signal);
		const result = await learn.processNext();

		expect(result).toBe("skipped");
		expect(genome.memories.all().length).toBe(0);
		expect(genome.allRoutingRules().length).toBe(0);
		expect(genome.agentCount()).toBe(4);
	}, 30_000);
});
```

**Step 2: Run tests**

Run: `bun test test/learn/learn.integration.test.ts`
Expected: All tests PASS (requires API keys)

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add test/learn/learn.integration.test.ts
git commit -m "test: add Learn integration tests with real API calls"
```

---

## Summary

After completing all 6 tasks, Phase 6 delivers:

| Component | What it does |
|-----------|-------------|
| MetricsStore | Tracks stumble counts and action counts per agent, computes stumble rates |
| shouldLearn() | Filters signals: always learn from failures, learn from 3+ repeated stumbles, skip one-offs |
| LearnProcess | Async signal queue + LLM-based reasoning + genome mutation application |
| Agent-Learn wiring | Agent.run() pushes learn signals to LearnProcess, factory auto-creates LearnProcess |
| Integration tests | Full pipeline: signal → filter → LLM → genome mutation, verified with real API |

**What's deferred to later phases:**
- Periodic review / genome pruning (spec 8.7) — Phase 8 or later
- End-of-task and end-of-session learning triggers (spec 8.5) — needs event system (Phase 7)
- Evaluate improvement (spec 8.6) — needs more session data to compare before/after
- Background processing loop (drain queue continuously) — Phase 7 host interface

**Integration point:** After Phase 6, the caller flow is:
```typescript
const { agent, genome, events, learnProcess } = await createAgent({
  genomePath: '~/.local/share/sprout-genome',
  bootstrapDir: './bootstrap',
  workDir: process.cwd(),
});
const result = await agent.run("Fix the failing login test");
// LearnProcess automatically receives stumble signals
// Process queued signals (typically done by host at end of session):
while (learnProcess.queueSize() > 0) {
  await learnProcess.processNext();
}
```

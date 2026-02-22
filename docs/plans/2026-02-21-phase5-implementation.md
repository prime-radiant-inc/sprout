# Phase 5: Bootstrap Integration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the Genome and Recall systems into the Agent loop so bootstrap agents work end-to-end: fresh genome → initFromBootstrap → recall → agent runs with memories/routing in system prompt. Verify with integration tests.

**Architecture:** The Agent class gains an optional `genome` parameter. When present, the agent calls `recall(genome, goal)` before Plan, passing memories and routing hints to `buildSystemPrompt`. A `createAgent()` factory function handles genome initialization, bootstrap loading, and wiring. Integration tests verify the full pipeline with real API calls.

**Tech Stack:** TypeScript/Bun, existing `Genome`, `recall()`, `buildSystemPrompt()`, `Agent` class, `bun test`

---

## Context

**What already exists:**
- `bootstrap/` — 4 YAML specs (root, code-reader, code-editor, command-runner)
- `src/genome/genome.ts` — Genome class with full CRUD + git versioning
- `src/genome/recall.ts` — `recall()`, `renderMemories()`, `renderRoutingHints()`
- `src/agents/agent.ts` — Agent class with core loop (Perceive → Plan → Act → Verify)
- `src/agents/plan.ts` — `buildSystemPrompt()` already accepts optional `recallContext`
- `test/agents/agent.integration.test.ts` — existing integration tests (leaf + root delegation)

**What's missing (the gap this phase closes):**
- Agent.run() does NOT call recall() — it builds systemPrompt without memories/routing (line 127-132 of agent.ts)
- No `createAgent()` factory — tests manually wire everything together
- No test that exercises genome → recall → agent end-to-end
- No test of a fresh genome bootstrapped and used for a multi-step task

**Key files to modify:**
- `src/agents/agent.ts` — Add optional `genome` to AgentOptions, call recall() in run()
- `src/agents/index.ts` — Export new factory
- `test/agents/agent.integration.test.ts` — Add genome-wired integration tests

**Key files to read:**
- `src/genome/genome.ts` — Genome class API
- `src/genome/recall.ts` — recall() signature
- `src/agents/plan.ts:67-93` — buildSystemPrompt with recallContext parameter

---

### Task 1: Wire Recall into Agent Loop

**Files:**
- Modify: `src/agents/agent.ts` (add genome to AgentOptions, call recall in run())
- Modify: `test/agents/agent.test.ts` (add test for recall wiring)

**Step 1: Write the failing test**

Add a test to `test/agents/agent.test.ts` that verifies recall is called when a genome is provided. This test should create a genome with a memory, run the agent, and verify the memory content appears in the system prompt (via events or by checking the plan request).

Since directly testing that recall was called is hard without mocking (and we don't mock), the cleanest approach is to test it via the integration test in Task 3. For this task, we focus on the structural change — making Agent accept a genome and call recall.

Actually, the best approach for testability: write a unit test that creates a Genome, adds a memory, creates an Agent with that genome, and verifies the agent doesn't crash. The real behavioral test will be in integration (Task 3).

```typescript
// Add to test/agents/agent.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../../src/genome/genome.ts";

describe("Agent with genome", () => {
	test("constructor accepts genome option", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-agent-genome-"));
		try {
			const genome = new Genome(tempDir);
			await genome.init();
			await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

			const codeReader = genome.getAgent("code-reader")!;
			const agent = new Agent({
				spec: codeReader,
				env: mockEnv,
				client: mockClient,
				primitiveRegistry: mockRegistry,
				availableAgents: genome.allAgents(),
				genome,
			});
			expect(agent).toBeDefined();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
```

Note: `mockEnv`, `mockClient`, `mockRegistry` should use whatever test doubles already exist in agent.test.ts. Read the file first to understand the existing test setup.

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/agent.test.ts`
Expected: FAIL — `genome` is not a valid property on `AgentOptions`

**Step 3: Implement the change**

In `src/agents/agent.ts`:

1. Add import for Genome and recall:
```typescript
import type { Genome } from "../genome/genome.ts";
import { recall } from "../genome/recall.ts";
```

2. Add `genome` to AgentOptions:
```typescript
export interface AgentOptions {
	spec: AgentSpec;
	env: ExecutionEnvironment;
	client: Client;
	primitiveRegistry: PrimitiveRegistry;
	availableAgents: AgentSpec[];
	depth?: number;
	events?: AgentEventEmitter;
	sessionId?: string;
	genome?: Genome;  // NEW
}
```

3. Store genome in the class:
```typescript
private readonly genome?: Genome;
// In constructor:
this.genome = options.genome;
```

4. In `run()`, after perceive and before the core loop, call recall if genome is present:
```typescript
// After: this.events.emit("perceive", ...)
// Before: while (turns < ...)

// Recall: search genome for relevant context
let recallContext: { memories?: Memory[]; routingHints?: RoutingRule[] } | undefined;
if (this.genome) {
	const recallResult = await recall(this.genome, goal);
	recallContext = {
		memories: recallResult.memories,
		routingHints: recallResult.routing_hints,
	};
	this.events.emit("recall", agentId, this.depth, {
		agent_count: recallResult.agents.length,
		memory_count: recallResult.memories.length,
		routing_hint_count: recallResult.routing_hints.length,
	});
}

// Build system prompt (with recall context if available)
const systemPrompt = buildSystemPrompt(
	this.spec,
	this.env.working_directory(),
	this.env.platform(),
	this.env.os_version(),
	recallContext,
);
```

5. Add type imports:
```typescript
import type { Memory, RoutingRule } from "../kernel/types.ts";
```

**Step 4: Run test to verify it passes**

Run: `bun test test/agents/agent.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: wire recall into Agent loop when genome is provided"
```

---

### Task 2: Create createAgent() Factory Function

**Files:**
- Create: `src/agents/factory.ts`
- Create: `test/agents/factory.test.ts`
- Modify: `src/agents/index.ts` (add export)

**Step 1: Write the failing tests**

```typescript
// test/agents/factory.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/agents/factory.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { Client } from "../../src/llm/client.ts";
import { Genome } from "../../src/genome/genome.ts";

describe("createAgent", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("creates agent with fresh genome from bootstrap", async () => {
		const genomePath = join(tempDir, "factory-fresh");
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
		});

		expect(result.agent).toBeDefined();
		expect(result.agent.spec.name).toBe("root");
		expect(result.genome).toBeDefined();
		expect(result.genome.agentCount()).toBe(4);
	});

	test("creates agent with existing genome", async () => {
		// First, set up a genome
		const genomePath = join(tempDir, "factory-existing");
		const genome = new Genome(genomePath);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		// Now create agent from existing genome
		const result = await createAgent({
			genomePath,
			workDir: tempDir,
		});

		expect(result.agent).toBeDefined();
		expect(result.genome.agentCount()).toBe(4);
	});

	test("uses specified root agent name", async () => {
		const genomePath = join(tempDir, "factory-root");
		const result = await createAgent({
			genomePath,
			bootstrapDir: join(import.meta.dir, "../../bootstrap"),
			workDir: tempDir,
			rootAgent: "code-editor",
		});

		expect(result.agent.spec.name).toBe("code-editor");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/factory.test.ts`
Expected: FAIL — cannot find module `../../src/agents/factory.ts`

**Step 3: Implement**

```typescript
// src/agents/factory.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Genome } from "../genome/genome.ts";
import { Genome as GenomeClass } from "../genome/genome.ts";
import { LocalExecutionEnvironment } from "../kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../kernel/primitives.ts";
import { Client } from "../llm/client.ts";
import { Agent } from "./agent.ts";
import { AgentEventEmitter } from "./events.ts";

export interface CreateAgentOptions {
	/** Path to the genome directory */
	genomePath: string;
	/** Path to bootstrap agent YAML files. Required for first-time setup. */
	bootstrapDir?: string;
	/** Working directory for the agent */
	workDir?: string;
	/** Name of the root agent to use (default: "root") */
	rootAgent?: string;
	/** Pre-configured LLM client. If not provided, creates from env vars. */
	client?: Client;
	/** Event emitter for observing agent events */
	events?: AgentEventEmitter;
}

export interface CreateAgentResult {
	agent: Agent;
	genome: Genome;
	events: AgentEventEmitter;
}

/**
 * Create an agent wired to a genome with recall.
 * Handles genome initialization, bootstrap loading, and full wiring.
 */
export async function createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
	const genome = new GenomeClass(options.genomePath);

	// Check if genome already exists (has a .git directory)
	const isExisting = existsSync(join(options.genomePath, ".git"));

	if (isExisting) {
		await genome.loadFromDisk();
	} else {
		await genome.init();
		if (options.bootstrapDir) {
			await genome.initFromBootstrap(options.bootstrapDir);
		}
	}

	const rootName = options.rootAgent ?? "root";
	const rootSpec = genome.getAgent(rootName);
	if (!rootSpec) {
		throw new Error(
			`Root agent '${rootName}' not found in genome. Available: ${genome.allAgents().map((a) => a.name).join(", ")}`,
		);
	}

	const workDir = options.workDir ?? process.cwd();
	const env = new LocalExecutionEnvironment(workDir);
	const client = options.client ?? Client.fromEnv();
	const registry = createPrimitiveRegistry(env);
	const events = options.events ?? new AgentEventEmitter();

	const agent = new Agent({
		spec: rootSpec,
		env,
		client,
		primitiveRegistry: registry,
		availableAgents: genome.allAgents(),
		genome,
		events,
	});

	return { agent, genome, events };
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/factory.test.ts`
Expected: All 3 tests PASS

**Step 5: Add export and commit**

Add to `src/agents/index.ts`:
```typescript
export { createAgent, type CreateAgentOptions, type CreateAgentResult } from "./factory.ts";
```

```bash
git add src/agents/factory.ts test/agents/factory.test.ts src/agents/index.ts
git commit -m "feat: add createAgent factory for genome-wired agent setup"
```

---

### Task 3: Integration Test — Fresh Genome End-to-End

**Files:**
- Modify: `test/agents/agent.integration.test.ts` (add genome-wired tests)

**Step 1: Write the failing tests**

Add a new describe block to `test/agents/agent.integration.test.ts`:

```typescript
describe("Agent with Genome Integration", () => {
	let genomeDir: string;

	beforeAll(async () => {
		genomeDir = await mkdtemp(join(tmpdir(), "sprout-genome-int-"));
	});

	afterAll(async () => {
		await rm(genomeDir, { recursive: true, force: true });
	});

	test("fresh genome with bootstrap agents completes a file creation task", async () => {
		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(join(import.meta.dir, "../../bootstrap"));

		const events = new AgentEventEmitter();
		const rootSpec = genome.getAgent("root")!;

		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
		});

		const result = await agent.run(
			`Create a file called test_bootstrap.py in ${tempDir} that contains a function called greet(name) which returns "Hello, {name}!". Use the absolute path.`,
		);

		expect(result.success).toBe(true);

		// Verify the file exists and has the right content
		const content = await readFile(join(tempDir, "test_bootstrap.py"), "utf-8");
		expect(content).toContain("def greet");
		expect(content).toContain("Hello");

		// Verify recall event was emitted (genome was consulted)
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "recall")).toBe(true);

		// Verify delegation happened (root → code-editor)
		expect(collected.some((e) => e.kind === "act_start")).toBe(true);
	}, 120_000);

	test("agent with memory in genome includes it in context", async () => {
		// Add a memory to the existing genome
		await genome.addMemory({
			id: "int-test-mem",
			content: "This project uses Python 3.12 and follows PEP 8 style",
			tags: ["python", "style"],
			source: "test",
			created: Date.now(),
			last_used: Date.now(),
			use_count: 0,
			confidence: 1.0,
		});

		const events = new AgentEventEmitter();
		const rootSpec = genome.getAgent("root")!;

		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: genome.allAgents(),
			genome,
			events,
			depth: 0,
		});

		const result = await agent.run(
			`Create a file called style_test.py in ${tempDir} that has a simple function.`,
		);

		expect(result.success).toBe(true);

		// Verify recall found the memory
		const recallEvent = events.collected().find((e) => e.kind === "recall");
		expect(recallEvent).toBeDefined();
		expect((recallEvent!.data as any).memory_count).toBeGreaterThan(0);
	}, 120_000);
});
```

Add imports at the top:
```typescript
import { Genome } from "../../src/genome/genome.ts";
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/agents/agent.integration.test.ts`
Expected: FAIL — the new tests should fail because recall event is not emitted (if Task 1 is not yet done) or should pass if Task 1 is done. If they pass, verify the assertions are correct.

**Step 3: Fix any issues**

The genome variable in the second test needs to be shared with the first test. Make `genome` a `let` at the describe scope level (alongside `genomeDir`), and initialize it in the first test or in a beforeAll.

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/agent.integration.test.ts`
Expected: All tests PASS (including the 2 existing ones + 2 new ones)

**Step 5: Commit**

```bash
git add test/agents/agent.integration.test.ts
git commit -m "test: add genome-wired integration tests for bootstrap agents"
```

---

## Summary

After completing all 3 tasks, Phase 5 delivers:

| Component | What it does |
|-----------|-------------|
| Agent + Recall wiring | Agent.run() calls recall(genome, goal) when genome is provided, injects memories/routing into system prompt |
| `createAgent()` factory | One-call setup: genome init/load → bootstrap → agent wiring |
| Integration tests | Fresh genome → bootstrap → multi-step task; memory injection verified |

**Integration point:** After Phase 5, the caller flow is:
```typescript
const { agent, genome, events } = await createAgent({
  genomePath: '~/.local/share/sprout-genome',
  bootstrapDir: './bootstrap',
  workDir: process.cwd(),
});
const result = await agent.run("Fix the failing login test");
```

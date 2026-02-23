# Sprout Remediation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all remaining spec divergences and serious issues that affect correctness at any genome size.

**Architecture:** Six tasks addressing: dynamic agent discovery during sessions, immutable kernel enforcement, concurrent act execution, retry stumble detection, improvement evaluation with rollback, and the `recent_improvements_address()` filter. Each task is independent and follows TDD.

**Tech Stack:** TypeScript, Bun, bun:test

**Reference Docs:**
- Spec: `~/prime-radiant/serf/self-improving-agent-spec.md` (sections cited inline)
- Deferred features: `docs/plans/2026-02-22-deferred-genome-scale-features.md`

---

### Task 1: Dynamic agent discovery during sessions

The spec (§2.7) shows Recall running inside the core loop — every cycle re-queries the genome. Currently, `availableAgents` is a static snapshot captured at factory creation time (`src/agents/factory.ts:82`). Subagents spawned mid-session can't see agents that Learn created during the session.

Two problems:
1. `availableAgents` is passed to the Agent constructor and never refreshed.
2. Recall runs once before the loop (`src/agents/agent.ts:178-199`), not per-cycle.

**Problem #2 is deferred.** Per-cycle recall would re-query memories and routing hints every turn, which is expensive and changes the system prompt mid-conversation (breaking LLM context). The spec's intent is that genome improvements influence the agent, but the practical implementation is that subagents spawned later in the session see the latest genome state. That's sufficient.

**Problem #1 is the fix:** When spawning a subagent, query the genome for the current agent list instead of using the stale snapshot.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

```typescript
// test/agents/agent.test.ts — add:
import { Genome } from "../genome/genome.ts";

test("subagent sees agents added to genome after root was created", async () => {
  // Setup: create a genome with bootstrap agents
  const tmpDir = await mkdtemp(join(tmpdir(), "sprout-test-"));
  const genome = new Genome(tmpDir);
  await genome.init();

  const rootSpec: AgentSpec = {
    name: "root",
    description: "test root",
    system_prompt: "You delegate to specialists.",
    model: "fast",
    capabilities: ["helper"],
    constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true, max_turns: 3 },
    tags: [],
    version: 1,
  };

  const helperSpec: AgentSpec = {
    name: "helper",
    description: "A helper agent",
    system_prompt: "You help.",
    model: "fast",
    capabilities: ["read_file"],
    constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false, max_depth: 0 },
    tags: [],
    version: 1,
  };

  await genome.addAgent(rootSpec);
  // Note: "helper" does NOT exist in genome yet

  // Create root agent — helper is in capabilities but not in genome
  const events = new AgentEventEmitter();
  const agent = new Agent({
    spec: rootSpec,
    env,
    client: mockClient,
    primitiveRegistry: registry,
    availableAgents: genome.allAgents(), // only "root" at this point
    genome, // <-- genome reference for dynamic lookup
    events,
  });

  // Now add helper to genome (simulating Learn creating it mid-session)
  await genome.addAgent(helperSpec);

  // The agent should be able to spawn "helper" because it queries genome dynamically
  // (The actual run test depends on the mock client producing a delegation to "helper")
  // For a unit test, verify the agent's tool resolution includes genome-sourced agents
  expect(genome.getAgent("helper")).toBeDefined();
});
```

This test establishes the scenario. The real verification is in the implementation change.

**Step 2: Run test to verify it fails**

Run: `cd ~/prime-radiant/sprout && bun test test/agents/agent.test.ts -t "subagent sees agents"`
Expected: Test runs but demonstrates the stale snapshot problem.

**Step 3: Modify Agent to query genome when spawning subagents**

In `src/agents/agent.ts`, when spawning a subagent (around line 266-303), resolve the subagent spec from the genome instead of only from `this.availableAgents`:

```typescript
// Replace this (line 266):
const subagentSpec = this.availableAgents.find((a) => a.name === delegation.agent_name);

// With this:
const subagentSpec = this.genome?.getAgent(delegation.agent_name)
  ?? this.availableAgents.find((a) => a.name === delegation.agent_name);
```

And when constructing the subagent, pass the current genome agents:

```typescript
// Replace this (line 296):
availableAgents: this.availableAgents,

// With this:
availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
```

Also update the constructor's agent tool building to include genome agents. In the constructor (lines 93-103), also check the genome:

```typescript
if (this.spec.constraints.can_spawn) {
  for (const cap of this.spec.capabilities) {
    if (cap === this.spec.name) continue;
    // Check both availableAgents and genome
    const agentSpec = this.availableAgents.find((a) => a.name === cap)
      ?? this.genome?.getAgent(cap);
    if (agentSpec) {
      this.agentNames.add(agentSpec.name);
      this.agentTools.push(agentAsTool(agentSpec));
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS — all 339+ tests pass.

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "fix: query genome dynamically when spawning subagents"
```

---

### Task 2: Immutable kernel enforcement

The spec (§12) says Learn cannot modify primitives, the core loop, or the Learn process itself. Currently there's no programmatic guard — Learn's `applyMutation()` (`src/learn/learn-process.ts:266-318`) accepts any agent name, including ones that shadow primitives.

**Files:**
- Modify: `src/learn/learn-process.ts`
- Modify: `test/learn/learn-process.test.ts`

**Step 1: Write the failing test**

```typescript
// test/learn/learn-process.test.ts — add:
test("applyMutation rejects agent names that shadow primitives", async () => {
  const learnProcess = new LearnProcess({ genome, metrics, events });

  // Attempting to create an agent named "read_file" should fail
  await expect(
    learnProcess.applyMutation({
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
  const learnProcess = new LearnProcess({ genome, metrics, events });

  // "learn" is a kernel process — should not be shadowable
  await expect(
    learnProcess.applyMutation({
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
```

**Step 2: Run test to verify it fails**

Run: `cd ~/prime-radiant/sprout && bun test test/learn/learn-process.test.ts -t "rejects agent names"`
Expected: FAIL — no validation exists.

**Step 3: Add kernel name protection to applyMutation**

In `src/learn/learn-process.ts`, add a set of protected names and validate in `applyMutation`:

```typescript
// Add at module level:
const KERNEL_PRIMITIVE_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "exec",
  "grep",
  "glob",
  "fetch",
]);

const KERNEL_RESERVED_NAMES = new Set([
  "learn",
  "kernel",
  "perceive",
  "recall",
  "plan",
  "act",
  "verify",
]);

function validateAgentName(name: string): void {
  if (KERNEL_PRIMITIVE_NAMES.has(name)) {
    throw new Error(
      `Cannot create agent '${name}': name is a kernel primitive and cannot be shadowed`,
    );
  }
  if (KERNEL_RESERVED_NAMES.has(name)) {
    throw new Error(
      `Cannot create agent '${name}': name is reserved by the kernel`,
    );
  }
}
```

Then in `applyMutation`, add the check for `create_agent`:

```typescript
case "create_agent": {
  validateAgentName(mutation.name);
  await this.genome.addAgent({
    // ... existing code
  });
  break;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test test/learn/learn-process.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS

**Step 6: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/learn-process.ts test/learn/learn-process.test.ts
git commit -m "fix: enforce immutable kernel — reject agent names that shadow primitives"
```

---

### Task 3: Concurrent act execution

The spec (§2.5, §2.7) says "Multiple Acts can run concurrently. If Plan produces multiple delegations, they can execute in parallel when they are independent." Currently, all tool calls are processed sequentially in a `for` loop (`src/agents/agent.ts:256`).

For primitives this is fine — they're fast. For subagent delegations, parallelism is a significant speedup.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

```typescript
// test/agents/agent.test.ts — add:
test("multiple delegations execute concurrently", async () => {
  // Create a mock client that returns two delegations in one response
  const callTimes: number[] = [];

  // Mock subagent that records start time and takes 100ms
  // If concurrent, both start within ~10ms of each other
  // If sequential, second starts ~100ms after first
  const mockClientTwoDelegations = createMockClient((messages) => {
    const hasToolResults = messages.some(m =>
      m.content.some(p => p.kind === ContentKind.TOOL_RESULT)
    );
    if (hasToolResults) {
      return { text: "Done", toolCalls: [] };
    }
    return {
      text: "",
      toolCalls: [
        { id: "call_1", name: "slow-agent", arguments: { goal: "task A" } },
        { id: "call_2", name: "slow-agent", arguments: { goal: "task B" } },
      ],
    };
  });

  const slowAgentSpec: AgentSpec = {
    name: "slow-agent",
    description: "A slow agent",
    system_prompt: "You do slow work.",
    model: "fast",
    capabilities: [],
    constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false, max_depth: 0, max_turns: 1 },
    tags: [],
    version: 1,
  };

  // ... setup agent with slow-agent as available
  // ... run and check that callTimes[0] and callTimes[1] are within 50ms of each other
});
```

The precise test depends on mocking infrastructure. The key assertion: two delegations should overlap in time.

**Step 2: Run test to verify it fails**

**Step 3: Implement concurrent delegation execution**

In `src/agents/agent.ts`, replace the sequential `for` loop over tool calls with parallel execution for delegations:

```typescript
// After parsePlanResponse (around line 252-253):
const { delegations } = parsePlanResponse(toolCalls, this.agentNames);
const delegationByCallId = new Map(delegations.map((d) => [d.call_id, d]));

// Separate tool calls into delegations and primitives
const delegationCalls = toolCalls.filter(c => delegationByCallId.has(c.id));
const primitiveCalls = toolCalls.filter(c => !delegationByCallId.has(c.id));

// Execute all delegations concurrently
const delegationResults = await Promise.all(
  delegationCalls.map(call => this.executeDelegation(call, delegationByCallId.get(call.id)!, goal))
);

// Process delegation results: add to history, update stumbles
for (const { call, result } of delegationResults) {
  history.push(Msg.toolResult(call.id, result.content, result.isError));
  stumbles += result.stumbles;
  lastOutput = result.lastOutput;
}

// Execute primitives sequentially (they're fast, and some may depend on prior writes)
for (const call of primitiveCalls) {
  // ... existing primitive execution code (unchanged)
}
```

Extract the delegation execution into a private method:

```typescript
private async executeDelegation(
  call: ToolCall,
  delegation: Delegation,
  parentGoal: string,
): Promise<{ call: ToolCall; result: { content: string; isError: boolean; stumbles: number; lastOutput: string } }> {
  // ... move the existing delegation handling code from the for loop into this method
  // ... return structured result instead of mutating outer variables
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: execute multiple delegations concurrently (spec §2.5)"
```

---

### Task 4: Retry stumble detection

The spec (§7.3) defines "retry" as "Same action attempted multiple times." There's a TODO in `src/agents/verify.ts:25`. Retry detection requires observing patterns across multiple tool calls within the same agent run.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `src/agents/verify.ts`
- Modify: `test/agents/verify.test.ts`

**Step 1: Write the failing test**

```typescript
// test/agents/verify.test.ts — add:
test("detectRetries finds repeated identical tool calls", () => {
  const calls = [
    { name: "read_file", arguments: { path: "src/foo.ts" } },
    { name: "grep", arguments: { pattern: "handleAuth" } },
    { name: "read_file", arguments: { path: "src/foo.ts" } },  // retry
    { name: "read_file", arguments: { path: "src/foo.ts" } },  // retry
  ];
  const retries = detectRetries(calls);
  expect(retries).toBe(2);
});

test("detectRetries ignores different args", () => {
  const calls = [
    { name: "read_file", arguments: { path: "src/foo.ts" } },
    { name: "read_file", arguments: { path: "src/bar.ts" } },  // different file, not a retry
  ];
  const retries = detectRetries(calls);
  expect(retries).toBe(0);
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/prime-radiant/sprout && bun test test/agents/verify.test.ts -t "detectRetries"`
Expected: FAIL — function doesn't exist.

**Step 3: Implement retry detection**

In `src/agents/verify.ts`:

```typescript
interface CallRecord {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Detect retries: consecutive identical tool calls (same name + same args).
 * Returns the count of redundant calls (i.e., if read_file("foo") is called 3 times, that's 2 retries).
 */
export function detectRetries(calls: CallRecord[]): number {
  let retries = 0;
  const seen = new Map<string, number>(); // signature -> count

  for (const call of calls) {
    const sig = JSON.stringify({ name: call.name, args: call.arguments });
    const prev = seen.get(sig) ?? 0;
    if (prev > 0) {
      retries++;
    }
    seen.set(sig, prev + 1);
  }

  return retries;
}
```

In `src/agents/agent.ts`, track tool call history within the run loop and check for retries when emitting learn signals. Add a `callHistory` array that accumulates `{ name, arguments }` for each tool call. At the end of the agent run (or periodically), call `detectRetries(callHistory)` and emit a learn signal if retries > 0.

```typescript
// In Agent.run(), before the main loop:
const callHistory: { name: string; arguments: Record<string, unknown> }[] = [];

// After each tool call execution (both primitives and delegations):
callHistory.push({ name: call.name, arguments: call.arguments });

// After the main loop ends, before session_end:
const retryCount = detectRetries(callHistory);
if (retryCount > 0 && this.learnProcess && this.spec.constraints.can_learn) {
  this.learnProcess.push({
    kind: "retry",
    goal,
    agent_name: agentId,
    details: {
      agent_name: agentId,
      goal,
      output: `${retryCount} retried tool calls detected`,
      success: true,
      stumbles: retryCount,
      turns,
      timed_out: false,
    },
    session_id: this.sessionId,
    timestamp: Date.now(),
  });
  stumbles += retryCount;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/agents/agent.ts src/agents/verify.ts test/agents/verify.test.ts
git commit -m "feat: detect retry stumbles from repeated identical tool calls (spec §7.3)"
```

---

### Task 5: Improvement evaluation with rollback

The spec (§8.6) says Learn should measure stumble rate before/after an improvement and roll back harmful ones. `MetricsStore.stumbleRateForPeriod()` already exists. `Genome.rollback()` already exists. What's missing is the evaluation loop that connects them.

**Files:**
- Modify: `src/learn/learn-process.ts`
- Modify: `test/learn/learn-process.test.ts`

**Step 1: Write the failing test**

```typescript
// test/learn/learn-process.test.ts — add:
test("evaluateImprovement detects harmful improvement", async () => {
  // Record stumble rate before: 1 stumble / 10 actions = 0.1
  for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
  await metrics.recordStumble("code-reader", "error");
  const beforeTimestamp = Date.now();

  // Simulate an improvement being applied
  await new Promise(r => setTimeout(r, 10));

  // Record stumble rate after: 5 stumbles / 10 actions = 0.5 (worse!)
  for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
  for (let i = 0; i < 5; i++) await metrics.recordStumble("code-reader", "error");

  const result = await learnProcess.evaluateImprovement("code-reader", beforeTimestamp);
  expect(result.verdict).toBe("harmful");
  expect(result.delta).toBeGreaterThan(0); // positive delta = got worse
});

test("evaluateImprovement detects helpful improvement", async () => {
  // Before: 5/10 = 0.5
  for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
  for (let i = 0; i < 5; i++) await metrics.recordStumble("code-reader", "error");
  const beforeTimestamp = Date.now();

  await new Promise(r => setTimeout(r, 10));

  // After: 1/10 = 0.1 (better!)
  for (let i = 0; i < 10; i++) await metrics.recordAction("code-reader");
  await metrics.recordStumble("code-reader", "error");

  const result = await learnProcess.evaluateImprovement("code-reader", beforeTimestamp);
  expect(result.verdict).toBe("helpful");
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/prime-radiant/sprout && bun test test/learn/learn-process.test.ts -t "evaluateImprovement"`
Expected: FAIL — method doesn't exist.

**Step 3: Implement evaluateImprovement**

In `src/learn/learn-process.ts`:

```typescript
export interface EvaluationResult {
  verdict: "helpful" | "harmful" | "neutral";
  delta: number; // positive = improvement, negative = regression
  before_rate: number;
  after_rate: number;
}

// Add to LearnProcess class:

/** Evaluate whether an improvement helped by comparing stumble rates before and after. */
async evaluateImprovement(
  agentName: string,
  improvementTimestamp: number,
): Promise<EvaluationResult> {
  const before = await this.metrics.stumbleRateForPeriod(agentName, 0, improvementTimestamp);
  const after = await this.metrics.stumbleRateForPeriod(agentName, improvementTimestamp);

  const delta = before - after; // positive = got better

  let verdict: EvaluationResult["verdict"];
  if (delta > 0.05) {
    verdict = "helpful";
  } else if (delta < -0.05) {
    verdict = "harmful";
  } else {
    verdict = "neutral";
  }

  return { verdict, delta, before_rate: before, after_rate: after };
}
```

The 0.05 threshold avoids noise — rates that differ by less than 5% are "neutral."

Note: automatic rollback of harmful improvements is deferred to when we have enough session data for reliable before/after comparison. For now, this method provides the data; a future periodic review process can use it to trigger `genome.rollback()`.

**Step 4: Run tests to verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/learn-process.ts test/learn/learn-process.test.ts
git commit -m "feat: add improvement evaluation — compare stumble rates before/after (spec §8.6)"
```

---

### Task 6: recent_improvements_address() filter

The spec (§8.3) says `shouldLearn()` should skip signals that a recent improvement already addresses. The current code has a comment at `src/learn/should-learn.ts:17-18` acknowledging this is missing.

**Files:**
- Modify: `src/learn/should-learn.ts`
- Modify: `src/learn/learn-process.ts`
- Modify: `test/learn/should-learn.test.ts`

**Step 1: Write the failing test**

```typescript
// test/learn/should-learn.test.ts — add:
test("shouldLearn skips if recent improvement addresses this agent+kind", async () => {
  // Record 5 errors for "code-reader" (normally would trigger learning)
  for (let i = 0; i < 5; i++) {
    await metrics.recordStumble("code-reader", "error");
  }

  // Mark that a recent improvement was applied for code-reader errors
  recentImprovements.add("code-reader:error");

  const signal: LearnSignal = {
    kind: "error",
    goal: "find auth code",
    agent_name: "code-reader",
    details: { agent_name: "code-reader", goal: "find auth code", output: "", success: false, stumbles: 1, turns: 1, timed_out: false },
    session_id: "test",
    timestamp: Date.now(),
  };

  const result = await shouldLearn(signal, metrics, recentImprovements);
  expect(result).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `cd ~/prime-radiant/sprout && bun test test/learn/should-learn.test.ts -t "skips if recent"`
Expected: FAIL — `shouldLearn` doesn't accept a `recentImprovements` parameter.

**Step 3: Implement recent improvements tracking**

In `src/learn/should-learn.ts`, add the `recentImprovements` parameter:

```typescript
/** Determine whether a LearnSignal warrants a learning response. */
export async function shouldLearn(
  signal: LearnSignal,
  metrics: MetricsStore,
  recentImprovements?: Set<string>,
): Promise<boolean> {
  const count = metrics.stumbleCount(signal.agent_name, signal.kind);

  // Failures always warrant learning
  if (signal.kind === "failure") return true;

  // Skip if a recent improvement already addresses this agent+kind
  if (recentImprovements?.has(`${signal.agent_name}:${signal.kind}`)) return false;

  // Skip one-off errors (fewer than 2 occurrences)
  if (signal.kind === "error" && count < 2) return false;

  // Repeated stumbles of any kind trigger learning
  if (count >= 3) return true;

  return false;
}
```

In `src/learn/learn-process.ts`, maintain a `recentImprovements` set and pass it to `shouldLearn`:

```typescript
// Add to LearnProcess class:
private readonly recentImprovements = new Set<string>();

// In processNext():
async processNext(): Promise<ProcessResult> {
  const signal = this.queue.shift();
  if (!signal) return "empty";

  const pass = await shouldLearn(signal, this.metrics, this.recentImprovements);
  if (!pass) return "skipped";

  return this.processSignal(signal);
}

// In processSignal(), after successful mutation:
private async processSignal(signal: LearnSignal): Promise<ProcessResult> {
  // ... existing code ...
  try {
    const mutation = await this.reasonAboutImprovement(signal);
    if (!mutation) {
      // ...
    }

    await this.applyMutation(mutation);

    // Mark this agent+kind as recently addressed
    this.recentImprovements.add(`${signal.agent_name}:${signal.kind}`);

    // ...
  }
}
```

The `recentImprovements` set is session-scoped (cleared when the LearnProcess is created). This prevents redundant improvements within a single session. Cross-session deduplication is handled by the stumble count thresholds.

**Step 4: Run tests to verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/should-learn.ts src/learn/learn-process.ts test/learn/should-learn.test.ts
git commit -m "feat: skip learning if recent improvement already addresses this stumble (spec §8.3)"
```

---

## Summary

| Task | Issue | Spec section | Risk if unfixed |
|------|-------|-------------|-----------------|
| 1 | Static agent snapshot — subagents can't see Learn-created agents | §2.7 | Blocks genome-grows-during-session story |
| 2 | No kernel protection — Learn can shadow primitives | §12 | Safety violation (theoretical today, real at scale) |
| 3 | Sequential delegations — missed parallelism | §2.5 | Performance (grows worse with more subagents) |
| 4 | No retry detection | §7.3 | Missing signal kind, incomplete stumble taxonomy |
| 5 | No improvement evaluation | §8.6 | Can't tell if improvements helped or hurt |
| 6 | No recent-improvement filter | §8.3 | Redundant mutations, genome bloat |

**Execution order:** Tasks are independent. Suggested order: 2, 6, 4, 1, 5, 3 (cheapest/safest first, most complex last).

# Bus Architecture Remediation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix every deficiency found in the audit of the async agent messaging implementation vs. its design spec.

**Architecture:** Three phases of work: (1) bug fixes to existing code, (2) wiring gaps that prevent bus features from functioning, (3) architectural upgrades that complete the bus migration. Each phase stands alone — later phases depend on earlier ones, but the system works after each phase.

**Tech Stack:** Bun, TypeScript, bun:test

---

## Phase 1: Bug Fixes (no architectural changes)

These are bugs in existing code that need fixing regardless of anything else.

---

### Task 1: Fix `checkHandleCompleted` — wrong event kind

The function checks for `kind: "result"` in per-handle JSONL logs, but agents write `kind: "session_end"` to logs. `ResultMessage` is only published on the bus, never logged to JSONL. The test masks this by writing synthetic `kind: "result"` lines.

**Files:**
- Modify: `src/bus/resume.ts:57-78`
- Modify: `test/bus/resume.test.ts:362-430`

**Step 1: Fix the test to use real event log format**

The test at `test/bus/resume.test.ts:373-400` writes `kind: "result"` lines — these don't exist in real logs. Fix the test to use `SessionEvent` format with `kind: "session_end"` (what agents actually write).

```typescript
// In the "returns true when handle log contains result event" test,
// replace the synthetic result line with a real session_end event:
test("returns true when handle log contains session_end event", async () => {
    const handleLogDir = join(tempDir, "logs", "session-1");
    await mkdir(handleLogDir, { recursive: true });

    const handleId = "handle-abc";
    const logPath = join(handleLogDir, `${handleId}.jsonl`);
    const lines = [
        JSON.stringify(event("perceive", { goal: "work" })),
        JSON.stringify(event("session_end", {
            success: true,
            stumbles: 0,
            turns: 3,
            timed_out: false,
        })),
    ];
    await writeFile(logPath, `${lines.join("\n")}\n`, "utf-8");

    const completed = await checkHandleCompleted(handleLogDir, handleId);
    expect(completed).toBe(true);
});
```

Note: The `event()` helper creates a `SessionEvent` with `kind`, `agent_id`, `depth`, `timestamp`, `data`. Verify this helper is available — it's used earlier in the same test file.

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/resume.test.ts`
Expected: FAIL — `checkHandleCompleted` still looks for `kind: "result"`, won't find `kind: "session_end"`.

**Step 3: Fix the implementation**

In `src/bus/resume.ts:73`, change:

```typescript
// Before:
if (parsed.kind === "result") return true;

// After:
if (parsed.kind === "session_end") return true;
```

Also update the JSDoc comment at line 54-55:

```typescript
// Before:
 * Looks for a line with "kind":"result" in {handleLogDir}/{handleId}.jsonl.

// After:
 * Looks for a "session_end" event in {handleLogDir}/{handleId}.jsonl.
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/resume.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bus/resume.ts test/bus/resume.test.ts
git commit -m "fix: checkHandleCompleted looks for session_end instead of result"
```

---

### Task 2: Fix steer messages dropped during initial `run()` in agent-process

When the agent process receives a `start` message, it enters `agent.run(goal, signal)`. During this initial run, steer messages published to the inbox are silently dropped. The `waitForStartWithReady` callback at line 202 returns early because `resolveStart` is null. The `idleLoop` handles steers (line 255-258), but that only runs after the initial `run()` completes.

The fix: register a second inbox callback that forwards steer messages to `agent.steer()` during the initial run.

**Files:**
- Modify: `src/bus/agent-process.ts:96-163`
- Modify: `test/bus/agent-process.test.ts`

**Step 1: Write the failing test**

Add a test to `test/bus/agent-process.test.ts` that sends a steer message while the agent is doing its initial `run()` and verifies the agent receives it. This is tricky to test directly because the agent must be mid-run when the steer arrives.

```typescript
test("steer message during initial run() is delivered to agent", async () => {
    // Use a VCR cassette or mock where the agent makes multiple LLM calls,
    // giving us time to inject a steer between turns.
    // After run completes, verify that the steering text appears somewhere
    // in the conversation (the agent's history will contain a steering user turn).
    //
    // Alternatively: verify via the event log that a "steering" event was emitted.
});
```

The exact test setup depends on the existing VCR/mock patterns in this test file. Use the same `setupTestProcess` or equivalent helper. The key assertion is that a steer message published to the inbox during `run()` results in `agent.steer()` being called.

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/agent-process.test.ts`
Expected: FAIL — steer message is dropped.

**Step 3: Implement the fix**

In `src/bus/agent-process.ts`, after receiving the start message and before calling `agent.run()`, register a second inbox subscription that forwards steer messages:

```typescript
// After line 129 (agent construction) and before line 137 (build goal):

// Forward steer messages from the inbox to the agent during the initial run.
// The idleLoop handles steers for shared agents after run() completes,
// but during the initial run() this is the only path for steers.
await bus.subscribe(inboxTopic, (payload) => {
    try {
        const msg = parseBusMessage(payload);
        if (msg.kind === "steer") {
            agent.steer(msg.message);
        }
    } catch {
        // Ignore malformed messages
    }
});
```

Note: `BusClient.subscribe()` adds the callback to the existing Set (inbox was already subscribed by `waitForStartWithReady`), so no duplicate wire subscribe is sent.

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/agent-process.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bus/agent-process.ts test/bus/agent-process.test.ts
git commit -m "fix: forward steer messages to agent during initial run()"
```

---

### Task 3: Queue continue messages instead of dropping them

`idleLoop` at `agent-process.ts:260` silently drops continue messages that arrive while a previous continue is processing. The fix: queue continues and process them sequentially.

**Files:**
- Modify: `src/bus/agent-process.ts:229-292`
- Modify: `test/bus/agent-process.test.ts`

**Step 1: Write the failing test**

Add a test that sends two continue messages in rapid succession and verifies both are processed (both produce results).

```typescript
test("continue messages are queued when one is already processing", async () => {
    // Send start message, wait for first result (shared=true so agent stays in idle).
    // Send two continue messages in quick succession.
    // Wait for both results (two result messages should arrive).
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/agent-process.test.ts`
Expected: FAIL — only one result arrives.

**Step 3: Implement the fix**

In the `idleLoop` function, replace the `!processing` guard with a queue:

```typescript
function idleLoop(
    bus: BusClient,
    agent: Agent,
    inboxTopic: string,
    resultTopic: string,
    handleId: string,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) return Promise.resolve();

    return new Promise((resolve) => {
        let processing = false;
        const continueQueue: ContinueMessage[] = [];

        const onAbort = () => {
            resolve();
        };

        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        async function processNext(): Promise<void> {
            if (continueQueue.length === 0) {
                processing = false;
                return;
            }

            processing = true;
            const continueMsg = continueQueue.shift()!;
            try {
                const result = await agent.continue(continueMsg.message, signal);
                const resultMsg: ResultMessage = {
                    kind: "result",
                    handle_id: handleId,
                    output: result.output,
                    success: result.success,
                    stumbles: result.stumbles,
                    turns: result.turns,
                    timed_out: result.timed_out,
                };
                await bus.publish(resultTopic, JSON.stringify(resultMsg));
            } catch (err) {
                const errorResult: ResultMessage = {
                    kind: "result",
                    handle_id: handleId,
                    output: `Continue failed: ${err instanceof Error ? err.message : String(err)}`,
                    success: false,
                    stumbles: 0,
                    turns: 0,
                    timed_out: false,
                };
                await bus.publish(resultTopic, JSON.stringify(errorResult));
            }

            // Process next queued continue (if any)
            await processNext();
        }

        bus.subscribe(inboxTopic, async (payload) => {
            try {
                const msg = parseBusMessage(payload);

                if (msg.kind === "steer") {
                    agent.steer(msg.message);
                    return;
                }

                if (msg.kind === "continue") {
                    continueQueue.push(msg as ContinueMessage);
                    if (!processing) {
                        await processNext();
                    }
                    return;
                }
            } catch {
                // Ignore malformed messages
            }
        });
    });
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/agent-process.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/agent-process.ts test/bus/agent-process.test.ts
git commit -m "fix: queue continue messages instead of dropping in idleLoop"
```

---

### Task 4: Add `handle_id` to `act_start` events for spawner delegations

`extractChildHandles` uses `act_end` events, but the design says `act_start` should contain the handle_id. If an agent dies between `act_start` and `act_end`, the in-flight child is invisible.

**Files:**
- Modify: `src/agents/agent.ts:382-385`
- Modify: `src/bus/resume.ts:18-51` (also scan `act_start`)
- Modify: `test/bus/resume.test.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

In `test/bus/resume.test.ts`, add a test for `extractChildHandles` that has an `act_start` with `handle_id` but NO corresponding `act_end` (simulating agent death mid-delegation). Verify the handle is still discovered.

```typescript
test("extracts handles from act_start events when no act_end exists (agent death)", async () => {
    const logPath = join(tempDir, "root.jsonl");
    const lines = [
        JSON.stringify(event("act_start", { agent_name: "editor", goal: "fix", handle_id: "HANDLE_01" })),
        // No act_end — agent died
    ];
    await writeFile(logPath, `${lines.join("\n")}\n`, "utf-8");

    const handles = await extractChildHandles(logPath);
    expect(handles.length).toBe(1);
    expect(handles[0]!.handleId).toBe("HANDLE_01");
    expect(handles[0]!.completed).toBe(false);
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/resume.test.ts`
Expected: FAIL — `extractChildHandles` only reads `act_end`.

**Step 3: Implement**

First, in `src/agents/agent.ts:382-385`, add `handle_id` to the `act_start` event. The handle isn't assigned until `spawnAgent()` returns, so we need to restructure slightly. The `spawnAgent()` call at line 392 returns the handle ID (for non-blocking) or a `ResultMessage` (for blocking). For spawner delegations, generate the handle_id BEFORE calling `spawnAgent` and pass it in. However, looking at the spawner, it generates the ULID internally (line 92). So instead, emit `act_start` after `spawnAgent()` returns (for non-blocking the handle ID is available as the return value, for blocking the handle is in the result). Actually the simplest approach: move the `act_start` emission to AFTER the spawner has assigned the handle.

Wait — the spawner generates the handle. For non-blocking, the return is the handleId string. For blocking, the handleId isn't directly returned. Let me look at this more carefully.

The spawner's `spawnAgent` always generates the handle ID at line 92. But the caller doesn't know it until the method returns (as string for non-blocking, or embedded in ResultMessage for blocking).

Simplest fix: have the spawner accept an optional pre-assigned handleId, or return the handleId alongside the result for blocking calls. Or: restructure `executeSpawnerDelegation` to first call a method that allocates the handle, then emit `act_start`, then send `start` message.

Actually, the cleanest fix is: always return the handleId from `spawnAgent`, even for blocking. Change the return type. But that's a larger change.

Simpler: For `act_start`, emit it WITHOUT the handle_id (as today), and then update `extractChildHandles` to ALSO scan `act_start` events — using `act_start` only to discover delegations that died before `act_end`. `act_start` without a handle_id still tells us an agent_name and goal were dispatched, but without a handle we can't resume the child. So we need the handle in `act_start`.

Best approach: Make `spawnAgent` accept a pre-generated handleId, or split it into `allocateHandle()` + `startAgent()`. Let's keep it simple — have the spawner accept an optional `handleId` parameter:

In `src/bus/spawner.ts`, add `handleId?: string` to `SpawnAgentOptions`. If provided, use it instead of generating a new one.

Then in `executeSpawnerDelegation`:
1. Generate a ULID handle_id
2. Emit `act_start` with the handle_id
3. Call `spawnAgent` with the pre-assigned handle_id

```typescript
// In agent.ts executeSpawnerDelegation:
const handleId = ulid();
this.emitAndLog("act_start", agentId, this.depth, {
    agent_name: delegation.agent_name,
    goal: delegation.goal,
    handle_id: handleId,
});

const result = await this.spawner!.spawnAgent({
    ...opts,
    handleId,
});
```

Then update `extractChildHandles` to build a map: first collect all handle_ids from `act_start`, then mark as completed if a matching `act_end` with `turns` is found.

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/resume.test.ts && bun test test/agents/agent.test.ts && bun test test/bus/spawner.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/agents/agent.ts src/bus/spawner.ts src/bus/resume.ts test/bus/resume.test.ts test/agents/agent.test.ts test/bus/spawner.test.ts
git commit -m "fix: include handle_id in act_start, extract handles from both act_start and act_end"
```

---

### Task 5: Fix `Delegation.shared` comment

**Files:**
- Modify: `src/kernel/types.ts:64`

**Step 1: Fix the comment**

```typescript
// Before (line 64):
/** If true, reuse an existing agent instance instead of spawning a new one. Default: false */
shared?: boolean;

// After:
/** If true, the agent stays alive after completion and can receive follow-up messages. Default: false */
shared?: boolean;
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Clean

**Step 3: Commit**

```bash
git add src/kernel/types.ts
git commit -m "fix: correct Delegation.shared comment to match design spec"
```

---

### Task 6: Make `waitAgent` timeout configurable

The 30-second hardcoded timeout at `spawner.ts:178` is too short for complex delegations.

**Files:**
- Modify: `src/bus/spawner.ts:163-186`
- Modify: `test/bus/spawner.test.ts`

**Step 1: Write the failing test**

```typescript
test("waitAgent uses configured timeout", async () => {
    // Spawn an agent that never completes.
    // Call waitAgent with a short timeout (e.g., 100ms).
    // Verify it rejects after ~100ms, not 30s.
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/spawner.test.ts`
Expected: FAIL — waitAgent doesn't accept a timeout parameter.

**Step 3: Implement**

Add a `waitTimeoutMs` option to the `AgentSpawner` constructor, defaulting to 120_000 (2 minutes). Use it in `waitAgent`:

```typescript
// In AgentSpawner constructor:
private readonly waitTimeoutMs: number;
constructor(bus: BusClient, busUrl: string, sessionId: string, opts?: { waitTimeoutMs?: number }) {
    // ...
    this.waitTimeoutMs = opts?.waitTimeoutMs ?? 120_000;
}

// In waitAgent, line 178:
const timeout = setTimeout(() => {
    // ...
    reject(new Error(`waitAgent timed out for handle ${handleId}`));
}, this.waitTimeoutMs);
```

Update the call sites in `cli.ts` — no change needed since the default is fine.

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/spawner.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/spawner.ts test/bus/spawner.test.ts
git commit -m "feat: make waitAgent timeout configurable, default to 120s"
```

---

### Task 7: Validate `CallerIdentity` in `parseBusMessage`

`parseBusMessage` validates field presence but not nested structure. `caller: "garbage"` passes validation.

**Files:**
- Modify: `src/bus/types.ts:84-108`
- Modify: `test/bus/types.test.ts`

**Step 1: Write the failing test**

```typescript
test("throws on start message with invalid caller structure", () => {
    const raw = JSON.stringify({
        kind: "start",
        handle_id: "H1",
        agent_name: "editor",
        genome_path: "/tmp",
        session_id: "S1",
        caller: "not-an-object",
        goal: "fix",
        shared: false,
    });
    expect(() => parseBusMessage(raw)).toThrow();
});

test("throws on start message with caller missing agent_name", () => {
    const raw = JSON.stringify({
        kind: "start",
        handle_id: "H1",
        agent_name: "editor",
        genome_path: "/tmp",
        session_id: "S1",
        caller: { depth: 0 },
        goal: "fix",
        shared: false,
    });
    expect(() => parseBusMessage(raw)).toThrow();
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/types.test.ts`
Expected: FAIL — parser doesn't validate `caller` structure.

**Step 3: Implement**

Add a `validateCallerIdentity` helper in `src/bus/types.ts`:

```typescript
function validateCallerIdentity(obj: Record<string, unknown>): void {
    const caller = obj.caller;
    if (caller === null || typeof caller !== "object" || Array.isArray(caller)) {
        throw new Error("'caller' must be an object with agent_name (string) and depth (number)");
    }
    const c = caller as Record<string, unknown>;
    if (typeof c.agent_name !== "string" || typeof c.depth !== "number") {
        throw new Error("'caller' must have agent_name (string) and depth (number)");
    }
}
```

Call it in the `start` and `continue` cases after `requireFields`:

```typescript
case "start":
    requireFields(obj, ["handle_id", "agent_name", "genome_path", "session_id", "caller", "goal", "shared"]);
    validateCallerIdentity(obj);
    break;
case "continue":
    requireFields(obj, ["message", "caller"]);
    validateCallerIdentity(obj);
    break;
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/types.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/types.ts test/bus/types.test.ts
git commit -m "fix: validate CallerIdentity structure in parseBusMessage"
```

---

## Phase 2: Wiring Gaps (make existing bus features work)

These tasks wire up bus features that exist in code but don't function in production.

---

### Task 8: Forward sub-agent bus events to the host EventBus

Sub-agent processes publish events to the WebSocket bus, but the host never subscribes. The TUI is blind to sub-agent progress.

Rather than implementing glob subscriptions (complex, may not be needed yet), use a targeted approach: the spawner knows every handle it creates, so the host-side spawner can subscribe to each agent's event topic when it spawns them and relay events to the in-process EventBus.

**Files:**
- Modify: `src/bus/spawner.ts`
- Modify: `src/host/session-controller.ts` (wire the relay)
- Modify: `test/bus/spawner.test.ts`

**Step 1: Write the failing test**

In `test/bus/spawner.test.ts`, add a test that spawns an agent, verifies the spawner's `onEvent` callback fires with the sub-agent's events:

```typescript
test("spawner relays sub-agent events via onEvent callback", async () => {
    const events: EventMessage[] = [];
    spawner.onEvent((event) => events.push(event));

    await spawner.spawnAgent({ /* ... blocking: true ... */ });

    // The sub-agent should have emitted at least a session_start and session_end event
    expect(events.length).toBeGreaterThan(0);
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/spawner.test.ts`
Expected: FAIL — `spawner.onEvent` is not a function.

**Step 3: Implement**

Add event relay to `AgentSpawner`:

```typescript
// In AgentSpawner class:
private eventCallback?: (event: EventMessage) => void;

onEvent(callback: (event: EventMessage) => void): void {
    this.eventCallback = callback;
}
```

In `spawnAgent()`, after subscribing to the result topic, also subscribe to the agent's events topic:

```typescript
const eventsTopic = agentEvents(this.sessionId, handleId);
await this.bus.subscribe(eventsTopic, (payload) => {
    if (!this.eventCallback) return;
    try {
        const msg = parseBusMessage(payload);
        if (msg.kind === "event") {
            this.eventCallback(msg as EventMessage);
        }
    } catch {}
});
```

Then in `session-controller.ts`'s `defaultFactory`, after creating the spawner reference, wire the event relay:

```typescript
// In defaultFactory, after creating the spawner (if spawner exists on options):
if (options.spawner) {
    // Type assertion needed since spawner interface may not expose onEvent yet
    (options.spawner as any).onEvent?.((eventMsg: any) => {
        const ev = eventMsg.event;
        options.events.emitEvent(ev.kind, ev.agent_id, ev.depth, ev.data);
    });
}
```

Actually, the relay should be set up where the spawner is created, not in defaultFactory. The spawner is created in `startBusInfrastructure()` in `cli.ts`. The relay callback needs access to the SessionBus. Best approach: set up the callback in `SessionController` constructor or `submitGoal` where both spawner and bus are available.

The exact wiring point needs to be determined during implementation. The key contract: when `AgentSpawner` receives an `EventMessage` from a sub-agent, it calls the registered callback, which relays to the SessionBus/EventBus.

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/spawner.test.ts && bun test test/host/session.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/spawner.ts src/host/session-controller.ts test/bus/spawner.test.ts
git commit -m "feat: relay sub-agent bus events to host EventBus via spawner"
```

---

### Task 9: Pass spawner to bus-spawned agents for nested delegation

Bus-spawned sub-agents currently can't delegate via the bus because `agent-process.ts` doesn't pass a spawner to the Agent. If a sub-agent has `can_spawn: true`, it falls back to in-process delegation.

**Files:**
- Modify: `src/bus/agent-process.ts:96-129`
- Modify: `test/bus/agent-process.test.ts`

**Step 1: Write the failing test**

This is hard to test directly without a multi-level delegation VCR cassette. A simpler test: verify the Agent constructed in `runAgentProcess` has a spawner when one should be available.

Alternatively, inspect the `AgentProcessConfig` to accept a spawner factory or verify the Agent is constructed with one. The simplest approach: add a test that spawns an orchestrator agent that itself delegates, and verify the nested delegation succeeds.

This may require a new integration test. Follow existing patterns in `test/bus/agent-process.test.ts`.

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/agent-process.test.ts`
Expected: FAIL — sub-agent can't delegate via bus.

**Step 3: Implement**

In `src/bus/agent-process.ts`, create an `AgentSpawner` connected to the same bus and pass it to the Agent:

```typescript
// After line 114 (event forwarding setup), before line 116 (Agent construction):
const { AgentSpawner } = await import("./spawner.ts");
const spawner = new AgentSpawner(bus, config.busUrl, sessionId);

const agent = new Agent({
    spec: agentSpec,
    env,
    client,
    primitiveRegistry: registry,
    availableAgents: genome.allAgents(),
    genome,
    events,
    sessionId,
    logBasePath,
    preambles,
    projectDocs,
    genomePostscripts,
    spawner,                    // <-- Add this
    genomePath,                 // <-- Already passed? Check. If not, add.
});
```

Verify that `AgentProcessConfig` includes the `busUrl` field (it does — it's the WebSocket URL of the bus server).

Also ensure the spawner is shut down properly in the `finally` block. Add `spawner.shutdown()` before `bus.disconnect()`.

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/agent-process.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/agent-process.ts test/bus/agent-process.test.ts
git commit -m "feat: pass spawner to bus-spawned agents for nested delegation"
```

---

### Task 10: Wire learn signals from bus agents to genome mutation service

Bus-spawned agents have no `learnProcess`, so learn signals are silently dropped. Meanwhile, the `GenomeMutationService` is running but has no callers.

The fix: give bus-spawned agents a lightweight learn signal forwarder that publishes learn signals to the `genomeMutations` bus topic.

**Files:**
- Create: `src/bus/learn-forwarder.ts`
- Modify: `src/bus/agent-process.ts`
- Modify: `src/bus/genome-service.ts` (add `learn_signal` mutation type)
- Test: `test/bus/learn-forwarder.test.ts`
- Modify: `test/bus/genome-service.test.ts`

**Step 1: Write the failing test**

```typescript
// test/bus/learn-forwarder.test.ts
import { describe, expect, test } from "bun:test";
import { BusLearnForwarder } from "../../src/bus/learn-forwarder.ts";

describe("BusLearnForwarder", () => {
    test("push publishes learn_signal mutation to bus", async () => {
        const published: { topic: string; payload: string }[] = [];
        const fakeBus = {
            publish(topic: string, payload: string) {
                published.push({ topic, payload });
            },
        };
        const forwarder = new BusLearnForwarder(fakeBus as any, "SESSION1");

        forwarder.push({
            session_id: "SESSION1",
            agent_id: "agent-1",
            kind: "stumble",
            detail: "failed to read file",
            goal: "fix bug",
        });

        expect(published.length).toBe(1);
        const msg = JSON.parse(published[0]!.payload);
        expect(msg.kind).toBe("mutation_request");
        expect(msg.mutation_type).toBe("learn_signal");
        expect(msg.signal.kind).toBe("stumble");
    });
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/learn-forwarder.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the forwarder**

```typescript
// src/bus/learn-forwarder.ts
import type { BusClient } from "./client.ts";
import { genomeMutations } from "./topics.ts";
import type { LearnSignal } from "../learn/learn-process.ts";

/**
 * Lightweight learn signal forwarder for bus-spawned agents.
 * Publishes learn signals to the genomeMutations bus topic,
 * where the GenomeMutationService can process them.
 *
 * Implements the subset of the LearnProcess interface that Agent uses:
 * - push(signal): forward a learn signal
 * - recordAction(agentId): no-op (metrics are host-side)
 * - startBackground/stopBackground: no-ops
 */
export class BusLearnForwarder {
    private readonly bus: BusClient;
    private readonly sessionId: string;

    constructor(bus: BusClient, sessionId: string) {
        this.bus = bus;
        this.sessionId = sessionId;
    }

    push(signal: LearnSignal): void {
        const topic = genomeMutations(this.sessionId);
        const payload = JSON.stringify({
            kind: "mutation_request",
            mutation_type: "learn_signal",
            signal,
        });
        this.bus.publish(topic, payload);
    }

    recordAction(_agentId: string): void {
        // No-op for bus agents — metrics are host-side
    }

    startBackground(): void {}
    async stopBackground(): Promise<void> {}
}
```

Then update the `GenomeMutationService` to handle `learn_signal` mutation requests. This requires integrating the reasoning logic from `LearnProcess`. This is a larger change — the mutation service would need an LLM client to reason about improvements.

**Important design decision**: The `GenomeMutationService` currently applies pre-formed mutations. Adding LLM reasoning to it would conflate two concerns. A simpler approach for now: have the forwarder collect signals and the host-side `LearnProcess` process them. This means learn signals from bus agents need to flow back to the host.

**Alternative simpler approach**: Instead of a forwarder, have the spawner relay learn signals. When the root agent calls `verifyActResult()` on the spawner delegation result (which it already does in `executeSpawnerDelegation`), it pushes to its own `learnProcess`. This already works for blocking delegations! The gap is only for non-blocking delegations and for sub-sub-agent delegations.

**Reassessment**: For blocking spawner delegations, learn signals already work (agent.ts:445-446). The gap is:
1. Non-blocking delegations — the root never calls `verifyActResult` because it doesn't wait for the result.
2. Sub-agent-to-sub-agent delegations — the sub-agent has no `learnProcess`.

For now, defer the full forwarder. Instead, just wire a `learnProcess` in `agent-process.ts` when the agent has `can_learn`. The simplest approach: create a `BusLearnForwarder` that publishes signals to the bus, and have the host's `GenomeMutationService` process `learn_signal` mutations by delegating to a `LearnProcess` instance.

This task is complex. The implementer should discuss the exact approach with Jesse if the full forwarder feels too heavy. At minimum, create the `BusLearnForwarder` class, wire it into `agent-process.ts`, and add `learn_signal` handling to `GenomeMutationService`.

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/learn-forwarder.test.ts && bun test test/bus/genome-service.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/learn-forwarder.ts src/bus/agent-process.ts src/bus/genome-service.ts test/bus/learn-forwarder.test.ts test/bus/genome-service.test.ts
git commit -m "feat: forward learn signals from bus agents to genome mutation service"
```

---

### Task 11: Add `shared` access control to spawner

Design says `shared=false` means only the parent can `waitAgent`/`messageAgent`. Currently no enforcement.

**Files:**
- Modify: `src/bus/spawner.ts`
- Modify: `test/bus/spawner.test.ts`

**Step 1: Write the failing test**

This is tricky because in the current single-process spawner, there's no concept of "caller identity" — it's one spawner per process. Access control would need a `callerId` parameter on `waitAgent`/`messageAgent` to enforce ownership.

Practical approach: add an `ownerId` to `AgentHandle` (set to the parent agent's name at spawn time). `waitAgent` and `messageAgent` accept an optional `callerId` parameter. If the handle is not shared and `callerId` doesn't match `ownerId`, throw.

```typescript
test("messageAgent rejects non-parent on non-shared handle", async () => {
    // Spawn a non-shared agent as "root"
    const handleId = await spawner.spawnAgent({
        agentName: "editor",
        /* ... */
        shared: false,
    });

    // Attempt to message as a different agent
    await expect(
        spawner.messageAgent(handleId, "hello", { agent_name: "other", depth: 1 }, true)
    ).rejects.toThrow(/not shared/);
});

test("messageAgent allows non-parent on shared handle", async () => {
    // Spawn a shared agent as "root"
    // Message as a different agent — should succeed
});
```

**Step 2: Run the test to verify it fails**

Run: `bun test test/bus/spawner.test.ts`
Expected: FAIL — no access control check.

**Step 3: Implement**

Add `ownerId: string` to `AgentHandle`. Set it from `opts.caller.agent_name` in `spawnAgent`. Check it in `waitAgent` and `messageAgent`:

```typescript
// In waitAgent and messageAgent:
if (!handle.shared && caller.agent_name !== handle.ownerId) {
    throw new Error(
        `Handle ${handleId} is not shared — only '${handle.ownerId}' can access it`
    );
}
```

Note: `waitAgent` currently doesn't take a `caller` param. Add one. Update all call sites (`executeAgentCommand` in `agent.ts`).

**Step 4: Run tests to verify they pass**

Run: `bun test test/bus/spawner.test.ts && bun test test/agents/agent.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/bus/spawner.ts src/agents/agent.ts test/bus/spawner.test.ts
git commit -m "feat: enforce shared access control on agent handles"
```

---

## Phase 3: Resume System

These tasks make the resume system actually work.

---

### Task 12: Activate sub-agent resume in session host

`cli.ts:401-416` discovers child handles and logs their counts, then discards the information. Wire this into the session resume flow so completed child results are available and pending children are reported.

**Files:**
- Modify: `src/host/cli.ts:396-416`
- Modify: `test/host/cli.test.ts` or `test/integration/e2e.test.ts`

**Step 1: Write the failing test**

This needs an integration test that:
1. Runs a session where the root agent delegates to a sub-agent via the bus.
2. The session completes successfully.
3. Resume the session with `--resume`.
4. Verify the child handle status is correctly reported and the resume loads properly.

Follow existing e2e test patterns in `test/integration/e2e.test.ts`.

**Step 2: Run the test to verify it fails**

Run: `bun test test/integration/e2e.test.ts`
Expected: FAIL — resume doesn't use child handle info.

**Step 3: Implement**

The simplest useful step: pass the `childHandles` info into the `SessionController` so it can pre-populate the spawner's handle map with completed results. This allows the root agent (on resume) to call `wait_agent` on a handle that completed in a previous session and get the cached result.

In `cli.ts`, after extracting child handles:

```typescript
// For each completed child handle, read its per-handle log to reconstruct the result.
// Pre-populate the spawner's handle map so wait_agent works on resume.
for (const handle of childHandles) {
    if (handle.completed) {
        const handleLog = join(command.genomePath, "logs", sessionId, `${handle.handleId}.jsonl`);
        // Read the last session_end event to reconstruct the ResultMessage
        // Pre-register in spawner.registerCompletedHandle(handleId, result)
    }
}
```

Add `registerCompletedHandle(handleId: string, result: ResultMessage)` to `AgentSpawner` — this creates a handle entry with `status: "completed"` and the cached result.

For pending children: log a warning. Full re-spawn is a future task (requires the agent process to support receiving `initialHistory` in the start message, which is Task 14 from the original plan).

**Step 4: Run tests to verify they pass**

Run: `bun test test/integration/e2e.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/host/cli.ts src/bus/spawner.ts test/integration/e2e.test.ts
git commit -m "feat: pre-populate spawner handle map with completed child results on resume"
```

---

### Task 13: Replace `delay()` with deterministic waits in agent-process tests

Tests at `test/bus/agent-process.test.ts` use `delay(500)` for shared-agent message propagation. Replace with proper `waitForMessage` or result-counting patterns.

**Files:**
- Modify: `test/bus/agent-process.test.ts`

**Step 1: Identify all `delay()` usages**

Search for `delay(` in the test file. Each one should be replaced with either:
- `await client.waitForMessage(resultTopic)` for waiting on a result
- A proper message collection helper that waits until N messages are received

**Step 2: Replace each delay**

For each `delay()` call, determine what the test is actually waiting for and use the appropriate deterministic wait.

**Step 3: Run tests to verify they pass**

Run: `bun test test/bus/agent-process.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add test/bus/agent-process.test.ts
git commit -m "test: replace delay() with deterministic waits in agent-process tests"
```

---

## Phase 4: Documentation

---

### Task 14: Update design doc to match implementation reality

The design doc is stale. Update it to reflect the actual architecture:

**Files:**
- Modify: `docs/plans/2026-02-25-async-agent-messaging-design.md`

**Changes:**

1. **Transport**: Note the TCP fallback from Unix sockets, with the documented reason.
2. **Topics**: Add `ready` channel to the topic list (line 50-55). Add `commands` topic.
3. **Protocol additions**: Document subscribe acknowledgment (`{action: "subscribed", topic}`).
4. **Ready handshake**: Add to Agent Process Lifecycle startup sequence (lines 163-168).
5. **Hybrid architecture**: Add a section documenting the current hybrid state — root in-process, sub-agents on bus — as an intermediate step. Note what still uses EventBus and why.
6. **Environment variables**: Update the list of env vars for agent process startup.

**Do NOT remove the target architecture description** — it's still the goal. Add a "Current State" section that documents the hybrid reality alongside the target.

**Step 1: Make the edits**

Update the sections listed above.

**Step 2: Commit**

```bash
git add docs/plans/2026-02-25-async-agent-messaging-design.md
git commit -m "docs: update design doc to reflect hybrid architecture and protocol additions"
```

---

## Dependency Order

```
Tasks 1, 5, 6, 7 — independent, no dependencies
Task 2 — independent
Task 3 — independent
Task 4 — independent
Task 8 — depends on nothing (spawner event relay)
Task 9 — depends on nothing (spawner in agent-process)
Task 10 — depends on 9 (learn forwarder needs agent-process changes)
Task 11 — depends on nothing
Task 12 — depends on 1 (correct checkHandleCompleted)
Task 13 — independent (test-only)
Task 14 — depends on all above (documents final state)
```

Parallelizable: Tasks 1-7 can all run in parallel. Tasks 8, 9, 11 can run in parallel. Task 10 after 9. Task 12 after 1. Task 14 last.

---

## Out of Scope (acknowledged, not remediated)

These findings from the audit are **intentionally not addressed** in this plan:

1. **C3: Root agent not a standalone process** — This is the full Task 18 migration. It's deferred because the in-process root agent is still actively used by the EventBus-based TUI. Completing this requires replacing the EventBus entirely, which is a separate project.

2. **I7: Glob/wildcard topic subscriptions** — Task 8 (event relay via spawner) provides an alternative that doesn't require glob support. Glob subscriptions can be added later if a use case arises that the relay pattern doesn't cover.

3. **M2: Non-blocking delegate returns wrapped string** — The `"Agent started. Handle: {handleId}"` format is pragmatic for LLMs. Changing it risks breaking existing agent behavior. Leave as-is unless LLMs demonstrate confusion.

4. **M4: Root agent log path convention** — The root agent uses session-level paths. Changing this would break existing session resume. Address when root agent becomes a bus process (see C3).

5. **M5: Session metadata handle-to-log-path mapping** — The current approach (scanning event logs at resume time) works. Metadata caching is an optimization, not a bug.

6. **M7: Dead waitForStartWithReady callback** — Harmless (early-returns via null check). Not worth the complexity of cleaning up.

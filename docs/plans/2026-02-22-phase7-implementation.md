# Phase 7: Event System and Host Interface — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the host-facing `submit()` API that returns an async event stream, add `session_start`/`session_end` lifecycle events, wire Learn queue draining into session end, and create a minimal CLI entry point.

**Architecture:** The spec describes the host interface as `agent.submit(goal) → AsyncIterable<SessionEvent>`. Currently `Agent.run()` is a Promise-based call that returns `AgentResult` and events are collected via `AgentEventEmitter.on()`. Phase 7 bridges this gap by adding a `submit()` method on the factory result that wraps `run()`, yields events via an `AsyncIterableIterator`, and drains the Learn queue at session end. A minimal CLI binary provides the `sprout "goal"` command and basic genome inspection.

**Tech Stack:** TypeScript/Bun, existing `Agent`, `AgentEventEmitter`, `LearnProcess`, `Genome`, `bun test`

---

## Context

**What already exists:**
- `src/agents/events.ts` — `AgentEventEmitter` with `on()`, `emit()`, `collected()`
- `src/agents/agent.ts` — `Agent.run(goal)` returns `Promise<AgentResult>`, emits events throughout
- `src/agents/factory.ts` — `createAgent()` returns `{ agent, genome, events, learnProcess }`
- `src/kernel/types.ts` — `EventKind` (18 event types), `SessionEvent` (kind, timestamp, agent_id, depth, data)
- Events are already emitted at every phase: session_start, perceive, recall, plan_start/delta/end, act_start/end, primitive_start/end, verify, learn_signal, learn_start/mutation/end
- Learn signals are pushed to LearnProcess queue but never drained automatically

**What's missing (the gap this phase closes):**
- No `submit()` that returns an async event stream — host has to wire `events.on()` manually
- No `session_end` event emission at the end of `Agent.run()`
- No automatic Learn queue draining after agent finishes
- No CLI entry point
- No genome inspection commands

**Key files to create:**
- `src/host/session.ts` — `submitGoal()` function that wraps Agent.run() and yields events
- `src/host/cli.ts` — Minimal CLI entry point
- `src/host/index.ts` — Barrel exports
- `test/host/session.test.ts` — Tests for session event stream
- `test/host/cli.test.ts` — Tests for CLI argument parsing

**Key files to modify:**
- `src/agents/agent.ts` — Add session_end event emission
- `src/index.ts` — Export host module

---

### Task 1: session_end Event and Agent.run() Cleanup

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

Agent.run() already emits `session_start` but never emits `session_end`. Add `session_end` emission at the end of `run()` with summary data (success, stumbles, turns, output length). This belongs in the agent itself, not in the host layer.

**Step 1: Write the failing test**

Add a test to `test/agents/agent.test.ts` that verifies `session_end` is emitted with correct data after run() completes.

**Step 2: Implement**

At the end of `Agent.run()`, just before the return statement, emit:
```typescript
this.events.emit("session_end", agentId, this.depth, {
    success: !hitTurnLimit,
    stumbles,
    turns,
    session_id: this.sessionId,
});
```

**Step 3: Run tests, commit**

---

### Task 2: submitGoal() — Async Event Stream

**Files:**
- Create: `src/host/session.ts`
- Create: `test/host/session.test.ts`

The `submitGoal()` function wraps `Agent.run()` and yields `SessionEvent` objects as an `AsyncIterableIterator`. It also drains the Learn queue after the agent finishes.

**Interface:**
```typescript
export interface SubmitOptions {
    agent: Agent;
    events: AgentEventEmitter;
    learnProcess?: LearnProcess;
}

export async function* submitGoal(goal: string, options: SubmitOptions): AsyncIterableIterator<SessionEvent> {
    // 1. Subscribe to events, push to a queue
    // 2. Start agent.run() in background
    // 3. Yield events as they arrive
    // 4. After run() completes, drain learn queue
    // 5. Yield any learn events
}
```

**Implementation approach:**
Use a simple queue + promise pattern:
1. Create an internal event queue (array of SessionEvent)
2. Create a resolve/notify mechanism so the iterator can await new events
3. Subscribe to events via `events.on()`
4. Start `agent.run(goal)` (don't await yet — let it run while we yield)
5. In the async generator, yield events as they arrive
6. When run() completes, drain learn queue (call `processNext()` in a loop)
7. Signal completion

**Tests:**
1. submitGoal yields session_start and session_end events
2. submitGoal drains learn queue after agent completes
3. submitGoal works with no learnProcess

---

### Task 3: CLI Entry Point

**Files:**
- Create: `src/host/cli.ts`
- Create: `test/host/cli.test.ts`

Minimal CLI that parses arguments and runs the agent. Supports:
- `sprout "goal"` — run a task
- `sprout --genome list` — list agents
- `sprout --genome log` — git log of genome
- `sprout --genome rollback <commit>` — revert a genome change

**Implementation:**
```typescript
// src/host/cli.ts
export function parseArgs(argv: string[]): CliCommand {
    // Parse Bun.argv or process.argv
}

export async function runCli(command: CliCommand): Promise<void> {
    // Execute the command
}

// Entry point (if run directly)
if (import.meta.main) {
    const command = parseArgs(process.argv.slice(2));
    await runCli(command);
}
```

**Tests:**
1. parseArgs extracts goal from positional argument
2. parseArgs handles --genome list
3. parseArgs handles --genome log
4. parseArgs handles --genome rollback <commit>
5. parseArgs shows help when no arguments

---

### Task 4: Barrel Exports

**Files:**
- Create: `src/host/index.ts`
- Modify: `src/index.ts`

Simple barrel exports for the host module.

---

## Summary

After completing all 4 tasks, Phase 7 delivers:

| Component | What it does |
|-----------|-------------|
| session_end event | Emitted at end of Agent.run() with summary data |
| submitGoal() | Async generator that yields SessionEvent stream, drains learn queue |
| CLI | Minimal `sprout` command with goal execution and genome inspection |
| Barrel exports | Clean re-exports from host module |

**What's deferred:**
- Streaming plan deltas (plan_delta events already emitted but not streaming LLM tokens — that's a Client-level feature)
- IDE integration (future)
- Rich terminal UI (future)

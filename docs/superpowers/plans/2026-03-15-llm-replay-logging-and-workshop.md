# LLM Replay Logging And Workshop Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the exact canonical LLM exchange for every planning turn in a stable replay log, then add a standalone workshop tool that can inspect and replay one captured turn without reconstructing it from indirect session artifacts.

**Architecture:** Capture the replay record at the planning seam where Sprout already has the built request and normalized response in memory. Keep replay logging out of the generic structured logger. Instead, give each agent instance a replay recorder derived from its existing event-log base path and have `executePlanningTurn()` append one JSONL record per successful planning turn. Build the workshop as a separate Bun tool under `tools/`, not as part of the main `sprout` binary. The tool should accept either an existing agent event-log path or a replay-log path, resolve the sibling replay log, and provide `list`, `show`, and `replay` operations over the recorded turns.

**Tech Stack:** TypeScript on Bun, existing normalized LLM request/response types in `src/llm/types.ts`, Bun test, Biome.

---

## File Map

- Create: `src/host/replay/types.ts`
  - Versioned replay-record types built on Sprout's canonical `Request`, `Response`, `Message`, and `ToolDefinition` types.
- Create: `src/host/replay/paths.ts`
  - Helpers for deriving replay-log paths from existing agent event-log paths and vice versa.
- Create: `src/host/replay/recorder.ts`
  - Append-only JSONL recorder that writes one replay record per planning turn.
- Create: `src/host/replay/workshop.ts`
  - Shared logic for loading replay logs, listing turns, showing turns, and replaying a single record with small overrides.
- Create: `tools/replay-workshop.ts`
  - Standalone Bun CLI for the replay workshop tool.
- Modify: `src/agents/run-loop-planning.ts`
  - Capture the exact canonical request/response for each successful planning turn and hand it to the replay recorder.
- Modify: `src/agents/agent.ts`
  - Instantiate a replay recorder from `logBasePath`, wire it into planning turns, and flush it on agent shutdown.
- Test: `test/agents/run-loop-planning.test.ts`
  - Exact capture coverage at the planning seam.
- Test: `test/agents/agent.test.ts`
  - Automatic replay-log creation for root and child agents using existing log-base layout.
- Test: `test/host/replay/recorder.test.ts`
  - JSONL append and schema coverage.
- Test: `test/host/replay/workshop.test.ts`
  - Loading, listing, showing, replay overrides, and schema validation coverage.
- Test: `test/tools/replay-workshop.test.ts`
  - Thin CLI argument parsing and output-shape coverage for the standalone tool.

## Replay Record Contract

Each JSONL line should be one exact successful planning turn with:

- `schema_version`
- `timestamp`
- `session_id`
- `agent_id`
- `depth`
- `turn`
- `request_context`
- `request`
- `response`

`request_context` exists so the workshop can show the original inputs without reconstructing them:

- `system_prompt`
- `history`
- `agent_tools`
- `primitive_tools`

`request` should store the exact canonical `Request` sent to `client.complete()` or `client.stream()`, minus `signal`.

`response` should store the exact normalized `Response` returned by the adapter layer.

This is deliberately redundant. The redundancy is acceptable because the purpose of this artifact is faithful replay and prompt debugging, not minimal storage.

## Path Convention

Do **not** store replay logs beside `session.log.jsonl`. That would fail for in-process child agents, which do not have a per-child `session.log.jsonl`.

Instead, derive replay logs from the existing per-agent event-log base path:

- root event log: `<project-data>/logs/<session-id>.jsonl`
- root replay log: `<project-data>/logs/<session-id>.replay.jsonl`
- child event log: `<project-data>/logs/<session-id>/subagents/<handle>.jsonl`
- child replay log: `<project-data>/logs/<session-id>/subagents/<handle>.replay.jsonl`
- spawned child event log: `<project-data>/logs/<session-id>/<handle>.jsonl`
- spawned child replay log: `<project-data>/logs/<session-id>/<handle>.replay.jsonl`

The workshop tool should accept either the event-log path or the replay-log path and resolve the sibling replay log automatically.

## Chunk 1: Replay Record And Recorder

### Task 1: Define the exact replay record schema and append-only recorder

**Files:**
- Create: `src/host/replay/types.ts`
- Create: `src/host/replay/paths.ts`
- Create: `src/host/replay/recorder.ts`
- Test: `test/host/replay/recorder.test.ts`

- [ ] **Step 1: Write failing recorder tests first**

Add `test/host/replay/recorder.test.ts` covering:
- creating a recorder from an event-log base path derives the expected `.replay.jsonl` path
- appending two replay records produces two JSONL lines
- each line preserves the exact stored `request_context`, `request`, and `response`
- unsupported schema versions are surfaced when loading later
- malformed JSONL fails clearly with line context

- [ ] **Step 2: Run the recorder tests and verify they fail**

Run: `bun test test/host/replay/recorder.test.ts`

Expected: FAIL because the replay module does not exist.

- [ ] **Step 3: Implement the replay types and recorder**

Create:
- `src/host/replay/types.ts` with a versioned `ReplayTurnRecord`
- `src/host/replay/paths.ts` with helpers like `replayPathFromLogBase(logBasePath)` and `resolveReplayPath(inputPath)`
- `src/host/replay/recorder.ts` with an append-only recorder that writes one JSONL line per planning turn

The recorder must:
- strip `signal` from the stored `Request`
- create parent directories lazily
- serialize writes through a promise chain
- never throw into the agent loop after construction

- [ ] **Step 4: Run the recorder tests and verify they pass**

Run: `bun test test/host/replay/recorder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the replay schema/recorder layer**

```bash
git add src/host/replay/types.ts src/host/replay/paths.ts src/host/replay/recorder.ts test/host/replay/recorder.test.ts
git commit -m "feat: add replay log recorder"
```

## Chunk 2: Planning-Turn Capture

### Task 2: Capture the exact canonical exchange in `executePlanningTurn()`

**Files:**
- Modify: `src/agents/run-loop-planning.ts`
- Test: `test/agents/run-loop-planning.test.ts`

- [ ] **Step 1: Write failing planning-turn tests first**

Extend `test/agents/run-loop-planning.test.ts` to assert:
- on success, the planning turn hands a replay record to a supplied recorder callback
- the stored `request_context.system_prompt` equals the original system prompt input
- the stored `request_context.history` equals the original pre-turn history
- the stored `request` matches the canonical built request, minus `signal`
- the stored `response` matches the normalized response exactly
- interrupted turns do not emit replay records

- [ ] **Step 2: Run the planning-turn tests and verify they fail**

Run: `bun test test/agents/run-loop-planning.test.ts`

Expected: FAIL because `executePlanningTurn()` has no replay hook.

- [ ] **Step 3: Add a minimal replay hook to the planning seam**

Modify `executePlanningTurn()` to accept an optional `recordReplay(record)` callback. Build the replay record immediately after the normalized response is available and before any later tool execution mutates state.

Keep the change local:
- no replay-path logic here
- no file I/O here
- just build the record and call the injected hook

- [ ] **Step 4: Run the planning-turn tests and verify they pass**

Run: `bun test test/agents/run-loop-planning.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the planning capture seam**

```bash
git add src/agents/run-loop-planning.ts test/agents/run-loop-planning.test.ts
git commit -m "feat: capture exact planning turn replays"
```

### Task 3: Wire replay recording into `Agent` lifecycle

**Files:**
- Modify: `src/agents/agent.ts`
- Test: `test/agents/agent.test.ts`

- [ ] **Step 1: Write failing agent-level tests first**

Add tests in `test/agents/agent.test.ts` that assert:
- an agent with `logBasePath` automatically creates `<logBasePath>.replay.jsonl`
- successful planning turns append replay records
- child in-process delegations create replay logs under their existing `subagents/<handle>.replay.jsonl` layout
- agents without `logBasePath` skip replay logging cleanly

- [ ] **Step 2: Run the agent tests and verify they fail**

Run: `bun test test/agents/agent.test.ts`

Expected: FAIL because `Agent` does not own a replay recorder yet.

- [ ] **Step 3: Instantiate and flush the replay recorder in `Agent`**

Modify `src/agents/agent.ts` so that:
- when `logBasePath` is present, the agent constructs a replay recorder using the shared path helper
- the recorder is passed into `executePlanningTurn()` via the new callback
- the recorder is flushed during agent shutdown/finalization

Do not route this through `SessionLogger`. Replay logging is a separate exact-exchange artifact.

- [ ] **Step 4: Run the agent tests and verify they pass**

Run: `bun test test/agents/agent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the agent wiring**

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: write replay logs for agent planning turns"
```

## Chunk 3: Standalone Workshop Tool

### Task 4: Implement replay-log loading, listing, and showing

**Files:**
- Create: `src/host/replay/workshop.ts`
- Create: `tools/replay-workshop.ts`
- Test: `test/host/replay/workshop.test.ts`
- Test: `test/tools/replay-workshop.test.ts`

- [ ] **Step 1: Write failing workshop-loader tests first**

Add `test/host/replay/workshop.test.ts` covering:
- resolving replay path from an event-log path
- loading valid replay records
- rejecting malformed JSONL
- rejecting unsupported schema versions
- `list` returns turn/depth/model/provider/finish-reason/usage summaries
- `show` returns the exact record for one selected turn

Add `test/tools/replay-workshop.test.ts` covering:
- `list <path>`
- `show <path> --turn N`
- help output for malformed invocations

- [ ] **Step 2: Run the workshop tests and verify they fail**

Run:
```bash
bun test test/host/replay/workshop.test.ts test/tools/replay-workshop.test.ts
```

Expected: FAIL because the workshop modules do not exist.

- [ ] **Step 3: Implement the shared workshop logic and thin CLI**

Create `src/host/replay/workshop.ts` with:
- `loadReplayLog(path)`
- `listReplayTurns(path)`
- `showReplayTurn(path, turn)`

Create `tools/replay-workshop.ts` as a thin Bun CLI over that module.

Keep the CLI small:
- `list <path>`
- `show <path> --turn <n>`
- `replay <path> --turn <n> [--system-prepend <text>] [--system-append <text>] [--model <provider:model-or-model>]`

Do not add this to the main `sprout` CLI parser.

- [ ] **Step 4: Run the workshop tests and verify they pass**

Run:
```bash
bun test test/host/replay/workshop.test.ts test/tools/replay-workshop.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the standalone workshop tool**

```bash
git add src/host/replay/workshop.ts tools/replay-workshop.ts test/host/replay/workshop.test.ts test/tools/replay-workshop.test.ts
git commit -m "feat: add replay workshop tool"
```

## Chunk 4: Live Replay

### Task 5: Replay one recorded turn against the real client with small overrides

**Files:**
- Modify: `src/host/replay/workshop.ts`
- Modify: `tools/replay-workshop.ts`
- Test: `test/host/replay/workshop.test.ts`

- [ ] **Step 1: Write failing replay tests first**

Extend `test/host/replay/workshop.test.ts` to assert:
- `replay` rebuilds the canonical request from the stored replay record
- `--system-prepend` and `--system-append` modify only the system prompt
- `--model` overrides only the model field
- the live request still uses the recorded provider unless the override explicitly changes the provider/model reference format
- missing provider/model in the current environment fails clearly

- [ ] **Step 2: Run the replay tests and verify they fail**

Run: `bun test test/host/replay/workshop.test.ts`

Expected: FAIL because live replay is not implemented.

- [ ] **Step 3: Implement live replay on the canonical client boundary**

Use the existing normalized `Client`:
- reconstruct a `Client` from current settings/env as appropriate for the tool
- rebuild the stored canonical request
- apply small overrides
- call `client.complete()` with the reconstructed request

Print the normalized response and usage. Do not fake tool execution or multi-turn continuation.

- [ ] **Step 4: Run the replay tests and verify they pass**

Run: `bun test test/host/replay/workshop.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the live replay support**

```bash
git add src/host/replay/workshop.ts tools/replay-workshop.ts test/host/replay/workshop.test.ts
git commit -m "feat: replay captured planning turns"
```

## Chunk 5: Final Verification

### Task 6: Verify end-to-end replay logging from a real agent run

**Files:**
- No new files expected unless a small doc note is needed

- [ ] **Step 1: Run focused tests for the touched areas**

Run:
```bash
bun test test/agents/run-loop-planning.test.ts test/agents/agent.test.ts test/host/replay/recorder.test.ts test/host/replay/workshop.test.ts test/tools/replay-workshop.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full pre-commit suite**

Run:
```bash
bun run precommit
```

Expected: PASS.

- [ ] **Step 3: Smoke-test the standalone tool against a real run artifact**

Do a small headless Sprout run that produces at least one planning turn, then verify:
- `<logBasePath>.replay.jsonl` exists
- `bun tools/replay-workshop.ts list <event-or-replay-log-path>` prints the recorded turn
- `bun tools/replay-workshop.ts show <path> --turn 1` prints the exact captured exchange

- [ ] **Step 4: Commit any final test/doc cleanup**

```bash
git add [any remaining replay-workshop files]
git commit -m "test: verify replay logging end to end"
```

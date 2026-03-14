# Sprout ATIF And Harbor Integration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native ATIF logging for headless Sprout runs, package Sprout as an installed binary with an embedded root genome, and ship a real Harbor adapter under `tools/harbor/` for terminal-bench evaluations.

**Architecture:** Extend the existing shared headless runtime instead of creating a benchmark-only execution path. Add a literal event-mirror ATIF recorder attached to the host event bus, propagate an explicit `evalMode` flag through root and subagent execution so learning and genome mutation are genuinely disabled, and generate a compiled binary that materializes an embedded `root/` bundle at runtime. Keep Harbor integration thin: install the binary, point Sprout at `/logs/agent/agent-state`, and let Sprout itself emit `trajectory.json`.

**Tech Stack:** TypeScript on Bun for Sprout runtime, tests, and build scripts; Python only inside `tools/harbor/` for the Harbor installed-agent adapter; Bun test, Biome, existing Harbor installed-agent interface.

---

## File Map

- Create: `src/host/atif/types.ts`
  - Local TypeScript interfaces for the ATIF root object, steps, metrics, observations, and root metadata.
- Create: `src/host/atif/event-mapper.ts`
  - Literal one-step-per-event mapping from Sprout `SessionEvent` to ATIF `StepObject`, excluding `llm_chunk`.
- Create: `src/host/atif/costs.ts`
  - Runtime cost calculation from usage plus pricing snapshot provenance.
- Create: `src/host/atif/recorder.ts`
  - In-memory recorder that subscribes to the host event bus and incrementally writes `trajectory.json`.
- Create: `src/genome/read-only-genome.ts`
  - Root-cause enforcement layer that throws on genome mutation methods during eval mode.
- Create: `src/host/embedded-root.ts`
  - Runtime extraction and versioning for the embedded `root/` bundle.
- Create: `src/generated/embedded-root.ts`
  - Generated TypeScript bundle containing embedded `root/` files and metadata.
- Create: `scripts/generate-embedded-root.ts`
  - Build helper that walks `root/` and regenerates `src/generated/embedded-root.ts`.
- Create: `scripts/build-sprout-binary.ts`
  - Build helper that regenerates the embedded root bundle and compiles Sprout binaries for Harbor.
- Create: `tools/harbor/sprout_agent.py`
  - Harbor installed-agent adapter for Sprout.
- Create: `tools/harbor/install-sprout.sh.j2`
  - Container install template that installs the correct Sprout binary and common benchmark dependencies.
- Create: `tools/harbor/README.md`
  - Operator notes for building binaries and running Harbor with the Sprout adapter.
- Modify: `src/host/cli-parse.ts`
  - Add `--log-atif <path>` and `--eval-mode`, restricted to headless mode.
- Modify: `src/host/cli-run.ts`
  - Pass ATIF/eval options into the headless runner.
- Modify: `src/host/cli-headless.ts`
  - Create and own the ATIF recorder around headless session execution.
- Modify: `src/host/cli-bootstrap.ts`
  - Thread eval-mode and pricing snapshot access into the shared runtime bootstrap.
- Modify: `src/host/session-controller.ts`
  - Carry eval-mode/runtime metadata into session execution when needed by the recorder and factory.
- Modify: `src/agents/factory.ts`
  - Create a read-only genome and suppress learn process creation in eval mode.
- Modify: `src/kernel/primitives.ts`
  - Omit workspace mutation primitives in eval mode.
- Modify: `src/bus/types.ts`
  - Add eval-mode propagation to start messages.
- Modify: `src/bus/spawner.ts`
  - Propagate eval-mode to spawned child agents.
- Modify: `src/bus/agent-process.ts`
  - Honor eval-mode in child-process agent creation.
- Modify: `src/host/pricing-cache.ts`
  - Expose the pricing snapshot metadata needed for ATIF provenance if current helpers do not.
- Modify: `package.json`
  - Add binary build script(s) for Harbor packaging.
- Test: `test/host/cli.test.ts`
  - CLI parsing coverage for new headless-only flags.
- Test: `test/host/cli-headless.test.ts`
  - Headless runner coverage for recorder wiring and ATIF file output.
- Test: `test/host/atif/costs.test.ts`
  - Cost computation and provenance coverage.
- Test: `test/host/atif/event-mapper.test.ts`
  - Literal event-to-ATIF step mapping coverage.
- Test: `test/host/atif/recorder.test.ts`
  - Recorder flush behavior and root metadata coverage.
- Test: `test/genome/read-only-genome.test.ts`
  - Mutation-guard coverage.
- Test: `test/bus/spawner.test.ts`
  - Eval-mode propagation through spawn messages.
- Test: `test/bus/agent-process.test.ts`
  - Child-process eval-mode behavior.
- Test: `test/agents/factory.test.ts`
  - Eval-mode createAgent behavior.
- Test: `test/host/embedded-root.test.ts`
  - Embedded root extraction/versioning coverage.
- Test: `test/tools/harbor/sprout-artifacts.test.ts`
  - Syntax/shape checks for `tools/harbor/` artifacts from Bun tests.

## Chunk 1: Headless CLI Flags And Recorder Wiring

### Task 1: Add `--log-atif` and `--eval-mode` to the headless CLI grammar

**Files:**
- Modify: `src/host/cli-parse.ts`
- Modify: `src/host/cli-run.ts`
- Test: `test/host/cli.test.ts`

- [ ] **Step 1: Write failing parser tests for the new flags**

Add tests in `test/host/cli.test.ts` that assert:
- `sprout -p "solve" --log-atif /tmp/trajectory.json --eval-mode` parses as headless with both fields.
- `sprout --resume 01ABC -p "continue" --log-atif /tmp/trajectory.json` parses as headless continuation.
- `sprout --log-atif /tmp/trajectory.json` without `-p/--prompt` returns help.
- `sprout --eval-mode` without `-p/--prompt` returns help.
- `sprout --web -p "solve" --log-atif /tmp/t.json` returns help because interactive flags and headless flags cannot mix.

- [ ] **Step 2: Run the parser tests and verify they fail**

Run: `bun test test/host/cli.test.ts`

Expected: FAIL because the parser does not recognize `--log-atif` or `--eval-mode`.

- [ ] **Step 3: Extend the CLI command model**

Update `src/host/cli-parse.ts` so the `headless` command carries:
- `goal`
- `genomePath`
- optional `sessionId`
- optional `atifPath`
- optional `evalMode`

Keep the flags headless-only. Do not add compatibility shims for interactive mode.

- [ ] **Step 4: Update top-level dispatch to pass the new headless options through**

Modify `src/host/cli-run.ts` so parsed ATIF/eval options are passed into `runHeadlessMode(...)`.

- [ ] **Step 5: Run the parser tests and verify they pass**

Run: `bun test test/host/cli.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the CLI flag change**

```bash
git add src/host/cli-parse.ts src/host/cli-run.ts test/host/cli.test.ts
git commit -m "feat: add headless atif and eval flags"
```

### Task 2: Wire the headless runner so it can own an ATIF recorder

**Files:**
- Modify: `src/host/cli-headless.ts`
- Modify: `src/host/cli-bootstrap.ts`
- Test: `test/host/cli-headless.test.ts`

- [ ] **Step 1: Write failing headless-runner tests for ATIF recorder wiring**

Add tests in `test/host/cli-headless.test.ts` that assert:
- `runHeadlessMode(...)` can receive an `atifPath`.
- the headless runner constructs and closes a recorder around `runGoal(...)`.
- the headless runner passes `evalMode` into the shared runtime/bootstrap path.

- [ ] **Step 2: Run the headless tests and verify they fail**

Run: `bun test test/host/cli-headless.test.ts`

Expected: FAIL because the runner has no ATIF/eval-mode hooks.

- [ ] **Step 3: Thread ATIF/eval options through the headless runner and bootstrap contract**

Update `RunHeadlessOptions`, `SessionBootstrapOptions`, and the tests so the headless runner can:
- create the shared runtime
- subscribe an ATIF recorder to the event bus when `atifPath` is set
- pass `evalMode` into the runtime/factory path

Do not implement the recorder yet. Use an injected dependency seam so the tests can verify wiring first.

- [ ] **Step 4: Run the headless tests and verify they pass**

Run: `bun test test/host/cli-headless.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the runner wiring**

```bash
git add src/host/cli-headless.ts src/host/cli-bootstrap.ts test/host/cli-headless.test.ts
git commit -m "refactor: thread atif logging through headless runtime"
```

## Chunk 2: Literal ATIF Recorder And Cost Accounting

### Task 3: Implement local ATIF types and cost calculation

**Files:**
- Create: `src/host/atif/types.ts`
- Create: `src/host/atif/costs.ts`
- Modify: `src/host/pricing-cache.ts`
- Test: `test/host/atif/costs.test.ts`

- [ ] **Step 1: Write failing tests for pricing snapshot and ATIF step cost calculation**

Create `test/host/atif/costs.test.ts` covering:
- prompt + cached + completion token cost on a normal model
- OpenRouter model pricing using stripped/full ids
- provider-specific extra usage dimensions landing in `metrics.extra`
- provenance metadata including source and fetched-at timestamp

- [ ] **Step 2: Run the cost tests and verify they fail**

Run: `bun test test/host/atif/costs.test.ts`

Expected: FAIL because the ATIF cost module does not exist.

- [ ] **Step 3: Implement `src/host/atif/types.ts` and `src/host/atif/costs.ts`**

Define only the ATIF fields Sprout needs. Keep it local and explicit; do not pull Harbor Python models into the TypeScript runtime.

Implement cost helpers that accept:
- model id
- provider id
- usage counts
- pricing table snapshot metadata

If `src/host/pricing-cache.ts` does not currently expose fetched-at metadata, extend it minimally so the ATIF recorder can capture it.

- [ ] **Step 4: Run the cost tests and verify they pass**

Run: `bun test test/host/atif/costs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the ATIF cost layer**

```bash
git add src/host/atif/types.ts src/host/atif/costs.ts src/host/pricing-cache.ts test/host/atif/costs.test.ts
git commit -m "feat: add atif cost calculation"
```

### Task 4: Implement the literal event-mirror mapper and recorder

**Files:**
- Create: `src/host/atif/event-mapper.ts`
- Create: `src/host/atif/recorder.ts`
- Modify: `src/host/cli-headless.ts`
- Test: `test/host/atif/event-mapper.test.ts`
- Test: `test/host/atif/recorder.test.ts`
- Test: `test/host/cli-headless.test.ts`

- [ ] **Step 1: Write failing tests for one-step-per-event ATIF mapping**

Create `test/host/atif/event-mapper.test.ts` that asserts:
- every `SessionEvent` except `llm_chunk` maps to one ATIF step
- `perceive` at depth 0 maps to a `source: "user"` step with the goal message
- `plan_end` maps to a `source: "agent"` step with text, reasoning, and tool calls
- `llm_end` maps to a `source: "system"` step with token/cost metrics
- `primitive_end` and `act_end` map to observations
- original event payload is preserved in `extra`

- [ ] **Step 2: Write failing recorder tests**

Create `test/host/atif/recorder.test.ts` that asserts:
- the recorder writes a root ATIF object with metadata immediately
- each mirrored event append updates `trajectory.json`
- `llm_chunk` is excluded
- child-agent events are preserved in timestamp order with depth/identity metadata
- fatal completion still leaves a valid file on disk

- [ ] **Step 3: Run the ATIF tests and verify they fail**

Run:

```bash
bun test test/host/atif/event-mapper.test.ts test/host/atif/recorder.test.ts
```

Expected: FAIL because the mapper and recorder do not exist.

- [ ] **Step 4: Implement `event-mapper.ts`**

Map each non-`llm_chunk` `SessionEvent` directly to one ATIF step.

Rules to encode:
- `source` mapping from the spec
- raw Sprout event payload copied to `extra`
- event-specific enrichment for `plan_end`, `llm_end`, `primitive_end`, `act_end`, `warning`, `error`, and `interrupted`

- [ ] **Step 5: Implement `recorder.ts`**

Build a recorder that:
- owns the root ATIF object
- accepts live `SessionEvent`s
- appends one ATIF step per event
- recalculates final metrics incrementally
- writes `trajectory.json` atomically after each mirrored step

Do not build a post-hoc converter.

- [ ] **Step 6: Integrate the real recorder into the headless runner**

Replace the placeholder dependency seam from Task 2 with the real recorder and hook it to the host event bus used by headless runs.

- [ ] **Step 7: Run the ATIF and headless tests and verify they pass**

Run:

```bash
bun test test/host/atif/event-mapper.test.ts test/host/atif/recorder.test.ts test/host/cli-headless.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the ATIF recorder**

```bash
git add src/host/atif/event-mapper.ts src/host/atif/recorder.ts src/host/cli-headless.ts test/host/atif/event-mapper.test.ts test/host/atif/recorder.test.ts test/host/cli-headless.test.ts
git commit -m "feat: add headless atif event recorder"
```

## Chunk 3: Eval-Mode Hardening And Propagation

### Task 5: Enforce read-only genome semantics in eval mode

**Files:**
- Create: `src/genome/read-only-genome.ts`
- Modify: `src/agents/factory.ts`
- Modify: `src/kernel/primitives.ts`
- Test: `test/genome/read-only-genome.test.ts`
- Test: `test/agents/factory.test.ts`

- [ ] **Step 1: Write failing tests for eval-mode mutation blocking**

Create `test/genome/read-only-genome.test.ts` covering:
- `addAgent`, `updateAgent`, `addMemory`, `addRoutingRule`, `saveAgentTool`, `saveAgentFile`, `savePostscript`, and `rollbackCommit` all throw a clear eval-mode error through the wrapper.

Add tests in `test/agents/factory.test.ts` covering:
- eval mode does not create a `LearnProcess`
- eval mode does not expose workspace mutation primitives (`save_tool`, `save_file`, `save_agent`)
- normal mode behavior remains unchanged

- [ ] **Step 2: Run the genome/factory tests and verify they fail**

Run:

```bash
bun test test/genome/read-only-genome.test.ts test/agents/factory.test.ts
```

Expected: FAIL because no read-only wrapper or eval-mode gating exists.

- [ ] **Step 3: Implement the read-only genome wrapper and factory gating**

Add `src/genome/read-only-genome.ts` as the root-cause enforcement layer.

In `src/agents/factory.ts`:
- wrap the loaded genome in read-only mode when `evalMode` is true
- do not construct `LearnProcess` in eval mode

In `src/kernel/primitives.ts`:
- add a small option so workspace mutation primitives are omitted in eval mode instead of merely failing later

- [ ] **Step 4: Run the genome/factory tests and verify they pass**

Run:

```bash
bun test test/genome/read-only-genome.test.ts test/agents/factory.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the eval-mode guardrails**

```bash
git add src/genome/read-only-genome.ts src/agents/factory.ts src/kernel/primitives.ts test/genome/read-only-genome.test.ts test/agents/factory.test.ts
git commit -m "feat: enforce read-only eval mode"
```

### Task 6: Propagate eval mode into bus-spawned child agents

**Files:**
- Modify: `src/bus/types.ts`
- Modify: `src/bus/spawner.ts`
- Modify: `src/bus/agent-process.ts`
- Test: `test/bus/spawner.test.ts`
- Test: `test/bus/agent-process.test.ts`

- [ ] **Step 1: Write failing tests for child-agent eval-mode propagation**

Add tests that assert:
- spawn start messages include `eval_mode: true`
- child agent processes construct their agents in eval mode
- child agents do not create `LearnProcess`
- child agents inherit the same read-only genome semantics

- [ ] **Step 2: Run the bus tests and verify they fail**

Run:

```bash
bun test test/bus/spawner.test.ts test/bus/agent-process.test.ts
```

Expected: FAIL because start messages and agent-process wiring do not carry eval mode.

- [ ] **Step 3: Implement end-to-end eval-mode propagation**

Update:
- `StartMessage` in `src/bus/types.ts`
- `SpawnAgentOptions` and payload construction in `src/bus/spawner.ts`
- `runAgentProcess(...)` in `src/bus/agent-process.ts`

Do not add a secondary “maybe read-only” path. Propagate the explicit flag all the way through.

- [ ] **Step 4: Run the bus tests and verify they pass**

Run:

```bash
bun test test/bus/spawner.test.ts test/bus/agent-process.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit child-process eval-mode propagation**

```bash
git add src/bus/types.ts src/bus/spawner.ts src/bus/agent-process.ts test/bus/spawner.test.ts test/bus/agent-process.test.ts
git commit -m "feat: propagate eval mode to child agents"
```

## Chunk 4: Embedded Root Bundle And Binary Build

### Task 7: Generate and extract an embedded root bundle

**Files:**
- Create: `scripts/generate-embedded-root.ts`
- Create: `src/generated/embedded-root.ts`
- Create: `src/host/embedded-root.ts`
- Modify: `src/host/cli-run.ts`
- Test: `test/host/embedded-root.test.ts`

- [ ] **Step 1: Write failing tests for embedded-root extraction**

Create `test/host/embedded-root.test.ts` covering:
- extraction writes the expected files to a cache dir
- extraction is skipped when the embedded version/hash matches what is already on disk
- changing the embedded version/hash causes a refresh

- [ ] **Step 2: Run the embedded-root tests and verify they fail**

Run: `bun test test/host/embedded-root.test.ts`

Expected: FAIL because the embedded-root modules do not exist.

- [ ] **Step 3: Implement the generator and runtime extractor**

Create `scripts/generate-embedded-root.ts` to walk `root/` and emit `src/generated/embedded-root.ts`.

Create `src/host/embedded-root.ts` to:
- materialize the generated files into a managed cache directory
- return the extracted `rootDir`

Keep the format dead simple: a file list plus content strings and a bundle hash/version.

- [ ] **Step 4: Update runtime entrypoints to use the embedded root when a source-tree `root/` is not explicitly provided**

Modify `src/host/cli-run.ts` so the runtime uses:
- source-tree `root/` during normal repo development
- extracted embedded root when running as a built artifact

Do not remove explicit `rootDir` overrides.

- [ ] **Step 5: Run the embedded-root tests and verify they pass**

Run: `bun test test/host/embedded-root.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the embedded-root support**

```bash
git add scripts/generate-embedded-root.ts src/generated/embedded-root.ts src/host/embedded-root.ts src/host/cli-run.ts test/host/embedded-root.test.ts
git commit -m "feat: embed root genome bundle in binary builds"
```

### Task 8: Add a repeatable Harbor binary build

**Files:**
- Create: `scripts/build-sprout-binary.ts`
- Modify: `package.json`
- Test: `test/tools/harbor/sprout-artifacts.test.ts`

- [ ] **Step 1: Write failing artifact-shape tests**

Create `test/tools/harbor/sprout-artifacts.test.ts` that asserts:
- the build script path exists
- the Harbor adapter directory contains the expected filenames
- the build script targets `tools/harbor/dist/` for output

Keep these tests focused on artifact contract, not full binary compilation.

- [ ] **Step 2: Run the artifact tests and verify they fail**

Run: `bun test test/tools/harbor/sprout-artifacts.test.ts`

Expected: FAIL because the build script does not exist.

- [ ] **Step 3: Implement the build script and package.json entry**

Create `scripts/build-sprout-binary.ts` that:
- regenerates `src/generated/embedded-root.ts`
- compiles Sprout for `linux-x64` and `linux-arm64`
- writes outputs into `tools/harbor/dist/`

Add a `package.json` script such as:
- `build:harbor-agent`

Use Bun’s compile mode; do not invent a second packaging toolchain.

- [ ] **Step 4: Run the artifact tests and verify they pass**

Run: `bun test test/tools/harbor/sprout-artifacts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the binary build pipeline**

```bash
git add scripts/build-sprout-binary.ts package.json test/tools/harbor/sprout-artifacts.test.ts
git commit -m "build: add harbor binary packaging"
```

## Chunk 5: Harbor Installed-Agent Adapter

### Task 9: Add the Harbor adapter under `tools/harbor/`

**Files:**
- Create: `tools/harbor/sprout_agent.py`
- Create: `tools/harbor/install-sprout.sh.j2`
- Create: `tools/harbor/README.md`
- Test: `test/tools/harbor/sprout-artifacts.test.ts`

- [ ] **Step 1: Extend the artifact test with adapter/install-script expectations**

Add assertions that:
- `tools/harbor/sprout_agent.py` exists
- `tools/harbor/install-sprout.sh.j2` exists
- the adapter command includes:
  - `--prompt`
  - `--log-atif /logs/agent/agent-state/trajectory.json`
  - `--eval-mode`
  - `--genome-path /logs/agent/agent-state/genome`

For Python, keep the automated check to syntax/shape assertions from Bun tests plus a `python3 -m py_compile` shellout if `python3` is present.

- [ ] **Step 2: Run the artifact tests and verify they fail**

Run: `bun test test/tools/harbor/sprout-artifacts.test.ts`

Expected: FAIL because the Harbor adapter files do not exist.

- [ ] **Step 3: Implement the Harbor adapter**

Create `tools/harbor/sprout_agent.py` modeled on the Serf adapter, but keep it thin:
- install binary via the template
- run Sprout headlessly with the benchmark flags
- download `/logs/agent/agent-state`
- copy `trajectory.json` to the Harbor trial root

Create `tools/harbor/install-sprout.sh.j2` to:
- install benchmark-common packages
- copy the correct Sprout binary into `/usr/local/bin/sprout`
- configure `git safe.directory '*'`

Document usage in `tools/harbor/README.md`.

- [ ] **Step 4: Run the artifact tests and verify they pass**

Run: `bun test test/tools/harbor/sprout-artifacts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the Harbor adapter**

```bash
git add tools/harbor/sprout_agent.py tools/harbor/install-sprout.sh.j2 tools/harbor/README.md test/tools/harbor/sprout-artifacts.test.ts
git commit -m "feat: add harbor installed-agent adapter for sprout"
```

## Chunk 6: End-To-End Verification

### Task 10: Verify the full Sprout side locally

**Files:**
- Modify only if verification reveals a real bug

- [ ] **Step 1: Run focused verification for the new areas**

Run:

```bash
bun test test/host/cli.test.ts
bun test test/host/cli-headless.test.ts
bun test test/host/atif/costs.test.ts test/host/atif/event-mapper.test.ts test/host/atif/recorder.test.ts
bun test test/genome/read-only-genome.test.ts test/agents/factory.test.ts
bun test test/bus/spawner.test.ts test/bus/agent-process.test.ts
bun test test/host/embedded-root.test.ts
bun test test/tools/harbor/sprout-artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 2: Build Harbor binaries**

Run:

```bash
bun run build:harbor-agent
```

Expected: `tools/harbor/dist/` contains architecture-specific Sprout binaries.

- [ ] **Step 3: Run the full repo verification**

Run:

```bash
bun run check
bun run typecheck
bun test
bun run precommit
```

Expected: PASS.

- [ ] **Step 4: Commit any final bugfixes from verification**

```bash
git status --short
git add <only the files changed for real fixes>
git commit -m "fix: close atif harbor integration gaps"
```

### Task 11: Do one real Harbor smoke run

**Files:**
- No code changes unless the smoke test reveals a real bug

- [ ] **Step 1: Build the Harbor artifacts from the current tip**

Run:

```bash
bun run build:harbor-agent
```

- [ ] **Step 2: Launch one Harbor run against a single terminal-bench task using the new adapter**

Example shape:

```bash
cd inspo/harbor-runner
./launch.sh \
  --agent-dir /Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/tools/harbor \
  --agent-import-path sprout_agent:SproutAgent \
  --model <provider/model> \
  --benchmark terminal-bench@2.0 \
  --tasks 1 \
  --reps 1
```

Use a single task and single rep. The point is artifact validation, not benchmark throughput.

- [ ] **Step 3: Download the result and inspect the artifacts**

Verify:
- `trajectory.json` exists at the Harbor-visible trial root
- `agent-state/` contains Sprout logs and runtime artifacts
- Harbor viewer can read the trajectory
- ATIF token counts and `cost_usd` fields are populated

- [ ] **Step 4: If the smoke run reveals real defects, fix them with focused tests first**

For each bug:
- add a failing focused test
- implement the minimal fix
- rerun the focused test
- commit the fix before returning to the smoke path

- [ ] **Step 5: Commit the smoke-run closeout only if code changed**

```bash
git status --short
git add <only real code/doc fixes>
git commit -m "fix: harden harbor smoke path"
```


# Sprout ATIF Logging And Harbor Integration Design

**Date:** 2026-03-14

## Goal

Enable Sprout to run Harbor terminal-bench evaluations as an installed binary that:

- runs non-interactively from the command line
- emits a Harbor-compatible `trajectory.json` ATIF artifact during the run
- records accurate-enough token and cost metrics with documented provenance
- includes subagent activity in the root trajectory
- avoids copying the full Sprout repo into the benchmark container

This design is for benchmark runs only. Interactive sessions are out of scope.

## Decisions

- Add native Sprout ATIF logging behind an explicit `--log-atif <path>` CLI flag.
- Support ATIF logging only in headless runs.
- Emit one root `trajectory.json`.
- Flatten subagent activity into the root trajectory instead of depending on linked subagent trajectory files.
- Build a real Harbor installed-agent adapter for Sprout immediately.
- Ship a compiled Sprout binary with the root genome embedded in the artifact.
- Add an explicit benchmark mode that disables learning and genome mutation during eval runs.
- Compute ATIF `cost_usd` from a runtime pricing snapshot and recorded usage, and document that this is a pricing-table-derived estimate rather than invoice reconciliation.

## Why Native ATIF Logging

There are two plausible implementation shapes:

1. Convert Sprout's native JSONL logs into ATIF after the run.
2. Add a native ATIF recorder to the headless runtime and write `trajectory.json` as the run progresses.

The second approach is the right one.

Sprout already has a coherent semantic event stream for:

- user goals
- LLM turns
- tool calls and tool results
- delegations and subagent results

Those events are a better ATIF source of truth than Harbor-side reconstruction from log files. A native recorder keeps the transformation inside Sprout, lets the Harbor adapter stay thin, and avoids another split execution path like the oneshot/runtime problems we just finished removing.

This does not replace Sprout's existing logs. Native JSONL logs remain the debugging artifact. ATIF becomes an additional benchmark artifact.

## User-Facing CLI Contract

Sprout adds two benchmark-related flags to the existing headless CLI:

- `--log-atif <path>`
- `--eval-mode`

Supported forms:

- `sprout -p "solve the task" --log-atif /logs/agent/trajectory.json --eval-mode`
- `sprout --resume <id> -p "continue" --log-atif /path/to/trajectory.json --eval-mode`

Rules:

- `--log-atif` is only valid with headless `-p/--prompt` execution.
- `--log-atif` requires an explicit output path.
- `--eval-mode` is optional at the CLI level, but the Harbor adapter will always pass it.
- Interactive mode rejects `--log-atif`.

`--eval-mode` means:

- disable learn-process execution
- disable genome mutation writes
- disable mutation-producing genome tools
- keep normal workspace tools and task-oriented file edits intact

This keeps benchmark runs from mutating agent definitions or writing back learnings during the trial.

## Runtime Architecture

Sprout should add a small benchmark logging layer to the shared headless runtime instead of building a separate exporter command.

The core units are:

- `AtifRecorder`
  - subscribes to the session event stream from the start of the run
  - maintains one in-memory ATIF trajectory model
  - incrementally flushes `trajectory.json`
- `AtifEventMapper`
  - translates each Sprout event into exactly one ATIF step
  - preserves the full original event payload in ATIF step `extra`
- `AtifCostCalculator`
  - computes step and total `cost_usd` from usage plus a pricing snapshot
- `AtifRunMetadata`
  - records benchmark-mode, pricing provenance, provider/model identity, and embedded-genome metadata in root `extra`

The recorder should attach near the headless session runner, not the web/TUI layer and not a post-run log converter.

The important runtime rule is:

- the ATIF recorder observes the same live event stream that the rest of the session runtime uses
- it must capture child-agent events as they flow through the root session infrastructure

That keeps root and subagent logging on one coherent timeline.

## ATIF Mapping Semantics

Sprout should produce a literal mirror of the runtime event stream.

The rule is:

- emit one ATIF step for every Sprout `SessionEvent`
- preserve event order by timestamp
- exclude only `llm_chunk`

This means the ATIF file is a faithful run trajectory, not a semantic condensation of the run.

Every mirrored step should preserve the original Sprout event in `extra`, including:

- `sprout_kind`
- `sprout_agent_id`
- `sprout_depth`
- `sprout_data`

This preserves full-fidelity replay/debug information inside the Harbor artifact without depending on a separate converter.

### Root Metadata

The root ATIF object should contain:

- `schema_version: "ATIF-v1.6"`
- `session_id`
- `agent.name: "sprout"`
- `agent.version`
- default `model_name` when there is one stable root model
- `extra` with:
  - `sprout_session_id`
  - `eval_mode`
  - pricing snapshot source and timestamp
  - working directory
  - embedded genome version/hash
  - notes that the trajectory is a literal Sprout event mirror with `llm_chunk` omitted
  - notes that subagent activity is flattened into the root trajectory

### Step Mapping

The ATIF `steps` array should mirror Sprout events one-by-one.

Recommended source mapping:

- root `perceive` -> `source: "user"`
- `plan_end` -> `source: "agent"`
- all other mirrored events -> `source: "system"`

The root `perceive` event is the user-visible task submission for benchmark runs, so it should carry the prompt in `message`.

`plan_end` should remain the primary assistant-content step. It should carry:

- assistant text from `plan_end`
- reasoning from `plan_end`
- tool calls from `assistant_message`
- model name when available

Other mirrored steps should use `message` only when Sprout already provides a clear human-readable string. Otherwise the important information should stay in `extra`.

Every mirrored step should carry identity metadata in `extra`, including:

- `agent_id`
- `agent_name`
- `mnemonic_name` when available
- `parent_agent_id`
- `depth`
- `handle_id` when the child is bus-spawned
- `child_id`
- `delegation_call_id` when it can be resolved

This is intentionally a single-file representation. Sprout should not depend on `subagent_trajectory_ref` for v1.

### Event-Specific Enrichment

Although the mapping is literal, a few events should still populate structured ATIF fields in addition to raw `extra` data.

- `plan_end`
  - `message`
  - `reasoning_content`
  - `tool_calls`
- `llm_end`
  - `metrics.prompt_tokens`
  - `metrics.completion_tokens`
  - `metrics.cached_tokens`
  - `metrics.cost_usd`
  - `metrics.extra` for provider-specific usage such as cache-write tokens
- `primitive_end`
  - `observation.results` with the primitive output and error state
- `act_end`
  - `observation.results` with delegation output/result summaries
- `error`, `warning`, `interrupted`
  - human-readable `message` when Sprout provides one

This keeps the ATIF file faithful to Sprout's event stream while still making Harbor's trajectory tooling useful.

### Resumed Headless Runs

If a resumed headless run uses `--log-atif`, the trajectory should begin at the first mirrored event for that invocation. This design does not stitch multiple invocations into one ATIF file.

### Excluded Event

`llm_chunk` is the only excluded event kind.

The reason is practical rather than architectural:

- chunk-level streaming events would explode ATIF size
- Harbor's trajectory view is not the right place for token-stream deltas
- Sprout's native logs remain the better artifact for chunk-level debugging

All other `SessionEvent` kinds should be mirrored.

## Cost Accounting

ATIF cost fields should be populated from a runtime pricing snapshot plus recorded token usage.

The rule is:

- `prompt_tokens` = full prompt token count
- `cached_tokens` = cache-read subset when available
- `completion_tokens` = output tokens
- `cost_usd` = computed from the pricing snapshot and step usage

Because this is now a literal event mirror, cost metrics should live on mirrored `llm_end` steps rather than being reattached to `plan_end`.

For providers with extra usage dimensions that materially affect billing, the recorder should:

- use the most accurate available formula from Sprout's pricing data
- record provider-specific quantities in `metrics.extra`
- record the pricing provenance in root `extra`

This is a runtime estimate, not invoice reconciliation. The trajectory should say so explicitly in root metadata.

The design target is:

- accurate enough for Harbor cost reporting and comparison
- deterministic from recorded usage plus a pinned pricing snapshot

## Embedded Genome Packaging

The installed-agent path cannot rely on copying the full repo into the container.

Sprout should ship as:

- compiled Sprout binary
- embedded root genome bundle inside the build artifact

The embedded genome should be materialized to a managed on-disk location at runtime and used as the read-only root spec source.

The simplest design is:

- generate a build-time bundle of `root/` file contents and metadata
- compile that bundle into the Sprout binary
- extract it to a cache directory on first run or version change
- point Sprout's `rootDir` at that extracted bundle

This avoids teaching every agent/tool loader to read directly from an in-memory virtual filesystem.

The runtime genome remains separate from the embedded root bundle:

- root bundle: read-only shipped defaults
- genome path: runtime session/project state

For Harbor runs, the adapter should set `--genome-path` to a directory inside the preserved agent state area so all session logs and temp genome state stay under `/logs/agent/agent-state`.

## Harbor Adapter

Sprout needs a real installed-agent adapter, similar in shape to the Serf one.

The Harbor integration should include:

- a Python adapter class for Harbor's installed-agent interface
- an install script template
- architecture-specific Sprout binaries

The adapter should:

- install the Sprout binary into the container
- pass benchmark flags:
  - `--prompt`
  - `--log-atif /logs/agent/agent-state/trajectory.json`
  - `--eval-mode`
  - `--genome-path /logs/agent/agent-state/genome`
- provide provider secrets via environment variables or the existing Harbor secret path
- download the preserved Sprout state dir after the run
- copy `trajectory.json` to the Harbor trial root so the viewer sees it

The adapter should not upload the entire Sprout repo.

## Failure And Partial-Run Behavior

ATIF output should still be useful when a run fails.

The recorder should:

- flush the trajectory file incrementally after each mirrored step
- flush again at normal session completion
- attempt a final flush on fatal error paths

If a run fails before any agent step is completed, the trajectory may contain only:

- the mirrored early events
- one or more error/interruption steps describing the failure

That is acceptable and better than losing the artifact entirely.

## Non-Goals

This design does not include:

- interactive-mode ATIF logging
- separate per-subagent trajectory files as the primary artifact
- Harbor-side reconstruction from Sprout JSONL logs
- invoice-reconciled billing accuracy
- copying the full Sprout repo into the eval container

## Testing

Implementation should cover four layers.

### Sprout Unit Tests

- CLI parsing for `--log-atif` and `--eval-mode`
- headless runner wiring for ATIF recorder creation
- event-to-ATIF literal step mapping
- `llm_chunk` exclusion
- subagent flattening metadata
- cost calculation from pricing snapshot and usage
- eval-mode suppression of learning and genome mutation

### Sprout Integration Tests

- headless run with `--log-atif` writes a valid `trajectory.json`
- delegated run includes child-agent steps in the root trajectory
- every emitted non-chunk event appears as one ATIF step
- failure run still writes partial ATIF
- embedded genome extraction provides a runnable root bundle without repo files

### Harbor Adapter Tests

- install script installs the correct binary for container architecture
- adapter command line includes `--log-atif`, `--eval-mode`, and `--genome-path`
- adapter copies `trajectory.json` into the Harbor-visible logs root

### Real Smoke Test

- run one terminal-bench task through Harbor with installed Sprout binary
- confirm:
  - task executes
  - `trajectory.json` appears in the trial output
  - Harbor viewer renders the trajectory
  - token counts and cost fields are populated

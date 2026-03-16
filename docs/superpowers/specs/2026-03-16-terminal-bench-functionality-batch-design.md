# Terminal-Bench Functionality Batch Design

**Date:** 2026-03-16

## Goal

Broaden Sprout's evaluation from a single `nginx-request-logging` smoke test to a
small, deliberately diverse batch of terminal-bench tasks.

The goal is not to maximize the pass count. The goal is to expose the next
general workflow failures across different task shapes while keeping the run
shape fixed enough that failures remain attributable.

This batch should tell us whether the current prompt and delegation stack is
becoming broadly functional, or whether it is still fragile outside the nginx
systems-execution path.

## Why This Batch Exists

The nginx work already established three important facts:

- the Harbor adapter and installed Sprout binary can run real tasks
- the mixed model configuration (`gpt-5.4` plus `gpt-5-mini` for `fast`) is
  economically viable
- the remaining issues are mostly orchestration and helper-behavior problems,
  not packaging or infrastructure failures

What nginx does not tell us is whether those fixes generalize.

We need a short batch that exercises different task shapes so we can separate:

- general delegation/reporting defects
- exact-literal corruption
- monolithic-script brittleness
- over-reporting and transcript bloat
- task-specific failures

## Selected Task Set

Run exactly these four tasks first:

1. `git-leak-recovery`
2. `vulnerable-secret`
3. `log-summary-date-ranges`
4. `multi-source-data-merger`

Use these canonical Harbor task `path` selectors for the batch:

- `git-leak-recovery`
- `vulnerable-secret`
- `log-summary-date-ranges`
- `multi-source-data-merger`

These four were chosen for breadth, not because they are the top four easiest
tasks.

### Task Shape Coverage

- `git-leak-recovery`
  - git state repair and command discipline
- `vulnerable-secret`
  - exact-content and security-sensitive file editing
- `log-summary-date-ranges`
  - concise analysis/report generation from command output or files
- `multi-source-data-merger`
  - structured file and data transformation across multiple inputs

This set intentionally avoids another systems-config task in the first broadened
batch because nginx already gives us that signal.

## Fixed Run Shape

Run the batch as four separate local Harbor invocations, in the exact order
listed above.

Keep the runtime configuration fixed across the batch:

- dataset: `terminal-bench@2.0`
- Harbor fallback model: `openai/gpt-5.4`
- `best_model=openai:gpt-5.4`
- `balanced_model=openai:gpt-5.4`
- `fast_model=openai:gpt-5-mini`
- local Harbor runs first
- one trial per task invocation
- replay logging enabled

The purpose of fixing the run shape is to avoid confounding prompt/workflow
behavior with model-routing changes.

The batch should use task-specific job names and temp directories so artifacts
stay attributable. For each task, the run command should select exactly one task
with Harbor's task filter, not a multi-task local run. The selector must be the
canonical Harbor `path` string listed in this spec, not the display `name`, not
a substring, and not a wildcard. This avoids collisions with sample tasks such
as `sample/log-summary-date-ranges`.

## Batch Policy

Do not change prompts, code, or model routing in the middle of the first
broadened baseline batch.

The baseline batch means:

- run `git-leak-recovery`
- run `vulnerable-secret`
- run `log-summary-date-ranges`
- run `multi-source-data-merger`
- record the outcome of each run first
- only then decide which fixes deserve implementation

The only exception is infrastructure failure before Sprout produces usable
artifacts. If a run fails before it writes a root event log or `trajectory.json`,
stop and fix that infrastructure/runtime problem before continuing the batch,
because there is no comparable task signal yet.

An `INFRA_BLOCKED` attempt does not satisfy that task's baseline run. After the
infrastructure problem is fixed, rerun the same task and keep both records in
the notes:

- the blocked attempt
- the successful rerun or task-level failure

## Evaluation Method

For each task:

1. Run one local Harbor trial with the fixed mixed-model configuration.
2. Inspect the first meaningful replay branches before deciding on changes.
3. Classify the first real failure mode.
4. Record the outcome and the classification in the batch notes.

Each task must receive one primary outcome category. Use one of these buckets:

- `SUCCESS_PATH`
- delegation/context failure
- exact-literal or exact-output corruption
- monolithic-script brittleness
- over-reporting or transcript bloat
- verification sequencing failure
- task-specific domain failure
- infrastructure failure

Use `SUCCESS_PATH` only when the task passes. For failed or blocked runs, use
the most specific non-success category available. If none fit cleanly, the notes
should say so explicitly instead of forcing the wrong category.

Apply this precedence when multiple categories seem true:

1. `infrastructure failure`
2. `delegation/context failure`
3. `monolithic-script brittleness`
4. `exact-literal or exact-output corruption`
5. `verification sequencing failure`
6. `over-reporting or transcript bloat`
7. `task-specific domain failure`

Examples:

- If one brittle all-in-one script both breaks quoting and corrupts exact file
  contents, classify it as `monolithic-script brittleness`.
- If a task succeeds but returns a huge command transcript with no earlier
  execution defect, classify it as `over-reporting or transcript bloat`.
- If a parent coordinator chooses the wrong branching strategy and that drives
  the failure, classify it as `delegation/context failure` even if one leaf also
  contains a local mistake.

### Meaningful Branch Selection

Use one explicit rule so results stay comparable:

- If the task fails:
  - record the earliest branch that directly caused the final failed outcome or
    made the task impossible to complete
  - ignore exploratory dead ends that were superseded and did not affect the
    final outcome
- If the decisive failure is at a parent coordinator rather than one leaf
  branch, record the parent branch as the meaningful branch
- If the task passes:
  - record the highest-token branch that performed the core implementation
  - only fall back to the highest-token verification branch if implementation
    stayed trivial and verification is what dominated the successful path

This rule avoids mixing harmless false starts with the branch that actually
determined the run result.

## What Counts As Success

This batch is successful when:

- all four tasks have a completed baseline record
- each task has a recorded outcome and a concrete primary category
- replay artifacts are sufficient to explain the first meaningful failure or the
  successful path
- we can identify whether the same orchestration defects recur across multiple
  task shapes

A task passing with ugly token usage is still a useful result. The primary goal
is broad functionality and trustworthy diagnosis.

## Metrics To Record

For each task, record:

- reward or failure outcome
- agent execution duration
- total input and output tokens
- per-model token split when available from replay logs
- first meaningful failing branch or the clean success path
- the most likely root cause category

Estimated cost should be recorded, but treated as a secondary metric during this
batch.

### Required Per-Task Record

Each task entry in the running notes must include:

- task name
- run directory
- result: `PASS`, `FAIL`, or `INFRA_BLOCKED`
- reward if present
- total input and output tokens if present
- per-model token split, or `unavailable`
- chosen meaningful branch id/path
- root-cause category
- one short paragraph explaining why that branch was chosen

If a run has usable Harbor output but no per-model split, record the total
tokens and mark the split as unavailable. That is a valid result.

Treat Harbor outcomes this way:

- `PASS`
  - verifier reward is present and equal to `1.0`
- `FAIL`
  - verifier reward is present and not equal to `1.0`
  - or Sprout produced usable artifacts but the run still ended unsuccessfully
- `INFRA_BLOCKED`
  - Sprout did not produce a root event log or `trajectory.json`

If a run is infra-blocked before usable replay exists, record:

- task name
- run directory
- result: `INFRA_BLOCKED`
- the highest-level failure symptom available
- whether `trajectory.json` existed
- whether a root event log existed
- rerun required: `yes`

### Evaluable Artifact Set

A run is baseline-evaluable only if it has:

- Harbor `result.json` or an equivalent trial-level failure symptom
- a root event log JSONL
- at least one replay JSONL for the branch chosen as meaningful

The canonical branch identifier is:

- the relative path from the run's `logs/` directory to the chosen branch
  event-log `.jsonl`

When available, record the sibling replay-log path next to that identifier.

If a run has a root event log or `trajectory.json` but no replay JSONL for the
chosen branch, classify it as `INFRA_BLOCKED` for batch purposes and rerun after
the logging problem is fixed. Branch analysis is a required part of this batch.

## Non-Goals

This batch does not:

- optimize for minimum dollar cost
- change model routing between tasks
- add benchmark-specific agents
- declare the stack ready for large-scale AWS runs
- solve every failure inside the batch itself
- patch normal task-level defects before the four-task baseline batch is fully
  recorded

## Notes And Documentation

Continue recording outcomes in:

- `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`

That existing notes file already contains the current Harbor/local rerun
commands, token/cost baselines, and the recent nginx cycles. Keeping the
broadened batch in the same running notes file is simpler than splitting the
history across multiple near-duplicate docs.

# Terminal-Bench Functionality Batch Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a four-task local Harbor batch that broadens Sprout evaluation beyond nginx, record deterministic per-task diagnostics, and identify the next general functionality failures without changing prompts or model routing mid-batch.

**Architecture:** Reuse the existing local Harbor rerun workflow and replay logging instead of adding new harness code first. Treat the batch as four separate single-task runs with fixed model routing, a fixed ordering, and a fixed per-task notes format so outcomes remain comparable. Only after the full baseline batch is recorded do we decide which defects deserve fixes.

**Tech Stack:** Harbor local runner via `uv run harbor run`, Sprout installed-agent adapter under `tools/harbor`, replay JSONL and ATIF artifacts, Markdown notes under `docs/superpowers/`.

---

## File Map

- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`
  - Add one structured entry per task run, including task selector, run directory, outcome, branch identifier, category, and concise diagnosis.
- Reference: `docs/superpowers/specs/2026-03-16-terminal-bench-functionality-batch-design.md`
  - Source of truth for batch policy, selectors, and evaluation rules.

## Chunk 1: Lock The Batch Contract In The Notes

### Task 1: Add a fixed batch header to the running notes

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`
- Reference: `docs/superpowers/specs/2026-03-16-terminal-bench-functionality-batch-design.md`

- [ ] **Step 1: Add a `Functionality Batch` section to the notes**

Add a section that states:
- exact task order:
  - `git-leak-recovery`
  - `vulnerable-secret`
  - `log-summary-date-ranges`
  - `multi-source-data-merger`
- exact Harbor task name selectors within dataset `terminal-bench@2.0`:
  - `git-leak-recovery`
  - `vulnerable-secret`
  - `log-summary-date-ranges`
  - `multi-source-data-merger`
- fixed model routing:
  - fallback `openai/gpt-5.4`
  - `best_model=openai:gpt-5.4`
  - `balanced_model=openai:gpt-5.4`
  - `fast_model=openai:gpt-5-mini`
- policy:
  - no prompt/code/model changes until all four baseline task records exist
  - `INFRA_BLOCKED` runs must be rerun and both attempts remain in the notes

- [ ] **Step 2: Add a per-task notes template**

Add a copy-paste template with these fields:
- task name
- selector
- run directory
- result: `PASS` | `FAIL` | `INFRA_BLOCKED`
- reward
- duration
- total input/output tokens
- per-model split or `unavailable`
- estimated cost or `unavailable`
- meaningful branch id/path
- replay log path or `missing`
- primary category
- short rationale

- [ ] **Step 3: Commit the notes-structure update**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: add functionality batch tracking template"
```

## Chunk 2: Run And Record The Four Baseline Tasks

### Task 2: Run `git-leak-recovery` and record the result

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`
- Reference: `docs/superpowers/specs/2026-03-16-terminal-bench-functionality-batch-design.md`

- [ ] **Step 1: Launch the local Harbor run for `git-leak-recovery`**

From repo root:

```bash
tmpdir=$(mktemp -d /tmp/harbor-local-git-leak-recovery.XXXXXX)
set -a
source .env
set +a
export PYTHONPATH="/Users/jesse/Documents/GitHub/prime-radiant-inc/sprout/tools/harbor${PYTHONPATH:+:$PYTHONPATH}"
cd inspo/harbor
uv run harbor run \
  --job-name sprout-batch-git-leak-recovery \
  --jobs-dir "$tmpdir" \
  --orchestrator local \
  -n 1 \
  -k 1 \
  --agent-import-path sprout_agent:SproutAgent \
  -m openai/gpt-5.4 \
  --ak best_model=openai:gpt-5.4 \
  --ak balanced_model=openai:gpt-5.4 \
  --ak fast_model=openai:gpt-5-mini \
  -d terminal-bench@2.0 \
  -t git-leak-recovery \
  -l 1
```

Expected:
- one local Harbor job directory under `$tmpdir`
- one single-task trial directory

- [ ] **Step 2: Determine the batch record for `git-leak-recovery`**

Inspect:
- Harbor `result.json`
- root event log
- chosen branch event log
- replay log for the chosen branch

Apply the spec rules:
- `PASS` only if the run is baseline-evaluable and reward is exactly `1.0`
- `FAIL` if the run is baseline-evaluable and not `PASS`
- `INFRA_BLOCKED` if the run is not baseline-evaluable

- [ ] **Step 3: Add the `git-leak-recovery` record to the notes**

Use the per-task template from Chunk 1.

- [ ] **Step 4: Commit the recorded `git-leak-recovery` result**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: record git leak recovery batch result"
```

### Task 3: Run `vulnerable-secret` and record the result

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`

- [ ] **Step 1: Launch the local Harbor run for `vulnerable-secret`**

Run the same command shape as Task 2, changing only:

```bash
tmpdir=$(mktemp -d /tmp/harbor-local-vulnerable-secret.XXXXXX)
...
  --job-name sprout-batch-vulnerable-secret \
...
  -t vulnerable-secret \
```

- [ ] **Step 2: Determine the task record using the same rules**

Collect:
- reward/outcome
- duration
- total tokens
- per-model split or `unavailable`
- meaningful branch identifier
- replay path or `missing`
- primary category

- [ ] **Step 3: Add the `vulnerable-secret` record to the notes**

- [ ] **Step 4: Commit the recorded `vulnerable-secret` result**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: record vulnerable secret batch result"
```

### Task 4: Run `log-summary-date-ranges` and record the result

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`

- [ ] **Step 1: Launch the local Harbor run for `log-summary-date-ranges`**

Run the same command shape, changing only:

```bash
tmpdir=$(mktemp -d /tmp/harbor-local-log-summary-date-ranges.XXXXXX)
...
  --job-name sprout-batch-log-summary-date-ranges \
...
  -t log-summary-date-ranges \
```

Expected:
- the selected task name resolves within dataset `terminal-bench@2.0`
- no wildcard selection is used

- [ ] **Step 2: Verify the task selection in the trial config**

Before analyzing the run, confirm the trial/config points at dataset
`terminal-bench@2.0` and task name `log-summary-date-ranges`. If selection did
not resolve as intended, record the run as `INFRA_BLOCKED`, note the selector
issue, and rerun with a corrected selection mechanism before continuing.

- [ ] **Step 3: Determine and record the result**

Apply the same artifact and category rules as Tasks 2 and 3.

- [ ] **Step 4: Commit the recorded `log-summary-date-ranges` result**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: record log summary date ranges batch result"
```

### Task 5: Run `multi-source-data-merger` and record the result

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`

- [ ] **Step 1: Launch the local Harbor run for `multi-source-data-merger`**

Run the same command shape, changing only:

```bash
tmpdir=$(mktemp -d /tmp/harbor-local-multi-source-data-merger.XXXXXX)
...
  --job-name sprout-batch-multi-source-data-merger \
...
  -t multi-source-data-merger \
```

- [ ] **Step 2: Determine and record the result**

Apply the same artifact and category rules as the earlier tasks.

- [ ] **Step 3: Commit the recorded `multi-source-data-merger` result**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: record multi source data merger batch result"
```

## Chunk 3: Synthesize The Batch Before Any Fixes

### Task 6: Write the cross-task synthesis section

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md`
- Reference: `docs/superpowers/specs/2026-03-16-terminal-bench-functionality-batch-design.md`

- [ ] **Step 1: Add a `Batch Synthesis` section after the four task records**

Summarize:
- which tasks passed
- which tasks failed
- which tasks were infra-blocked and rerun
- which primary categories recurred across multiple tasks
- which defects look general versus task-specific

- [ ] **Step 2: Add a ranked shortlist of follow-up fixes**

Rank by generality:
- first: defects that appear in multiple task shapes
- second: severe single-task defects that block broad functionality
- last: cost/reporting polish issues

- [ ] **Step 3: Commit the synthesis**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: summarize terminal bench functionality batch"
```

## Chunk 4: Verify The Batch Deliverable

### Task 7: Verify the notes are complete and deterministic

**Files:**
- Modify: `docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md` if fixes are needed

- [ ] **Step 1: Check that all four tasks have baseline records**

Verify the notes file contains entries for:
- `git-leak-recovery`
- `vulnerable-secret`
- `log-summary-date-ranges`
- `multi-source-data-merger`

- [ ] **Step 2: Check that each entry contains the required fields**

Each task must include:
- result
- duration
- run directory
- tokens
- estimated cost or `unavailable`
- per-model split or `unavailable`
- meaningful branch id/path
- replay path or `missing`
- primary category
- rationale paragraph

- [ ] **Step 3: Fix any missing fields and commit if needed**

```bash
git add docs/superpowers/plans/2026-03-15-harbor-mixed-model-improvement-notes.md
git commit -m "docs: complete functionality batch records"
```

- [ ] **Step 4: Report completion**

State:
- whether the four-task baseline batch is complete
- the recurring top categories
- the recommended first follow-up fix area

# Capture-all tool outputs — unify the three output gates

**Date:** 2026-07-21
**Status:** design v2 (redrafted after fresh-eyes review; awaiting Jesse's go)
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (capture/splice, §2),
`2026-07-19-sap-completion-and-roadmap-design.md` (data plane)
**Evidence:** `test/integration/code-mode-advantage.test.ts` (the structural wins, measured)

## Purpose

Every model-facing output boundary should capture the same way: above a svelte, configurable
budget, the full raw content becomes a store value and the model gets a bounded preview +
`⟦ref⟧`; at or below budget it stays inline. Today that behavior exists **three times, each
slightly different**, and the differences are the problem:

| gate | where | trigger | budget | redacts? |
|---|---|---|---|---|
| primitive capture-on-truncation | `primitives.ts` `createPrimitiveRegistry.execute` | lossy truncation | 50 KB `read_file`, 30 KB `exec`/`fetch`, 20 KB `grep`/`glob` (`DEFAULT_CHAR_LIMITS`) | **no** |
| child-boundary auto-bind | `agent-process.ts` `prepareResultOutput` | result over budget | `SUMMARY_BUDGET_CHARS` = 4,000 chars | **no** |
| cell transcript gate | `cell-host.ts` `gateForTranscript` | output over threshold | `CELL_AUTO_BIND_THRESHOLD` = 2,000 chars | yes |

This is a **unification, not a greenfield feature**: one shared gate, one budget table (svelte
by default, configurable), one marker format, redaction at every gate — while preserving each
existing gate's hard-won behaviors (listed per-gate below; they are requirements, not
incidentals).

## Why now

Measured, from `code-mode-advantage.test.ts` and the byte instrumentation (2026-07-21):

- Processing a ~100 KB log: a code-mode cell returns **15 bytes** to the model; the traditional
  `read_file` puts **50,220 bytes** into the payload — **~3,300× more model-facing bytes**.
- Relaying confidential content: code mode never exposes it; `read_file` returns it verbatim
  into the payload, and pattern-based redaction does not recognize it.

The gaps, stated precisely against the code as it exists:

1. **Primitive budgets are so large the gate almost never fires.** Capture triggers only on
   lossy truncation at 20–50 KB. A 20 KB API response or a 10 KB log flows fully inline into
   the payload; nothing is captured, nothing is a reusable ref.
2. **The child boundary already captures — but on its own terms.** `prepareResultOutput`
   auto-binds + publishes any child result over 4,000 chars and sends the head + `⟦name⟧`
   marker (sap spec §2 Auto-bind). It works, but its budget is a hardcoded constant outside
   any shared table, its marker wording differs, and it does not redact. Fan-out orchestration
   already benefits from it; convergence makes it tunable and consistent, not new.
3. **Only the cell gate redacts.** Primitive outputs and child results reach the transcript
   unredacted today (`redactSensitiveTranscriptContent` is imported by value-primitives, cell
   paths, and telemetry — never by `primitives.ts` or the child result path). Content-agnostic
   capture narrows the leak surface, but the redaction pass itself should also be uniform.

## The wins

1. **Reuse without reflow.** Every substantial tool output becomes a splice-able `⟦ref⟧`;
   relaying or re-using it (into a write, a cell, another agent) never re-floods the payload.
2. **Leak-proof by default.** Capture is content-agnostic — it keeps ALL captured bytes out of
   the payload, where redaction only catches recognized patterns (the `code-mode-advantage`
   Scenario 2 finding). Plus: redaction extends to the two gates that lack it today.
3. **Orchestrator scaling.** The child boundary already bounds sub-results at 4,000 chars +
   ref; unification brings the same discipline to every primitive an orchestrator's turns
   accumulate, and makes all the budgets one tunable surface.

## Goals

1. One shared gate helper used by all three boundaries; behavior differences become data (the
   budget table), not code.
2. Svelte, configurable budgets (Jesse, 2026-07-21): capture fires at ~2,000 chars, not 20–50 KB.
3. Redaction at every gate — an explicit behavior CHANGE for primitives and child results.
4. Stored values are the RAW source (faithful splices); everything model-facing is redacted.
5. One canonical marker format across all three gates.

## Non-goals

- New scope semantics. The child boundary KEEPS its existing bind-under-child-identity +
  publish flow (that is how the parent sees the value today; it works and is already spec'd).
  The earlier draft's parent-scope binding is dropped.
- Renaming captured values. Existing schemes stay: `<primitive>_output` (primitives),
  goal-slug `_result` (child boundary), `cell_<n>_return` (cells). The unification is the
  gate, not the names.
- Changing what the cell gate shows (it is already the svelte reference behavior).

## Design

### The shared gate

One kernel helper (beside `truncation.ts`) that all three boundaries call:

```
gateOutput(boundary, rawSource, renderedOutput, captureStore, opts):
    redacted = redact(renderedOutput)
    budget   = previewBudget(boundary)        # defaults ⊕ SPROUT_PREVIEW_BUDGETS ⊕ opts.overrides
    pass     = truncateToolOutputDetailed(redacted, boundary, {charLimit: budget})
    if not pass.truncated:                    # fits → inline (no capture)
        return redacted
    value    = captureStore.bind(<boundary's naming scheme>, rawSource, explicit: false)
    return render(pass, marker(value))        # preview shaped by the tool's mode + line limits
```

Key points, each preserving existing behavior:

- **The preview is shaped by the existing truncation machinery**, not a naive head slice:
  per-tool modes survive (`head_tail` for `exec`/`read_file`/`fetch` — the error at the tail
  of a build log stays visible) and per-tool line limits survive (`exec` 256, `grep` 200,
  `glob` 500). The budget replaces `DEFAULT_CHAR_LIMITS` as the char trigger; `DEFAULT_MODES`
  and `DEFAULT_LINE_LIMITS` keep shaping what is shown. A line-limit cut also triggers
  capture, exactly as it triggers capture-on-truncation today.
- **The stored value is the SOURCE, not the rendering.** Primitives bind
  `result.captureSource.content` (the true file/command bytes) — that is what makes splices
  faithful. A primitive with no `captureSource` degrades to honest truncation with no marker,
  as today.
- **Redact-then-gate**, as the cell gate does: the threshold applies to the redacted text;
  the stored value is raw.

### Behaviors each gate keeps (requirements)

From the primitive gate (`primitives.ts:94–168`):

- **No double-store**: a primitive that already explicitly bound its source (`boundValues`)
  gets a marker naming the existing value; the gate never binds a second copy.
- **Stderr companion**: `exec` stderr the preview dropped binds as its own value; the marker
  names both.
- **`value_*` exclusion**: value-read primitives never re-capture — their output already comes
  from the store; re-capturing would chain refs.
- **Honest degradation**: store-full / bind-failure yields `[... truncated; content not
  captured]` — never a marker naming a value that does not exist.

From the child boundary (`agent-process.ts:828–855`):

- Bind under the **child's** identity with `origin: {kind: "delegation"}`, then **publish** —
  the parent's visibility path, unchanged.
- Goal-slug naming (`resultValueName`), unchanged.
- The 30,000-char inline fallback when bind/publish fails, unchanged.

From the cell gate (`cell-host.ts:389–406`): redact-then-threshold ordering, and the marker
format (which becomes the canonical one, below).

### Budgets — svelte by default, configurable

**Decision (Jesse, 2026-07-21): previews are svelte but configurable.** The unconditional wins
(reuse, no-leak, orchestrator scaling) come from always creating the ref; the budget only sets
how much the model reads for free before reaching for the ref (or a cell). Budgets are
**chars** (every comparison in the code is `.length`), one record with few exceptions:

- **`default`: 2,000** — the cell gate's scale (`CELL_AUTO_BIND_THRESHOLD` folds into this
  record as the `cell` boundary's entry). Covers `exec`, `grep`, `glob`, `fetch`, and any
  future tool.
- **`read_file` / `edit_file` / `apply_patch`: 4,000** — the code-editing path, where the
  model must see the region it is changing; targeted re-reads (`read_file` offset/limit)
  cover files past the budget.
- **`delegate`: 4,000** — the child's answer is the one output the parent must actually reason
  over; this preserves `SUMMARY_BUDGET_CHARS` exactly.
- **`write_file`: 1,000** — a confirmation message; preserves today's limit (the 2,000 default
  would *raise* it).

#### Configurability

Follows the existing tunable patterns (`DEFAULT_CHAR_LIMITS` record + per-call `overrides` in
`truncation.ts`; `SPROUT_SESSION_MAX_*` env resolution in `session-budget.ts`):

- `DEFAULT_PREVIEW_BUDGETS` — the record above, beside `DEFAULT_CHAR_LIMITS`.
- `SPROUT_PREVIEW_BUDGETS` — one env var holding a JSON map merged over the defaults, e.g.
  `{"default": 4000, "read_file": 16000}`. Resolved once per process at startup,
  `session-budget.ts`-style: an invalid value warns and falls back (never crashes a session).
  Spawned agent processes read it from their own environment, which they inherit at launch —
  note Bun.spawn snapshots env at startup, so runtime `process.env` mutation does NOT
  propagate; evals and tests must use the programmatic override channel, not env mutation.
- Programmatic override threading (registry options, like `overrides?.charLimit` today) for
  evals and tests.

### The canonical marker

One format, all three gates (today: primitives say "full output:", the child boundary says
"full output:" with different framing, cells say "full content:"):

```
[... <N chars|N lines> truncated — full content: ⟦name⟧]
```

with the stderr companion appending `, stderr: ⟦name⟧`, and the degradation forms
`[... <dropped> truncated; store full — content not captured]` / `; capture failed — …`.
"full content:" wins because the cell gate and the scenario-3 e2e test already match on it;
agents pattern-match markers, so convergence is itself a feature. Prompts/genomes that
reference the old wordings get surveyed in the phase that touches their gate.

## Invariants

- An output at or below its budget reaches the model **identical to today except redaction**
  (the one deliberate change on the inline path) — line limits and modes still apply.
- A captured value's stored content is the exact raw SOURCE; splicing `⟦ref⟧` reproduces it.
- Nothing above budget crosses to the model except the redacted, mode-shaped preview + marker.
- No double-store; no marker ever names a value that does not exist.
- The child boundary's bind-and-publish visibility semantics are unchanged.

## Phases

**P1 — Shared gate + primitives.** Extract the shared gate into the kernel (built on
`truncateToolOutputDetailed`); primitives adopt it: budgets replace `DEFAULT_CHAR_LIMITS` as
the capture trigger, redaction added to the primitive output path (explicit change), canonical
marker, budget resolver (`DEFAULT_PREVIEW_BUDGETS` ⊕ `SPROUT_PREVIEW_BUDGETS` ⊕ overrides).
TDD; update the primitive/truncation tests that assert inline content, each move recorded.
Fable review.

**P2 — Child boundary converges.** `prepareResultOutput` becomes a caller of the shared gate,
keeping child-identity bind + publish, goal-slug naming, and the inline fallback; its budget
comes from the record (`delegate`); redaction added; canonical marker. Tests: over-budget
sub-result → preview + ref in the parent's payload; ref splices to the exact full result;
fallback path unchanged. Fable review.

**P3 — Cell gate adopts + tune + prove.** `gateForTranscript` becomes a caller of the shared
gate (budget = the record's `cell` entry; behavior byte-identical, asserted). Re-run
`code-mode-advantage`-style byte measurement across tool mode (capture on vs off); tune
budgets; add an e2e scenario proving an N-way fan-out keeps the orchestrator payload flat.
Fable review.

## Acceptance

1. Every boundary's over-budget output is captured and returned as redacted preview + `⟦ref⟧`;
   at or below budget, inline (redacted) with today's line/mode shaping.
2. A sub-result over budget never appears in full in the orchestrator's provider payload; its
   ref splices to the exact full result.
3. `⟦ref⟧` from any captured output splices faithfully into a `write_file` / cell.
4. Stored values raw; every model-facing render redacted — including the two paths that were
   not redacted before.
5. One marker format everywhere; the preserved behaviors (no-double-store, stderr companion,
   `value_*` exclusion, honest degradation, child publish, fallback) each hold under test.
6. Full suite green, with inline-output assertion churn resolved honestly, each recorded.

## Risks (honest)

- **Broad blast radius.** Every agent sees previews + refs on outputs that used to be inline
  up to 20–50 KB; tests asserting inline content move. Mitigated by phasing and by the gate
  logic already existing at all three boundaries.
- **Code-editing regression** if budgets are too tight — the deliberate cost of svelte
  defaults. Mitigated by the read/edit exception (4,000), targeted re-reads, and
  `SPROUT_PREVIEW_BUDGETS`.
- **Redaction on the hot inline path** is new for primitives — a regex pass over every tool
  output. The patterns are few and anchored; if profiling ever shows it, it shows up in the
  bench harness, not in guesswork.
- **Genome prompt assumptions.** Prompts may assume full tool output or match old marker
  wording. Surveyed per phase, at the gate that phase touches.

## Open questions (for the P1 review, not blockers)

- Adaptive budgets (e.g., larger when the agent's task is flagged code-editing)? Static
  defaults + `SPROUT_PREVIEW_BUDGETS` cover per-deployment tuning; revisit only if
  code-editing regresses under the svelte defaults.
- A hard "always ref, no preview" mode for a maximally-locked-down agent? Out of scope; the
  shared gate makes it a one-line future option.

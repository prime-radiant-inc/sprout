# Capture-all tool outputs — unify the three output gates

**Date:** 2026-07-21
**Status:** design v3 (v2 survived adversarial review with 14 confirmed findings, all folded in;
awaiting Jesse's go)
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
| primitive capture-on-truncation | `primitives.ts` `createPrimitiveRegistry.execute` | lossy truncation (char OR line limits) | `DEFAULT_CHAR_LIMITS`: 50 KB `read_file`, 30 KB `exec`/`fetch`, 20 KB `grep`/`glob`, 10 KB `edit_file`/`apply_patch`, 1 KB `write_file`; line limits `exec` 256 / `grep` 200 / `glob` 500 | **no** |
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

1. **Primitive budgets are large for exactly the high-volume tools.** Capture fires on lossy
   truncation — char limits (20–50 KB for `read_file`/`exec`/`fetch`/`grep`/`glob`) or line
   limits (`exec` 256, `grep` 200, `glob` 500; a 10 KB 300-line exec output does capture
   today). But a 20 KB single-line API response or a 10 KB 200-line log flows fully inline:
   nothing captured, nothing a reusable ref.
2. **Only the subprocess delegation path captures.** `prepareResultOutput` auto-binds +
   publishes a subprocess child's result over 4,000 chars and sends the head + `⟦name⟧`
   marker (sap spec §2 Auto-bind) — but it runs only in the agent-subprocess entry path.
   **Featherweight children** (`spawner.ts` `runFeatherweight`) return raw `exec.output` with
   no bind and no budget, and the **in-process delegation fallback** (`agent.ts` ~1500) is the
   same; both then hit the parent's `truncateToolOutput(output, agent_name)`, where an agent
   name is never a char-limit key, so the 30,000-char fallback applies — up to 30 KB of
   sub-result inline in the orchestrator's payload, uncaptured.
3. **Only the cell gate redacts.** Primitive outputs and child results reach the transcript
   unredacted today (`redactSensitiveTranscriptContent` is imported by value-primitives, cell
   paths, and telemetry — never by `primitives.ts` or the child result path).

## The wins

1. **Reuse without reflow.** Every substantial capture-capable output becomes a splice-able
   `⟦ref⟧`; relaying or re-using it (into a write, a cell, another agent) never re-floods the
   payload.
2. **Leak-proof for captured bytes.** Capture is content-agnostic — it keeps ALL over-budget
   bytes out of the payload, where redaction only catches recognized patterns (the
   `code-mode-advantage` Scenario 2 finding). Honest limitation: content at or below budget
   still rides inline, so sub-budget confidential content (Scenario 2's memo is ~180 chars)
   is NOT protected by this mechanism — code mode remains the answer there. Redaction also
   extends to the two gates that lack it today.
3. **Orchestrator scaling.** The subprocess boundary already bounds sub-results at 4,000
   chars + ref; unification extends that to featherweight and in-process delegation and to
   every primitive an orchestrator's turns accumulate, with all the budgets one tunable
   surface.

## Goals

1. One shared gate helper used by all three boundaries — including all three delegation
   flavors; behavior differences become data (the budget/mode table), not code.
2. Svelte, configurable budgets (Jesse, 2026-07-21): capture fires at ~2,000 chars, not
   20–50 KB.
3. Redaction at every gate — an explicit behavior CHANGE for primitives and child results.
4. Stored values are the RAW source (faithful splices); everything model-facing is redacted.
5. One canonical marker format across all three gates.

## Non-goals

- New scope semantics. Delegation results KEEP the existing bind-under-child-identity +
  publish flow (that is how the parent sees the value today; it works and is already spec'd).
- Renaming captured values. Existing schemes stay: `<primitive>_output` (primitives),
  goal-slug `_result` (delegation), `cell_<n>_output` / `cell_<n>_return` (cells). The
  unification is the gate, not the names.
- Changing what any gate shows below its budget, beyond the redaction pass.
- **Changing flag-off behavior.** With the data plane off there is no capture store and no
  refs to reach for; svelte truncation would destroy information with no compensation. Budgets
  apply ONLY when a capture store is present; flag-off sessions keep today's
  `DEFAULT_CHAR_LIMITS` truncation unchanged.

## Design

### The shared gate

One kernel helper (beside `truncation.ts`) that all boundaries call. The boundary supplies its
capture step as a callback, because the boundaries' capture contracts differ (primitives bind;
delegation binds AND publishes):

```
gateOutput(boundary, renderedOutput, capture, opts):
    redacted = redact(renderedOutput)
    budget   = previewBudget(boundary)        # defaults ⊕ SPROUT_PREVIEW_BUDGETS ⊕ opts.overrides
    pass     = truncateToolOutputDetailed(redacted, boundary, {charLimit: budget})
    if not pass.truncated:                    # fits → inline (no capture)
        return redacted
    value    = capture()                      # boundary-supplied: bind(raw source) [+ publish]
    if capture failed (any step):             # honest degradation — never a marker naming a
        return render(pass, degradation banner)   # value the reader cannot see
    return render(pass, marker(value))        # preview shaped by the boundary's mode + line limits
```

Key points:

- **The capture callback is all-or-nothing.** For primitives it binds the raw source; for
  delegation it binds under the child's identity AND publishes. If ANY step fails (bind,
  publish, store full), the gate degrades to the marker-less honest form. A bind that
  succeeds but a publish that fails must NOT produce a marker — an unpublished child-scope
  value is invisible to the parent, and a marker naming an invisible value is a lie.
- **The preview is shaped by the truncation machinery with an explicit per-boundary mode.**
  `TruncationMode` today is `head_tail | tail`; the gate adds a third, **`head`** (head slice
  + trailing marker) — which is what BOTH the cell gate and the child boundary already emit.
  Assignments: primitives keep their `DEFAULT_MODES` entries (`head_tail` for
  `exec`/`read_file`/`fetch` — the error at the tail of a build log stays visible; `tail` for
  the rest); `cell` and `delegate` use `head`, preserving their current preview shapes
  exactly. Per-tool line limits survive (`exec` 256, `grep` 200, `glob` 500), and a
  line-limit cut also triggers capture, as it does today.
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
  names both. The containment predicate MOVES to redacted space (redacted stderr vs redacted
  preview) — today's raw-vs-preview check (`primitives.ts:134–137`) would false-positive
  under redact-then-gate whenever stderr contains a redactable token, binding a spurious
  companion.
- **`value_*` exclusion**: value-read primitives never re-capture — their output already comes
  from the store; re-capturing would chain refs.
- **Honest degradation**: store-full / bind-failure yields `[... truncated; content not
  captured]` — never a marker naming a value that does not exist.

From the delegation boundary (`agent-process.ts:828–855`):

- Bind under the **child's** identity with `origin: {kind: "delegation"}`, then **publish** —
  the parent's visibility path, unchanged.
- Goal-slug naming (`resultValueName`), unchanged.
- The 30,000-char inline fallback when bind/publish fails, unchanged (a documented exception
  to the invariants, below).

From the cell gate (`cell-host.ts:389–406`): redact-then-threshold ordering, the head-slice
preview shape (now the `head` mode), and the marker format (which becomes the canonical one).

### Delegation covers all three flavors

P2 routes ALL delegation results through the shared gate with the same child-identity
bind + publish contract:

- **Subprocess**: `prepareResultOutput` becomes a gate caller (it already has the store and
  the child handle).
- **Featherweight**: `runFeatherweight` (`spawner.ts:904–969`) gains the same call before
  returning its `ResultMessage` — it runs in the parent process where the spawner's store
  access lives, and the child has a handle identity.
- **In-process fallback** (`agent.ts` ~1500): same.

The parent-side `truncateToolOutput(output, agent_name)` rendering stays as a backstop, but
after P2 a gated result is already preview-sized when it reaches it.

### Budgets — svelte by default, configurable

**Decision (Jesse, 2026-07-21): previews are svelte but configurable.** The unconditional wins
(reuse, no-leak, orchestrator scaling) come from always creating the ref; the budget only sets
how much the model reads for free before reaching for the ref (or a cell). Budgets are
**chars** (every comparison in the code is `.length`), one record with few exceptions:

- **`default`: 2,000** — the cell gate's scale (`CELL_AUTO_BIND_THRESHOLD` folds into this
  record as the `cell` entry). Covers `exec`, `grep`, `glob`, `fetch`, `edit_file`,
  `apply_patch` (the latter two emit one-line confirmations — "Replaced N occurrence(s)…",
  per-op result lines — so the default is generous for them), and any future tool.
- **`read_file`: 4,000** — the one code-editing exception: the model must see the region it
  is changing; targeted re-reads (offset/limit) cover files past the budget.
- **`delegate`: 4,000** — the child's answer is the one output the parent must actually
  reason over; preserves `SUMMARY_BUDGET_CHARS` (and, with the `head` mode, today's preview
  shape) exactly.
- **`write_file`: 1,000** — a confirmation message; preserves today's limit (the 2,000
  default would *raise* it).
- **`value_get` (and value-read primitives): 50,000** — matches `VALUE_GET_CHAR_BUDGET`, the
  tool's own model-facing contract. Reading past a ref is the design's escape hatch; gating
  it at the svelte default would make >2,000 chars unmaterializable in tool mode (value reads
  are capture-excluded, so there would be no new ref to follow). The svelte default must
  never apply to value reads.

### Capture coverage (P1 work items, not assumptions)

`CAPTURE_PRIMITIVE_NAMES` is `["read_file", "exec", "grep", "fetch"]` (`capture.ts:18`) and
`glob` returns no `captureSource` (`primitives.ts:700–707`). At a 2,000-char budget, glob
output truncating ref-less stops being a corner case. P1 adds `glob` capture (source = the
full listing) and adds it to the allow-list. The environment-dependent fallback paths
(`read_file` without `read_file_raw`, `grep` without `grep_structured`) keep honest
degradation — a documented exception to Acceptance #1, not silent.

#### Configurability

Follows the existing tunable patterns (`DEFAULT_CHAR_LIMITS` record + per-call `overrides` in
`truncation.ts`; the resolve-once env pattern of `session-budget.ts`):

- `DEFAULT_PREVIEW_BUDGETS` — the record above, beside `DEFAULT_CHAR_LIMITS`.
- `SPROUT_PREVIEW_BUDGETS` — one env var holding a JSON map merged over the defaults, e.g.
  `{"default": 4000, "read_file": 16000}`. Resolved once per process at startup; an invalid
  value warns and falls back to defaults (never crashes a session; note `ceilingFromEnv`
  itself falls back silently — the warn is this resolver's addition).
- Propagation: the spawner spreads the LIVE `process.env` at spawn call time
  (`spawner.ts:233–237`, `env: { ...process.env, ...env }`), so the var set in the host's
  environment — or set in `process.env` before a spawn — reaches spawned agent processes.
  The per-process resolve-once means in-process changes after startup have no effect; evals
  and tests therefore use the programmatic override channel (registry options, like
  `overrides?.charLimit` today), which also avoids cross-child env leakage.

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

These hold **when a capture store is present and the boundary's capture step succeeds**; the
documented degradations (honest marker-less truncation; the delegation 30,000-char fallback;
flag-off sessions, which keep today's behavior wholesale) are the only exceptions, and each is
tested as such:

- An output at or below its budget reaches the model **identical to today except redaction**
  (the one deliberate change on the inline path) — line limits and modes still apply.
- A captured value's stored content is the exact raw SOURCE; splicing `⟦ref⟧` reproduces it.
- Nothing above budget crosses to the model except the redacted, mode-shaped preview + marker.
- No double-store; no marker ever names a value the reader cannot see (nonexistent or, at the
  delegation boundary, unpublished).
- The delegation boundary's bind-and-publish visibility semantics are unchanged.

## Phases

**P1 — Shared gate + primitives.** Add the `head` truncation mode; extract the shared gate
into the kernel (built on `truncateToolOutputDetailed`, capture as a boundary callback);
primitives adopt it: budgets replace `DEFAULT_CHAR_LIMITS` as the capture trigger **when a
capture store is present** (flag-off keeps today's limits), redaction added to the primitive
output path (explicit change), stderr predicate moved to redacted space, `glob` capture
added, canonical marker, budget resolver (`DEFAULT_PREVIEW_BUDGETS` ⊕ `SPROUT_PREVIEW_BUDGETS`
⊕ overrides) with the `value_*` exemption. TDD; update the primitive/truncation tests that
assert inline content, each move recorded. Fable review.

**P2 — Delegation converges (all three flavors).** `prepareResultOutput`, `runFeatherweight`,
and the in-process fallback all route through the shared gate with the bind-AND-publish
capture callback, keeping child-identity, goal-slug naming, and the inline fallback; budget
from the record (`delegate`, mode `head`); redaction added; canonical marker. Tests:
over-budget sub-result → preview + ref in the parent's payload for EACH flavor; ref splices
to the exact full result; publish-failure produces the fallback, never a marker; fallback
path unchanged. Fable review.

**P3 — Cell gate adopts + tune + prove.** `gateForTranscript` becomes a caller of the shared
gate (budget = the record's `cell` entry, mode `head`; behavior byte-identical, asserted —
possible now that `head` exists). Re-run `code-mode-advantage`-style byte measurement across
tool mode (capture on vs off); tune budgets; add an e2e scenario proving an N-way fan-out
keeps the orchestrator payload flat. Fable review.

## Acceptance

1. Every capture-capable boundary's over-budget output is captured and returned as redacted
   preview + `⟦ref⟧`; at or below budget, inline (redacted) with today's line/mode shaping.
   The documented exceptions (no `captureSource` fallback paths, capture failure, flag-off)
   degrade honestly and are each covered by a test.
2. A sub-result over budget never appears in full in the orchestrator's provider payload —
   for subprocess, featherweight, AND in-process delegation; the ref splices to the exact
   full result.
3. `⟦ref⟧` from any captured output splices faithfully into a `write_file` / cell.
4. Stored values raw; every model-facing render redacted — including the two paths that were
   not redacted before.
5. One marker format everywhere; the preserved behaviors (no-double-store, stderr companion
   in redacted space, `value_*` exclusion + budget exemption, honest degradation, child
   publish, fallback) each hold under test.
6. Full suite green, with inline-output assertion churn resolved honestly, each recorded.

## Risks (honest)

- **Broad blast radius.** Every agent sees previews + refs on outputs that used to be inline
  up to 20–50 KB; tests asserting inline content move. Mitigated by phasing and by the gate
  logic already existing at all three boundaries.
- **Code-editing regression** if budgets are too tight — the deliberate cost of svelte
  defaults. Mitigated by the `read_file` exception (4,000), targeted re-reads, and
  `SPROUT_PREVIEW_BUDGETS`.
- **Redaction on the hot inline path** is new for primitives — a regex pass over every tool
  output. The patterns are few and anchored; if profiling ever shows it, it shows up in the
  bench harness, not in guesswork.
- **Genome prompt assumptions.** Prompts may assume full tool output or match old marker
  wording. Surveyed per phase, at the gate that phase touches.
- **Featherweight/in-process gating is new code on hot delegation paths** — the smallest
  change is reusing the existing child-boundary helper, but it moves where those flavors'
  results are shaped; the P2 per-flavor tests are the guard.

## Open questions (for the P1 review, not blockers)

- Adaptive budgets (e.g., larger when the agent's task is flagged code-editing)? Static
  defaults + `SPROUT_PREVIEW_BUDGETS` cover per-deployment tuning; revisit only if
  code-editing regresses under the svelte defaults.
- A hard "always ref, no preview" mode for a maximally-locked-down agent? Out of scope; the
  shared gate makes it a one-line future option.

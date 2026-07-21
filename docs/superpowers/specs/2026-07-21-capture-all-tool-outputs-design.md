# Capture-all tool outputs — unify the three output gates

**Date:** 2026-07-21
**Status:** design v4 (two adversarial review rounds: 14 findings on v2, 9 on v3, all folded in;
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

### The governing principle (v4)

**The svelte budget bites only where a ref can compensate.** A tool result is cut to a svelte
preview ONLY when the full content was captured and the marker names a value the reader can
actually reach. Where capture cannot happen — no capture store (flag-off, in-process
delegation), no `captureSource` (memory/workspace/save tools, degraded-env fallbacks), or a
failed capture — today's truncation behavior stands unchanged. Svelte truncation without a
ref destroys information with no compensation; this spec never does that.

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
   no bind and no budget; the parent's `truncateToolOutput(output, agent_name)` then applies
   the 30,000-char fallback (an agent name is never a char-limit key) — up to 30 KB of
   sub-result inline in the orchestrator's payload, uncaptured. (The in-process delegation
   fallback has the same rendering, but is out of scope — see Delegation, below.)
3. **Only the cell gate redacts.** Primitive outputs and child results reach the transcript
   unredacted today (`redactSensitiveTranscriptContent` is imported by value-primitives, cell
   paths, and telemetry — never by `primitives.ts` or the child result path). The primitive
   **error** channel is likewise unredacted (`agent.ts` renders
   `` `Error: ${result.error}\n${result.output}` ``), even though error strings can embed
   content — `edit_file` errors include a slice of `old_string`; the kernel's value
   primitives already redact their errors for exactly this reason.

## The wins

1. **Reuse without reflow.** Every substantial capture-capable output becomes a splice-able
   `⟦ref⟧`; relaying or re-using it (into a write, a cell, another agent) never re-floods the
   payload.
2. **Leak-proof for captured bytes.** Capture is content-agnostic — it keeps ALL over-budget
   bytes out of the payload, where redaction only catches recognized patterns (the
   `code-mode-advantage` Scenario 2 finding). Honest limitation: content at or below budget
   still rides inline, so sub-budget confidential content (Scenario 2's memo is ~171 chars)
   is NOT protected by this mechanism — code mode remains the answer there. Redaction also
   extends to the gates and channels that lack it today, including primitive errors.
3. **Orchestrator scaling.** The subprocess boundary already bounds sub-results at 4,000
   chars + ref; unification extends that to featherweight delegation and to every
   capture-capable primitive an orchestrator's turns accumulate, with all the budgets one
   tunable surface.

## Goals

1. One shared gate helper used by the primitive registry, the delegation boundaries that can
   capture, and the cell transcript gate; behavior differences become data (the budget/mode
   table), not code.
2. Svelte, configurable budgets (Jesse, 2026-07-21): capture fires at ~2,000 chars, not
   20–50 KB — under the governing principle (only where a ref can compensate).
3. Redaction at every gate and on the primitive error channel — an explicit behavior CHANGE.
4. Stored values are the RAW source (faithful splices); everything model-facing is redacted.
5. One canonical marker format across all gates.

## Non-goals

- New scope semantics for the **subprocess** flavor: it KEEPS bind-under-child-identity +
  publish (that is how the parent sees the value today; it works and is already spec'd).
  Featherweight capture is parent-scope by design — see Delegation; it is a new behavior,
  not a change to an existing one.
- Renaming captured values. Existing schemes stay: `<primitive>_output` (primitives),
  goal-slug `_result` (delegation), `cell_<n>_output` / `cell_<n>_return` (cells). The
  unification is the gate, not the names.
- Changing what any gate shows below its budget, beyond the redaction pass. (One deliberate,
  stated exception: value reads — see the budget table.)
- **Changing no-store behavior.** Flag-off sessions and the in-process delegation fallback
  have no capture store; they keep today's truncation unchanged (the governing principle).

## Design

### The shared gate

One kernel helper (beside `truncation.ts`). The boundary supplies its capture step as a
callback, and the gate returns a **structured outcome** the boundary renders — degradation
rendering is boundary-owned, because the boundaries' existing degradation forms differ and
each is preserved:

```
gateOutput(boundary, renderedOutput, capture, opts) -> outcome
    redacted = redact(renderedOutput)
    budget   = previewBudget(boundary)        # defaults ⊕ SPROUT_PREVIEW_BUDGETS ⊕ opts.overrides
    pass     = truncateToolOutputDetailed(redacted, boundary, {charLimit: budget})
    if not pass.truncated:                    # fits → inline (no capture)
        return {kind: "inline", text: redacted}
    value    = capture()                      # boundary-supplied: bind(raw source) [+ publish]
    if capture failed (any step):
        return {kind: "capture-failed", pass, reason}
    return {kind: "captured", pass, value}
```

Boundary rendering:

- `inline` → the redacted text as-is.
- `captured` → the mode-shaped preview + the canonical marker naming the value.
- `capture-failed` → **the boundary's existing degradation form, unchanged**: primitives
  render the preview + `[... truncated; content not captured]` banner; the delegation
  boundary returns the full raw output up to 30,000 chars with no banner (its existing
  fallback, `agent-process.ts:848–853`) — the gate does not force one degradation rendering
  on both.

Key points:

- **The capture callback is all-or-nothing.** For primitives it binds the raw source; for
  subprocess delegation it binds under the child's identity AND publishes. If ANY step fails
  (bind, publish, store full), the outcome is `capture-failed` — a bind that succeeds but a
  publish that fails must NOT produce a marker, because an unpublished child-scope value is
  invisible to the parent, and a marker naming an invisible value is a lie.
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
  faithful.
- **Redact-then-gate**, as the cell gate does: the threshold applies to the redacted text;
  the stored value is raw.
- **The error channel is redacted too.** `result.error` strings pass through
  `redactSensitiveTranscriptContent` at the registry boundary (mirroring the value
  primitives' existing rule — "error messages can embed value content"). Errors are not
  budgeted or captured (they are short); they are redacted.

### Which tools the svelte budget applies to

The registry gate applies the svelte budget ONLY to **capture-capable** primitives — after
P1: `read_file`, `exec`, `grep`, `fetch`, `glob` (P1 adds glob's `captureSource` and
allow-list entry; today's list is `["read_file", "exec", "grep", "fetch"]`, `capture.ts:18`).
Everything else keeps today's truncation limits unchanged, per the governing principle:

- **Source-less tools** — the memory/workspace tools (`memory_search`, `memory_get`,
  `save_tool`, `save_file`, …) and any primitive without `captureSource` — keep the existing
  `DEFAULT_CHAR_LIMITS` / 30,000-char fallback. A 20 KB memory result stays as visible as it
  is today; cutting it to 2,000 chars with no ref would destroy information.
- **Degraded-env fallback paths** (`read_file` without `read_file_raw`, `grep` without
  `grep_structured`) produce no source → same rule: today's truncation, honest, no marker.
- **`value_*` reads are exempt from gating and capture** (their output already comes from
  the store; re-capturing would chain refs). Their truncation ceiling becomes
  `VALUE_GET_CHAR_BUDGET` (50,000) — **a deliberate, stated behavior change**: today the
  registry's generic 30,000 fallback mid-cuts `value_get` output in the 30–50 K range,
  silently breaking the tool's own "up to 50000 chars" model-facing contract. The exemption
  fixes that latent violation; the payload-size effect (value reads 30–50 K now ride whole)
  is intended — the model explicitly asked to read that value.
- **The `cell` primitive is exempt from the registry gate.** The cell tool is itself a
  registry primitive named `cell` (`cell-primitive.ts:62`); its rendered result is a
  composite of pieces the cell transcript gate ALREADY gated (output, return, binding lines)
  and can legitimately exceed 2,000 chars while every piece is within budget. Re-gating it at
  the registry would double-gate: the no-double-store branch would emit a marker naming
  `boundValues[0]` — an arbitrary cell binding that does not contain the truncated text — or
  degradation would destroy the cell's own inner `⟦ref⟧` markers. The registry skips `cell`
  exactly as it skips `value_*`; the budget record's `cell` entry belongs to the cell
  transcript gate in `cell-host.ts`, not to the registry.

### Delegation

Three flavors, three different capture capabilities — the spec treats them separately
because the store's identity model makes them genuinely different:

- **Subprocess** (`prepareResultOutput`): becomes a gate caller with the bind-AND-publish
  callback. It runs inside the child process on the child's own authenticated store
  connection — which is the ONLY place bind-under-child-identity is possible (`StoreAccess`
  carries its own scope authority; "identity is the connection's, never the payload's").
  Child-identity bind + publish + goal-slug naming + the 30,000-char fallback all unchanged.
- **Featherweight** (`runFeatherweight`): featherweight children skip handle registration by
  design (`spawner.ts:743–744` short-circuits before `registerHandleForLaunch`;
  `session-budget.ts:13–15` documents it) and never hold a store connection, so
  bind-under-child-identity is unimplementable without new host machinery. **Design: the
  featherweight result binds via the spawner's parent-scoped `StoreAccess` into the PARENT's
  scope**, `origin: {kind: "delegation"}` carrying attribution, goal-slug naming, and **no
  publish** — the value is already in the parent's scope, and publishing would push it to the
  grandparent's manifest, a visibility change nobody asked for. This is a new, designed
  behavior (today: nothing is captured on this path), not a change to subprocess semantics.
  Rejected alternative: registering featherweight handles to reuse the child-identity flow —
  heavier, and it contradicts the documented featherweight design (skip registration is the
  point of the tier).
- **In-process fallback** (`agent.ts` ~1500): **out of scope.** It runs ONLY when the agent
  has no spawner (`agent.ts:2942–2944`), and store access exists only via the spawner — this
  path is structurally storeless, the same category as flag-off. It keeps its existing
  30,000-char backstop unchanged. (If in-process delegation ever gains store plumbing, it
  adopts the featherweight contract.)

The parent-side `truncateToolOutput(output, agent_name)` rendering stays as a backstop; after
P2 a gated result is already preview-sized when it reaches it.

### Budgets — svelte by default, configurable

**Decision (Jesse, 2026-07-21): previews are svelte but configurable.** The unconditional wins
(reuse, no-leak, orchestrator scaling) come from always creating the ref; the budget only sets
how much the model reads for free before reaching for the ref (or a cell). Budgets are
**chars** (every comparison in the code is `.length`), one record with few exceptions:

- **`default`: 2,000** — the cell gate's scale. Covers the capture-capable primitives
  (`exec`, `grep`, `glob`, `fetch`) and, at the cell transcript gate, the `cell` entry
  (`CELL_AUTO_BIND_THRESHOLD` folds into this record).
- **`read_file`: 4,000** — the one code-editing exception: the model must see the region it
  is changing; targeted re-reads (offset/limit) cover files past the budget.
- **`delegate`: 4,000** — the child's answer is the one output the parent must actually
  reason over; preserves `SUMMARY_BUDGET_CHARS` (and, with the `head` mode, today's preview
  shape) exactly.
- `edit_file` / `apply_patch` / `write_file` emit one-line confirmations and are not
  capture-capable; they keep their existing `DEFAULT_CHAR_LIMITS` entries (10,000 / 10,000 /
  1,000) under the governing principle. (Their outputs never approach any of these numbers.)
- Value reads: 50,000, per the exemption above. Source-less tools: existing limits, above.

### Configurability

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

One format, all gates (today: primitives say "full output:", the child boundary says "full
output:" with different framing, cells say "full content:"):

```
[... <N chars|N lines> truncated — full content: ⟦name⟧]
```

- **Unit rule** (new, explicit): the dropped count reports the unit of the pass that did the
  cutting — a line-limit cut reports `N lines`; a char/budget cut reports `N chars`. Cell
  cuts are always char cuts, so the cell gate's marker stays byte-identical to today. This is
  a small stated change for primitives, which today prefer lines whenever `droppedLines > 0`
  even on a char cut.
- The stderr companion appends `, stderr: ⟦name⟧`; degradation forms are
  `[... <dropped> truncated; store full — content not captured]` / `; capture failed — …`.
- "full content:" wins because the cell gate and the scenario-3 e2e test already match on it;
  agents pattern-match markers, so convergence is itself a feature. Prompts/genomes that
  reference the old wordings get surveyed in the phase that touches their gate.

### Behaviors each gate keeps (requirements)

From the primitive gate (`primitives.ts:94–168`):

- **No double-store**: a primitive that already explicitly bound its source (`boundValues`)
  gets a marker naming the existing value; the gate never binds a second copy. (With the
  `cell` exemption, this branch no longer sees composite cell results.)
- **Stderr companion**: `exec` stderr the preview dropped binds as its own value; the marker
  names both. The containment predicate MOVES to redacted space (redacted stderr vs redacted
  preview) — today's raw-vs-preview check (`primitives.ts:134–137`) would false-positive
  under redact-then-gate whenever stderr contains a redactable token.
- **`value_*` exclusion** and **honest degradation**, as specified above.

From the delegation boundary (`agent-process.ts:828–855`): child-identity bind + publish
(subprocess), goal-slug naming, and the 30,000-char inline fallback — all unchanged, as
specified in Delegation.

From the cell gate (`cell-host.ts:389–406`): redact-then-threshold ordering, the head-slice
preview shape (now the `head` mode), the chars-unit marker, and the marker format.

## Invariants

These hold **when a capture store is present and the boundary's capture step succeeds**; the
documented degradations (boundary-owned capture-failed rendering; source-less and no-store
paths, which keep today's behavior wholesale) are the only exceptions, and each is tested as
such:

- An output at or below its budget reaches the model **identical to today except redaction**
  (the deliberate inline-path changes: redaction everywhere, and the value-read ceiling
   30,000 → 50,000) — line limits and modes still apply.
- A captured value's stored content is the exact raw SOURCE; splicing `⟦ref⟧` reproduces it
  (up to the existing splice bound — see Acceptance #3).
- Nothing above budget crosses to the model except the redacted, mode-shaped preview + marker.
- No double-store; no marker ever names a value the reader cannot see (nonexistent or, at the
  subprocess boundary, unpublished).
- The subprocess boundary's bind-and-publish visibility semantics are unchanged; featherweight
  capture adds parent-scope values without touching any existing scope's visibility.

## Phases

**P1 — Shared gate + primitives.** Add the `head` truncation mode and the marker unit rule;
extract the shared gate into the kernel (built on `truncateToolOutputDetailed`, capture as a
boundary callback returning the structured outcome); primitives adopt it for the
capture-capable set: budgets replace their `DEFAULT_CHAR_LIMITS` entries **when a capture
store is present** (flag-off and source-less tools keep today's limits), redaction added to
the primitive output AND error channels (explicit change), stderr predicate moved to redacted
space, `glob` capture added, `cell` + `value_*` registry exemptions (value ceiling 50,000,
stated change), canonical marker, budget resolver (`DEFAULT_PREVIEW_BUDGETS` ⊕
`SPROUT_PREVIEW_BUDGETS` ⊕ overrides). TDD; update the primitive/truncation tests that assert
inline content, each move recorded. Fable review.

**P2 — Delegation converges (subprocess + featherweight).** `prepareResultOutput` becomes a
gate caller with the bind-AND-publish callback (child-identity, goal-slug, fallback
unchanged); `runFeatherweight` gains the parent-scope bind flavor (no publish); budget from
the record (`delegate`, mode `head`); redaction added to the child result path. Tests:
over-budget sub-result → preview + ref in the parent's payload for BOTH flavors; ref splices
to the exact full result; publish-failure produces the existing fallback rendering (full raw
≤ 30,000, no banner), never a marker; featherweight capture-failure falls back to today's
raw-output path; in-process fallback asserted unchanged. Fable review.

**P3 — Cell gate adopts + tune + prove.** `gateForTranscript` becomes a caller of the shared
gate (budget = the record's `cell` entry, mode `head`, chars unit; behavior byte-identical,
asserted — possible now that `head` and the unit rule exist). Re-run
`code-mode-advantage`-style byte measurement across tool mode (capture on vs off); tune
budgets; add an e2e scenario proving an N-way fan-out keeps the orchestrator payload flat.
Fable review.

## Acceptance

1. Every capture-capable boundary's over-budget output is captured and returned as redacted
   preview + `⟦ref⟧`; at or below budget, inline (redacted) with today's line/mode shaping.
   The governed exceptions (source-less tools, no-store paths, capture failure) keep today's
   rendering and are each covered by a test.
2. A sub-result over budget never appears in full in the orchestrator's provider payload —
   for subprocess AND featherweight delegation; the ref splices to the exact full result.
   (In-process delegation is storeless and documented as keeping its 30,000-char backstop.)
3. `⟦ref⟧` from a captured output splices faithfully into a `write_file` / cell for captures
   up to `REF_SPLICE_MAX_BYTES` (4 MiB — the existing splice bound; a capture between it and
   the 6 MiB bind wire limit stores fine but cannot splice, a pre-existing boundary this spec
   inherits and documents).
4. Stored values raw; every model-facing render redacted — outputs AND error strings,
   including the paths that were not redacted before.
5. One marker format everywhere under the stated unit rule; the preserved behaviors
   (no-double-store, stderr companion in redacted space, `value_*`/`cell` exemptions, honest
   boundary-owned degradation, child publish, fallbacks) each hold under test.
6. Full suite green, with inline-output assertion churn resolved honestly, each recorded.

## Risks (honest)

- **Broad blast radius.** Every agent sees previews + refs on outputs that used to be inline
  up to 20–50 KB; tests asserting inline content move. Mitigated by phasing and by the gate
  logic already existing at all three boundaries.
- **Code-editing regression** if budgets are too tight — the deliberate cost of svelte
  defaults. Mitigated by the `read_file` exception (4,000), targeted re-reads, and
  `SPROUT_PREVIEW_BUDGETS`.
- **Redaction on the hot inline path** is new for primitives — a regex pass over every tool
  output and error. The patterns are few and anchored; if profiling ever shows it, it shows
  up in the bench harness, not in guesswork.
- **Genome prompt assumptions.** Prompts may assume full tool output or match old marker
  wording. Surveyed per phase, at the gate that phase touches.
- **Featherweight parent-scope capture is new behavior on a hot delegation path** — and its
  provenance attributes the value to the parent's scope with only `origin` marking the child.
  The P2 per-flavor tests are the guard; if origin-only attribution proves too weak for
  auditability, handle registration for featherweight is the fallback design.
- **The capture-capable/source-less split is a fork in the registry gate** — two truncation
  regimes in one dispatch path. Mitigated by making the split data (the allow-list +
  `captureSource` presence), not scattered conditionals.

## Open questions (for the P1 review, not blockers)

- Adaptive budgets (e.g., larger when the agent's task is flagged code-editing)? Static
  defaults + `SPROUT_PREVIEW_BUDGETS` cover per-deployment tuning; revisit only if
  code-editing regresses under the svelte defaults.
- A hard "always ref, no preview" mode for a maximally-locked-down agent? Out of scope; the
  shared gate makes it a one-line future option.
- Should more tools become capture-capable over time (memory reads are the obvious
  candidate)? The governing principle makes that a per-tool `captureSource` addition, not a
  design change.

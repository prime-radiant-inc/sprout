# Capture-all tool outputs — unify the three output gates

**Date:** 2026-07-21
**Status:** design v5 (three adversarial review rounds: 14 findings on v2, 9 on v3, 10 on v4 —
all verified and folded in; awaiting Jesse's go)
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (capture/splice, §2),
`2026-07-19-sap-completion-and-roadmap-design.md` (data plane)
**Evidence:** `test/integration/code-mode-advantage.test.ts` (the structural wins, measured)

## Purpose

Every **tool-output** boundary should capture the same way: above a svelte, configurable
budget, the full raw content becomes a store value and the model gets a bounded preview +
`⟦ref⟧`; at or below budget it stays inline. Today that behavior exists **three times, each
slightly different**, and the differences are the problem:

| gate | where | trigger | budget | redacts? |
|---|---|---|---|---|
| primitive capture-on-truncation | `primitives.ts` `createPrimitiveRegistry.execute` | lossy truncation (char OR line limits) | `DEFAULT_CHAR_LIMITS`: 50 KB `read_file`, 30 KB `exec`/`fetch`, 20 KB `grep`/`glob`, 10 KB `edit_file`/`apply_patch`, 1 KB `write_file`; line limits `exec` 256 / `grep` 200 / `glob` 500 | **no** |
| child-boundary auto-bind | `agent-process.ts` `prepareResultOutput` | result over budget | `SUMMARY_BUDGET_CHARS` = 4,000 chars | **no** |
| cell transcript gate | `cell-host.ts` `gateForTranscript` | output over threshold | `CELL_AUTO_BIND_THRESHOLD` = 2,000 chars | yes |

This is a **unification, not a greenfield feature**: one shared gate, one budget table (svelte
by default, configurable), one marker format, redaction at every model-facing render — while
preserving each existing gate's hard-won behaviors (listed per-gate below; they are
requirements, not incidentals).

### The governing principles (v5)

1. **The svelte budget bites only where a ref compensates.** A tool result is cut to a svelte
   preview ONLY when the full content was captured and the marker names a value the reader
   can actually reach. Where capture cannot happen (no store, no `captureSource`) or FAILS
   (store full, over the bind wire limit), the boundary renders at **today's limits** — the
   svelte budget never applies without a successful capture. Svelte truncation without a ref
   destroys information with no compensation; this spec never does that. Note the failure
   trigger is deterministic, not exotic: `ChannelStoreAccess.bind` hard-fails any value over
   `CHANNEL_BIND_WIRE_LIMIT` (6 MiB), so every subprocess agent's >6 MiB output takes the
   capture-failed path — and must therefore land on today's 20–50 KB rendering, not a 2 KB
   preview.
2. **Redaction is unconditional and orthogonal to capture.** Every model-facing render this
   spec touches — outputs, previews, error strings, degradation fallbacks, no-store paths —
   passes `redactSensitiveTranscriptContent`. Redaction needs no store; "keeps today's
   behavior" everywhere below means today's *sizing and shape*, plus redaction.

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
   the 30,000-char fallback — up to 30 KB of sub-result inline, uncaptured. Worse, the gate
   only guards the LIVE result path: the child logs its raw output in `session_end`, and both
   crash recovery (`readHandleResult` → `settleHandleResult`) and cold resume
   (`loadCompletedChildHandles`) reconstruct results from that raw log record, re-serving
   ungated output into the parent's payload.
3. **Only the cell gate redacts.** Primitive outputs and child results reach the transcript
   unredacted today, as does the primitive **error** channel (`agent.ts` renders
   `` `Error: ${result.error}\n${result.output}` ``) — even though error strings can embed
   content (`edit_file` errors include a slice of `old_string`; the kernel's value
   primitives already redact their errors for exactly this reason).

## The wins

1. **Reuse without reflow.** Every substantial capture-capable output becomes a splice-able
   `⟦ref⟧`; relaying or re-using it (into a write, a cell, another agent) never re-floods the
   payload.
2. **Leak-proof for captured bytes.** Capture is content-agnostic — it keeps ALL over-budget
   bytes out of the payload, where redaction only catches recognized patterns (the
   `code-mode-advantage` Scenario 2 finding). Honest limitation: content at or below budget
   still rides inline, so sub-budget confidential content (Scenario 2's memo is ~171 chars)
   is NOT protected by this mechanism — code mode remains the answer there.
3. **Orchestrator scaling.** The subprocess boundary already bounds sub-results at 4,000
   chars + ref; unification extends that to featherweight delegation, to the durable-log
   recovery/resume paths, and to every capture-capable primitive an orchestrator's turns
   accumulate, with all the budgets one tunable surface.

## Non-goals

- New scope semantics for the **subprocess** flavor: it KEEPS bind-under-child-identity +
  publish. Featherweight capture is parent-scope by design — see Delegation; it is a new
  behavior, not a change to an existing one.
- Renaming captured values. Existing schemes stay: `<primitive>_output` (primitives),
  goal-slug `_result` (delegation), `cell_<n>_output` / `cell_<n>_return` (cells).
- Changing what any gate shows below its budget, beyond redaction. (One deliberate, stated
  exception: value reads — see the budget table.)
- **Changing no-store sizing.** Flag-off sessions and the in-process delegation fallback have
  no capture store; they keep today's truncation sizing (plus redaction, per principle 2).
- Gating the **adjacent model-facing surfaces** inventoried below beyond what is stated
  there (agent-message clamp only).

## Adjacent model-facing surfaces (inventoried; mostly out of scope)

Review round three audited every path that renders content into a provider payload. Beyond
the three gates, there are three more; this spec's premise is scoped to tool outputs, so
these are handled as follows:

- **Agent messages** (`renderAgentMessagesForPrompt`): queued `message_agent` text is
  injected **in full, unredacted, unbounded** into the recipient's system prompt. Left alone
  this trivially bypasses the delegation gate — a child gated at 4,000 chars on its result
  can ship 100 KB verbatim via `message_agent "caller"`. **In scope (P2), minimally**: the
  parent-side render clamps each message at the `delegate` budget (`head` mode, plain
  `[... N chars truncated]` banner — no capture, messages are transient and the sender may
  be storeless) and redacts. Nothing else about messaging changes.
- **Session-collapse summarization** (`session-collapse.ts`): renders tool results into an
  LLM summarization payload at `MAX_COLLAPSE_OUTCOME_CHARS` = 2,000 with a bare
  `[truncated]`. Already redacts; consumes mostly post-gate content. **Out of scope.**
- **Observer quotes** (`observers.ts`): event output quoted into observer frames at a quote
  cap. Already redacts. **Out of scope.**

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
        return {kind: "capture-failed", redacted, reason}   # NOT the svelte pass — see below
    return {kind: "captured", pass, value}
```

Boundary rendering:

- `inline` → the redacted text as-is.
- `captured` → the mode-shaped svelte preview + the canonical marker naming the value.
- `capture-failed` → **today's rendering, from the full redacted text** (governing principle
  1: no svelte cut without a ref). Primitives re-truncate at their `DEFAULT_CHAR_LIMITS`
  entry with the `[... truncated; content not captured]` banner — a >6 MiB read_file still
  shows ~50 KB, as today. The delegation boundary returns the full redacted output when
  ≤ 30,000 chars (no banner), and a 30,000-char slice + `[... output truncated at 30000
  chars]` banner above that — exactly its existing two-branch fallback
  (`agent-process.ts:848–853`; note the over-30 K branch DOES have a banner).

Key points:

- **The capture callback is all-or-nothing.** For primitives it binds the raw source; for
  subprocess delegation it binds under the child's identity AND publishes. If ANY step fails
  (bind, publish, store full, wire limit), the outcome is `capture-failed` — a bind that
  succeeds but a publish that fails must NOT produce a marker, because an unpublished
  child-scope value is invisible to the parent, and a marker naming an invisible value is a
  lie.
- **The preview is shaped by the truncation machinery with an explicit per-boundary mode.**
  `TruncationMode` today is `head_tail | tail`; the gate adds a third, **`head`** (head slice
  + trailing marker) — which is what BOTH the cell gate and the child boundary already emit.
  Assignments: primitives keep their `DEFAULT_MODES` entries (`head_tail` for
  `exec`/`read_file`/`fetch`; `tail` for the rest); `cell` and `delegate` use `head`,
  preserving their current preview shapes exactly. Per-tool line limits survive, and a
  line-limit cut also triggers capture, as today.
- **The stored value is the SOURCE, not the rendering.** Primitives bind
  `result.captureSource.content` (the true file/command bytes) — that is what makes splices
  faithful.
- **`fetch` headers are handled explicitly.** The fetch rendering embeds
  `headers: JSON.stringify(...)` while `captureSource` is deliberately the body only
  ("capture stores the raw body, never the status/header rendering") — so under a svelte
  budget, mid-cut header content would exist in NO stored value while the marker claimed
  "full content". Fix (P1): the rendered header line is bounded (a ~500-char cap with a
  `(+N more headers)` note), keeping status+headers inside every head-mode preview, and the
  fetch marker reads `full body: ⟦ref⟧` — the marker never claims more than the value holds.
- **Redact-then-gate**, as the cell gate does; and `result.error` strings are redacted at
  the registry boundary (errors are not budgeted or captured — they are short; they are
  redacted).

### Which tools the svelte budget applies to

The registry gate applies the svelte budget ONLY to **capture-capable** primitives — after
P1: `read_file`, `exec`, `grep`, `fetch`, `glob` (P1 adds glob's `captureSource` and
allow-list entry). Everything else keeps today's truncation sizing, per principle 1:

- **Source-less tools** — memory/workspace tools (`memory_search`, `memory_get`,
  `save_tool`, `save_file`, …) and any primitive without `captureSource` — keep the existing
  `DEFAULT_CHAR_LIMITS` / 30,000-char fallback.
- **Degraded-env fallback paths** (`read_file` without `read_file_raw`, `grep` without
  `grep_structured`) produce no source → same rule.
- **`value_*` reads are exempt from gating and capture** (their output already comes from
  the store; re-capturing would chain refs). Their truncation ceiling becomes
  `VALUE_GET_CHAR_BUDGET` (50,000) — **a deliberate, stated behavior change**: today the
  registry's generic 30,000 fallback mid-cuts `value_get` output in the 30–50 K range,
  silently breaking the tool's own "up to 50000 chars" model-facing contract.
- **The `cell` primitive is exempt from svelte gating and capture, and keeps its 30,000
  registry ceiling as a backstop that should never be the operative cut.** The cell tool is
  a registry primitive (`cell-primitive.ts:62`) whose result is a composite of pieces the
  cell transcript gate ALREADY gated — re-gating would double-gate (the no-double-store
  branch would emit a marker naming an arbitrary `boundValues[0]` that does not contain the
  truncated text). But exemption alone is not enough: the `bound: ⟦name⟧ (N bytes)` lines
  are appended per binding with NO cap today, so a binding-heavy cell could flood the
  composite anyway. **Fix (P1): `cell-primitive` renders at most 32 binding lines plus
  `(and N more bindings)`** — with output and return each ≤ 2,000 (cell gate) and binding
  lines capped, the composite stays far under the 30,000 backstop, which remains only as
  the honest last resort.

### Delegation

Three flavors, three different capture capabilities:

- **Subprocess** (`prepareResultOutput`): becomes a gate caller with the bind-AND-publish
  callback. It runs inside the child process on the child's own authenticated store
  connection — the ONLY place bind-under-child-identity is possible. Child-identity bind +
  publish + goal-slug naming + the two-branch 30 K fallback all unchanged (plus redaction).
- **Featherweight** (`runFeatherweight`): featherweight children skip handle registration by
  design and never hold a store connection, so bind-under-child-identity is unimplementable.
  **Design: the featherweight result binds via the spawner's parent-scoped `StoreAccess`
  into the PARENT's scope, no publish** (the value is already in the parent's scope;
  publishing would push it to the grandparent). **Attribution requires a schema extension —
  scoped work, not hand-waving**: `ValueOrigin`'s delegation variant is today the bare tag
  `{ kind: "delegation" }`, and both wire codecs (`store-channel.ts`, `journal.ts`)
  normalize to exactly that. P2 extends it to `{ kind: "delegation"; agentName?: string }`
  and updates both codecs; without this the captured value would record nothing about which
  child produced it.
- **In-process fallback**: **out of scope.** It runs ONLY when the agent has no spawner
  (`agent.ts:2942–2944`), and store access exists only via the spawner — structurally
  storeless, the same category as flag-off. Keeps its 30,000-char backstop (plus redaction).

**The durable log is part of the boundary.** Today the gate guards only the live
`ResultMessage`; the raw output is logged in `session_end` and re-served ungated by crash
recovery and cold resume. P2 moves gating **upstream of the log write**, so the logged
`session_end.data.output` IS the gated form; recovery and resume then reconstruct the gated
preview + ref (store values persist in the journal/CAS, so the ref remains splice-able after
resume). The 30 K backstop remains for children that crash before gating. Two records, two
readers, two renderings — each honest for its reader:

- `session_end.data.output` (parent-facing result): the gated preview + `⟦ref⟧` marker.
- `plan_end` / replayed child history (child-facing): featherweight children cannot resolve
  refs (no store surface), so the child-facing record carries the marker-less degradation
  form (`[... N chars truncated]`) — never a marker naming a value the reader cannot reach.

The parent-side `truncateToolOutput(output, agent_name)` rendering stays as a backstop.

### Budgets — svelte by default, configurable

**Decision (Jesse, 2026-07-21): previews are svelte but configurable.** The unconditional wins
come from always creating the ref; the budget only sets how much the model reads for free
before reaching for the ref (or a cell). Budgets are **chars**, one record with few
exceptions:

- **`default`: 2,000** — the cell gate's scale. Covers the capture-capable primitives
  (`exec`, `grep`, `glob`, `fetch`) and, at the cell transcript gate, the `cell` entry
  (`CELL_AUTO_BIND_THRESHOLD` folds into this record).
- **`read_file`: 4,000** — the one code-editing exception; targeted re-reads (offset/limit)
  cover files past the budget.
- **`delegate`: 4,000** — preserves `SUMMARY_BUDGET_CHARS` (and, with `head` mode, today's
  preview shape) exactly. Also the clamp size for rendered agent messages.
- `edit_file` / `apply_patch` / `write_file` are not capture-capable and emit one-line
  confirmations; they keep their existing `DEFAULT_CHAR_LIMITS` entries.
- Value reads: 50,000 (stated change, above). Source-less tools: existing limits.

### Configurability

Follows the existing tunable patterns (`DEFAULT_CHAR_LIMITS` record + per-call `overrides`;
the resolve-once env pattern of `session-budget.ts`):

- `DEFAULT_PREVIEW_BUDGETS` — the record above, beside `DEFAULT_CHAR_LIMITS`.
- `SPROUT_PREVIEW_BUDGETS` — one env var holding a JSON map merged over the defaults, e.g.
  `{"default": 4000, "read_file": 16000}`. Resolved once per process at startup; an invalid
  value warns and falls back (never crashes a session; `ceilingFromEnv` itself falls back
  silently — the warn is this resolver's addition).
- Propagation: the spawner spreads the LIVE `process.env` at spawn call time
  (`spawner.ts:233–237`), so the var reaches spawned agent processes. In-process changes
  after startup have no effect; evals and tests use the programmatic override channel.

### The canonical marker

One format, all gates:

```
[... <N chars|N lines> truncated — full content: ⟦name⟧]
```

- **Unit rule**: the dropped count reports the unit of the pass that did the cutting — a
  line-limit cut reports `N lines`; a char/budget cut reports `N chars`. Cell cuts are
  always char cuts, so the cell gate's marker stays byte-identical to today. (Small stated
  change for primitives, which today prefer lines whenever `droppedLines > 0`.)
- `fetch` uses `full body: ⟦name⟧` (the value holds the body, not the rendering — above).
- The stderr companion appends `, stderr: ⟦name⟧`; degradation forms are
  `[... <dropped> truncated; store full — content not captured]` / `; capture failed — …`.
- "full content:" wins because the cell gate and the scenario-3 e2e test already match on
  it; agents pattern-match markers, so convergence is itself a feature.

### Behaviors each gate keeps (requirements)

From the primitive gate (`primitives.ts:94–168`): **no double-store** (explicit
`boundValues` → marker names the existing value, never a second copy); **stderr companion**
with the containment predicate MOVED to redacted space (today's raw-vs-preview check would
false-positive whenever stderr contains a redactable token); **`value_*` exclusion** and
**honest degradation at today's limits**, as specified above.

From the delegation boundary (`agent-process.ts:828–855`): child-identity bind + publish
(subprocess), goal-slug naming, and the two-branch 30 K fallback — unchanged plus redaction.

From the cell gate (`cell-host.ts:389–406`): redact-then-threshold ordering, the head-slice
preview shape (now the `head` mode), the chars-unit marker, and the marker format.

## Invariants

These hold when a capture store is present and the boundary's capture step succeeds; the
documented degradations (capture-failed → today's sizing; source-less and no-store paths →
today's sizing; the pre-gate-crash recovery backstop) are the only exceptions, each redacted
and each tested as such:

- An output at or below its budget reaches the model **identical to today except redaction**
  (deliberate inline-path changes: redaction everywhere; the value-read ceiling 30,000 →
  50,000; the fetch header-line bound; the cell binding-line cap).
- A captured value's stored content is the exact raw SOURCE; splicing `⟦ref⟧` reproduces it
  (up to the existing 4 MiB splice bound — Acceptance #3).
- Nothing above budget crosses to the model except the redacted, mode-shaped preview +
  marker — **on the live path AND the durable-log recovery/resume paths**.
- No double-store; no marker ever names a value the reader cannot see (nonexistent,
  unpublished at the subprocess boundary, or any ref in featherweight child-facing history).
- The subprocess boundary's bind-and-publish visibility semantics are unchanged;
  featherweight capture adds parent-scope values without touching any existing scope's
  visibility.

## Phases

**P1 — Shared gate + primitives.** Add the `head` truncation mode and the marker unit rule;
extract the shared gate (structured outcome, capture as a boundary callback,
capture-failed → today's-limits rendering); primitives adopt it for the capture-capable set
(budgets replace their char limits when a store is present; flag-off and source-less tools
keep today's sizing); redaction added to primitive output AND error channels (explicit
change, unconditional); stderr predicate to redacted space; `glob` capture added; `cell` +
`value_*` registry exemptions (value ceiling 50,000, stated change); the cell binding-line
cap (32 + summary); the fetch header-line bound + `full body:` marker; canonical marker;
budget resolver. TDD; update the primitive/truncation tests that assert inline content, each
move recorded. Fable review.

**P2 — Delegation converges (subprocess + featherweight) + durable log + messages.**
`prepareResultOutput` becomes a gate caller (bind-AND-publish callback; child-identity,
goal-slug, two-branch fallback unchanged, redaction added) and **moves upstream of the log
write** so `session_end` carries the gated form; recovery (`readHandleResult`) and cold
resume re-serve the gated preview + ref; featherweight gains the parent-scope bind flavor
(no publish) with the `ValueOrigin` delegation-variant extension (`agentName`) and both
codec updates; featherweight child-facing records carry the marker-less form; the
agent-message render clamp (delegate budget, `head`, redacted). Tests: over-budget
sub-result → preview + ref for BOTH flavors; ref splices to the exact full result; ref
survives cold resume; crash-recovery of a gated child re-serves the gated form;
publish-failure produces the two-branch fallback, never a marker; featherweight
capture-failure falls back to today's raw path; a 100 KB `message_agent` renders clamped;
in-process fallback asserted unchanged. Fable review.

**P3 — Cell gate adopts + tune + prove.** `gateForTranscript` becomes a caller of the shared
gate (budget = `cell`, mode `head`, chars unit; behavior byte-identical, asserted). Re-run
`code-mode-advantage`-style byte measurement across tool mode; tune budgets; add an e2e
scenario proving an N-way fan-out keeps the orchestrator payload flat. Fable review.

## Acceptance

1. Every capture-capable boundary's over-budget output is captured and returned as redacted
   preview + `⟦ref⟧`; at or below budget, inline (redacted) with today's line/mode shaping.
   The governed exceptions (source-less, no-store, capture-failed) render at today's sizing,
   redacted, each covered by a test — including the deterministic >6 MiB capture-failure.
2. A sub-result over budget never appears in full in the orchestrator's provider payload —
   for subprocess AND featherweight delegation, on the live path AND via crash-recovery and
   cold resume. (In-process delegation is storeless and documented as keeping its 30 K
   backstop.)
3. `⟦ref⟧` from a captured output splices faithfully into a `write_file` / cell for captures
   up to `REF_SPLICE_MAX_BYTES` (4 MiB; a capture between it and the 6 MiB bind wire limit
   stores but cannot splice — pre-existing, documented).
4. Every model-facing render this spec touches is redacted — outputs, previews, errors,
   fallbacks, no-store paths, clamped agent messages.
5. One marker format everywhere under the stated unit rule (fetch: `full body:`); the
   preserved behaviors each hold under test.
6. Full suite green, with inline-output assertion churn resolved honestly, each recorded.

## Risks (honest)

- **Broad blast radius.** Every agent sees previews + refs on outputs that used to be inline
  up to 20–50 KB; tests asserting inline content move. Mitigated by phasing and by the gate
  logic already existing at all three boundaries.
- **Code-editing regression** if budgets are too tight. Mitigated by the `read_file`
  exception, targeted re-reads, and `SPROUT_PREVIEW_BUDGETS`.
- **Redaction on the hot inline path** is new for primitives. The patterns are few and
  anchored; if it ever matters it shows up in the bench harness.
- **Genome prompt assumptions.** Prompts may assume full tool output or match old marker
  wording. Surveyed per phase.
- **Log-format coupling.** Gating upstream of the log write changes what `session_end`
  carries; recovery/resume of sessions recorded by OLDER builds still yields raw output
  (the backstop covers it). One-way, documented.
- **The capture-capable/source-less fork is two truncation regimes in one dispatch path.**
  Mitigated by making the split data (allow-list + `captureSource` presence), not scattered
  conditionals.
- **`ValueOrigin` extension** touches the journal schema and both codecs — small but
  load-bearing; resume of old journals must tolerate the absent field (it is optional).

## Open questions (for the P1 review, not blockers)

- Adaptive budgets? Static defaults + `SPROUT_PREVIEW_BUDGETS` cover per-deployment tuning;
  revisit only if code-editing regresses.
- A hard "always ref, no preview" mode? Out of scope; one-line future option.
- Should more tools become capture-capable (memory reads are the obvious candidate)? The
  governing principle makes that a per-tool `captureSource` addition, not a design change.
- Should session-collapse summarization learn to pass refs through instead of `[truncated]`?
  Inventoried, out of scope here.

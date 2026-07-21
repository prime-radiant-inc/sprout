# Capture-all tool outputs — design

**Date:** 2026-07-21
**Status:** design (awaiting Jesse's go)
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (capture/splice, §2),
`2026-07-19-sap-completion-and-roadmap-design.md` (data plane)
**Evidence:** `test/integration/code-mode-advantage.test.ts` (the structural wins, measured)

## Purpose

Make the sap data plane's capture mechanism **uniform across every tool-mode tool output** —
primitives (`read_file`, `exec`, `grep`, `glob`, `fetch`, `apply_patch`, …) **and the
delegate/subagent tool** — so that a substantial tool result becomes a captured store value the
model references by `⟦ref⟧` + a bounded preview, instead of flooding the provider payload with
its full content. This extends the *code mode* advantage to *tool mode*: tool-mode agents stop
bypassing the data plane and start benefiting from it.

## Why now

Measured, from `code-mode-advantage.test.ts` and the byte instrumentation (2026-07-21):

- Processing a ~100 KB log: a code-mode cell returns **15 bytes** to the model; the traditional
  `read_file` puts **50,220 bytes** into the payload — **~3,300× more model-facing bytes**.
- Relaying confidential content: code mode never exposes it; `read_file` returns it verbatim
  into the payload, and pattern-based redaction does not recognize it.

Tool mode leaves that value on the table because capture is **inconsistent**:

1. **Primitives capture only when they *truncate*.** The auto-capture in
   `createPrimitiveRegistry` fires on lossy truncation, at per-tool char limits that are LARGE
   (`read_file` 50 KB, `exec`/`fetch` 30 KB, `grep`/`glob` 20 KB — `truncation.ts`). A 20 KB
   API response or a 10 KB log flows **fully inline** into the payload; nothing is captured, and
   nothing is a reusable ref.
2. **The delegate/subagent tool never captures.** It is an agent tool (`buildDelegateTool`), not
   a primitive, so its result never touches the capture path. Every subagent's full result lands
   inline in the orchestrator's payload. An agent that fans out to N subagents accumulates all N
   results in its own context — the wall that makes deep multi-agent orchestration collapse.

## The wins (why this is better across the board)

1. **Reuse without reflow.** Every substantial tool output becomes a splice-able `⟦ref⟧`; relaying
   or re-using it (into a write, a cell, another agent) never re-floods the payload.
2. **Leak-proof by default.** Capture is content-agnostic — it keeps ALL captured bytes out of
   the payload, where redaction only catches recognized patterns (the `code-mode-advantage`
   Scenario 2 finding: confidential business content redaction misses).
3. **Orchestrator scaling (the prize).** Captured subagent results mean an orchestrator holds N
   refs + previews and *routes* them (splice into a report, hand to the next agent, reduce in a
   cell) instead of drowning in them. This is what makes many-agent pipelines viable.

## Goals

1. One **unified capture gate** applied to every tool result — primitives and the delegate tool —
   at a consistent, tunable, per-tool preview budget.
2. Above its budget, a tool result **captures the full (raw) content** into a session value and
   returns a **redacted, bounded preview + `⟦ref⟧`**; at or below budget it is returned inline
   (no capture — tiny/control-flow outputs are not worth a ref).
3. The delegate/subagent tool participates: a subagent's result captures into a value the PARENT
   can reference and splice.
4. The captured value is the RAW content (faithful splices); everything rendered to the model
   (preview, later reads) is redacted — the keystone no-leak property, uniformly.
5. Behavior converges with the cell transcript gate (`CELL_AUTO_BIND_THRESHOLD`), so code mode and
   tool mode capture the same way.

## Non-goals

- Changing cell/code-mode behavior (it already captures via the transcript gate — this brings tool
  mode *up to* it, not the reverse).
- Removing the model's ability to see content it needs (see the preview policy — this is the
  central decision, deliberately NOT "everything becomes a bare ref").
- A new store/scope model. Captured values bind into the acting agent's existing scope (delegate
  results bind into the PARENT's scope — see Design).

## Design

### The unified gate

Today the capture logic lives inside `createPrimitiveRegistry.execute` and is gated on
`truncateToolOutputDetailed(...).truncated`. Generalize it to a single `gateToolOutput(toolName,
rawOutput, captureStore)` used by BOTH the primitive registry and the delegate tool:

```
redacted = redact(rawOutput)
budget   = previewBudget(toolName)
if redacted.length <= budget:            # small / control-flow → inline, no capture
    return redacted
value    = captureStore.bind(name(toolName), rawOutput, explicit:false)   # RAW content
preview  = redacted.slice(0, budget)
return `${preview}\n[... ${redacted.length - budget} chars — full content: ⟦${value.name}⟧]`
```

This is the cell transcript gate (`cell-host.ts` `gateForTranscript`), lifted to a shared kernel
helper and parameterized by a per-tool budget. Cells keep their existing gate (or adopt the shared
helper with `budget = CELL_AUTO_BIND_THRESHOLD`) so the two paths cannot drift.

### THE central decision — the preview budget

What the model SEES by default is the one real tradeoff, and it is per-tool:

- A **tiny** budget (≈2 KB, cell-gate-aligned) maximizes token savings but starves workflows that
  need full sight — the model cannot see a 5 KB file it must *edit*, or reason over a subagent's
  detailed answer.
- A **large** budget (today's 50 KB) preserves sight but is the flood itself.

**Decision: per-tool budgets, sized to what the tool's output is FOR** — always capture above
budget, always return a ref, but let the preview match the plausible need:

| tool | today's limit | proposed budget | rationale |
|---|---|---|---|
| `read_file` | 50 KB | **8 KB** | code the model edits — most files fit fully; big files get ref |
| `edit_file` / `apply_patch` | 10 KB | 8 KB | same (the model reasons over the diff/region) |
| `exec` | 30 KB | **4 KB** | command output is usually consumed/routed, not read whole |
| `grep` / `glob` | 20 KB | 4 KB | match lists — a page is enough; the rest is a ref |
| `fetch` | 30 KB | **2 KB** | API/HTTP bodies are data to process in a cell, not to read |
| `delegate` (subagent) | ∞ (uncaptured) | **4 KB** | route the sub-result; full answer is a ref |

(Numbers are a starting proposal, not doctrine — they are the knob to tune against real runs.)
The unconditional wins (reuse, no-leak, orchestrator scaling) come from **always creating the ref**;
the budget only sets how much the model reads for free before reaching for the ref (or a cell).

### The delegate/subagent tool

Route the delegate tool's result through `gateToolOutput("delegate", result, captureStore)`. The
subagent's result binds into the **parent's** scope as a value (so the parent can `⟦ref⟧` it), and
the parent's tool result is the preview + ref. Cross-agent visibility: the value is created in the
parent's scope at delegation-return time (the parent owns it), not shared out of the child's scope —
no new scope semantics. Fan-out (`handle.future`) benefits directly: each future's result is a ref
the orchestrator reduces, not inline text it accumulates.

### Value naming + splice

Captured values get a derived, collision-safe name (`<tool>_<seq>`, matching the existing
`cell_<n>_return` scheme). The marker is the existing `⟦name⟧` sap splice token, so a captured tool
output is immediately usable everywhere a value is: `write_file` splices, cell `get()`, another
tool's argument.

### Redaction

The stored value is RAW (splices must be faithful — a spliced config with a real key must WORK).
The preview and every later model-facing render are redacted, exactly as the cell gate and the
transcript gate do today. Capture does not weaken redaction; it makes the no-leak guarantee
content-agnostic on top of it.

## Invariants

- A tool output at or below its budget is byte-identical to today (inline, redacted) — small reads
  do not regress.
- A captured value's stored content is the exact raw tool output; splicing `⟦ref⟧` reproduces it.
- Nothing above budget crosses to the model except the redacted preview + the marker.
- The delegate result is captured into the parent's scope; the child's scope is unchanged.

## Phases

**P1 — Shared gate + primitives.** Extract `gateToolOutput` (shared by the primitive registry and
cells); replace capture-on-truncation with capture-above-budget; wire per-tool budgets. Update the
primitive/truncation tests that assert inline content. Fable review.

**P2 — Delegate/subagent capture.** Route delegate results through the gate; bind into the parent
scope; the fan-out/`handle.future` path returns refs. Tests: a large sub-result is captured, the
orchestrator payload holds only the preview + ref, the ref splices to the full result. Fable review.

**P3 — Tune + prove.** Re-run `code-mode-advantage`-style measurement across tool mode (payload
bytes with capture on vs off); tune budgets; add an e2e scenario proving an N-way fan-out keeps the
orchestrator payload flat. Fable review.

## Acceptance

1. Every tool result over its budget is captured and returned as preview + `⟦ref⟧`; below budget,
   unchanged.
2. A subagent's large result never appears in full in the orchestrator's provider payload; the ref
   splices to the exact full result.
3. `⟦ref⟧` from a captured tool output splices faithfully into a `write_file` / cell.
4. Redaction unchanged for previews; stored values raw.
5. Full suite green (with the test churn from inline-output assertions resolved honestly, each
   recorded).

## Risks (honest)

- **Broad blast radius.** Every agent sees previews + refs on large tool outputs; tests that assert
  inline content move. This is the main cost — mitigated by phasing and by the gate already existing
  for primitives-on-truncation.
- **Code-editing regression** if budgets are too tight. Mitigated by the per-tool budget table
  (read_file/edit generous) and by targeted re-reads (`read_file` offset/limit) for full sight.
- **Genome prompt assumptions.** Agent prompts may assume they see full tool output. The preview +
  ref shape is close enough that most prompts are unaffected; surveyed and fixed where not.
- **Cross-agent value lifetime** for delegate captures — the parent-scope binding must outlive the
  child; verified against the existing future-reclaim rules.

## Open questions (for the P1 review, not blockers)

- Should the budget be a single number per tool, or adaptive (e.g., a larger budget when the agent's
  task is flagged code-editing)? Start static; revisit only if code-editing regresses.
- Do we ever want a hard "always ref, no preview" mode for a maximally-locked-down agent? Out of
  scope here; the gate makes it a one-line future option.

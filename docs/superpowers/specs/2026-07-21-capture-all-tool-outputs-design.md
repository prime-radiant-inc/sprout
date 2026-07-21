# Capture-all tool outputs — one budget table, one marker, three gates

**Date:** 2026-07-21
**Status:** design v7 (five adversarial review rounds; 53 verified findings folded in;
implementation authorized by Jesse 2026-07-21 after 1–3 further cycles)
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (capture/splice, §2),
`2026-07-19-sap-completion-and-roadmap-design.md` (data plane)
**Evidence:** `test/integration/code-mode-advantage.test.ts` (the structural wins, measured)

## Purpose

Every tool-output boundary should capture the same way: above a svelte, configurable budget,
the full raw content becomes a store value and the model gets a bounded preview + `⟦ref⟧`; at
or below budget it stays inline. Three gates already do versions of this — the primitive
registry gate (capture-on-truncation at 20–50 KB limits), the child-boundary auto-bind
(4,000 chars), and the cell transcript gate (2,000 chars, redacted).

**What needs unifying is the DATA, not the code.** The three gates stay where they are —
each is small, working, and tested. What they share:

1. **One budget record** (`DEFAULT_PREVIEW_BUDGETS`, configurable via
   `SPROUT_PREVIEW_BUDGETS`) — all three gates read their threshold from it.
2. **One marker helper** (`formatCaptureMarker()`) — all three gates emit through it.
3. **One redaction rule** — every model-facing render this spec touches passes
   `redactSensitiveTranscriptContent`.
4. **One predicate** — the svelte/capture path engages iff the result carries
   `captureSource` AND a capture store is present; everything else renders at today's
   limits.

No shared gate function, no new truncation mode, no callback contracts.

## Governing principles

1. **The svelte budget bites only where a ref compensates.** A result is cut to a svelte
   preview ONLY when the full content was captured and the marker names a value the reader
   can reach. No store, no `captureSource`, or a FAILED capture → today's limits. Capture
   failure is real, not exotic: channel-backed agents (all subprocess children) hard-fail
   binds over `CHANNEL_BIND_WIRE_LIMIT` (6 MiB) — deterministic for them. The ROOT agent
   uses `DirectStoreAccess`, which has NO wire limit: a >6 MiB root capture SUCCEEDS (up to
   `maxValueBytes`), and its value is then reachable via cells/`value_slice` even though
   splice (4 MiB) and `value_get` (50 K) refuse it. Both behaviors are by design and both
   are tested.
2. **Redaction is unconditional and orthogonal to capture.** Outputs, previews, error
   strings, fallbacks, no-store paths, recovery renders — all redacted. Today NONE of the
   parent-side result renders redact (verified: the only redaction in `agent.ts` is cell
   telemetry); this spec ADDS redaction there — it is new work with a named work item (P2),
   not a preserved behavior.

## Why now

Measured (`code-mode-advantage.test.ts`, 2026-07-21): a ~100 KB log processed in code mode
puts **15 bytes** in the payload; traditional `read_file` puts **50,220** — ~3,300×. Capture
is content-agnostic where redaction is pattern-based: sub-budget confidential content still
rides inline (Scenario 2's memo is ~171 chars), but every over-budget byte stays out.

The gaps against the code as it exists:

1. **Primitive budgets are large for exactly the high-volume tools** — capture fires only on
   lossy truncation at 20–50 KB (or line limits), so a 20 KB single-line API response flows
   fully inline: no capture, no ref.
2. **Only the subprocess delegation path captures.** Featherweight children return raw
   `exec.output` (no bind, no budget → the parent's generic 30,000-char fallback); the
   in-process fallback is the same; and the recovery/resume paths re-serve the raw durable
   log — the predecessor spec requires "summary + manifest like a live one" there, which
   was never implemented.
3. **Nothing on the tool-output paths redacts except the cell gate.** Primitive outputs,
   primitive error strings (`Error: ${result.error}`; `edit_file` errors embed a slice of
   `old_string`), child results, and all parent-side result renders are unredacted.

## Non-goals

- **No shared gate function.** The three gates keep their code; they share the record, the
  helper, redaction, and the predicate.
- **No new `TruncationMode`.** Cell and delegate gates keep their literal `slice(0, budget)`
  previews; captured markers always report chars.
- **No `ValueOrigin` schema change.** Nothing reads `origin` beyond the codecs (verified);
  featherweight values are attributed by their goal-slug NAME.
- **No log-format change.** The durable log stays a full-fidelity, below-the-line record
  (predecessor design). Recovery behavior changes READ-side only — see Delegation.
- **No cell binding-line cap; no fetch header cap** (deleted in v6; the `full body:` marker
  wording alone keeps the fetch marker honest).
- **The agent-message clamp is NOT part of this spec** — a standalone two-line fix
  (`AGENT_MESSAGE_RENDER_CLAMP = 4_000` + redaction in `renderAgentMessagesForPrompt`) that
  ships independently and immediately.
- Renaming captured values; changing flag-off sizing; new scope semantics for the
  subprocess flavor.

## Design

### The predicate

The registry gate's svelte/capture path runs iff `result.captureSource !== undefined` AND a
capture store is set. **Within** the gate, a non-empty `result.boundValues` selects the
no-double-store branch (the marker names the explicitly bound value; nothing binds twice) —
explicit-bind results carry BOTH fields, so `boundValues` remains the branch selector; the
predicate is the gate's entry condition, not the branch key. The former exemption classes
are instances of the predicate:

- `value_*` reads never set `captureSource` — the existing `name.startsWith("value_")`
  clause is dead code and is deleted. Their truncation ceilings become data rows **matching
  each tool's own contract**: `value_get` 50,000 (`VALUE_GET_CHAR_BUDGET`); `value_slice`
  and `value_grep` 262,144 (their store-side engine budgets, `sliceBudgetBytes` /
  `grepOutputBudgetBytes`) — a precision read is never silently middle-cut (predecessor §2
  requirement). Stated behavior change: today's generic 30,000 fallback mid-cuts all three.
- The `cell` primitive (`boundValues` but no `captureSource`) never enters the gate, fixing
  the bogus-marker hazard by construction. Its composite keeps the generic 30 K backstop.
- Memory/workspace tools and degraded-env fallbacks (`read_file` without `read_file_raw`,
  `grep` without `grep_structured`) have no source → today's limits.

Capture-capable after P1: `read_file`, `exec`, `grep`, `fetch`, `glob` (P1 adds glob's
`captureSource`). `CAPTURE_PRIMITIVE_NAMES` keeps its separate job (the explicit
`bind:`/`publish:` parameter surface) and is not part of the predicate.

### The registry gate (modified in place)

- Redact the rendered output and `result.error` (errors are redacted, never budgeted or
  captured), then gate on the redacted text.
- **On the predicate path, the svelte char budget is the ONLY truncation.** Below budget the
  output renders fully inline — including outputs over the old line limits. This is a
  **stated inline-path behavior change** (the third): today a sub-budget >256-line exec
  output is line-cut AND captured; under v7 it renders whole, which drops nothing and needs
  no ref. Line limits continue to apply only to non-predicate results (source-less tools,
  no store), where they keep doing readability work.
- Above budget: bind the raw `captureSource.content`, render the mode-shaped preview
  (existing `head_tail`/`tail` modes, unchanged) + marker. **Capture failure → re-truncate
  at the tool's `DEFAULT_CHAR_LIMITS` entry** with the `content not captured` banner, per
  principle 1.
- Preserved: no-double-store (above); the stderr companion, with its containment predicate
  moved to **redacted space** (raw-vs-redacted comparison would false-positive whenever
  stderr contains a redactable token); honest store-full degradation.
- `fetch`: `captureSource` stays body-only; its marker reads `full body: ⟦name⟧` so it
  never claims content (headers) the value doesn't hold.

### Delegation

- **Subprocess** (`prepareResultOutput`, in place): gains redaction, reads the `delegate`
  budget from the record, and **adopts the marker helper** (its marker text changes from
  "truncated at the summary budget — full output:" to the canonical form; the
  agent-process tests pinning the old wording move, recorded). Child-identity bind +
  publish (all-or-nothing; publish failure → fallback, never a marker), goal-slug naming,
  and the two-branch fallback (raw ≤ 30,000, no banner; slice + banner above) unchanged in
  shape, now redacted.
- **Featherweight** (`runFeatherweight`): no store connection and no handle registration,
  so the result binds via the spawner's parent-scoped `StoreAccess` into the PARENT's scope
  — bare `{ kind: "delegation" }` origin, goal-slug name, **no publish**. **Private,
  non-keep-alive handles only**: a shared or keep-alive featherweight result keeps the raw
  path (a marker naming a parent-scope value would be unreadable to a future non-owner
  waiter of a shared handle; one sentence closes what would otherwise be a latent
  invariant violation when cross-process shared waits land). Capture failure → the
  existing raw path. `plan_end`/child-facing replay history stays full-fidelity raw.
- **In-process fallback**: out of scope for capture — it runs only when no spawner exists
  (`agent.ts:2942–2944`), hence storeless; its renders gain redaction via the parent-side
  render work item below.
- **Recovery/resume (read-side clamp — the predecessor's requirement, now implemented).**
  The predecessor spec: "A recovered result delivers summary + manifest like a live one;
  nothing published is ever stranded. Only if the store itself is unavailable at recovery
  does the fallback drop to the full logged output at today's 30 K inline truncation."
  v7 implements exactly that, read-side: at the recovery/resume seam
  (`readHandleResult`/`settleHandleResult`), a logged output over the `delegate` budget is
  clamped to the budget-sized head + a mechanical-cut banner (no marker is synthesized —
  the manifest lines, which already render adjacent to every result, deliver any published
  ref); when the store is unavailable, the 30 K fallback stands. The log itself is
  untouched. Live subprocess results are already ≤ budget + marker and are never re-cut.
- **Parent-side render redaction (new work item, P2).** The delegation-outcome renders
  (`agent.ts:2302`, `2466`, `2512`, `2556`, and the in-process render at `1500`) redact
  the result output. This is the choke point that covers live, recovery, resume,
  in-process, and `wait_agent`/`message_agent` renders in one place.

### The cell gate (in place)

Reads its threshold from its OWN row in the record (`cell: 2000` — an explicit row, so
tuning `default` does not silently move the data-plane transcript gate) and emits its
marker via the shared helper. Its 14 lines, redact-then-gate ordering, and head-slice shape
stay.

### The marker

One helper: `formatCaptureMarker(name, droppedChars, opts?)` where `opts` covers the two
variants the format needs: `noun` (`"content"` default; `"body"` for fetch) and
`stderrName` (the preserved exec companion appends `, stderr: ⟦name⟧` — the helper owns
this so Acceptance #5 is satisfiable). Formats:

```
[... N chars truncated — full content: ⟦name⟧]
[... N chars truncated — full body: ⟦name⟧]                      (fetch)
[... N chars truncated — full content: ⟦name⟧, stderr: ⟦name2⟧]  (exec companion)
[... <dropped> truncated; store full — content not captured]      (degradation)
[... <dropped> truncated; capture failed — content not captured]
```

Captured markers always report chars. "full content:" is canonical; primitive-side tests
pinning "full output:" (`test/kernel/capture.test.ts`) AND delegate-side tests pinning the
old summary-budget wording (`test/bus/agent-process.test.ts`) move — churn recorded per
test. The machine contract is the `⟦…⟧` glyph pair.

### Budgets — svelte by default, configurable (Jesse, 2026-07-21)

Chars, one record with explicit rows:

| row | chars | note |
|---|---|---|
| `default` | 2,000 | exec, grep, glob, fetch |
| `read_file` | 4,000 | the code-editing exception; offset/limit re-reads past it |
| `delegate` | 4,000 | preserves `SUMMARY_BUDGET_CHARS` and today's preview shape |
| `cell` | 2,000 | explicit row; `CELL_AUTO_BIND_THRESHOLD` folds in |

Not capture-capable, so keeping today's limits: `edit_file`/`apply_patch`/`write_file`;
source-less tools. Value-read ceilings become contract-matching rows (50,000 / 262,144 /
262,144 — stated change, above).

`DEFAULT_PREVIEW_BUDGETS` lives beside `DEFAULT_CHAR_LIMITS`. `SPROUT_PREVIEW_BUDGETS` is
one env var, a JSON map merged over defaults, resolved once per process at startup; invalid
→ warn + defaults. The spawner spreads live `process.env` at spawn time (`spawner.ts:233`),
so it reaches children; evals/tests use the programmatic override channel.

## Invariants

Holding when the predicate holds and capture succeeds; capture-failed, source-less,
no-store, and store-unavailable-recovery paths render at today's sizing, redacted — the
documented exceptions, each with a P1/P2 work item and test:

- At or below budget: identical to today except redaction and the **three** stated changes
  (value-read ceilings; fetch marker noun; sub-budget line-dense outputs render whole on
  the predicate path).
- Captured values store the exact raw SOURCE; `⟦ref⟧` splices reproduce it up to the
  pre-existing 4 MiB `REF_SPLICE_MAX_BYTES`. (Channel-backed captures cap at 6 MiB by the
  wire limit; root captures can exceed both — reachable via cell/`value_slice`.)
- Above budget, only the redacted preview + marker crosses on the live path; recovery with
  a reachable store clamps to the delegate budget (manifest delivers refs).
- No double-store; no marker ever names a value the reader cannot see (which is why
  shared/keep-alive featherweight results do not capture, and recovery synthesizes no
  marker).
- Subprocess bind-and-publish semantics unchanged; featherweight capture only adds values
  to the parent's own scope.

## Phases

**P1 — Registry gate + shared data.** The budget record (+ explicit `cell` row) + resolver;
`formatCaptureMarker` (noun + stderr slots); the predicate (delete the dead `value_*`
clause; entry = `captureSource` + store, branch = `boundValues`); chars-only trigger (with
the stated sub-budget line-shaping change); capture-failed → today's-limits rendering;
redaction of registry outputs and errors; stderr predicate to redacted space; `glob`
captureSource; value-read contract rows (50 K/256 K/256 K); fetch `full body:` noun. TDD;
inline-assertion churn recorded per test. Fable review.

**P2 — Delegation + cell fold-in + prove.** Subprocess: redaction + budget-from-record +
marker-helper adoption (delegate-side test churn recorded). Featherweight: parent-scope
bind flavor, private non-keep-alive handles only (tests: over-budget result → preview +
ref; shared/keep-alive → raw path; capture-failure → raw path; publish-failure at
subprocess → fallback, never a marker). Recovery/resume read-side clamp (store reachable →
delegate-budget head + banner + manifest refs; store unavailable → 30 K). Parent-side
render redaction at the delegation-outcome choke points. Cell: threshold from its record
row + marker helper. Measurement: `code-mode-advantage`-style payload byte counts with
capture on/off; an e2e proving N-way fan-out keeps the orchestrator payload flat; tune
budgets. Fable review.

(The agent-message clamp ships separately, before or alongside P1.)

## Acceptance

1. Capture-capable over-budget outputs → redacted preview + `⟦ref⟧`; at or below budget →
   inline, redacted, with the three stated changes. Documented exceptions render at
   today's sizing, redacted — each tested, including BOTH >6 MiB behaviors (channel:
   deterministic capture failure → 30–50 K rendering; root/direct: capture succeeds).
2. **Absent capture failure**, subprocess and featherweight sub-results over budget never
   ride the live parent payload in full, and recovery/resume with a reachable store clamps
   to the delegate budget; refs splice to the exact result. Capture failure degrades per
   principle 1 (tested); store-unavailable recovery and in-process keep the 30 K backstop
   (documented, redacted).
3. Splice fidelity up to the 4 MiB bound (documented).
4. Every render this spec touches is redacted — registry outputs, previews, errors,
   fallbacks, and ALL parent-side delegation-result renders (new work, tested).
5. One marker via one helper (noun + stderr variants included); preserved behaviors hold
   under test.
6. Full suite green; assertion churn recorded.

## Risks (honest)

- **Blast radius**: outputs inline up to 20–50 KB today become preview + ref; tests move.
- **Code-editing regression** if 4,000 is too tight for `read_file`; offset/limit re-reads
  and `SPROUT_PREVIEW_BUDGETS` are the relief valves.
- **Redaction on the hot path** — a few anchored regexes; the bench harness will say if it
  matters.
- **Genome prompts** may assume full output or old marker wording — surveyed per phase.
- **Featherweight binds charge the parent's 10,000-value scope cap** — unlike subprocess
  results, whose manifest aliases deliberately don't (`store.ts` alias delivery). Sustained
  featherweight fan-out consumes parent slots until store-full, at which point results
  degrade honestly to the raw path. Accepted: the cap is generous, degradation is honest,
  and the asymmetry is inherent to parent-scope binding; revisit only if real orchestrators
  hit the cap.
- **Recovery clamp touches the crash path** — mitigated: read-side only, log untouched,
  live results never re-cut (they arrive ≤ budget + marker), and the store-unavailable
  fallback is exactly today's behavior.

## Open questions (for the P1 review, not blockers)

- Adaptive budgets? Static + env override; revisit only if code-editing regresses.
- "Always ref, no preview" lockdown mode? One-line future option.
- More capture-capable tools (memory reads)? A per-tool `captureSource` addition under the
  predicate — not a design change.

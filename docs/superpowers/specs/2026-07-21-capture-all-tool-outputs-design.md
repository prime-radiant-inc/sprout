# Capture-all tool outputs — one budget table, one marker, three gates

**Date:** 2026-07-21
**Status:** design v6 (four adversarial review rounds: three correctness rounds — 33 verified
findings folded in — then a simplification round that DELETED most of the accreted machinery;
awaiting Jesse's go)
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (capture/splice, §2),
`2026-07-19-sap-completion-and-roadmap-design.md` (data plane)
**Evidence:** `test/integration/code-mode-advantage.test.ts` (the structural wins, measured)

## Purpose

Every tool-output boundary should capture the same way: above a svelte, configurable budget,
the full raw content becomes a store value and the model gets a bounded preview + `⟦ref⟧`; at
or below budget it stays inline. Three gates already do versions of this — the primitive
registry gate (capture-on-truncation at 20–50 KB limits), the child-boundary auto-bind
(4,000 chars), and the cell transcript gate (2,000 chars, redacted).

**The v6 insight (simplification round): what needs unifying is the DATA, not the code.**
The three gates stay where they are — each is small, working, and tested. What they share is:

1. **One budget record** (`DEFAULT_PREVIEW_BUDGETS`, configurable via
   `SPROUT_PREVIEW_BUDGETS`) — all three gates read their threshold from it.
2. **One marker helper** (`formatCaptureMarker()`) — all three gates emit the same marker.
3. **One redaction rule** — every model-facing render passes
   `redactSensitiveTranscriptContent`.
4. **One predicate** — the svelte/capture path engages iff the result carries
   `captureSource` and a capture store is present; everything else renders at today's limits.

No shared gate function, no new truncation mode, no callback contracts, no boundary-owned
rendering protocol. Earlier drafts built those; the simplification review showed each existed
only to route 14-line gates through machinery they don't need.

## Governing principles

1. **The svelte budget bites only where a ref compensates.** A result is cut to a svelte
   preview ONLY when the full content was captured and the marker names a value the reader
   can reach. No store, no `captureSource`, or a FAILED capture (store full; the
   deterministic 6 MiB `CHANNEL_BIND_WIRE_LIMIT` on big outputs) → today's limits. Svelte
   truncation without a ref destroys information with no compensation; this spec never does
   that.
2. **Redaction is unconditional and orthogonal to capture.** Outputs, previews, error
   strings, fallbacks, no-store paths — all redacted. "Keeps today's behavior" below always
   means today's *sizing*, plus redaction.

## Why now

Measured (`code-mode-advantage.test.ts`, 2026-07-21): a ~100 KB log processed in code mode
puts **15 bytes** in the payload; traditional `read_file` puts **50,220** — ~3,300×. And
capture is content-agnostic where redaction is pattern-based: sub-budget confidential content
still rides inline (Scenario 2's memo is ~171 chars), but every over-budget byte stays out.

The gaps against the code as it exists:

1. **Primitive budgets are large for exactly the high-volume tools** — capture fires only on
   lossy truncation at 20–50 KB (or line limits), so a 20 KB single-line API response flows
   fully inline: no capture, no ref.
2. **Only the subprocess delegation path captures.** Featherweight children return raw
   `exec.output` (no bind, no budget → the parent's generic 30,000-char fallback), and the
   in-process fallback is the same.
3. **Only the cell gate redacts.** Primitive outputs, primitive **error** strings
   (`Error: ${result.error}` rendering; `edit_file` errors embed a slice of `old_string`),
   and child results reach the transcript unredacted.

## Non-goals (much of this is what v6 deleted — kept for the record)

- **No shared gate function.** The three gates keep their code; they share the record, the
  marker helper, redaction, and the predicate.
- **No new `TruncationMode`.** The cell and delegate gates keep their literal
  `slice(0, budget)` previews; no `head` mode, no marker unit rule (captured markers always
  report chars — a line-limit cut no longer triggers capture, below).
- **No `ValueOrigin` schema change.** Nothing in the tree reads `origin` beyond the codecs
  (verified by search); featherweight values bind with the existing bare
  `{ kind: "delegation" }` and are attributed by their goal-slug NAME, which every actual
  reader (humans, transcripts) uses.
- **No durable-log change.** The predecessor spec deliberately logs the full output
  ("the log is below the line — it's a file") and delivers published refs to recovered
  results via the normal manifest fetch ("nothing published is ever stranded" — and the
  manifest lines render adjacent to every result, `agent.ts:2302–2305`). v5's
  gate-before-log-write + two-renderings design reversed that without acknowledging it;
  reverted. Crash-recovery/cold-resume renders keep today's 30 K backstop + redaction — a
  documented principle-1 degradation on a rare path.
- **No cell binding-line cap.** Reaching the 30 K registry backstop takes ~350 binding lines
  (~85 chars each; spawns cap at 64 ≈ 4–5 KB); a deliberate `bind()` loop lands on the
  honest generic banner. Not worth a mechanism.
- **No fetch header cap.** The `full body:` marker wording alone makes the fetch marker
  honest; bounding headers was preview aesthetics purchased with an inline behavior change.
- **The agent-message clamp is NOT part of this spec.** `renderAgentMessagesForPrompt`
  injects message text unbounded and unredacted into the system prompt — real, and fixed as
  a standalone two-line change (own constant, `AGENT_MESSAGE_RENDER_CLAMP = 4_000`, +
  redaction) that ships independently and immediately. It shares nothing with capture and
  should not ride the `delegate` budget knob.
- Renaming captured values; changing flag-off / no-store sizing; new scope semantics for the
  subprocess flavor.

## Design

### The predicate (replaces v5's exemption taxonomy)

The registry gate's svelte/capture path runs iff `result.captureSource !== undefined` AND a
capture store is set. One condition; the former exemption classes are all instances of it:

- `value_*` reads never set `captureSource` — the existing `name.startsWith("value_")`
  clause is dead code and is deleted, not preserved. Their truncation ceilings become data:
  50,000-char rows (`VALUE_GET_CHAR_BUDGET`) in the limits record — **a stated behavior
  change**: today's generic 30,000 fallback mid-cuts `value_get` in the 30–50 K range,
  breaking the tool's own "up to 50000 chars" contract.
- The `cell` primitive has `boundValues` but no `captureSource`; keying the no-double-store
  branch on `captureSource` presence (not `boundValues`) fixes the bogus-marker hazard **by
  construction** — no named exemption. Its composite keeps the generic 30 K backstop.
- Memory/workspace tools, and the degraded-env fallbacks (`read_file` without
  `read_file_raw`, `grep` without `grep_structured`), have no source → today's limits.

Capture-capable after P1: `read_file`, `exec`, `grep`, `fetch`, `glob` (P1 adds glob's
`captureSource`). The `CAPTURE_PRIMITIVE_NAMES` allow-list keeps its separate existing job
(the explicit `bind:`/`publish:` parameter surface); it is NOT part of the gating predicate.

### The registry gate (modified in place, ~15 lines)

- Redact the rendered output (and `result.error` — errors are redacted, never budgeted or
  captured), then gate on the redacted text.
- **Chars-only svelte trigger**: when the predicate holds, the budget is the char limit.
  Line limits no longer trigger capture — under a 2,000-char budget a line-only trip means
  ≤ 2,000 chars across 200+ lines, where inlining drops nothing and capture would drop
  lines to store what fits inline anyway. Line limits keep working on every no-capture
  regime, where they do real readability work.
- Above budget: bind the raw `captureSource.content`, render the mode-shaped preview
  (existing `head_tail`/`tail` modes, unchanged) + marker. **Capture failure → re-truncate
  at the tool's `DEFAULT_CHAR_LIMITS` entry** with the `content not captured` banner — a
  >6 MiB read still shows ~50 KB, per principle 1.
- Preserved as today: no-double-store (marker names the explicitly bound value); the stderr
  companion, with its containment predicate moved to **redacted space** (raw-vs-redacted
  comparison would false-positive whenever stderr contains a redactable token); honest
  store-full degradation.
- `fetch`: `captureSource` stays body-only (deliberate — splices want the body); its marker
  reads `full body: ⟦name⟧` so it never claims content (headers) the value doesn't hold.

### Delegation (two flavors in scope)

- **Subprocess** (`prepareResultOutput`, in place): gains redaction and reads the `delegate`
  budget from the record. Child-identity bind + publish (all-or-nothing — a bind that
  succeeds but a publish that fails produces the fallback, never a marker naming a value
  the parent can't see), goal-slug naming, and the two-branch fallback (raw ≤ 30,000 with
  no banner; slice + `[... output truncated at 30000 chars]` above) all unchanged.
- **Featherweight** (`runFeatherweight`): these children skip handle registration and hold
  no store connection, so child-identity bind is impossible. The result binds via the
  spawner's parent-scoped `StoreAccess` into the PARENT's scope — bare
  `{ kind: "delegation" }` origin, goal-slug name, **no publish** (the value is already in
  the parent's scope; publishing would push it to the grandparent). Capture failure → the
  existing raw path. `plan_end` / child-facing replay history stays full-fidelity raw (the
  child re-reads its own prior answer; clamping it would be a regression).
- **In-process fallback**: out of scope — it runs only when no spawner exists
  (`agent.ts:2942–2944`), hence storeless; keeps its 30 K backstop + redaction.
- **Recovery/resume**: unchanged (see Non-goals) — 30 K backstop + redaction; published
  refs arrive via the manifest as designed.

### The cell gate (in place)

Reads its threshold from the record (`cell` entry — `CELL_AUTO_BIND_THRESHOLD` folds in and
becomes configurable, the one real deliverable here) and emits its marker via the shared
helper. Its 14 lines, redact-then-gate ordering, and head-slice shape stay.

### The marker

One helper, one format:

```
[... N chars truncated — full content: ⟦name⟧]        (fetch: full body: ⟦name⟧)
```

Captured markers always report chars (line cuts no longer capture). Degradation forms:
`[... <dropped> truncated; store full — content not captured]` / `; capture failed — …`.
"full content:" is canonical (the cell gate and the scenario-3 test already match it);
primitive-side tests pinning "full output:" move, recorded. The machine contract is the
`⟦…⟧` glyph pair.

### Budgets — svelte by default, configurable (Jesse, 2026-07-21)

Chars, one record: **`default`: 2,000** (exec, grep, glob, fetch, and the `cell` entry);
**`read_file`: 4,000** (the code-editing exception; offset/limit re-reads past it);
**`delegate`: 4,000** (preserves `SUMMARY_BUDGET_CHARS` and today's preview shape).
Not capture-capable, so untouched: `edit_file`/`apply_patch`/`write_file` keep their
existing limits; value reads 50,000 (stated change); source-less tools today's limits.

`DEFAULT_PREVIEW_BUDGETS` lives beside `DEFAULT_CHAR_LIMITS`. `SPROUT_PREVIEW_BUDGETS` is
one env var, a JSON map merged over defaults, resolved once per process at startup; invalid
→ warn + defaults. The spawner spreads live `process.env` at spawn time (`spawner.ts:233`),
so it reaches children; evals/tests use the programmatic override channel.

## Invariants

Holding when the predicate holds and capture succeeds; capture-failed, source-less,
no-store, and recovery/resume paths render at today's sizing, redacted — the documented
exceptions, each tested:

- At or below budget: identical to today except redaction (and the two stated changes:
  value-read ceiling 30 K → 50 K; fetch marker wording).
- Captured values store the exact raw SOURCE; `⟦ref⟧` splices reproduce it (up to the
  pre-existing 4 MiB `REF_SPLICE_MAX_BYTES`; 4–6 MiB captures store but cannot splice).
- Above budget, only the redacted preview + marker crosses on the live path.
- No double-store; no marker ever names a value the reader cannot see.
- Subprocess bind-and-publish semantics unchanged; featherweight capture only adds values
  to the parent's own scope.

## Phases (three → two)

**P1 — Registry gate + shared data.** The budget record + resolver; the marker helper; the
predicate (delete the dead `value_*` clause; key no-double-store on `captureSource`);
chars-only trigger; capture-failed → today's-limits rendering; redaction of outputs and
errors; stderr predicate to redacted space; `glob` captureSource; value-read ceiling rows;
fetch `full body:` marker. TDD; inline-assertion churn recorded per test. Fable review.

**P2 — Delegation + cell fold-in + prove.** Subprocess: redaction + budget-from-record.
Featherweight: parent-scope bind flavor (tests: over-budget result → preview + ref;
capture-failure → raw path; publish-failure at subprocess → fallback, never a marker).
Cell: threshold from record + marker helper (its existing tests must pass untouched except
recorded marker-wording moves). Measurement: re-run `code-mode-advantage`-style payload
byte counts with capture on/off; an e2e proving N-way fan-out keeps the orchestrator
payload flat; tune budgets. Fable review.

(The agent-message clamp ships separately, before or alongside P1 — it waits on nothing.)

## Acceptance

1. Capture-capable over-budget outputs → redacted preview + `⟦ref⟧`; at or below budget →
   inline, redacted, today's shaping. Documented exceptions render at today's sizing,
   redacted — each tested, including the deterministic >6 MiB capture failure.
2. Subprocess and featherweight sub-results over budget never ride the live parent payload
   in full; refs splice to the exact result. (Recovery/resume and in-process: 30 K backstop,
   documented.)
3. Splice fidelity up to the 4 MiB bound (documented).
4. Every render this spec touches is redacted — outputs, previews, errors, fallbacks.
5. One marker via one helper; preserved behaviors hold under test.
6. Full suite green; assertion churn recorded.

## Risks (honest)

- **Blast radius**: outputs inline up to 20–50 KB today become preview + ref; tests move.
  Mitigated by phasing; the gates already exist.
- **Code-editing regression** if 4,000 is too tight for `read_file` — the deliberate svelte
  cost; offset/limit re-reads and `SPROUT_PREVIEW_BUDGETS` are the relief valves.
- **Redaction on the hot path** — a few anchored regexes; the bench harness will say if it
  ever matters.
- **Genome prompts** may assume full output or old marker wording — surveyed per phase.
- **Recovery/resume renders up to 30 K raw (redacted)** — accepted, documented; the
  alternative (v5's log redesign) cost a log-format migration and a child-history
  regression to close a rare, bounded, redacted path.

## Open questions (for the P1 review, not blockers)

- Adaptive budgets? Static + env override; revisit only if code-editing regresses.
- "Always ref, no preview" lockdown mode? One-line future option.
- More capture-capable tools (memory reads)? A per-tool `captureSource` addition under the
  predicate — not a design change.

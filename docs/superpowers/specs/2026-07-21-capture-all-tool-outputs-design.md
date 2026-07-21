# Capture-all tool outputs — one budget table, one marker, three gates

**Date:** 2026-07-21
**Status:** design v9 (seven adversarial review rounds; 76 verified findings folded in;
implementation authorized by Jesse 2026-07-21)
**Predecessor specs:** `2026-07-16-sap-data-plane-and-repl-design.md` (capture/splice, §2),
`2026-07-19-sap-completion-and-roadmap-design.md` (data plane)
**Evidence:** `test/integration/code-mode-advantage.test.ts` (the structural wins, measured)

## Purpose

Every tool-output boundary should capture the same way: above a svelte, configurable budget,
the full raw content becomes a store value and the model gets a bounded preview + `⟦ref⟧`; at
or below budget it stays inline. Three gates already do versions of this — the primitive
registry gate (capture-on-truncation at 20–50 KB limits), the child-boundary auto-bind
(4,000 chars), and the cell transcript gate (2,000 chars, redacted).

**What needs unifying is the DATA, not the code.** The three gates stay where they are.
What they share:

1. **One budget record** (`DEFAULT_PREVIEW_BUDGETS`, configurable via
   `SPROUT_PREVIEW_BUDGETS`) — all three gates read their threshold from it.
2. **One marker helper** — all markers flow through it.
3. **One redaction rule** — every model-facing render this spec touches passes
   `redactSensitiveTranscriptContent`.
4. **One predicate** — the svelte/capture path engages iff the result carries
   `captureSource` AND a capture store is present; everything else renders at today's
   limits.
5. **One delegation-render helper** — the parent renders every child result (live,
   recovered, resumed, in-process) through a single function that redacts, clamps, and
   appends manifest lines.

## Governing principles

1. **The svelte budget bites only where a ref compensates.** A result is cut to a svelte
   preview ONLY when the full content was captured and the marker names a value the reader
   can reach. No store, no `captureSource`, or a FAILED capture → today's limits.
   Channel-backed agents (all subprocess children) hard-fail binds over
   `CHANNEL_BIND_WIRE_LIMIT` (6 MiB) — deterministic for them. The ROOT agent uses
   `DirectStoreAccess` (no wire limit): a >6 MiB root capture SUCCEEDS, reachable via
   cells/`value_slice` even though splice (4 MiB) and `value_get` (50 K) refuse it. Both
   behaviors are by design and both are tested.
2. **Redaction is unconditional and orthogonal to capture.** Registry outputs, previews,
   error strings, fallbacks, and the delegation-render helper — all redacted. Today NONE of
   the parent-side result renders redact; this spec ADDS that (named work item), not
   preserves it.

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
   `exec.output`; the in-process fallback is the same; and the recovery/resume paths
   re-serve the raw durable log — the predecessor requires "summary + manifest like a live
   one" there, never implemented.
3. **Nothing on the tool-output paths redacts except the cell gate** — primitive outputs,
   error strings (`Error: ${result.error}`; `edit_file` errors embed a slice of
   `old_string`), child results, and all parent-side renders are unredacted.

## Non-goals

- **No shared gate function; no new `TruncationMode`; no `ValueOrigin` change; no
  log-format change** (all deleted in earlier rounds — the durable log stays a
  full-fidelity, below-the-line record; recovery behavior changes render-side only).
- **No cell binding-line cap; no fetch header cap** (the `full body:` marker noun alone
  keeps the fetch marker honest).
- **The agent-message clamp is NOT part of this spec** — a standalone two-line fix
  (`AGENT_MESSAGE_RENDER_CLAMP = 4_000` + redaction in `renderAgentMessagesForPrompt`)
  that ships independently and immediately.
- Renaming captured values; changing flag-off sizing; new scope semantics for the
  subprocess flavor.

## Design

### The predicate

The registry gate's svelte/capture path runs iff `result.captureSource !== undefined` AND a
capture store is set. **Within** the gate, non-empty `result.boundValues` selects the
no-double-store branch (explicit-bind results carry both fields; the predicate is the entry
condition, `boundValues` the branch selector). The former exemption classes are instances:

- **`value_*` reads bypass registry truncation entirely** — hoisted ABOVE the truncation
  call, restoring the predecessor's stated design ("they bypass the registry's
  `truncateToolOutput` layer … a precision instrument whose own budgets *are* the
  truncation policy; never a silent middle-cut"). The tools already self-bound
  (`value_get` 50 K refusal; slice/grep engine budgets 256 KB) and self-redact via
  `ok()`/`fail()`. One source fix rides along: `value_get`'s over-budget error path
  currently embeds `err.message` without `fail()` — routed through `fail()` so the error
  is redacted like every other. (Stated change: >30 K value reads no longer mid-cut by the
  generic fallback.) The old post-truncation `name.startsWith("value_")` capture clause is
  deleted as dead.
- The `cell` primitive (`boundValues`, no `captureSource`) never enters the gate — the
  bogus-marker hazard is fixed by construction. Its composite keeps the generic 30 K
  backstop.
- Memory/workspace tools and degraded-env fallbacks (`read_file` without `read_file_raw`,
  `grep` without `grep_structured`) have no source → today's limits.

Capture-capable after P1: `read_file`, `exec`, `grep`, `fetch`, `glob`. P1 gives glob a
`captureSource` AND adds it to `CAPTURE_PRIMITIVE_NAMES` — one capability list, no
two-lists caveat; glob gains the explicit `bind:` surface like its peers. One caveat the
"generic" claim misses: `summarizeArgs` hardcodes per-tool arg keys and defaults to `url`,
so P1 also adds glob's `pattern` arm — otherwise every glob bind records empty
`argsSummary` provenance.

### The registry gate (modified in place)

- Redact the rendered output and `result.error` (errors are redacted, never budgeted or
  captured), then gate on the redacted text. (`value_*` results return before this gate's
  truncation — they self-redact.)
- **On the predicate path, the svelte char budget is the ONLY truncation.** Below budget
  the output renders fully inline — including outputs over the old line limits (a stated
  inline-path change: today a sub-budget >256-line exec output is line-cut AND captured;
  under v8 it renders whole, dropping nothing). Line limits continue on non-predicate
  results only.
- Above budget: bind the raw `captureSource.content`, render the mode-shaped preview
  (existing `head_tail`/`tail` modes) + marker. **Capture failure → re-truncate at the
  tool's `DEFAULT_CHAR_LIMITS` entry** with the `content not captured` banner (principle 1).
- Preserved: no-double-store; the stderr companion with its containment predicate moved to
  **redacted space**; honest store-full degradation.
- `fetch`: `captureSource` stays body-only; its marker noun is `body`.

### Delegation

- **Subprocess** (`prepareResultOutput`, in place): gains redaction, reads the `delegate`
  budget from the record, adopts the marker helper, and its preview becomes
  **budget-inclusive** (head slice + marker together ≤ the delegate budget). Ordering
  matters: **redact THEN slice** — redaction can lengthen text (`token: abc` →
  `token: [REDACTED_SECRET]`), so slicing first could push a boundary-length preview back
  over budget after the parent re-redacts. Child-identity bind + publish (all-or-nothing;
  publish failure → fallback, never a marker), goal-slug naming, and the two-branch
  fallback (raw ≤ 30,000; slice + banner above) unchanged in shape, now redacted.
- **Featherweight**: **reuses `prepareResultOutput` with a `{ publish: boolean }` flag**
  (moved to a shared module to avoid an import cycle) — it is field-for-field the same
  mechanism: bind full output, goal-slug name, `{ kind: "delegation" }` origin, head +
  marker, degrade-to-raw on failure. Featherweight passes the spawner's parent-scoped
  `StoreAccess` and `publish: false` (the value is already in the parent's scope;
  publishing would push it to the grandparent). **Private handles only** — private
  visibility is the exact discriminator for owner-only readability, and on every path that
  can reach featherweight, keep-alive ⟺ shared (verified), so one clause suffices. Called
  at the two featherweight settle points; `plan_end`/child-facing replay stays raw.
  Provenance note: the bind passes the CHILD's handleId (as subprocess does); over a
  channel the host forces the connection identity, so a mid-tier parent's featherweight
  captures stamp the parent while a root parent's stamp the child — a documented
  inconsistency in audit metadata only, accepted.
- **In-process fallback**: storeless by construction (`agent.ts:2942–2944`); no capture;
  covered by the render helper below.

### The delegation-render helper (parent side — one seam for redaction AND recovery)

The five current render sites (`agent.ts:1500, 2302, 2466, 2512, 2556` — the complete
caller set of `truncateToolOutput`, and four of them the same expression **including the
`rewriteManifestNames` step**, which the helper keeps) collapse into one private helper
the parent uses for every child result:

```
renderDelegationResult(output, label, manifest, recovered):
    redacted = redact(output)
    if recovered AND manifest.deliveredResultValue AND redacted.length > delegateBudget:
        body = clamp(redacted, delegateBudget) + recovered-clamp banner
    else:
        body = truncateToolOutput(redacted, label)     # generic 30 K backstop
    return rewriteManifestNames(body, manifest.rewrites) + manifest.lines
```

Two inputs make the clamp honest and structural, and both are named work items:

- **`recovered`** — stamped (in-memory only; no log change) on the `ResultMessage`
  reconstructed at the two recovery sites (`readPersistedHandleResult`,
  `loadCompletedChildHandles`). LIVE results — gated (≤ budget by the budget-inclusive
  marker) or capture-failed (raw ≤ 30 K, which principle 1 requires stay at today's
  limits) — never carry the flag and can never reach the clamp.
- **`manifest.deliveredResultValue`** — `fetchManifestLines` gains a typed return
  (`status: ok | no-store | unavailable`, plus whether the delta delivered the child's
  auto-published delegation-origin result value). This IS a contract change to
  `fetchManifestLines`, owned as such: today no-store and empty-delta are
  indistinguishable (`lines: ""` both) and the unavailable case returns text, not a
  signal. The clamp fires only when the ref the reader needs actually arrived; every
  other case — store unavailable, delta already consumed by an earlier render
  (delivery cursors are durable), child died before publishing, other-values-published-
  but-result-failed — lands on the 30 K backstop, redacted.

This implements the predecessor's recovery requirement ("summary + manifest like a live
one; … only if the store itself is unavailable does the fallback drop to the full logged
output at today's 30 K") at the one place that renders both the summary and the manifest.
The durable log and `handle.result` are untouched; no `⟦ref⟧` is synthesized (the manifest
line delivers the published ref, adjacent); the storeless in-process path lands on the
30 K branch automatically. Redaction is written exactly once and covers live, recovered,
resumed, in-process, `wait_agent`, and `message_agent` renders — plus any future caller.

### The cell gate (in place)

Reads its threshold from its OWN row (`cell: 2000` — explicit, so tuning `default` does
not silently move the data-plane transcript gate) and emits its marker via the helper. Its
markers are already byte-identical to the canonical format, so this is a zero-behavior
refactor with zero test churn.

### The marker

One helper, prefix + tail — no option slots:

```
captureMarker(dropped, tail)  →  "[... ${dropped} truncated${tail}]"
```

The six canonical forms, all through the helper:

```
[... N chars truncated — full content: ⟦name⟧]
[... N chars truncated — full body: ⟦name⟧]                      (fetch)
[... N chars truncated — full content: ⟦name⟧, stderr: ⟦name2⟧]  (exec companion)
[... N chars truncated — full output: see published values below] (recovered clamp)
[... <dropped> truncated; store full — content not captured]
[... <dropped> truncated; capture failed — content not captured]
```

Captured markers always report chars. The recovered-clamp form names no `⟦ref⟧` (the
parent cannot recompute the child-side suffixed name); it is emitted only when
`deliveredResultValue` holds, so "published values below" is always true. The preserved
subprocess >30 K fallback banner (`[... output truncated at 30000 chars]`) is unchanged
legacy outside the helper — enumerated here for honesty, not converged. "full content:"
is canonical; the ~6 test pins on old wordings (`test/kernel/capture.test.ts`,
`test/bus/agent-process.test.ts`) move — churn recorded per test. The machine contract is
the `⟦…⟧` glyph pair.

### Budgets — svelte by default, configurable (Jesse, 2026-07-21)

Chars, one record:

| row | chars | note |
|---|---|---|
| `default` | 2,000 | exec, grep, glob, fetch |
| `read_file` | 4,000 | the code-editing exception; offset/limit re-reads past it |
| `delegate` | 4,000 | preserves `SUMMARY_BUDGET_CHARS`; budget-inclusive preview |
| `cell` | 2,000 | explicit row; `CELL_AUTO_BIND_THRESHOLD` folds in |

Not capture-capable, so keeping today's limits: `edit_file`/`apply_patch`/`write_file` and
source-less tools. Value reads: registry bypass (above), bounded by their own contracts.

`DEFAULT_PREVIEW_BUDGETS` lives beside `DEFAULT_CHAR_LIMITS`. `SPROUT_PREVIEW_BUDGETS` is
one env var, a JSON map merged over defaults, resolved once per process at startup;
invalid → warn + defaults. The spawner spreads live `process.env` at spawn time; evals and
tests use the programmatic override channel.

## Invariants

Holding when the predicate holds and capture succeeds; capture-failed, source-less,
no-store, and store-unavailable paths render at today's sizing, redacted — documented
exceptions, each with a work item and test:

- At or below budget: identical to today except redaction and the stated changes
  (value-read bypass; fetch marker noun; sub-budget line-dense outputs render whole on the
  predicate path).
- Captured values store the exact raw SOURCE; `⟦ref⟧` splices reproduce it up to the 4 MiB
  `REF_SPLICE_MAX_BYTES` (channel captures cap at 6 MiB; root captures can exceed both —
  reachable via cell/`value_slice`).
- Above budget, only the redacted preview + marker crosses on the live path; recovered
  results **whose manifest delta delivered the published result value** clamp to the
  delegate budget at the render helper (all other recovered cases — delta consumed,
  died-before-publish, store unavailable — take the 30 K backstop, redacted).
- No double-store; no marker ever names a value the reader cannot see (hence: private-only
  featherweight capture; the render helper synthesizes no marker).
- Subprocess bind-and-publish semantics unchanged; featherweight capture only adds values
  to the parent's own scope.

## Phases

**P1 — Registry gate + shared data.** The budget record (+ `cell` row) + resolver;
`captureMarker` (prefix + tail); the predicate (entry = `captureSource` + store, branch =
`boundValues`); the `value_*` bypass above truncation (+ `value_get` error-path `fail()`
fix; delete the dead post-truncation clause); chars-only trigger; capture-failed →
today's-limits rendering; redaction of registry outputs and errors; stderr predicate to
redacted space; `glob` captureSource + `CAPTURE_PRIMITIVE_NAMES` entry + `summarizeArgs`
pattern arm; fetch `body` noun. TDD; churn recorded per test. Fable review.

**P2 — Delegation + cell + prove.** Subprocess: redaction + budget-from-record +
marker-helper adoption + budget-inclusive preview (churn recorded). Featherweight:
`prepareResultOutput` reuse with `publish: false`, parent-scoped store, private handles
only (tests: over-budget result → preview + ref; shared → raw path; capture-failure → raw
path; publish-failure at subprocess → fallback, never a marker). The delegation-render
helper (redaction + recovery clamp at one seam; the `recovered` flag at the two
reconstruction sites; the `fetchManifestLines` typed-status + `deliveredResultValue`
contract change; tests: recovered over-budget result with delivered result value →
clamped + manifest; store unavailable / delta consumed / died-before-publish → 30 K; live
capture-FAILED result → today's limits, never clamped; rewrites applied in both branches;
all five sites migrated). Cell: threshold from its row + marker helper (zero churn,
asserted).
Measurement: payload byte counts with capture on/off; an N-way fan-out e2e proving the
orchestrator payload stays flat; tune budgets. Fable review.

(The agent-message clamp ships separately, before or alongside P1.)

## Acceptance

1. Capture-capable over-budget outputs → redacted preview + `⟦ref⟧`; at or below budget →
   inline, redacted, with the stated changes. Documented exceptions render at today's
   sizing, redacted — each tested, including BOTH >6 MiB behaviors (channel: deterministic
   failure → today's-limits rendering; root: capture succeeds).
2. **Absent capture failure**, private-handle subprocess and featherweight sub-results
   over budget never ride the live parent payload in full; recovered results whose delta
   delivered the result value clamp to the delegate budget; refs splice to the exact
   result. The documented raw-path cases — capture failure (per principle 1), SHARED
   featherweight results (a design choice, not a failure), store-unavailable or
   delta-consumed recovery, and in-process — keep the 30 K backstop, redacted; each
   tested, including the parent-side test that a live capture-failed subprocess result
   renders at today's limits and is never clamped.
3. Splice fidelity up to the 4 MiB bound (documented).
4. Every render this spec touches is redacted — registry outputs, errors, fallbacks, and
   ALL parent-side child-result renders via the one helper (structural, tested).
5. All new and changed markers flow through `captureMarker` (six forms); the preserved
   legacy subprocess >30 K banner is the one enumerated exception; preserved behaviors
   hold under test.
6. Full suite green; assertion churn recorded.

## Risks (honest)

- **Blast radius**: outputs inline up to 20–50 KB today become preview + ref; tests move.
- **Code-editing regression** if 4,000 is too tight for `read_file`; offset/limit re-reads
  and `SPROUT_PREVIEW_BUDGETS` are the relief valves.
- **Redaction on the hot path** — a few anchored regexes; the bench harness will say.
- **Genome prompts** may assume full output or old marker wording — surveyed per phase.
- **Featherweight binds charge the parent's 10,000-value scope cap** (manifest aliases
  deliberately don't). Accepted: the cap is generous, degradation honest; revisit if real
  orchestrators hit it.
- **The render helper touches every delegation render** — mitigated: it is the existing
  expression (including the manifest-name rewrite) factored once, redaction added; live
  results can't reach the clamp branch (the `recovered` flag is structural).
- **The value-read bypass raises the ceiling in the other direction**: a single
  `value_slice`/`value_grep` can now put up to ~256 KB in the payload where today's
  generic fallback cut at 30 K. Accepted deliberately — the model explicitly asked for
  that range and the tools' own budgets are the policy (predecessor §2) — but it is a
  payload-size regression direction worth watching in the P2 measurements.

## Open questions (for the P1 review, not blockers)

- Adaptive budgets? Static + env override; revisit only if code-editing regresses.
- "Always ref, no preview" lockdown mode? One-line future option.
- More capture-capable tools (memory reads)? A per-tool `captureSource` addition.

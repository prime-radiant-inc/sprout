# Capture-all tool outputs — implementation tracker

**Spec:** `docs/superpowers/specs/2026-07-21-capture-all-tool-outputs-design.md` (v10,
CONVERGED after 8 adversarial review rounds / 81 findings). Implementation authorized by
Jesse 2026-07-21 ("move to a complete implementation"). TDD mandatory: failing test first
for every item; commit frequently through the full pre-commit hook (NEVER --no-verify —
prefix commits with `PATH="/home/jesse/.bun/bin:$PATH"` so the hook finds bun/bunx).

## Pre-P1 — agent-message clamp (standalone; waits on nothing)

- [x] Failing test + implement + commit (14ad538): redact-then-clamp in
      `renderAgentMessagesForPrompt` at `AGENT_MESSAGE_RENDER_CLAMP = 4_000`; steering
      test pins redaction, banner, and bound.

## P1 — registry gate + shared data (spec §Design)

- [x] `DEFAULT_PREVIEW_BUDGETS` + `resolvePreviewBudgets(env, warn)` +
      `captureMarker(dropped, tail)` in `truncation.ts`; tested in
      `test/kernel/preview-budgets.test.ts` (10 tests incl. warn-sink fallbacks).
- [x] The predicate + chars-only trigger + capture-failed→today's-limits + redaction
      (output AND error) + stderr-in-redacted-space + value_* bypass + fetch body noun +
      markers via helper — all in `primitives.ts` execute; `truncateAtBudgetDetailed`
      added to truncation.ts. TDD: test/kernel/registry-gate.test.ts (12 tests). Churn
      recorded: 4 capture.test.ts pins moved (wording full output→full content;
      lines→chars gauge; value_get bypass replaces generic mid-cut).
- [x] `value_get` over-budget error routed through `fail()` (redacted like every path).
- [x] `glob`: `captureSource` (the listing) + `CAPTURE_PRIMITIVE_NAMES` entry +
      `summarizeArgs` pattern arm; withCapture provenance test.
- [x] Fetch marker noun `body` (in the gate).
- [x] Test churn recorded (4 capture.test.ts pins + allow-list pin 4→5).
- [x] Fable review pass at P1 end (diff walked against acceptance; cell lands on the
      source-less 30K path by construction; zero genome marker pins — verified round 8).

## P2 — delegation + cell + prove

- [x] Subprocess `prepareResultOutput`: redact-then-slice; budget-inclusive preview
      (MARKER_RESERVE_CHARS = 160; whole message ≤ delegate budget); budget from record
      (DELEGATE_BUDGET resolved once per process); canonical marker via helper; fallback
      redacted, shape unchanged. Both delegate-side pins moved (recorded).
- [x] Featherweight: `prepareResultOutput` moved to `src/bus/result-gate.ts` with
      `{ publish: boolean }`; gated inside `runFeatherweight` (covers both settle
      points), `handle.visibility !== "shared"` + parent-scoped store, publish:false;
      log records stay raw. Tests: preview+ref+no-publish; shared → raw; capture-fail
      → raw.
- [x] Delegation-render helper `Agent.renderDelegationResult` wired at all five sites;
      `recovered?: boolean` on ResultMessage, stamped once in `readHandleResult`; clamp
      iff recovered AND size-identity match AND over budget, form-1 marker with the
      delivered alias appended after rewrites; fail-closed to the 30 K backstop; redaction
      at the seam. Tests: test/agents/delegation-render.test.ts (5) + resume pin updated.
- [x] Cell gate: threshold from `cell` record row + marker helper — zero churn asserted
      (127 cell + e2e tests pass untouched; markers byte-identical).
- [x] Tests per spec P2 list: both flavors preview+ref; shared featherweight → raw;
      capture-failure → raw; publish-failure → fallback never marker
      (test/bus/result-gate.test.ts); recovered clamp/backstop matrix incl.
      stale-prior-goal (delegation-render tests); live results structurally unclampable;
      rewrites in both branches.
- [x] Measurement: test/integration/capture-all-advantage.test.ts — 8-way fan-out payload
      flat (>5× reduction, full answers in store); tool-mode capture on/off (>5×).
- [x] Fable review at P2 end (diff walked; publish-failure gap found and closed with
      direct unit tests).
- [ ] Budget TUNING against live runs: deferred — structural measurements are in tests;
      real tuning is a live-eval knob (SPROUT_PREVIEW_BUDGETS) once agents run on this.

## Deferred / parked

- QuickJS cutover (separate track; greenlit earlier). Former blocker RESOLVED
  2026-07-21: the teardown abort was the HOST wasm call stack exhausting before
  QuickJS's soft stack limit during deep recursion (JSC tier-dependent frame sizes →
  load-dependent). Reproduced 18/40 under 10-burner load; fixed (foreign-throw catch +
  teardown fault containment + module poison-discard + 256 KB stack cap); 0/40 after.
- Genome-prompt survey for marker-wording assumptions (per phase, per spec Risks).

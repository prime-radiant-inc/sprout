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
- [ ] Delegation-render helper in agent.ts replacing the five `truncateToolOutput` sites
      (1500, 2302, 2466, 2512, 2556): redact once; `recovered` flag stamped in
      `readHandleResult` (`resume.ts:144–181`, single constructor); clamp iff recovered
      AND content-identity match (delta value with `size === utf8ByteLength(raw)` +
      preview check — the log and the bind store the same string) AND over budget; clamp
      marker = form 1 naming the delivered ALIAS, inserted after `rewriteManifestNames`;
      else generic 30 K backstop. No fetchManifestLines/store contract changes.
- [ ] Cell gate: threshold from `cell` record row + marker helper (zero churn, asserted).
- [ ] Tests per spec P2 list: both flavors preview+ref; shared featherweight → raw;
      capture-failure → raw; publish-failure → fallback never marker; recovered
      clamp/backstop matrix incl. stale-prior-goal + live-capture-failed-never-clamped;
      rewrites in both branches.
- [ ] Measurement: payload bytes capture on/off; N-way fan-out e2e (orchestrator payload
      flat); tune budgets. Fable review at P2 end.

## Deferred / parked

- QuickJS cutover (separate track; greenlit earlier). BLOCKER noted: load-dependent
  teardown flake — `Assertion failed: list_empty(&rt->gc_obj_list)` in `JS_FreeRuntime`
  on the runaway-recursion probe under parallel shard load (seen once 2026-07-21 during a
  spec commit; passes isolated and on retry). Root-cause before flipping the default.
- Genome-prompt survey for marker-wording assumptions (per phase, per spec Risks).

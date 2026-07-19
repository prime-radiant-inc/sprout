# Sap completion & roadmap — build plan (living)

**Date started:** 2026-07-19
**Spec:** `../specs/2026-07-19-sap-completion-and-roadmap-design.md`
**Predecessor:** `2026-07-18-sap-build-plan.md` (sap Phases 0–7, COMPLETE)
**Status:** in progress — Phase 1 starting.

Working tracker for finishing everything deferred/TODO/roadmapped during the sap build. Records
what we build, in what order, and where we deliberately simplify. Update as phases land.

## Sequencing (Jesse, 2026-07-19)

- **Roadmap substrate first, then integrity loop, then measurement.** Later work sits on the
  substrate; build it once.
- **QuickJS-WASM engine swap is OUT of scope** — GitHub issue #1
  (prime-radiant-inc/sprout#1). Spec commits to `node:vm` and documents the fails-open ceiling.
- **Known tradeoff:** the measured capability number lands in Phase 5, not up front. Accepted.

## Frozen non-negotiables (carried from sap)

- Multi-run A/B with significance — never a single-run delta.
- Hidden canary suite — kernel-resident, never model-visible, fails closed, rolls back on
  regression regardless of visible fitness.
- The immutability line — store/capture/splice/publish/scope/cell semantics/ambient API/`$ref`
  allowlist are KERNEL; Learn evolves only the genome.

## Method

Per phase: TDD (failing test first) → build → full suite green + tsc + biome clean → adversarial
Fable review in fresh context → fix findings → commit → update this plan. Same as the sap build.

## Phases

- [x] **Phase 1 — Opaque provider-state persistence.** DONE + Fable-reviewed. Map showed
  assistant turns ride the event log (plan_end.assistant_message, ContentPart[]) → fix is purely
  at adapter parse/replay boundaries, no journal change. Anthropic already byte-exact (verified,
  not rebuilt); OpenAI Responses reasoning items (incl. encrypted_content, arrives on
  response.completed) and Gemini thought signatures were dropped — now captured as
  ContentKind.PROVIDER_STATE / thought_signature and replayed verbatim. Review found no HIGH (all
  SDK shapes verified real in node_modules); two MEDs fixed: Gemini *streaming* text-part
  signature drop, and OpenAI replay reorder of interleaved reasoning/tool items (now replays in
  true captured order). Redaction excludes opaque state structurally. Full suite 3968 pass.
- [x] **Phase 2 — Futures + `$ref` promise pipelining.** DONE + Fable-reviewed. New ambient
  `handle.future(name)` binds a started child's eventual outcome without awaiting; value ops on
  that name pipeline on the existing waitHandle mechanism, then settle to a NORMAL immutable value
  (ULID stable post-settlement). Per-cell generation guard reclaims abandoned futures; no new
  deadlock surface. Strictly additive. Review found no HIGH; the flagged settlement-orphan window
  is already guarded (verified falsifiable), with one narrow residual (cell ends during the bind
  round-trip) documented honestly rather than closed (full closure would cross the immutability
  line). Full suite 3975 pass.
- [x] **Phase 3 — Agent-Skills-compatible program metadata.** DONE + Fable-reviewed (SOUND, no
  findings). Superset frontmatter (semver/platforms/metadata/license/allowed-tools) added; sap
  numeric version stays authoritative for cell_end linkage (semver major derives it, string
  preserved + re-emitted); lexical scan unchanged at validate+load; round-trip byte-stable; no
  sap-native regression. Full suite 3979 pass.
- [ ] **Phase 4 — N-run pinned-snapshot eval harness.** The linchpin. Runs a candidate genome N×
  in eval mode against a pinned task set; feeds `ArmResult` to the A/B; supplies the real
  `CanaryHarness` adapter. No live-genome/journal mutation.
- [ ] **Phase 5 — Live integrity wiring + the capability number.** Swap `evaluateImprovement` to
  the N-run A/B gate; wire quartermaster fabrication/repair/curation through A/B + canary gates;
  wire canary rollback; run the multi-task/multi-model eval and record the real number vs baseline.
- [ ] **Phase 6 — Curator generalization + parameterization + root sync.** Curate agents/memories;
  infer typed params in fabrication; `programs/` in bootstrap manifest + `syncRoot`.
- [ ] **Phase 7 — Security hardening.** Per-session sub-call/token budget; script-tool
  shell-exposure tightening; document the `node:vm` ceiling.
- [ ] **Phase 8 — Recorded cross-phase deferrals.** Host-side deadlock detection; scoped observer
  store reads; shared-handle wait-graph pairing; scope announcements + post-compaction manifest
  event; `value_lines`/`value_publish`; manifest-pull relaxation. Each ships with a test or is
  explicitly re-deferred with a reason.

## Decisions log

- **2026-07-19:** Spec written. Sandbox fork resolved — keep `node:vm`, QuickJS port → issue #1.
  Phasing resolved — roadmap substrate first (Phases 1–3), then eval harness (4), integrity wiring
  + measurement (5), then curator/hardening/deferrals (6–8).

## Deviations log

_(recorded as they occur)_

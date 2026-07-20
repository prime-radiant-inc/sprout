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
- [x] **Phase 4 — N-run pinned-snapshot eval harness.** DONE + Fable-reviewed (HIGH + 3 MED found
  and fixed). Pure engine (imports only multi-run-ab + fs) with an injected TaskExecutor; live
  executor via runHeadlessMode; two labeled tiers (sap gates, general headline); real CanaryHarness
  adapter; genome/journal isolation via snapshot. Review caught a HIGH: streamed turns bypassed the
  capture middleware → keystone could false-pass; fixed with a RequestObserver firing on both
  complete() and stream() (proven live: canary now CATCHES a real streamed leak). Also fixed the
  gate-tier leak tasks (sentinel-in-goal made them always-leak; now random secret + per-run
  materialization, canary-style). Live path proven against real haiku. Full suite 3997 pass.
- [x] **Phase 5 — Live integrity wiring + measurement.** DONE + Fable-reviewed twice (wiring: no
  HIGH, gates are the sole adoption path, quartermaster fails closed; live gate: sound, its one
  MEDIUM — candidate genome missing rootDir made gated root-agent updates error — fixed + tested).
  Chokepoint `evaluateMutationForAdoption` (canary regression rejects before the A/B is consulted);
  `adoptMutation` gate-before-apply in learn-process; opt-in production gate
  `createSnapshotMutationGate` behind SPROUT_MUTATION_GATE=1 (default off; snapshots the live
  genome twice, mutates the candidate copy only, live genome proven untouched). Live measurement
  recorded above (gate calibration passed on real variance; keystone canary caught a real
  narration leak; sonnet-5 sap tier 30/30). Known non-blocker notes from review: tui
  model-picker test is order-dependent (flake, pre-existing); learn/ host-free-ness is convention
  not enforced by the architecture test; a snapshot tempdir can leak on a mid-setup error.
- [ ] **Phase 6 — Curator generalization + parameterization + root sync.** Curate agents/memories;
  infer typed params in fabrication; `programs/` in bootstrap manifest + `syncRoot`.
- [x] **Phase 7 — Security hardening.** Per-session sub-call/token budget; script-tool
  shell-exposure tightening; document the `node:vm` ceiling. Budget: `src/host/session-budget.ts`
  (defaults 1000 sub-calls / 50M tokens; `SPROUT_SESSION_MAX_SUB_CALLS` /
  `SPROUT_SESSION_MAX_TOKENS` overrides), enforced host-side in the handle registrar (both the
  trusted in-process path and the channel handler) so every subprocess spawn is admitted before
  launch; token feed = `llm_end` usage off the session-wide events topic; rejection surfaces as a
  normal `infrastructure_error` delegation outcome. Script tools: primitive dispatch is now
  restricted to the agent's OFFERED tool surface (previously ANY registered primitive — exec,
  save_tool, every workspace script tool — executed by bare name), and code-mode agents no longer
  load/register workspace script tools at all. `node:vm` ceiling documented in cell-worker.ts
  (realm doc), cell-host.ts (guard doc), and the spec's Phase 7 "Security posture" subsection.
- [ ] **Phase 8 — Recorded cross-phase deferrals.** Host-side deadlock detection; scoped observer
  store reads; shared-handle wait-graph pairing; scope announcements + post-compaction manifest
  event; `value_lines`/`value_publish`; manifest-pull relaxation. Each ships with a test or is
  explicitly re-deferred with a reason.

## Phase 5 live measurement results (2026-07-20, real models, real payload bytes)

- **Haiku (claude-haiku-4-5, full N=10 × 5 tasks × 2 arms, ~152 live sessions).** Self-A/B
  calibration (same genome both arms): sap tier p=0.4854 treat=5.167 base=6.233, general p=1.0 —
  **gate verdict accepted=false. Correct**: identical noisy arms must not produce a false accept;
  the permutation gate refused real RLM variance. This is the non-negotiable's calibration check
  passing live.
- **Canary suite on real bytes (haiku): keystone FAILED** — captured-content-never-in-payload
  caught secret bytes in a provider payload (the model narrated the secret file's content into a
  message even though it also performed the $ref splice correctly); code-mode-cannot-exec PASSED
  (cell rejected require/child_process). The DGM guard works on live bytes AND surfaced a real
  genome finding: haiku-tier capture discipline leaks by narration. Actionable: the genome's
  capture guidance should forbid transcribing source content while narrating.
- **Sonnet-5 (arm-only, N=10, trimmed for cost/latency ~5min/session).** sap tier: 30/30 pass,
  0 stumbles (capture-splice, code-mode fan-out, keystone-no-leak all clean). general tier:
  fizzbuzz 10/10 pass (7× one stumble), string-reverse 9/10.
- **Honest scope note:** this run measured gate calibration (self-A/B) + per-tier live profiles —
  NOT a data-plane-on-vs-off capability delta (the token-economics delta was measured in the v1
  eval: 29.5× live). A true on/off capability A/B needs a baseline arm with the data plane
  disabled; the harness supports it (arms are parameterized) — run when wanted.

## Decisions log

- **2026-07-19:** Spec written. Sandbox fork resolved — keep `node:vm`, QuickJS port → issue #1.
  Phasing resolved — roadmap substrate first (Phases 1–3), then eval harness (4), integrity wiring
  + measurement (5), then curator/hardening/deferrals (6–8).

## Deviations log

- **2026-07-19 (Phase 5, wiring half):** Built the single adoption chokepoint
  `src/learn/mutation-gate.ts` (`evaluateMutationForAdoption`) composing the frozen
  multi-run A/B (`compareGenomes` on the `sap` gate tier) and the hidden canary suite
  (`runCanarySuite` + fail-closed `mutationRegressesCanaries`); a canary regression
  rejects regardless of the A/B. Wired it into `learn-process.ts` as the SOLE gated
  adoption path: injected `MutationGate` + `adoptMutation()` (gate-before-apply) now
  fronts every mutation; `runQuartermaster()` derives `CellObservation[]` from `cell_end`
  events and routes fabrication/repair/curation proposals through the same chokepoint.
  New `create_program`/`retire_program` mutation variants + `genome.addProgram`/
  `removeProgram`.
  **Design decision (flagged for review):** inline live gating is impractical (N live
  evals per stumble), so the chokepoint is the sole *correctness* path but production
  wiring of a LIVE gate is deferred to the measurement step. Today, absent an injected
  gate, agent mutations keep the legacy single-delta apply-then-rollback (existing tests
  green); the quartermaster is inert without a gate (fabrication/repair/curation NEVER
  adopt ungated). Invariant held: **when a gate is wired, no mutation reaches the genome
  without passing both frozen gates.** Follow-up: inject a `MutationGate` at the
  `factory.ts` construction site (backed by the LiveTaskExecutor + createLiveCanaryHarness
  over eval-mode snapshots) to enforce the invariant in the live loop — this is the
  live-measurement step, out of scope for the offline wiring. The capability number
  (multi-task/multi-model eval vs baseline) is likewise still pending.
- **2026-07-20 (Phase 7):** Closing the dispatch surface invalidated three VCR cassettes
  (e2e bootstrap, e2e multi-step, agent-integration bootstrap): the recorded root sessions
  (root has `tools: []`) had created files by calling `write_file` directly — the recordings
  depended on the ungranted-primitive hole. All three re-recorded live against the enforced
  surface. Enablers fixed in the VCR helper along the way: record mode now resolves real model
  ids (the stubbed catalog pinned "test-model" and 404'd every live call), skips mnemonic and
  subcortical calls symmetrically with replay (recording them shifted sequential replay off by
  one), and pushes stream recordings in a `finally` so early-exiting consumers still capture
  entries. The agent-integration test now constructs root with the agent tree (as the factory
  does) — without it root has no file-capable delegate, which the old recording papered over
  via the hole. Featherweight spawns are not counted as sub-calls (they skip handle
  registration, cannot recurse, and their tokens still count); the budget spans the host
  process lifetime — `/clear` does not reset it, matching the handle registry.

# MIRA Memory Port — Completion Report Through Phase 10

Date: 2026-04-26

Branch: `jesse/pri-1354-implement-mira-memory-port-phase-1-foundation`

## Scope Completed

Implemented the MIRA memory port through Phase 10 using Sprout-native TypeScript,
Bun, JSONL source-of-truth storage, rebuildable SQLite derived indexes, and local
`MongoDB/mdbr-leaf-ir` embeddings. No legacy migration path was added because
there are no legacy users. No embedding fallbacks were added.

Completed capabilities:

- Phase 1: extended memory schema, JSONL store, SQLite/FTS/vector derived index,
  local fail-fast embeddings.
- Phase 2: prompt-file backed extraction, strict JSON repair/validation, dedup,
  learn-pipeline write integration.
- Phase 3: session segment collapse, segment embeddings/indexing, project
  detection.
- Phase 4: session-start surfacing, MIRA-format memory block rendering, delegated
  block propagation, mention tracking.
- Phase 5: deterministic memory tools, archivist agent, write authorization,
  prompt-file policies.
- Phase 6: link candidate discovery, relationship classifier, link persistence,
  traversal, dead-link healing.
- Phase 7: per-project activity clocks, importance scoring, access/mention/link
  decay signals, low-score archival.
- Phase 8: Anthropic cache breakpoints, OpenAI `prompt_cache_key`, cache-token
  telemetry through existing events/logging.
- Phase 9: consolidation clusters, merge/reject handlers, entity GC, FTS5 entity
  lookup, project-active-day maintenance cadence.
- Phase 10: opt-in subcortical recall pre-pass, query expansion, entity-hint hub
  discovery, pinned-memory retention, deterministic 30-query side-by-side eval.

## Verification

Targeted phase gates passed after each phase. The final Phase 10 gate included:

- `bun test test/genome/subcortical-eval.test.ts test/genome/subcortical.test.ts test/genome/recall-pipeline.test.ts test/genome/recall.test.ts test/genome/prompts.test.ts`
- `bun run typecheck`
- `bun run check`

Known full-suite caveat: `bun run precommit` still reaches the pre-existing
harbor fixture failures for missing `inspo/harbor-runner/launch.sh` and
`inspo/harbor-runner/userdata.sh.tpl`; those files are unrelated to the MIRA
memory port.

## Residual Risks

- Subcortical recall is implemented as an opt-in recall option, not enabled by
  default for live agents. This avoids silently adding an LLM call to every
  existing VCR-backed agent loop.
- Cache effectiveness was verified structurally with adapter tests. A live
  10-turn Anthropic/OpenAI token-savings run still needs API-backed measurement.
- Consolidation and entity GC expose strict handlers and tests; a production
  scheduler/CLI wrapper should decide when to run them automatically.
- Gemini explicit cached-content creation remains deferred as designed.

## Recommended Next Steps

1. Run a live cache-savings measurement on a 10-turn engineer loop with API keys.
2. Decide which agents, if any, should enable subcortical recall by default.
3. Add a thin maintenance command for consolidation/entity GC once operator UX is
   clear.
4. Run branch review before merging because this is a broad memory-system slice.

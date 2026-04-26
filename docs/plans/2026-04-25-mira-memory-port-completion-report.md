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
  lookup, project-active-day maintenance cadence, and `sprout --genome maintain`
  dry-run/apply operator flow with reviewed decision files.
- Phase 10: opt-in subcortical recall pre-pass, query expansion, entity-hint hub
  discovery, pinned-memory retention, deterministic 30-query side-by-side eval,
  and agent frontmatter config via `subcortical_recall`.

## Verification

Targeted phase gates passed after each phase. The final Phase 10 gate included:

- `bun test test/genome/subcortical-eval.test.ts test/genome/subcortical.test.ts test/genome/recall-pipeline.test.ts test/genome/recall.test.ts test/genome/prompts.test.ts`
- `bun run typecheck`
- `bun run check`

Follow-up verification after the completion pass:

- `bun test test/host/cli.test.ts test/host/cli-genome.test.ts test/genome/maintenance.test.ts test/agents/markdown-loader.test.ts test/agents/markdown-serializer.test.ts test/tools/harbor/harbor-runner.test.ts`
  passed, 141 tests.
- Local-embedding dogfood passed against a temporary genome using
  `local`/`MongoDB/mdbr-leaf-ir`/768d embeddings: add memories, recall through
  hybrid search, discover one consolidation candidate and one entity-GC
  candidate, then apply one reviewed consolidation decision.
- Live Anthropic 10-turn cache eval passed on `claude-haiku-4-5-20251001`:
  10/10 turns had cache reads, totaling 370,520 cache-read tokens.
- Live OpenAI cache eval was attempted with `gpt-4.1-mini` but the configured
  API account returned `insufficient_quota`, so no OpenAI cache measurement is
  available from this environment.
- `bun run precommit` passed: Biome check, TypeScript checks, and all five unit
  shards.

## Residual Risks

- Subcortical recall remains opt-in for live agents. This avoids silently adding
  an LLM call to every existing agent loop; enable it per agent with
  `subcortical_recall: true` or `{ enabled: true, max_tokens: N }`.
- OpenAI live cache measurement is blocked until the configured API account has
  quota.
- Consolidation and entity GC now have a CLI, but apply mode intentionally
  requires reviewed JSON decisions instead of automerging.
- Gemini explicit cached-content creation remains deferred as designed.

## Recommended Next Steps

1. Re-run the OpenAI cache eval once quota is available.
2. Decide which specific agents should opt into `subcortical_recall` after
   monitoring latency/cost.
3. Use `sprout --genome maintain --dry-run` during dogfood and apply only
   reviewed decision files.
4. Monitor real sessions for recall precision, consolidation candidate quality,
   and cache-token telemetry before broad rollout.

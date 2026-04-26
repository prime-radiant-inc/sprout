# MIRA Memory Port — Status

## Current phase

Phase 5 — Memory-tools and archivist (starting)

## Phase log

- Phase 1 — Foundation: completed 2026-04-26
- Phase 2 — Extraction: completed 2026-04-26
- Phase 3 — Segment collapse: completed 2026-04-26
- Phase 4 — Surfacing pipeline: completed 2026-04-26
- Phase 5 — Memory-tools and archivist: starting

## Current branch / commit

- Branch: `jesse/pri-1354-implement-mira-memory-port-phase-1-foundation`
- Last verified commit: `add3d69`

## Open issues

- `§14.1` session-start surfacing on resume — not needed for the current Phase 1 slice
- `§14.5` qm-reconciler scope — not needed until Phase 5
- `§14.12` recursive archivist — not needed until Phase 5

## Deviations from design

- The original draft defaulted embeddings to OpenAI. User direction and CodeMira
  review changed Phase 1 to local-first embeddings: `MongoDB/mdbr-leaf-ir`
  through Bun/Transformers.js, 768 dimensions, and no alternate production
  embedding provider.
- `sqlite-vec` is not usable with the current Bun SQLite build because dynamic
  extension loading is disabled. The vector lane now stores 768-dimensional
  embedding BLOBs in SQLite and performs cosine ranking in TypeScript as the
  production path.
- There are no legacy users for this port. The one-shot migration script is
  removed from scope; Phase 1 now embeds new memory writes directly and keeps
  schema normalization only as a tolerant parser/test convenience.

## Verification

- 2026-04-26: `bun test test/genome/memory-index.test.ts test/genome/memory-schema.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts test/genome/recall.test.ts` passed
- 2026-04-26: `bun run typecheck` passed
- 2026-04-26: `bun test test/genome/index-builder.test.ts test/genome/memory-index.test.ts test/genome/memory-schema.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts test/genome/recall.test.ts test/genome/genome.test.ts` passed
- 2026-04-26: `bun test test/llm/embeddings.test.ts test/genome/index-builder.test.ts test/genome/memory-index.test.ts test/genome/memory-schema.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts` passed
- 2026-04-26: `bun test test/llm/embeddings.test.ts` passed after switching
  embeddings to local mdbr defaults
- 2026-04-26: `bun run typecheck` passed after local embedding adapter update
- 2026-04-26: manual local smoke check returned 768-dimensional query and
  document embeddings from `MongoDB/mdbr-leaf-ir`, with query/document vectors
  differing
- 2026-04-26: `bun test test/llm/embeddings.test.ts test/genome/memory-schema.test.ts`
  passed after removing embedding provider fallbacks and fail-soft result types
- 2026-04-26: `bun run typecheck` passed after removing embedding provider
  fallbacks
- 2026-04-26: manual local smoke check returned 768-dimensional query and
  document embeddings from `MongoDB/mdbr-leaf-ir` after the fail-fast adapter
  change
- 2026-04-26: `bun test test/llm/embeddings.test.ts test/genome/memory-schema.test.ts test/genome/index-builder.test.ts test/genome/memory-index.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts`
  passed after removing embedding provider fallbacks
- 2026-04-26: `bun run typecheck` passed after the final no-fallback cleanup
- 2026-04-26: `bun test test/genome/memory-index.test.ts` passed after adding
  SQLite-backed embedding BLOB storage and vector/hybrid search
- 2026-04-26: `bun test test/genome/memory-index.test.ts test/genome/index-builder.test.ts test/genome/memory-schema.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts test/llm/embeddings.test.ts`
  passed after adding the vector lane
- 2026-04-26: `bun run typecheck` passed after adding the vector lane
- 2026-04-26: `bun test test/host/cli-compiled.test.ts` passed after adding
  the local embedding dependency
- 2026-04-26: `bun test` ran 2545 tests: 2543 passed, 2 failed in unrelated
  existing/environment checks because `test/tools/harbor/harbor-runner.test.ts`
  expects missing `inspo/harbor-runner/launch.sh` and `userdata.sh.tpl`
- 2026-04-26: `bun test test/llm/embeddings.test.ts test/genome/memory-embedding.test.ts test/genome/index-builder.test.ts test/genome/memory-index.test.ts test/genome/memory-schema.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts test/genome/genome.test.ts test/genome/recall.test.ts test/genome/pruning.test.ts test/bus/genome-service.test.ts test/learn/learn-process.test.ts`
  passed after routing new memory writes through required embeddings
- 2026-04-26: `bun run check` passed after embedded memory write changes
- 2026-04-26: `bun run typecheck` passed after embedded memory write changes
- 2026-04-26: `bun test test/host/cli-compiled.test.ts test/agents/agent.test.ts test/llm/embeddings.test.ts test/genome/memory-embedding.test.ts test/genome/index-builder.test.ts test/genome/memory-index.test.ts test/genome/memory-schema.test.ts test/genome/jsonl-store.test.ts test/genome/memory-store.test.ts test/genome/genome.test.ts test/genome/recall.test.ts test/genome/pruning.test.ts test/bus/genome-service.test.ts test/learn/learn-process.test.ts`
  passed after routing recall through the hybrid index
- 2026-04-26: `bun run typecheck` passed after routing recall through the
  hybrid index
- 2026-04-26: `bun test test/host/cli-compiled.test.ts` passed after lazy-loading
  the local embedding provider so CLI help does not load ONNX runtime
- 2026-04-26: `bun run precommit` passed `check`, `typecheck`, and all unit
  shards except the pre-existing `test/tools/harbor/harbor-runner.test.ts`
  failures for missing `inspo/harbor-runner/launch.sh` and
  `inspo/harbor-runner/userdata.sh.tpl`
- 2026-04-26: `bun test test/learn test/bus/genome-service.test.ts test/genome/extraction.test.ts test/genome/dedup.test.ts test/genome/recall.test.ts test/genome/genome.test.ts`
  passed after routing learn-generated memory writes through extraction and
  deduplication
- 2026-04-26: `bun run typecheck` passed after the Phase 2 learn write rewire
- 2026-04-26: `bun run check` passed after the Phase 2 learn write rewire
- 2026-04-26: `bun test test/host/session-collapse.test.ts test/genome/segments.test.ts test/genome/projects.test.ts test/genome/memory-index.test.ts test/genome/index-builder.test.ts`
  passed after adding segment collapse, segment indexing, and project detection
- 2026-04-26: `bun run typecheck` passed after Phase 3 segment collapse
- 2026-04-26: `bun test test/genome/recall-pipeline.test.ts test/agents`
  passed after adding memory surfacing, session cache propagation, and mention
  tracking
- 2026-04-26: `bun run typecheck` passed after Phase 4 surfacing
- 2026-04-26: `bun run check` passed after Phase 4 surfacing

## Completed in current slice

- Added memory fixture coverage for schema normalization
- Added extended memory schema normalization helpers
- Added generic JSONL store primitive with append/rewrite/load behavior
- Updated `MemoryStore` to normalize minimal and extended records on load/add
- Added SQLite/FTS5 memory index skeleton with JSONL rebuild tests
- Added index-builder helper that rebuilds `genome/.cache/index.db` from JSONL
- Added `.cache/` genome initialization and gitignore coverage
- Added local-first embedding provider abstraction with `MongoDB/mdbr-leaf-ir`
  default metadata, 768-dimensional dense projection, query/document prompt
  asymmetry, fail-fast production errors, and deterministic fake embeddings for
  tests
- Added SQLite-backed embedding vector storage and vector/hybrid search helpers
  with fail-fast behavior when vector-required search has no indexed embeddings
- Added required embedding generation to `Genome.addMemory`; new memory writes
  now persist ready local embedding metadata/vectors and rebuild the derived
  SQLite index after memory mutations
- Routed `recall()` memory lookup through `Genome.searchMemories()`, local query
  embeddings, SQLite FTS/vector hybrid search, and a MIRA-style vector
  similarity threshold
- Added prompt-file backed memory extraction, strict JSON parsing/repair,
  extraction draft normalization, three-stage duplicate filtering, and learn
  write-path integration that turns LLM-selected `create_memory` mutations into
  extracted, entity-linked, embedded memories
- Added collapsed session segment storage in `memories/segments.jsonl`,
  SQLite segment indexing, deterministic root-only transcript building,
  package/remote/git project detection, segment summary prompts, and a
  session-end collapse flow that extracts segment-linked memories
- Added deterministic memory surfacing with hybrid search plus entity-hub pool,
  MIRA-style XML memory blocks with `mem_XXXXXXXX` citations, per-session
  surfaced block propagation to delegated agents, and assistant citation
  mention tracking without git commits

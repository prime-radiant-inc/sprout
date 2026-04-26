# MIRA Memory Port — Status

## Current phase

Phase 1 — Foundation (in progress)

## Phase log

- Phase 1 — Foundation: in progress

## Current branch / commit

- Branch: `jesse/pri-1354-implement-mira-memory-port-phase-1-foundation`
- Last verified commit: `faed6d6`

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

## Completed in current slice

- Added legacy memory fixture for migration coverage
- Added extended memory schema normalization helpers
- Added generic JSONL store primitive with append/rewrite/load behavior
- Updated `MemoryStore` to normalize legacy and extended records on load/add
- Added SQLite/FTS5 memory index skeleton with JSONL rebuild tests
- Added index-builder helper that rebuilds `genome/.cache/index.db` from JSONL
- Added `.cache/` genome initialization and gitignore coverage
- Added local-first embedding provider abstraction with `MongoDB/mdbr-leaf-ir`
  default metadata, 768-dimensional dense projection, query/document prompt
  asymmetry, fail-fast production errors, and deterministic fake embeddings for
  tests
- Added SQLite-backed embedding vector storage and vector/hybrid search helpers
  with fail-fast behavior when vector-required search has no indexed embeddings

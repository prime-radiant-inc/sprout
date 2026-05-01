# MIRA Memory Port — Execution Plan

**Status:** Draft implementation plan
**Date:** 2026-04-25
**Design:** [`2026-04-25-mira-memory-port-design.md`](./2026-04-25-mira-memory-port-design.md)
**Reference:** [`../reference/mira-memory-architecture.md`](../reference/mira-memory-architecture.md)

## Goal

Implement the MIRA memory port in Sprout without losing Sprout's existing
operational guarantees: Bun/TypeScript only, JSONL as the genome audit trail,
SQLite as a rebuildable local index, deterministic recall as the hot path,
RoutingRules intact, and learn-event detection intact.

The practical delivery cut is:

- **V1:** Phases 1-5. Embedded semantic memory store, extraction, segment
  collapse, passive surfacing, memory-tools, and archivist.
- **Full parity:** Phases 6-9. Link graph, per-project decay, cache strategy,
  consolidation, and entity GC.
- **Optional:** Phase 10. Subcortical pre-pass only if evals show enough recall
  gain to justify the extra LLM call.

## Ground Rules

- Use `bun`, not `pnpm`, `npm`, `node`, `vitest`, or Python.
- Use `bun:sqlite`; keep Postgres out of v1. Do not require dynamic SQLite
  extensions in Bun.
- Keep JSONL authoritative. Every durable memory mutation writes JSONL first and
  commits through the genome path before the SQLite index is updated.
- Keep SQLite in `genome/.cache/index.db` and treat it as disposable. Cold-start
  rebuild must be deterministic from JSONL.
- Do not replace `RoutingRule`. Do not change learn-event detection. Only change
  how learn events produce memory writes.
- Do not give normal specialist agents write access to memory. Only archivist
  gets write tools, and destructive writes require code-level authorization.
- Prompts live in genome prompt files, not embedded TypeScript strings.
- Use VCR/replay tests by default. Live calls require `.env` keys and should be
  isolated to explicit record/live runs.

Verified dependency notes:

- Bun has a native `bun:sqlite` driver. In this environment, the bundled SQLite
  build does not support dynamic extension loading.
- `sqlite-vec` was tested and rejected for this port because
  `sqliteVec.load(db)` fails with dynamic extension loading disabled. Store
  vectors as SQLite BLOBs and rank them with TypeScript cosine distance instead.

Sources:

- Bun SQLite docs: https://bun.sh/docs/runtime/sqlite
- sqlite-vec JavaScript/Bun docs, retained only as background on the rejected
  extension path: https://alexgarcia.xyz/sqlite-vec/js.html

## Commands

Use these gates unless a phase says otherwise:

- Targeted unit test: `bun test test/path/to/file.test.ts`
- All tests: `bun test`
- Type check: `bun run typecheck`
- Format/lint: `bun run check`
- Pre-commit gate: `bun run precommit`
- Integration replay: `bun run test:integration`
- Integration live/record only when needed: `bun run test:integration:live` or
  `bun run test:integration:record`
- Web build only if web files change: `bun run web:build`

## Status Tracking

Create `docs/plans/2026-04-25-mira-memory-port-status.md` before the first
implementation commit.

Use this structure:

```markdown
# MIRA Memory Port — Status

## Current phase
Phase N — <name> (in progress / blocked / done)

## Phase log
- Phase 1 — Foundation: in progress

## Current branch / commit
- Branch: <branch>
- Last verified commit: <sha>

## Open issues
- <issue> — see design §<N>; awaiting user decision

## Deviations from design
- <deviation> — <reasoning>

## Verification
- <date>: `bun test test/genome/memory-store.test.ts` passed
```

Update it at the start and end of every phase, and whenever an implementation
choice deviates from the design.

## Preflight Work

### Task 0.1: Normalize the Launch Prompt

The dispatch prompt must match Sprout's actual commands. Keep
`docs/plans/2026-04-25-mira-memory-port-impl.md` aligned with `AGENTS.md`:

- `bun test`, not `pnpm vitest run`
- `bun run typecheck`, not package-level `pnpm tsc`
- `bun run precommit`, not `pnpm -r build`
- `AGENTS.md` required; `CLAUDE.md` optional if present

Gate: `git diff --check` passes on the docs.

### Task 0.2: Resolve Remaining Halt Points

Before implementation starts, decide whether these are blockers for the first
five phases:

- `§14.1` session-start surfacing on resume. Recommended default: resurface if
  cached block is older than 1 hour or the top-level goal changed.
- `§14.5` qm-reconciler scope. Recommended default: reconciler delegates memory
  audits to archivist; it does not read SQLite/schema directly.
- `§14.12` recursive archivist. Recommended default: archivist cannot delegate
  to itself; `max_turns: 8` remains the hard cap.

If not decided up front, the implementer should halt when each first affects
code.

### Task 0.3: Add Memory Schema Fixtures

Create small checked-in memory fixtures under `test/fixtures/memory/` covering
the persisted shapes the new code must read and write:

- One extended durable memory
- One low-confidence memory that should not surface by default
- One memory with multiple tags/entities
- One learn-sourced memory

These fixtures are for schema and index regression coverage. There are no
legacy users, so do not build a one-shot migration plan around them.

Gate: fixture loads through current `MemoryStore.load()` before schema changes.

## Phase 1: Foundation

Goal: replace keyword-only memory storage with extended JSONL records plus a
SQLite/FTS5/vector-BLOB derived index. User-visible behavior should only improve
recall quality.

Primary files:

- Modify `src/kernel/types.ts`
- Modify `src/genome/memory-store.ts`
- Modify `src/genome/genome.ts`
- Add `src/genome/jsonl-store.ts`
- Add `src/genome/memory-schema.ts`
- Add `src/genome/memory-index.ts`
- Add `src/genome/index-builder.ts`
- Add `src/genome/hybrid-search.ts`
- Add `src/llm/embeddings.ts`
- Update `test/genome/memory-store.test.ts`
- Update `test/genome/recall.test.ts`

### Task 1.1: Extended Types With Tolerant Parsing

Add extended memory types while preserving existing API/test compatibility:

- Keep `content`, `tags`, `source`, `created`, `last_used`, `use_count`, and
  `confidence` readable for existing tests and explicit memory creation calls.
- Add canonical fields from the design: short memory ID, embedding metadata,
  entities, links, annotations, project IDs, source segment, importance fields,
  archive/supersession fields, access counters, and creation provenance.
- Add conversion helpers so minimal records normalize into extended records on
  load/add. This is not a legacy-user migration path.

Gate:

- `bun test test/kernel/types.test.ts test/genome/memory-store.test.ts`
- `bun run typecheck`

Commit: `feat: extend memory schema`

### Task 1.2: JSONL Store Primitive

Implement a generic append/rewrite JSONL helper for genome-owned data files:

- Append-only writes for normal mutations
- Full rewrite for compaction and explicit maintenance operations
- Strict line-level parse errors with filename and line number
- Atomic rewrite via temp file + rename
- No Python helpers

Gate:

- New tests for append, load, malformed line, and rewrite
- `bun test test/genome/jsonl-store.test.ts`

Commit: `feat: add genome jsonl store`

### Task 1.3: SQLite Index Bootstrap

Build the rebuildable index:

- Use `bun:sqlite`.
- Database path: `genome/.cache/index.db`.
- Tables: memories, memory_embeddings, entities, memory_entities, memory_links,
  annotations, segments, projects.
- FTS5 table for memory text and tags.
- `memory_embeddings` table for 768-dimensional embedding BLOBs.
- Store schema version and source JSONL high-water metadata.
- Rebuild from JSONL when missing, stale, or schema version changes.

Implementation detail:

- FTS5 and vector search are separate lanes. Missing vector infrastructure is a
  failure for vector-required paths, not a degraded mode.

Gate:

- In-memory SQLite tests for schema creation
- Rebuild test from memory fixtures
- Stale-index detection test
- `bun test test/genome/memory-index.test.ts`

Commit: `feat: add sqlite memory index`

### Task 1.4: Embedding Adapter

Add `src/llm/embeddings.ts`:

- Default provider: local `MongoDB/mdbr-leaf-ir`
- Input: one string or batch of strings
- Output: 768-dimensional `Float32Array` plus provider/model metadata
- Query/document asymmetry: apply the model's query prompt for recall queries;
  document memories are embedded without a prompt
- Failure mode: fail fast on model load, inference, or dimension errors; do not
  silently substitute another provider or mark vector search as healthy
- Tests use fake loaders/adapters by default; live local model smoke tests are
  opt-in/manual because they download the model cache

Do not read `.env` directly in the adapter. Follow existing client/provider
patterns so normal environment loading remains centralized.

Gate:

- Fake-adapter unit tests
- One opt-in/manual live smoke test proving local embeddings produce 768d
  query/document vectors
- `bun test test/llm/embeddings.test.ts`

Commit: `feat: add embedding provider adapter`

### Task 1.5: Hybrid Search

Replace keyword token counting with hybrid search:

- Lane 1: FTS5/BM25
- Lane 2: TypeScript cosine similarity over SQLite-stored embedding BLOBs
- Fusion: reciprocal rank fusion
- Fail fast if query embeddings or indexed memory embeddings are required but
  unavailable; FTS5 is a lane, not a substitute for a broken vector path
- Maintain `MemoryStore.search(query, limit, minConfidence)` compatibility until
  callers move to richer query APIs

Gate:

- Existing recall tests pass
- New semantic-search regression where keyword search misses but vector lane hits
- Missing-embedding failure test
- `bun test test/genome/memory-store.test.ts test/genome/recall.test.ts`

Commit: `feat: replace memory search with hybrid index`

### Task 1.6: Embedded Memory Writes

Route memory creation through required embedding generation:

- Manual `addMemory` calls generate local document embeddings before write.
- Learn-pipeline writes use the same creation path when Phase 2 adds extraction.
- Persist ready embedding metadata and the 768-dimensional vector in JSONL.
- Fail the memory write if local embedding infrastructure is unavailable.
- Rebuild or update the SQLite index after the JSONL write.
- Do not create pending/unembedded memories in production paths.

Gate:

- Embedded-write unit test
- Missing-local-model failure test
- Index reflects the newly added memory without a separate migration step
- `bun test test/genome/genome.test.ts test/genome/memory-store.test.ts`

Commit: `feat: embed memory writes`

Phase 1 gate:

- `bun test`
- `bun run typecheck`
- `bun run precommit`
- Manual check: rebuild index from JSONL twice and confirm stable counts

## Phase 2: Extraction

Goal: learn events and session transcript slices create memories through one
MIRA-style extraction pipeline instead of handcrafted memory records.

Primary files:

- Add `src/genome/extraction.ts`
- Add `src/genome/dedup.ts`
- Add `genome/prompts/memory_extraction_system.txt`
- Add `genome/prompts/memory_extraction_user.txt`
- Modify `src/learn/learn-process.ts`
- Modify `src/bus/learn-contract.ts` and `src/bus/genome-service.ts` if bus
  learn mutations still bypass `LearnProcess`
- Add `test/genome/extraction.test.ts`
- Update `test/learn/learn-process.test.ts`
- Update `test/bus/genome-service.test.ts`

### Task 2.1: Prompt Files and Loader

Create genome prompt files and a loader that falls back to root/default prompt
templates when a genome does not yet have them.

Gate:

- Prompt files are plain text
- Tests prove missing prompt files produce deterministic defaults

Commit: `feat: add memory extraction prompts`

### Task 2.2: Extraction Runner

Implement:

- Transcript-slice input model
- LLM call through existing `Client`
- Strict JSON parser with repair fallback implemented in TypeScript or via a
  small vetted Bun-compatible package
- Shape normalization: array, `{ memories: [] }`, or single object
- Validation and normalization into extended memory records
- Debug output to `data/users/{user_id}/extraction_outputs.jsonl` only when the
  design's debug path is configured; do not create hardcoded user paths

Gate:

- Parser fixtures for valid JSON, wrapped JSON, malformed-but-repairable JSON,
  and invalid JSON
- No live LLM required for unit tests

Commit: `feat: add memory extraction pipeline`

### Task 2.3: Dedup

Implement three-stage duplicate handling:

- Fuzzy text match against local memory context
- Vector similarity against indexed memories
- Defer deeper semantic merges to consolidation

Gate:

- Tests for exact duplicate, near duplicate, vector duplicate, and distinct
  operational memories

Commit: `feat: add memory deduplication`

### Task 2.4: Rewire Learn Writes

Keep `should-learn` and learn signal creation unchanged. Change only the write
path:

- `create_memory` becomes transcript-slice extraction
- Manual/user memory creation still bypasses extraction but gets embedded and
  indexed
- RoutingRule creation remains supported
- Bus learn mutation paths must not keep a direct unembedded memory write path

Gate:

- Existing learn tests still pass or are intentionally updated
- Regression: known stumble produces an extracted memory with entities and
  embedding/pending embedding metadata
- `bun test test/learn test/bus/genome-service.test.ts`

Commit: `feat: route learn memories through extraction`

Phase 2 gate:

- `bun test test/learn test/genome`
- `bun run typecheck`
- A recorded/live eval only if prompt quality cannot be judged from fixtures

## Phase 3: Segment Collapse

Goal: completed or idle sessions produce segment summaries and extracted
memories.

Primary files:

- Add `src/core/session-collapse.ts` or the nearest existing host/session module
  if `src/core` remains absent
- Add `src/genome/segments.ts`
- Add `src/genome/projects.ts`
- Add `genome/prompts/segment_summary_system.txt`
- Modify `src/agents/agent.ts`
- Modify `src/host/session-controller.ts`
- Modify `src/host/session-state.ts`
- Add `test/genome/segments.test.ts`
- Add `test/host/session-collapse.test.ts`

### Task 3.1: Segment Store

Persist collapsed summaries in `genome/memories/segments.jsonl` and index them in
SQLite.

Gate:

- Add/load/rewrite tests
- Segment embedding pending path works without API keys

Commit: `feat: add memory segment store`

### Task 3.2: Transcript Builder

Build transcript input from session logs:

- User messages
- Root plan/final summaries
- Delegation outcomes
- Exclude full subagent transcripts by default
- Include absolute timestamps

Gate:

- Fixture session log produces deterministic transcript

Commit: `feat: build collapse transcripts`

### Task 3.3: Summary and Extraction Flow

Call summary prompt, persist segment, call extraction on transcript + summary,
and link extracted memories to `source_segment_id`.

Gate:

- Fake LLM test for summary + extraction
- Completed session fixture produces one segment and at least one memory

Commit: `feat: collapse sessions into memory segments`

### Task 3.4: Project Detection

Implement the resolved policy:

- Explicit `--project` or session metadata wins
- Fallback inference from `cwd`, git root, package name, and normalized remote
- Low confidence becomes `global`/`unknown`
- Project-specific decay clock does not advance for `unknown`

Gate:

- Tests for explicit, inferred, and unknown project
- Wrong-project false positive fixture stays unknown

Commit: `feat: detect memory projects`

Phase 3 gate:

- `bun test test/host/session-collapse.test.ts test/genome/segments.test.ts`
- `bun run typecheck`

## Phase 4: Surfacing Pipeline

Goal: recall surfaces a cached MIRA-format block once per session/goal change,
then every delegated agent receives the same block without rerunning search.

Primary files:

- Add `src/genome/recall-pipeline.ts`
- Add `src/genome/hub-discovery.ts`
- Add `src/genome/render-memory-block.ts`
- Modify `src/genome/recall.ts`
- Modify `src/kernel/types.ts`
- Modify `src/agents/agent.ts`
- Modify `src/agents/plan.ts`
- Add `test/genome/recall-pipeline.test.ts`
- Update `test/agents/agent.integration.test.ts`

### Task 4.1: Pipeline Service

Implement:

- Hybrid search pool
- Entity hub pool
- Merge/dedup
- Debut boost
- Supersedes penalty
- Link traversal placeholder until Phase 6
- XML rendering with `[mem_XXXXXXXX]` IDs

Gate:

- Deterministic fake-index tests for ordering and rendering

Commit: `feat: add memory surfacing pipeline`

### Task 4.2: Session Cache Boundary

Move expensive surfacing out of per-agent recall:

- Root session start / explicit goal change refreshes surfaced block
- Delegated agents receive cached block
- `recall()` remains deterministic and fast as accessor
- Resumed sessions follow §14.1 decision when settled

Gate:

- Test session with 5 delegations runs pipeline once
- Subsequent recall accessor is sub-millisecond in unit benchmark

Commit: `feat: cache surfaced memories per session`

### Task 4.3: Mention Tracking

Parse assistant output for `mem_XXXXXXXX` references:

- Count assistant text only
- Dedupe within one response
- Ignore tool results
- Persist access metadata without noisy git commits unless design says the
  access signal is durable

Gate:

- Parser tests
- Agent-output integration test

Commit: `feat: track memory mentions`

Phase 4 gate:

- `bun test test/genome/recall-pipeline.test.ts test/agents`
- `bun run typecheck`

## Phase 5: Memory-Tools and Archivist

Goal: agents can do deterministic memory reads, and selected agents can delegate
investigation or authorized mutation to archivist.

Primary files:

- Add `src/genome/memory-tools.ts`
- Add `src/genome/memory-write-policy.ts`
- Add `root/agents/archivist.md` or the correct root-agent path for this repo
- Add `genome/prompts/archivist_system.txt`
- Modify agent specs under `root/agents/`
- Modify tool registry/loading if memory-tools are primitives rather than
  workspace tools
- Add `test/genome/memory-tools.test.ts`
- Add `test/genome/memory-write-policy.test.ts`
- Add `test/agents/archivist.test.ts`

### Task 5.1: Read Tools

Implement:

- `memory.search`
- `memory.get`
- `memory.trace_links`
- `memory.entity_query`
- `memory.find_by_segment`

Expose these read-only tools broadly to engineer, architect, debugger, and
verifier.

Gate:

- Each tool has deterministic unit coverage
- Read-only agents cannot see write tools

Commit: `feat: add read-only memory tools`

### Task 5.2: Write Policy and Archivist Tools

Implement:

- `memory.annotate`
- `memory.archive`
- `memory.link`
- `memory.consolidate`
- `memory.synthesize_answer`
- Code-level write policy:
  - Additive writes require explicit caller instruction
  - Destructive/meaning-changing writes require explicit user confirmation
  - User-authored/manual memories are protected from archive/consolidation/
    supersession without confirmation
  - All archivist mutations carry `source: 'archivist:<session_id>'`

Gate:

- Authorized annotation persists
- Unauthorized archive is blocked
- User-created memory archive requires confirmation
- Audit source is recorded

Commit: `feat: gate archivist memory writes`

### Task 5.3: Archivist Agent

Add archivist spec and prompt:

- No surfaced memory block in archivist system prompt
- Query strategy decision tree
- Citation discipline
- Refusal when surfaced block already answers the question
- Structured answer shape
- `max_turns: 8`
- No recursive archivist delegation unless §14.12 is explicitly changed

Gate:

- Known synthesis fixture returns answer with cited memory IDs
- Covered-by-surfacing fixture refuses cleanly

Commit: `feat: add archivist agent`

### Task 5.4: Routing and Agent Wiring

Wire delegation access:

- `root`
- `quartermaster/qm-fabricator`
- `quartermaster/qm-planner`
- `quartermaster/qm-reconciler`
- `architect`
- `debugger`

Do not expose archivist delegation to engineer/verifier/utility agents by
default.

Gate:

- Agent spec loader tests
- Delegation availability tests

Commit: `feat: route memory investigations to archivist`

V1 gate:

- `bun test`
- `bun run precommit`
- Side-by-side recall eval against keyword baseline
- Manual session: one task creates a memory, next task surfaces it, and a
  selected agent can ask archivist a cited synthesis question

## Phase 6: Link Graph

Goal: memories become a navigable relationship graph.

Primary files:

- Add `src/genome/linking.ts`
- Add `src/genome/relationship-classifier.ts`
- Add `genome/prompts/memory_relationship_classification.txt`
- Add `test/genome/linking.test.ts`
- Add `test/fixtures/memory/relationship-pairs.jsonl`

Tasks:

- Candidate discovery from vector, entity co-occurrence, and TF-IDF
- Cheap-tier LLM classification with prompt examples preserved from MIRA
- Bidirectional link persistence to JSONL and SQLite
- Heal-on-read for dead refs
- Link traversal and rerank by type weight × inherited importance

Gate:

- 50-pair hand-labeled eval set reaches at least 80% agreement
- Traversal returns expected clusters

Commit boundary:

- `feat: discover memory link candidates`
- `feat: classify memory relationships`
- `feat: traverse memory links`

## Phase 7: Decay

Goal: per-project activity clocks drive importance without eroding dormant
project knowledge.

Primary files:

- Expand `src/genome/projects.ts`
- Add `src/genome/scoring.ts`
- Add background recompute hook in host/session lifecycle
- Add `test/genome/scoring.test.ts`
- Add `test/genome/projects.test.ts`

Tasks:

- Implement per-project counters
- Implement MIRA scoring formula in TypeScript
- Count access and mention signals
- Recompute daily/project-active-day working set
- Archive low-importance records instead of deleting

Gate:

- Synthetic 90-day timeline matches expected curves
- Dormant-project memories do not decay while project is inactive

## Phase 8: Cache Strategy

Goal: memory system does not explode token cost in long agent loops.

Primary files:

- Modify `src/llm/anthropic.ts`
- Modify `src/llm/openai.ts`
- Modify LLM request context plumbing
- Update `test/llm/anthropic.test.ts`
- Update `test/llm/openai.test.ts`

Tasks:

- Anthropic cache markers 3 and 4
- Optional 1h TTL beta per agent if configured
- OpenAI `prompt_cache_key` threading
- Usage telemetry for cache read/write tokens

Gate:

- Marker placement tests
- Cache key threading tests
- 10-turn engineer eval shows cache-read improvement

## Phase 9: Consolidation and Entity GC

Goal: memory store stays bounded and duplicate clusters collapse safely.

Primary files:

- Add `src/genome/consolidation.ts`
- Add `src/genome/entity-gc.ts`
- Add `genome/prompts/memory_consolidation.txt`
- Add `test/genome/consolidation.test.ts`
- Add `test/genome/entity-gc.test.ts`

Tasks:

- Connected-component cluster discovery
- Consolidation prompt + merge handler
- Rejection counter to avoid churn
- Entity grouping via FTS5 plus LLM review
- Archive, do not hard delete
- Schedule by project-active-days

Gate:

- Synthetic 20% duplicate store collapses below 5%
- Rejected clusters increment rejection counters

## Phase 10: Optional Subcortical Pre-Pass

Goal: improve recall quality with query expansion only if measured gains justify
the extra call.

Tasks:

- Add prompt file
- Cheap LLM pre-pass before search
- Entity output feeds hub discovery
- Pinned-memory retention across goal changes
- 30-query side-by-side eval

Gate:

- Merge only if eval shows strictly better relevance without unacceptable
  latency/cost.

## Cross-Cutting Test Strategy

- Unit tests use fake embeddings and fake LLM clients.
- Integration tests use VCR replay by default.
- Live tests require `.env` keys but must be opt-in and skipped in normal
  `bun test`.
- Every phase includes persisted-JSONL round-trip tests when it changes storage.
- Use fixtures for memories, segment transcripts, extraction outputs,
  relationship pairs, and scoring timelines.

## Data Safety

- Never commit `genome/.cache/index.db`, WAL files, embedding debug outputs, or
  live API response dumps.
- Keep source JSONL line order stable unless running an explicit compaction.
- Compaction is not part of Phase 1; do not sneak it in before Phase 9.
- Pending embeddings are not acceptable in production write paths; dropped
  memories are not acceptable.

## Recommended First Week

1. Create the status tracker.
2. Add memory schema fixtures.
3. Extend memory types with normalization.
4. Add the generic JSONL store.
5. Prove SQLite + FTS5 + embedding BLOB cosine search works in a tiny unit test.
6. Build index schema and cold-start rebuild.
7. Route new memory writes through local embeddings.
8. Keep old recall tests green before touching extraction.

The first week should end with a working index over newly written memories with
real ready embeddings. That creates a stable foundation for the prompt-heavy
phases that follow.

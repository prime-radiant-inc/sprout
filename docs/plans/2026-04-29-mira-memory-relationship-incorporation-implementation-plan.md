# MIRA Memory Relationship Incorporation Implementation Plan

Date: 2026-04-29

Status: ready for implementation

Linear: PRI-1424

Spec: `docs/plans/2026-04-28-mira-memory-relationship-incorporation-spec.md`

## Objective

Make automated MIRA-style memory extraction writes relationship-aware before new
memories become active recall candidates.

The implementation must guarantee that session-collapse, learn-process, and bus
learn-signal extraction writes all pass through one relationship-aware
incorporation path. If a new extracted memory supersedes an old memory, the old
memory is deactivated in the same JSONL commit that creates the new memory and
before the derived SQLite index is rebuilt.

## Ground Rules

- Use Bun and TypeScript only.
- Use strict red/green/refactor TDD. Write failing tests before each production
  slice.
- Do not add fallbacks. Missing configured memory models fail clearly.
- Do not add legacy compatibility for direct automated `create_memory` mutation
  support.
- Do not add a daemon, queue, observer, UI, or archivist delegation loop.
- Do not rescan the full graph on each write.
- Keep JSONL authoritative and SQLite derived.
- Preserve manual archivist write authorization.
- Keep changes small enough to commit after each green slice.

## Worktree Preflight

The current local branch may not match `PRI-1424`. Before implementation commits:

- Confirm whether to create/switch to branch
  `jesse/pri-1424-resolve-mira-memory-relationships-during-memory-writes`.
- Do not delete unrelated untracked files.
- Keep the spec and this plan uncommitted until the implementation branch
  decision is clear.
- Run the baseline targeted suites before red tests if time permits:
  `bun test test/genome/linking.test.ts test/genome/relationship-classifier.test.ts`.

## Phase 1: Restricted Link Candidate Discovery

Goal: discover only relationships involving newly staged memories, while
including explicit memory references from source evidence.

Primary files:

- `src/genome/linking.ts`
- `src/genome/memory-schema.ts`
- `test/genome/linking.test.ts`

Red tests:

- `discoverLinkCandidatesForNewMemories()` returns vector/entity/TF-IDF
  candidates for new-vs-existing pairs.
- It returns candidates for new-vs-new pairs.
- It does not return existing-vs-existing pairs.
- It excludes inactive existing memories: `archived_at`, `superseded_by`, and
  inbound `supersedes`.
- It excludes proposed memory ids that were dropped before the `newMemoryIds`
  set was built.
- It creates explicit candidates for full ids mentioned in new memory content.
- It creates explicit candidates for `mem_XXXXXXXX` short ids mentioned in new
  memory content.
- It creates explicit candidates from batch-level `explicitReferenceIds` even
  when new memory content omits those ids.
- It keeps the new memory as `source_id` for new-vs-existing candidates,
  including same-created-timestamp cases.
- It caps heuristic candidates without dropping explicit candidates.

Green implementation:

- Extend `LinkCandidateAxis` with `"explicit"`.
- Add `discoverLinkCandidatesForNewMemories(input)`.
- Factor the current vector/entity/TF-IDF pair scoring enough to avoid duplicate
  scoring logic.
- Add a small helper to resolve explicit memory references:
  full memory ids directly, and `mem_XXXXXXXX` through `memoryShortId()`.
- Use an incorporation-specific heuristic cap of 12 by default, while keeping
  the existing full-graph default unchanged.
- Preserve `discoverLinkCandidates()` behavior for maintenance/full graph use.

Refactor checks:

- Ensure source/target ordering is explicit for new-vs-existing and not an
  accidental consequence of timestamp sorting.
- Ensure explicit refs to inactive memories are ignored, consistent with active
  recall semantics.

Verification:

- `bun test test/genome/linking.test.ts`

Commit target:

- `feat: discover memory links for new extraction batches`

## Phase 2: In-Memory Link Application

Goal: reuse link mutation logic inside an atomic memory write without forcing an
intermediate commit.

Primary files:

- `src/genome/linking.ts`
- `test/genome/linking.test.ts`
- `test/genome/relationship-classifier.test.ts`

Red tests:

- `applyMemoryLinks()` writes reciprocal `refines` metadata and reports
  `added: 1`.
- `applyMemoryLinks()` writes reciprocal `conflicts` metadata and leaves both
  memories active.
- `applyMemoryLinks()` writes reciprocal `supersedes` metadata and sets target
  `superseded_by`.
- `applyMemoryLinks()` ignores `null`.
- Existing outbound links are repaired by adding missing inbound metadata and
  `superseded_by` without incrementing `added`.
- Applying links after new memories are staged mutates both the new memory's
  outbound links and the old memory's inbound/supersession metadata.
- Existing `persistMemoryLinks()` tests still pass and still rebuild the index.

Green implementation:

- Extract `applyMemoryLinks(memories, relationships, options)` from
  `persistMemoryLinks()`.
- Keep `persistMemoryLinks()` as the save/commit wrapper around
  `applyMemoryLinks()`.
- Keep `supersedes` lifecycle behavior in link application, not in recall.

Refactor checks:

- Name the helper as an in-memory mutation helper, not a pure function.
- Keep the validation error for missing relationship source/target memories.

Verification:

- `bun test test/genome/linking.test.ts`
- `bun test test/genome/relationship-classifier.test.ts`

Commit target:

- `refactor: split memory link application from persistence`

## Phase 3: Atomic Genome Incorporation Method

Goal: add the low-level atomic Genome method that stages memories, resolves
candidates, applies classified links, saves JSONL, rebuilds SQLite, and commits
once.

Primary files:

- `src/genome/genome.ts`
- New `src/genome/memory-incorporation.ts` if useful for shared types/wrapper
- `src/genome/linking.ts`
- `test/genome/memory-incorporation.test.ts`
- `test/genome/genome.test.ts`
- `test/genome/read-only-genome.test.ts`

Red tests:

- Given an active stale memory and a new corrected extracted memory, when the
  classifier callback returns `supersedes`, incorporation commits the new
  memory, records reciprocal links, sets `old.superseded_by`, rebuilds the
  index, and returns candidates/relationships.
- When the callback returns `conflicts`, both memories remain active and the
  conflict link is persisted.
- When no candidates are found, incorporation commits without invoking the
  classifier callback.
- When the callback throws, no new memory, segment, link, or index mutation
  remains.
- When embedding generation fails, no new memory, segment, link, or index
  mutation remains.
- When deduplication drops a proposed memory, no candidate is classified for the
  dropped id.
- The streamlinear Authorization regression is represented directly: source
  evidence contains stale `mem_...` ids, the extracted memory text omits them,
  explicit candidates are still classified, and stale memories are superseded.
- Heuristic candidate cap applies while explicit references survive the cap.
- Read-only genome rejects the new write method.

Green implementation:

- Add `Genome.addExtractedMemoriesWithRelationships(input)`.
- Keep the method LLM-agnostic by accepting `classifyRelationships`.
- Attach ready local embeddings before acquiring or immediately after acquiring
  the lock, matching existing failure semantics.
- Under the memory write lock:
  load fresh stores, dedupe against fresh memories, validate ids, stage deduped
  memories in memory, discover new-memory candidates, call classifier only when
  candidates exist, apply links, stage segment if present, save JSONL files,
  rebuild SQLite, and commit once.
- Do not call `mergeLatestFromDisk()` after applying link metadata.
- Use existing snapshot/restore patterns from `addSegmentWithMemories()`.
- Add a commit message parameter and use source only for diagnostics or future
  telemetry, not behavior branching.

Refactor checks:

- Avoid duplicating large chunks of `addMemories()` and
  `addSegmentWithMemories()` by extracting local helpers only where they reduce
  duplication without broad redesign.
- Keep `addMemory()` and `addMemories()` for explicit/manual/test writes, but
  do not use them from automated extraction call sites after later phases.

Verification:

- `bun test test/genome/memory-incorporation.test.ts`
- `bun test test/genome/genome.test.ts`
- `bun test test/genome/read-only-genome.test.ts`

Commit target:

- `feat: add atomic extracted memory incorporation`

## Phase 4: Production Incorporation Wrapper

Goal: add the production wrapper that resolves prompts/models and calls the
Genome method without putting LLM concerns inside `Genome`.

Primary files:

- New `src/genome/memory-incorporation.ts`
- `src/genome/relationship-classifier.ts`
- `src/genome/prompts.ts`
- `src/genome/genome.ts`
- `test/genome/memory-incorporation.test.ts`

Red tests:

- Wrapper resolves and uses configured `memory.relationship` model when
  candidates exist.
- Wrapper does not resolve relationship model when no candidates exist.
- Wrapper passes `metadata.purpose = "memory.relationship"` through classifier
  requests.
- Missing relationship model rejects before saving when candidates exist.
- Invalid classifier JSON rejects before saving when candidates exist.
- Classifier result count must equal candidate count; mismatch rejects before
  saving.

Green implementation:

- Add `incorporateExtractedMemories(input)`.
- Load or accept the relationship classification prompt at the wrapper boundary.
- Use existing `classifyMemoryRelationshipWithSettings()` or a thin batch helper
  that classifies the passed candidates in order.
- Bind relationship result ids from candidate context, not model output.
- Preserve strict classifier parse behavior. Do not add semantic fallbacks or
  retry with another model.

Refactor checks:

- Keep the old `classifyAndPersistMemoryLinksWithSettings()` maintenance helper
  working, but do not use it for new extraction writes.
- Avoid a generic service class; this is a function plus a Genome method.

Verification:

- `bun test test/genome/memory-incorporation.test.ts`
- `bun test test/genome/relationship-classifier.test.ts`

Commit target:

- `feat: classify relationships during memory incorporation`

## Phase 5: Session Collapse Integration

Goal: route session-collapse extracted memories through the wrapper and fail
atomically when relationship classification fails.

Primary files:

- `src/core/session-collapse.ts`
- `src/host/session-controller.ts`
- `src/genome/genome.ts`
- `src/genome/prompts.ts`
- `test/host/session-collapse.test.ts`
- `test/host/session-controller.test.ts` if model plumbing needs coverage

Red tests:

- Collapse with a stale existing memory and corrected extracted memory calls the
  relationship classifier with `memory.relationship` and persists `supersedes`.
- Collapse passes source-evidence `mem_...` ids from bounded extraction messages
  as `explicitReferenceIds`.
- Collapse classifier failure leaves neither the segment nor extracted memories
  on disk.
- Collapse with no extracted memories still persists the segment and does not
  require relationship model configuration.
- Collapse with extracted memories but no relationship candidates commits
  without resolving relationship model.

Green implementation:

- Extend `CollapseSessionToMemoryInput` with relationship incorporation inputs:
  resolver settings/model catalog or a prebuilt relationship config matching the
  wrapper.
- Add or expose a `Genome` prompt wrapper for relationship classification if
  that keeps call sites clean.
- Parse memory ids from the bounded extraction messages before calling
  extraction.
- Replace `genome.addSegmentWithMemories()` with
  `incorporateExtractedMemories()`.
- Thread relationship model plumbing from `SessionController` collapse setup.

Refactor checks:

- Keep summary/extraction model behavior unchanged.
- Keep existing transcript bounding and redaction behavior unchanged.
- Keep segment-only collapse behavior intact when no memories are extracted.

Verification:

- `bun test test/host/session-collapse.test.ts`
- Add `test/host/session-controller.test.ts` only if needed by wiring changes.

Commit target:

- `feat: incorporate collapsed memories with relationships`

## Phase 6: LearnProcess Integration

Goal: route learn-process extracted memories through the same wrapper and stop
silently skipping model configuration failures.

Primary files:

- `src/learn/learn-process.ts`
- `src/learn/extraction-evidence.ts`
- `test/learn/learn-process.test.ts`
- `test/learn/extraction-evidence.test.ts` if id parsing belongs there

Red tests:

- Learn-process extraction uses incorporation and supersedes stale active
  memories when classifier returns `supersedes`.
- Learn-process passes source-evidence memory ids as `explicitReferenceIds`.
- Relationship classifier failure emits `learn_end` with `result: "error"` and
  writes no new memory.
- Missing extraction model after `shouldLearn` passes emits `learn_end` with
  `result: "error"`, not `skipped`.
- Learn-process no longer writes extracted memories through raw
  `genome.addMemories()`.
- Non-memory learn mutations still work.

Green implementation:

- Store resolver settings and model catalog needed for relationship resolution
  alongside the existing extraction model context.
- Replace `genome.addMemories()` in `extractAndApplyLearnMemories()` with
  `incorporateExtractedMemories()`.
- Parse memory ids from `learnSignalExtractionMessages()` output.
- Change missing extraction model handling from silent false return to a thrown
  configuration error once a signal is being processed.
- Keep reasoner/non-memory mutation behavior unchanged.

Refactor checks:

- Do not make learn reasoner responsible for memory relationship decisions.
- Keep learn-event detection and `shouldLearn()` unchanged.

Verification:

- `bun test test/learn/learn-process.test.ts`
- `bun test test/learn/extraction-evidence.test.ts`

Commit target:

- `feat: incorporate learned memories with relationships`

## Phase 7: Bus Genome Service Integration And Direct Mutation Removal

Goal: route bus learn-signal extraction through incorporation and remove direct
automated `create_memory` mutation support.

Primary files:

- `src/bus/genome-service.ts`
- `src/bus/learn-contract.ts`
- `src/learn/learn-process.ts`
- `test/bus/genome-service.test.ts`
- `test/bus/learn-contract.test.ts`
- `test/bus/learn-forwarder.test.ts`
- `test/bus/agent-process.test.ts`

Red tests:

- Bus signal extraction uses incorporation and supersedes stale active memories.
- Bus signal extraction passes source-evidence memory ids as
  `explicitReferenceIds`.
- Relationship classifier failure publishes a failed confirmation with no memory
  write.
- Missing extraction model publishes a failed confirmation with no memory write.
- Direct `create_memory` mutation requests fail validation or return a clear
  unsupported-mutation confirmation without writing memory.
- Serial mutation tests no longer rely on `create_memory`; use supported
  `create_agent`, `update_agent`, or `create_routing_rule` requests.
- `BusLearnForwarder` signal path still publishes and confirms learn-signal
  extraction.

Green implementation:

- Replace `genome.addMemories()` in `applySignalRequest()` with
  `incorporateExtractedMemories()`.
- Parse memory ids from bus learn evidence messages.
- Resolve both extraction and relationship memory models through the same
  effective resolver settings/model map.
- Remove `create_memory` from `LearnMutation` if feasible in one slice.
- If removing the union member is too invasive, keep the type temporarily but
  make `resolveLearnMutation()` or `GenomeMutationService` reject it as
  unsupported and add a follow-up cleanup note. Do not keep a write path.
- Use a consistent confirmation `mutation_type`, preferably `learn_signal` or
  `memory_extraction`, for signal extraction success/failure.

Refactor checks:

- Do not introduce a second incorporation implementation for bus.
- Keep queue serialization and stop/drain behavior unchanged.

Verification:

- `bun test test/bus/genome-service.test.ts`
- `bun test test/bus/learn-contract.test.ts`
- `bun test test/bus/learn-forwarder.test.ts`
- `bun test test/bus/agent-process.test.ts`

Commit target:

- `feat: incorporate bus-learn memories with relationships`

## Phase 8: Recall Regression And Active-Memory Semantics

Goal: prove stale superseded memories cannot leak through deterministic recall.

Primary files:

- `src/genome/recall-pipeline.ts`
- `src/genome/genome.ts`
- `src/genome/memory-lifecycle.ts`
- `test/genome/recall.test.ts`
- `test/genome/recall-pipeline.test.ts`

Red tests:

- Given an old high-lexical-match stale memory and a new corrected memory linked
  with `supersedes`, searching for stale phrasing does not return the superseded
  memory.
- The corrected memory remains eligible for recall.
- Link traversal does not reintroduce superseded memories into recall clusters.

Green implementation:

- Expect most tests to pass from earlier phases because `superseded_by` is set
  before index rebuild.
- If a regression appears, fix active-memory filtering at the recall candidate
  boundary. Do not add score penalties as a substitute for inactive filtering.

Refactor checks:

- Keep MIRA-style supersedes score penalty only as secondary ranking metadata if
  already present; it must not be required for correctness.

Verification:

- `bun test test/genome/recall.test.ts`
- `bun test test/genome/recall-pipeline.test.ts`

Commit target:

- `test: cover superseded memory recall exclusion`

## Phase 9: Final Verification And Cleanup

Goal: prove the implementation is cohesive, typed, formatted, and not hiding
new fallbacks.

Cleanup tasks:

- Search for automated extraction call sites still using `addMemory()` or
  `addMemories()`.
- Search for `create_memory` direct mutation handling and remove or leave only
  explicit unsupported-path tests.
- Search for relationship model fallback logic.
- Search for `mergeLatestFromDisk()` inside the new incorporation mutation and
  confirm it cannot erase just-applied link metadata.
- Update docs if implementation names differ from the plan.

Commands:

- `rg -n "addMemory\\(|addMemories\\(" src/learn src/bus src/core src/host`
- `rg -n "create_memory|memory.relationship|relationshipModel|resolveMemoryModel" src test`
- `bun test test/genome/linking.test.ts`
- `bun test test/genome/memory-incorporation.test.ts`
- `bun test test/genome/relationship-classifier.test.ts`
- `bun test test/host/session-collapse.test.ts`
- `bun test test/learn/learn-process.test.ts`
- `bun test test/bus/genome-service.test.ts`
- `bun test test/genome/recall.test.ts test/genome/recall-pipeline.test.ts`
- `bun run typecheck`
- `bun run check`
- `bun test`

Commit target:

- `chore: verify memory relationship incorporation`

## Rollback And Failure Policy

- If a red test exposes broader architectural drift, update the spec before
  implementing around it.
- If relationship classification fails at runtime, leave no partial segment or
  memory write.
- If candidate discovery produces too many heuristic candidates, lower the
  incorporation cap rather than moving classification to a background queue.
- If direct `create_memory` removal breaks a real production caller, change that
  caller to emit a learn signal. Do not restore raw memory writes.
- If live model behavior is needed, add a targeted VCR/live test only after unit
  tests cover the deterministic behavior.

## Definition Of Done

- All automated extraction-created memories in collapse, learn-process, and bus
  learn-signal paths use relationship-aware incorporation.
- A source-evidence correction naming stale memory ids supersedes those memories
  atomically when the classifier returns `supersedes`.
- Missing extraction or relationship model configuration produces visible errors
  and no fallback writes.
- Direct automated `create_memory` mutation no longer writes memories.
- Manual archivist memory writes remain authorization-gated and unchanged.
- Superseded memories are excluded from recall after incorporation.
- Targeted tests, `bun run typecheck`, `bun run check`, and `bun test` pass.


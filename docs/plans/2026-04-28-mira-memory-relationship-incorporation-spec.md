# MIRA Memory Relationship Incorporation Spec

Date: 2026-04-28

Status: draft

Linear: PRI-1424

Related docs:

- `docs/reference/mira-memory-architecture.md`
- `docs/plans/2026-04-25-mira-memory-port-design.md`
- `docs/plans/2026-04-25-mira-memory-port-execution-plan.md`
- `docs/plans/2026-04-26-mira-memory-model-config-spec.md`

## Problem

Sprout has the pieces of MIRA's link graph, but the automated memory write paths
do not yet make relationship resolution part of memory incorporation.

Session collapse and learn-signal extraction can create a corrected memory while
older contradictory memories remain active. The concrete failure from session
`01KQBFDBDANYWV37EX8SM3T6FR` was a corrected streamlinear Authorization fact
coexisting with stale memories that claimed the code used `Authorization: token`.
Manual `memory_link` supersession fixed that data, but the system should not
require a human or archivist to notice and repair every corrected fact after
extraction.

This is a MIRA write-pipeline gap, not an archivist permission gap. Archivist is
for explicit investigation and curation. Automated extraction-created memories
need to be incorporated into the graph before they become active recall facts.

## Core Invariant

For every automated extraction batch that publishes active memories:

```text
new active memories are not committed until relationship resolution has run
against the active memory graph for the newly created memories.
```

Consequences:

- If a new memory `supersedes` an existing active memory, the target memory is
  deactivated in the same commit that creates the new memory.
- If a new memory `conflicts` with an existing memory, both remain active and the
  conflict link is recorded.
- If the classifier returns `null`, no link is recorded and both memories remain
  active.
- If candidate discovery finds relationship candidates and classification cannot
  complete, the extraction batch is not committed.
- If no candidates exist, the batch commits without calling the relationship
  model.

The invariant applies to automated extraction writes only:

- session collapse extraction;
- `LearnProcess` event-window extraction;
- `GenomeMutationService` bus learn-signal extraction.

Manual curation remains explicit. `memory_link`, `memory_archive`,
`memory_annotate`, and `memory_consolidate` keep their authorization policy.
Low-level `Genome.addMemory()` may remain for tests and explicit manual creation,
but it must not be used by production automated extraction paths.

## Goals

- Make MIRA relationship resolution part of the memory write path for newly
  extracted memories.
- Keep the design small: no daemon, no background queue, no observer involvement,
  no archivist delegation loop.
- Use the existing `memory.relationship` model configuration. No inherited model
  and no fallback model.
- Persist new memories, segment records, relationship links, and supersession
  metadata atomically.
- Restrict link discovery to pairs involving newly staged memories, while also
  honoring explicit memory ids referenced by the extracted memory text.
- Preserve the deterministic recall fast path by making superseded memories
  inactive before the index is rebuilt.
- Add focused red/green tests that prove stale corrected memories no longer
  survive as active recall candidates.

## Non-Goals

- Do not rescan or relabel the full historical memory graph on every write.
- Do not add a generic memory event bus, worker, or post-processing daemon.
- Do not auto-archive memories on `conflicts`.
- Do not synthesize replacement memories. Consolidation is separate reviewed
  maintenance work.
- Do not change manual archivist authorization policy.
- Do not add UI for this spec. Existing visible collapse/learn failure surfaces
  are enough for this fix.
- Do not add compatibility behavior for legacy memory users.

## Current State

Implemented pieces:

- `src/genome/linking.ts` can discover candidates across vector, entity, and
  TF-IDF axes.
- `src/genome/relationship-classifier.ts` can classify candidate pairs with the
  configured `memory.relationship` model.
- `persistMemoryLinks()` creates reciprocal links and sets `superseded_by` for
  `supersedes`.
- `isActiveMemoryForRecall()` excludes archived and superseded memories.
- Recall filters inactive memories before ranking.
- Memory model config already supports exact `relationship` provider/model
  selection with no implicit fallback.

Missing piece:

- New memories are committed before relationship discovery/classification runs,
  and in the main extraction paths it never runs at all.

Current write paths:

- `collapseSessionToMemory()` extracts drafts, dedupes them, builds memory
  records, and calls `genome.addSegmentWithMemories(segment, memories)`.
- `LearnProcess.extractAndApplyLearnMemories()` extracts drafts and calls
  `genome.addMemories(memories, ...)`.
- `GenomeMutationService.applySignalRequest()` does the same for bus learn
  signals.
- Old direct `create_memory` mutation handling still calls `genome.addMemory()`;
  this should not be treated as an automated extraction path.

## Design

### 1. Add One Narrow Incorporation Path

Use two small pieces with a hard boundary:

1. `Genome.addExtractedMemoriesWithRelationships()` owns the filesystem lock,
   JSONL staging, rollback, index rebuild, and git commit. It is LLM-agnostic.
2. `incorporateExtractedMemories()` is the production wrapper that loads prompts,
   resolves configured relationship models, and passes a classifier callback to
   the Genome method.

This keeps persistence authority inside `Genome` without pushing LLM client,
settings, or prompt-resolution concerns into `Genome`.

Production callers use only the wrapper:

```ts
incorporateExtractedMemories({
	genome,
	segment,
	memories,
	relationship,
	commitMessage,
	now,
});
```

The Genome method should be shaped around a classifier callback:

```ts
interface AddExtractedMemoriesWithRelationshipsInput {
	segment?: MemorySegment;
	memories: Memory[];
	explicitReferenceIds?: readonly string[];
	commitMessage: string;
	source: "session-collapse" | "learn-process" | "bus-learn-signal";
	discovery?: LinkDiscoveryOptions;
	now?: number;
	classifyRelationships: (input: {
		candidates: LinkCandidate[];
		memoriesById: ReadonlyMap<string, Memory>;
	}) => Promise<RelationshipClassificationResult[]>;
}
```

The production wrapper adds the LLM/settings pieces:

```ts
interface ExtractedMemoryIncorporationInput {
	genome: Genome;
	memories: Memory[];
	segment?: MemorySegment;
	explicitReferenceIds?: readonly string[];
	commitMessage: string;
	source: "session-collapse" | "learn-process" | "bus-learn-signal";
	relationship: {
		client: Client;
		resolverSettings: ResolverSettings;
		modelsByProvider: Map<string, ProviderModel[]>;
		prompt: string;
		maxTokens?: number;
	};
	discovery?: LinkDiscoveryOptions;
	now?: number;
}
```

Return shape:

```ts
interface ExtractedMemoryIncorporationResult {
	persistedMemories: Memory[];
	candidates: LinkCandidate[];
	relationships: RelationshipClassificationResult[];
	linksAdded: number;
}
```

This should be a memory incorporation primitive, not a broad "memory service".
The existing extraction functions still build drafts and memory records. The new
primitive owns only the final incorporation step: embed, dedupe against fresh
state, discover candidates, classify, apply links, save, index, commit.

### 2. Persist Under One Verified Memory Mutation

The clean implementation is one filesystem-locked mutation:

1. Attach local embeddings and project activity snapshots to proposed memories.
2. Attach the local embedding to the segment, if present.
3. Acquire the existing memory write lock.
4. Load fresh `segments.jsonl` and `memories.jsonl`.
5. Deduplicate proposed memories against the fresh loaded store.
6. If a segment is present, validate that the segment id is not already present.
7. Stage the deduped proposed memories in memory, but do not save.
8. Build candidates from the staged in-memory store and the deduped proposed ids.
9. If candidates exist, resolve the exact `memory.relationship` model and
   classify every candidate through the callback.
10. Apply non-null links in memory.
11. Stage the segment, if present.
12. Save JSONL, rebuild the derived SQLite index, and commit once.

Do not call `mergeLatestFromDisk()` after relationship links have been applied
unless the implementation proves it preserves the just-applied link metadata.
If a merge is needed, it belongs before staging/candidate discovery. The locked
fresh load should normally make a later merge unnecessary.

Holding the write lock across classification is acceptable for v1. Memory writes
are already serialized, relationship candidate count is bounded, and correctness
matters more than optimizing lock duration. An optimistic two-phase design would
need stale-snapshot detection and retry policy; that is more machinery than this
bug requires.

If classification fails, the lock exits through the existing rollback path and
no segment, memory, link, or index mutation remains.

### 3. Restrict Candidate Discovery To New Memories, But Include Explicit Refs

Add a discovery helper next to `discoverLinkCandidates()`:

```ts
export type LinkCandidateAxis = "vector" | "entity" | "tfidf" | "explicit";

interface NewMemoryLinkDiscoveryInput {
	memories: readonly Memory[];
	newMemoryIds: ReadonlySet<string>;
	explicitReferencesByNewMemoryId?: ReadonlyMap<string, readonly string[]>;
	options?: LinkDiscoveryOptions;
}

export function discoverLinkCandidatesForNewMemories(
	input: NewMemoryLinkDiscoveryInput,
): LinkCandidate[];
```

Rules:

- Consider active memories only.
- Consider only pairs where at least one side is in `newMemoryIds`.
- Include new-vs-existing and new-vs-new pairs.
- Exclude existing-vs-existing pairs.
- Exclude new ids that were dropped by deduplication.
- Add explicit candidates for full memory ids or `mem_XXXXXXXX` short ids
  mentioned by the new memory text.
- Add explicit candidates for full memory ids or `mem_XXXXXXXX` short ids parsed
  from the source evidence that produced the extraction batch. This batch-level
  set is passed as `explicitReferenceIds` and is applied to every deduped new
  memory in the batch.
- The discovery helper parses references from `memory.content` itself. The
  optional `explicitReferencesByNewMemoryId` map is only for call sites that
  already have structured references; it supplements text parsing.
- Explicit candidates are always included before capped heuristic candidates.
- Reuse the current vector, entity, and TF-IDF scoring behavior for heuristic
  candidates.
- For new-vs-existing pairs, the new memory is always `source_id`; do not use
  generic timestamp ordering for that case.
- For new-vs-new pairs, use the current temporal/id ordering.
- Apply `limit` to heuristic candidates after explicit candidates have been
  added.

Default incorporation candidate cap:

- Use a small default cap for heuristic candidates, initially 12.
- Full graph maintenance may continue to use the broader `discoverLinkCandidates`
  default.

This preserves MIRA's three-axis candidate discovery without turning every
memory write into a full graph maintenance job. It also closes the concrete
"manual correction names stale memory ids" gap: if the source evidence mentions
`mem_102588fb`, that memory must become a candidate even if the extractor omits
the id from the new memory text and similarity scoring would miss it.

### 4. Split Link Application From Link Persistence

`persistMemoryLinks()` currently mutates memory records and saves immediately.
Incorporation needs the same mutation logic without an intermediate commit.

Extract the in-memory mutation part:

```ts
export interface ApplyMemoryLinksResult {
	added: number;
	changed: boolean;
}

export function applyMemoryLinks(
	memories: Memory[],
	relationships: readonly ClassifiedMemoryRelationship[],
	options: { now?: number } = {},
): ApplyMemoryLinksResult;
```

`persistMemoryLinks()` becomes:

```text
load memories -> applyMemoryLinks -> saveMemoryMutation
```

The incorporation primitive uses `applyMemoryLinks()` before saving the combined
segment/memory/link mutation.

`supersedes` handling stays exactly where it belongs: in link application. If
relationship type is `supersedes`, set the target memory's `superseded_by` to the
source id in the same in-memory mutation.

### 5. Relationship Model Resolution

Relationship classification must use the configured `memory.relationship` model.

No candidates:

- Do not resolve the relationship model.
- Do not call the LLM.
- Commit the extraction batch normally.

Candidates found:

- Resolve `memory.relationship` through `resolveMemoryModel("relationship", ...)`.
- If the model is missing, unknown, disabled, or unavailable, fail the
  incorporation before saving.
- Send classifier requests with `metadata.purpose = "memory.relationship"`.
- Use temperature `0` and the existing relationship prompt.

This preserves the no-fallback rule without making unrelated no-candidate memory
writes depend on a relationship model.

### 6. Source And Target Semantics

Relationship classifier prompts describe `NEW MEMORY` and `EXISTING MEMORY`.
Candidate ordering should preserve that whenever possible:

- For new-vs-existing pairs, the new memory is the source.
- For new-vs-new pairs, use the current temporal/id ordering.
- `supersedes` may deactivate only the target memory.
- The classifier output does not contain ids. Bind the normalized relationship
  result to the candidate context that was classified.

The classifier should normally return `conflicts` rather than `supersedes` when
two facts contradict without explicit temporal replacement language. That means
two memories can remain active but visibly linked as contradictory. The system
should not guess that one is obsolete unless the extracted text supports
replacement.

### 7. Write Path Wiring

Session collapse:

- Keep summary and extraction behavior unchanged through draft filtering.
- Replace `genome.addSegmentWithMemories(segment, memories)` with incorporation.
- Parse memory ids from the bounded extraction messages and pass them as
  `explicitReferenceIds`.
- Load relationship prompts through a small `Genome` wrapper around
  `loadRelationshipClassificationPrompt()` or by passing the prompt in from the
  existing prompt loader.
- Pass resolver settings/model catalog or an exact lazy resolver so relationship
  model resolution happens only when candidates exist.
- If relationship classification fails, surface the existing memory-collapse
  failure path and do not persist the segment.

LearnProcess:

- Replace extracted-memory `genome.addMemories(...)` calls with incorporation.
- Use source `learn-process`.
- Parse memory ids from the learn evidence messages and pass them as
  `explicitReferenceIds`.
- On failure, emit `learn_end` with `result: "error"` as today.
- Non-memory learn mutations are unchanged.

GenomeMutationService:

- Replace bus signal extraction `genome.addMemories(...)` with incorporation.
- Use source `bus-learn-signal`.
- Parse memory ids from the bus learn evidence messages and pass them as
  `explicitReferenceIds`.
- On failure, publish a failed mutation confirmation with the exact error.

Direct mutation `create_memory`:

- Remove direct `create_memory` support from learn/bus mutation handling in this
  work. There are no legacy users, and current reasoning prompts already tell
  the learn reasoner not to create memories directly.
- If tests reveal an active caller, change that caller to emit a learn signal or
  use explicit manual memory tooling. Do not keep a hidden raw memory-write
  bypass.

### 8. Error Policy

Fail loudly and leave no partial memory write when:

- relationship model config is missing and candidates exist;
- extraction model config is missing on a path that is trying to extract
  memories;
- the classifier returns invalid JSON;
- the classifier returns an invalid relationship type;
- a non-null relationship points at a memory missing from the locked fresh store;
- embedding generation fails;
- JSONL save, index rebuild, or git commit fails.

Do not:

- save unlinked memories after classifier failure;
- retry with another model;
- downgrade `supersedes` to `conflicts`;
- swallow parse errors;
- commit the segment while dropping extracted memories because relationship
  classification failed.

Classifier parsing may continue to strip a single surrounding Markdown code
fence if that is already part of Sprout's strict parser behavior, but parser
repair must not change the semantic error policy: invalid classifier output
fails the batch.

## Test Plan

Use red/green/refactor. Each group should be written red first, then fixed with
the smallest implementation slice that makes it pass.

### Red 1: Restricted Candidate Discovery

File: `test/genome/linking.test.ts`

Add tests for `discoverLinkCandidatesForNewMemories()`:

- It returns new-vs-existing candidates across vector/entity/TF-IDF axes.
- It returns new-vs-new candidates.
- It never returns existing-vs-existing candidates.
- It excludes inactive existing memories, including `archived_at`,
  `superseded_by`, and inbound `supersedes`.
- It excludes proposed memory ids that were not in the deduped `newMemoryIds`
  set.
- It includes explicit full-id and `mem_XXXXXXXX` short-id references even when
  vector/entity/TF-IDF thresholds would not produce a candidate.
- It includes batch-level explicit references parsed from source evidence even
  when the new memory text does not contain the referenced id.
- It keeps the new memory as `source_id` for new-vs-existing pairs, including
  same-timestamp cases.
- It applies the heuristic cap without dropping explicit references.

Green implementation:

- Factor the existing pair loop enough to support the restricted helper without
  duplicating vector/entity/TF-IDF scoring.

### Red 2: Link Application Without Commit

File: `test/genome/linking.test.ts`

Add tests for `applyMemoryLinks()`:

- `refines` creates reciprocal link metadata and reports `added: 1`.
- `supersedes` creates reciprocal link metadata and sets target
  `superseded_by`.
- `null` makes no changes.
- Existing outbound links are repaired by adding missing inbound metadata and
  `superseded_by` without counting a duplicate added link.
- Applying links after new memories are staged mutates both new-memory outbound
  links and old-memory inbound/supersession metadata in the same in-memory store.

Green implementation:

- Extract the mutation logic from `persistMemoryLinks()`.
- Keep `persistMemoryLinks()` behavior unchanged by calling the new helper and
  then `saveMemoryMutation()`.

### Red 3: Atomic Incorporation

File: `test/genome/memory-incorporation.test.ts`

Add a new focused test file with a fake local embedding provider and fake
relationship client.

Required tests:

- Given an active stale memory and a new corrected extracted memory, when the
  classifier returns `supersedes`, incorporation commits the new memory, records
  reciprocal links, sets `old.superseded_by`, rebuilds the index, and returns
  both the candidate and relationship.
- When the classifier returns `conflicts`, both memories remain active and the
  conflict link is persisted.
- When no candidates are found, incorporation commits without calling the
  relationship model.
- When candidates exist and the relationship model is not configured,
  incorporation rejects and no new memory or segment is persisted.
- When the classifier returns invalid JSON, incorporation rejects and no new
  memory or segment is persisted.
- When deduplication drops a proposed memory, no candidate is classified for the
  dropped id.
- The streamlinear Authorization regression is represented directly: a new
  corrected memory extracted from source evidence that mentions stale `mem_...`
  ids produces explicit candidates and supersedes the stale memories, even if the
  extracted memory text omits those ids.
- Candidate discovery is capped for heuristic candidates, while explicit
  references still survive the cap.

Green implementation:

- Add the `Genome.addExtractedMemoriesWithRelationships()` method plus the
  `incorporateExtractedMemories()` wrapper.
- Keep the mutation single-commit and use the existing restore-on-failure
  patterns from `Genome.addSegmentWithMemories()`.

### Red 4: Session Collapse Integration

File: `test/host/session-collapse.test.ts`

Add tests proving collapse uses incorporation:

- Collapse with a stale existing memory and corrected extracted memory calls the
  relationship classifier with `metadata.purpose = "memory.relationship"` and
  persists a `supersedes` link.
- Collapse classifier failure leaves neither the segment nor the extracted
  memory on disk.
- Collapse with no extracted memories still persists the segment and does not
  require the relationship model.

Green implementation:

- Thread relationship model resolver/catalog and relationship prompt loading
  into `collapseSessionToMemory()`.
- Preserve existing summary/extraction behavior.

### Red 5: Learn And Bus Integration

Files:

- `test/learn/learn-process.test.ts`
- `test/bus/genome-service.test.ts` or the existing closest bus service test

Add tests proving:

- Learn-process extraction uses incorporation and supersedes stale active
  memories when the classifier returns `supersedes`.
- Bus learn-signal extraction uses incorporation and publishes a failed
  confirmation when relationship classification fails.
- Neither path writes extracted memories through raw `genome.addMemories()`.
- Missing extraction model configuration after a signal passes `shouldLearn`
  produces a visible error result, not a silent skip.

Green implementation:

- Replace extracted-memory writes in both paths with incorporation.
- Keep non-memory learn mutations unchanged.

### Red 6: Recall Regression

File: `test/genome/recall.test.ts`

Add an end-to-end recall test:

- Given an old high-lexical-match stale memory and a new corrected memory linked
  with `supersedes`, searching for the stale phrasing does not return the
  superseded memory.
- The corrected memory remains eligible for recall.

Green implementation:

- This should already pass once supersession is committed before index rebuild.
  If it does not, fix active-memory filtering in the deterministic recall path,
  not by adding score penalties or post-search filtering hacks.

## Implementation Order

1. Add restricted candidate discovery tests and helper.
2. Extract `applyMemoryLinks()` and keep existing link persistence tests green.
3. Add incorporation tests and implement the atomic write primitive.
4. Wire session collapse.
5. Wire learn-process extraction.
6. Wire bus learn-signal extraction.
7. Remove direct automated `create_memory` mutation support.
8. Run targeted tests after each slice.
9. Run `bun run check`, `bun run typecheck`, and relevant memory/learn/bus test
   suites before review.

## Acceptance Criteria

- `collapseSessionToMemory()` cannot commit extracted memories with unresolved
  relationship candidates.
- `LearnProcess` and `GenomeMutationService` use the same relationship-aware
  incorporation path.
- A corrected extracted memory can supersede an older active memory in the same
  commit that creates it.
- Classifier failures produce visible failures and no partial memory writes.
- Existing manual archivist tools still work and remain authorization-gated.
- No fallback model or fallback write path exists for relationship resolution.
- No learn or bus path silently skips memory extraction because a required model
  is missing.
- Explicit memory ids mentioned by newly extracted memories are relationship
  candidates even when similarity heuristics miss them.
- Explicit memory ids mentioned by source evidence are relationship candidates
  even when the extractor omits them from the new memory text.
- Tests cover supersedes, conflicts, null/no-candidate, missing model, invalid
  classifier output, deduped proposed memories, explicit memory-id candidates,
  source/target direction, and recall exclusion.

## Adversarial Review Notes

Why not archivist?

Archivist is intentionally explicit and permission-gated. It should not be
secretly invoked after every memory extraction, and it should not become the
only way a corrected fact can deactivate an obsolete one.

Why not a background queue?

MIRA uses post-processing batches because it has a server-side batch pipeline.
Sprout's memory store is a local git-backed JSONL source of truth with a
derived SQLite index. A background queue would add recovery, idempotency, and
operator visibility requirements. Inline incorporation is smaller and guarantees
the recall graph is coherent immediately after the write.

Why not classify the whole graph?

The bug is about newly extracted facts entering the graph unlinked. Existing
graph cleanup belongs to maintenance/consolidation. New-vs-active discovery
solves the write-path invariant without turning every collapse into global
maintenance.

Why not commit memories and classify later?

That reproduces the failure mode. A stale memory can be recalled between the
memory commit and the later classifier run. If the classifier never runs or
fails silently, the graph remains wrong.

Why hold the write lock during LLM calls?

It is the simplest correct v1. The alternative is a two-phase optimistic commit
protocol with generation checks and retry semantics. That is not justified until
we have evidence relationship classification lock time is a real bottleneck.

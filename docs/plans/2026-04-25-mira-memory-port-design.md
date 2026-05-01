# MIRA Memory Port for Sprout — Design

**Status**: Design
**Date**: 2026-04-25
**Scope**: Replace Sprout's `MemoryStore` and `recall()` with a port of MIRA's memory architecture, while preserving Sprout-specific primitives (RoutingRules, learn pipeline, multi-agent recall, git-backed genome).

---

## 1. Goals

- Make Sprout's recall qualitatively better. The current keyword-token search is the weakest link in the system; semantically related memories don't surface, near-duplicates accumulate, and there's no notion of one memory pulling related ones into context.
- Preserve everything Sprout already does well: routing rules, the learn pipeline's event-driven creation triggers, the git-backed audit trail, multi-agent visibility, fast deterministic recall as a per-session cache.
- Make memories first-class citizens of the genome — same audit, same diff-ability, same rollback story.
- Land per-provider cache discipline (Anthropic markers, OpenAI prompt_cache_key) so the new memory layer doesn't blow token budgets.

Non-goals: no model retraining, no managed-service backend, no breaking change to the agent spec format, no replacement of `RoutingRule`.

---

## 2. The framing reset

The earlier read of Sprout vs MIRA assumed Sprout had no continuum identity. That was wrong. Reframed:

- **The root agent is the speaking identity.** First-person summaries work — "I refactored the auth module by delegating to engineer..." — because the root *is* the entity the user is talking to. Specialist agents are tools the root uses, not separate speakers.
- **A session is a conversation.** It has a start, accumulates turns (where each turn may include delegations), and ends naturally on goal completion or idle-timeout.
- **The continuum is the user's lifelong relationship with the root.** Multiple sessions across days/weeks are segments of one ongoing thread.

With this framing, MIRA's design lands cleanly on Sprout — but it lands as a *replacement of the search/storage engine*, not as a wholesale architectural transplant. Three Sprout primitives stay, the rest of the memory layer gets the MIRA upgrade.

---

## 3. What stays, what changes, what goes

### Stays (Sprout-specific, no MIRA equivalent)

- **`RoutingRule`** as a primitive in `kernel/types.ts` and `genome.ts`. Routing hints aren't memories — they're decision metadata for the orchestrator. The recall result keeps `routing_hints`.
- **The learn pipeline** in `src/learn/`. Event-based triggers (stumbles ≥3, repeated errors ≥2, retries, timeouts) stay. They feed the extraction pipeline (see §5) instead of writing raw memories directly.
- **Multi-agent visibility**. Recall surfaces memories once at session level; every delegated agent receives the same surfaced block in its system prompt. The orchestrator owns this fan-out.
- **Git-backed audit**. JSONL stays as source-of-truth; SQLite is a derived index. Every mutation commits.
- **Deterministic recall fast-path**. Sub-millisecond `recall()` is preserved as a per-session cache. The expensive surfacing pipeline runs once per session start (or on explicit goal change), not per delegation.
- **Read-only genome wrapping**. `read-only-genome.ts` still wraps everything for subagent isolation.

### Changes (MIRA replaces or substantially extends)

- `MemoryStore` → SQLite-indexed memory store with embeddings, FTS5, link graph, per-project decay scoring.
- `recall()` → three-axis surfacing pipeline (vector + entity hub + TF-IDF), reranked by link weight × inherited importance, optionally preceded by subcortical pre-pass.
- `Memory` type → extended with embedding pointer, link arrays, entity links, annotations, project tags, source segment.
- Memory creation → segment-collapse extraction (time-based) AND learn-event extraction (event-based), both via the MIRA extraction prompt.
- Decay → per-project activity-day clock, multi-component scoring formula.
- Cache control → markers 3 and 4 in the Anthropic adapter; `prompt_cache_key` in the OpenAI adapter.

### Additions (new primitives that didn't exist before)

- **`memory-tools`** — a deterministic toolset (`memory.search`, `memory.get`, `memory.trace_links`, `memory.entity_query`, `memory.find_by_segment`) exposed to most agents. Fast, no LLM call. See §7.
- **`archivist`** — a new top-level specialist agent that wraps memory-tools with LLM-driven reasoning. Used by qm-family agents and a few specialists for memory investigation, synthesis, and explicit mutation. See §7.

### Goes (no longer needed)

- The keyword token-counting search in `memory-store.ts:search()`. Replaced by hybrid search.
- The simple `confidence × 0.5^(days/30)` decay. Replaced by the multi-component formula.
- `pruneByConfidence`. Subsumed by archival logic in the new scoring formula (memories with effective importance below threshold get archived, not deleted).
- The previous `Memory.confidence` field as a primary scoring input. Kept on the schema for API/test compatibility but no longer drives surfacing.

---

## 4. Storage architecture

### 4.1 Source of truth

JSONL files in `genome/memories/` remain authoritative. Every mutation is an append; periodic compaction rewrites and commits. This preserves the git audit trail.

```
genome/
├── memories/
│   ├── memories.jsonl        # core memory records (extended schema)
│   ├── links.jsonl           # bidirectional link records (rebuilt from memories on read, or normalized)
│   ├── entities.jsonl        # entity nodes
│   ├── segments.jsonl        # collapsed session summaries
│   └── annotations.jsonl     # contextual annotations on memories
├── routing-rules/            # unchanged
└── agents/                   # unchanged
```

### 4.2 Derived index

A SQLite database in `genome/.cache/index.db` (gitignored) is a rebuildable index over the JSONL. On cold start, if the DB doesn't exist or is stale, rebuild from JSONL. Mutations write to JSONL first, then update the index synchronously in-process.

Rationale: SQLite gives us embedded vector storage, FTS5 for BM25,
transactional updates, and indexed scoring formula evaluation. JSONL gives us
git-friendly audit. The split is fine because the index is fully derivable.

### 4.3 Tech stack

| Concern | Choice | Reasoning |
|---|---|---|
| Embeddings | Local `MongoDB/mdbr-leaf-ir` via Transformers.js (768d) | CodeMira's right architectural call is local, fixed-model IR embeddings with query/document asymmetry and no runtime provider registry. Sprout should not copy CodeMira's Python daemon, so the Bun implementation uses the ONNX-compatible `mdbr-leaf-ir` model plus its dense projection layer. There is no alternate production embedding provider. |
| Vector search | 768d embedding BLOBs in SQLite + TypeScript cosine ranking | `sqlite-vec` was tested and rejected because this Bun SQLite build cannot load dynamic extensions. This still stays embedded, deterministic, and process-local. |
| Full-text search | SQLite FTS5 | Built into SQLite. Hybrid search via reciprocal rank fusion (RRF) is straight TS code. |
| BM25 + RRF | Hand-rolled in TS over FTS5 + vector cosine results | Same algorithm MIRA uses; compact and testable code. |
| Entity NER | LLM-only (no spaCy) | spaCy doesn't run in Node; CodeMira's precedent shows LLM-only entity extraction works fine for code-domain entities. The extraction prompt already extracts entities; no separate NER pass. |
| Importance scoring | TS implementation of MIRA's formula, evaluated as part of recall ranking | Could be SQL inside SQLite, but TS is more readable, easier to tune, and SQLite math functions are limited. Computed on-demand against a working set, cached briefly. |
| TF-IDF | `natural` npm package or hand-rolled | Lazy-rebuild on memory count change, in-memory state on the recall service. |

### 4.4 Why not Postgres

Sprout is a single-binary Bun app shipped with a self-contained genome. Adding
Postgres as a runtime dependency conflicts with that distribution model.
SQLite with local vector BLOB ranking gets us the pgvector-style retrieval shape
at zero infrastructure cost, and Sprout's per-user memory size ceiling (probably
tens of thousands of memories per active user, even after years) sits
comfortably within SQLite plus in-process ranking.

Implementation decision: keep this CodeMira-style embedded architecture for v1.
JSONL remains the authoritative audit log, SQLite remains a rebuildable derived
index, and Postgres is out of scope unless a future measured scale problem
requires revisiting it.

---

## 5. Memory creation

Two trigger paths into one extraction pipeline.

### 5.1 Segment-collapse extraction (time-based)

A session is "collapsed" when:
- The root agent emits a `goal_complete` signal (the existing terminal state), OR
- The session is idle for 60 minutes (no new user message; no in-flight delegation)

On collapse, the orchestrator:
1. Builds a transcript from the session's audit log: user messages, root agent's plan summaries, delegation outcomes (not the full subagent transcripts — too noisy).
2. Calls the segment-summary LLM with the transcript and the previous five collapsed segment summaries (for narrative continuity).
3. Stores the summary, embedding, complexity score, display title, precis as a record in `segments.jsonl`.
4. Calls the extraction LLM with the same transcript + the summary as context.
5. Parses the extracted memories (JSON array), dedupes, persists to `memories.jsonl`, indexes.
6. Optionally runs link discovery on the new memories and queues relationship classification.

This is MIRA's segment-collapse chain, adapted: the source material is "root agent's session transcript" instead of "user-assistant conversation."

### 5.2 Learn-event extraction (event-based)

The existing learn pipeline detects operational events: stumbles, retries, timeouts, repeated errors, quick successes. Currently these write `Memory` records directly with hand-crafted content.

New behavior:
1. When `should-learn` fires, instead of writing a raw memory, the learn process collects the relevant event window (the failed attempts + the eventual success or terminal state).
2. It synthesizes a small "transcript slice" — the relevant tool calls, errors, and the resolution — formatted to look like the kind of evidence the extraction prompt expects.
3. Calls the extraction LLM on that slice with a learn-event-specific user prompt prefix ("The following is a learn-pipeline observation; extract durable operational memories from it").
4. The output goes through the same parser/dedup as segment extraction.

Net effect: the learn pipeline becomes a creation *trigger*, not a creation *implementation*. All memories pass through the same extraction prompt, get embedded, get linked, get scored. Quality and dedup are unified.

### 5.3 Manual creation

The existing `addMemory` API in genome.ts stays. It bypasses extraction (already-formed memory text), generates an embedding, and inserts. Used by tests and explicit user-driven memory creation.

### 5.4 Extraction prompt

Adapted from MIRA's `memory_extraction_system.txt` and CodeMira's coding-context variant:

- **Voice rule**: third-person, present tense, no hedging ("Project uses pnpm, never npm" not "User said they use pnpm").
- **Source rule flipped**: extract from BOTH the root agent's reflections AND the user's messages. Sprout sessions are mostly the root narrating its work; user input is sparse.
- **Entity types tuned for code**: PROJECT, LIBRARY, FILE_PATH, COMMAND, ERROR_TYPE, TECHNOLOGY, PERSON. Replaces MIRA's PERSON/ORG/GPE/PRODUCT taxonomy.
- **Durability filter retained**: extract things useful in weeks, months. Skip ephemeral task completions.
- **Pre-stitching within decision boundaries**: same rule. "We chose X because Y" stays as one memory; don't fragment into atoms.
- **Five failure modes preserved**: under-extraction, enumeration collapse, dialogue evaporation, observation skipping, vague closers.
- **Output format**: same JSON array shape, same optional fields (`entities`, `expires_at`, `happens_at`, `related_memory_ids`, `linking_hints`).

The prompt lives at `prompts/memory_extraction_system.txt` in the genome (so it's audit-tracked and version-controlled). User template at `prompts/memory_extraction_user.txt`.

### 5.5 Segment summary prompt

Adapted from MIRA's `segment_summary_system.txt`:

- First-person voice ("I refactored the auth module..."). Specialist agents become tools the root used: "I delegated test-running to verifier, which discovered..."
- Absolute timestamps required.
- Display title, precis, complexity score (0.5/1/2/3).
- Anchor budget: 2-4 load-bearing keywords (function names, library versions, error codes, commit SHAs in moderation).

Lives at `prompts/segment_summary_system.txt` in the genome.

---

## 6. Recall pipeline

The three-axis MIRA pipeline, adapted.

### 6.1 Per-session, not per-delegation

Critical change: recall runs **once at session start** and on explicit goal changes (new top-level user message). The result is cached as a `surfacedBlock: string` on the session record. Every delegated agent gets that same block injected into its system prompt.

Without this caching, the surfacing cost (subcortical LLM call + embedding + DB queries + reranking) hits every delegation. With it, the cost is amortized over the entire session.

The existing deterministic `recall()` function is repurposed as the read-side accessor — it returns `{ agents, surfacedBlock, routing_hints }` from the session's cached state, in microseconds. Refresh is a separate operation.

### 6.2 Surfacing flow (on session start / goal change)

```
1. SUBCORTICAL PRE-PASS (optional, opt-in via config)
   subcortical.generate(sessionGoal, recentTurns)
   → returns { query_expansion, entities, complexity }
   Uses a cheap LLM (Haiku, gpt-4o-mini, or local).
   ~200ms typical.

2. EMBEDDING
   query_embedding = embed(query_expansion ?? sessionGoal)

3. PARALLEL POOL FETCH
   [similarity_pool, hub_pool] = await Promise.all([
     hybridSearch(query_text, query_embedding, limit=20*2)   // BM25 + cosine + RRF
     hubDiscovery(entities, query_embedding)                  // entity → memories → expand
   ])

4. MERGE + DEBUT BOOST
   merged = unique(similarity_pool ++ hub_pool)
   for each m in merged:
     score = m.importance_score
     if isDebut(m):  score += DEBUT_BOOST
     if isSuperseded(m):  score *= SUPERSEDES_PENALTY
   sort merged by score, take top 20

5. LINK TRAVERSAL
   for each primary in merged:
     primary.linked_memories = traverseLinks(primary.id, depth=3)[:2]

6. RERANK BY LINK WEIGHT
   final = rerankByLinkWeight(merged)
   take top max_surfaced_memories (default 15)

7. RENDER
   block = renderMemoriesXml(final)  // <memories>...<context>...</context></memories>

8. CACHE
   session.surfacedBlock = block
   session.lastSurfaceTime = now
```

### 6.3 Tuning constants (initial)

```ts
const MEMORY_SURFACING = {
  MAX_SURFACED: 15,           // total per session
  MAX_HUB_PER_ENTITY: 10,
  MAX_LINKED_PER_PRIMARY: 2,
  SIMILARITY_THRESHOLD: 0.42,
  TRAVERSAL_DEPTH: 3,
  MIN_IMPORTANCE: 0.1,
  DEBUT_BOOST_DAYS: 7,
  DEBUT_BOOST_AMOUNT: 0.15,
  SUPERSEDES_PENALTY: 0.3,
};
```

Lower than MIRA's defaults (MIRA uses 20 surfaced, 15 pinned). Sprout sessions need shorter prompts to leave token budget for the actual work.

### 6.4 Render format

Memories render in the agent system prompt as an XML block, replacing the current `<memories>` rendering:

```xml
<memories>
- [mem_5e9a] Project uses pnpm, never npm — affects all installs and lockfile handling
- [mem_7c2b] vitest watch mode hangs on macOS without --bail flag
  <context>refines mem_5e9a — test command should be `pnpm test --bail`</context>
- [mem_a14d] User prefers single-file solutions over multi-file abstractions when scope is small
- ...
</memories>
```

The 8-char short ID (`mem_XXXXXXXX`) is preserved for explicit reference, matching MIRA's format. When the agent mentions a memory ID in its output, the orchestrator increments `mention_count` for that memory — strongest behavioral signal in the scoring formula.

### 6.5 Multi-agent flow

```
session start (or goal change)
  → orchestrator runs surfacing pipeline
  → caches surfacedBlock on session
  → delegate to root agent
     → recall() returns { agents, surfacedBlock, routing_hints } (cached)
     → root's system prompt includes <memories>...</memories> + <routing_hints>...</routing_hints>
     → root delegates to engineer
        → recall() for engineer returns same surfacedBlock
        → engineer's system prompt also includes the same memories
     → root delegates to verifier
        → same memories appear in verifier's prompt
```

All agents in one session see the same memories. Each agent decides what to do with them based on its own role (engineer might use them to inform implementation; verifier might use them to know which test conventions apply).

---

## 7. Active memory access: archivist and memory-tools

The recall pipeline (§6) handles passive surfacing — top-N memories injected ambiently into every delegated agent's prompt at session start. That covers ~80% of memory needs cheaply and automatically. The remaining 20% are queries the surfaced block can't satisfy:

- **Targeted investigation**: "find memories about pre-commit hooks specifically" — too narrow to have surfaced from the session goal alone.
- **Synthesis**: "what's the overall picture of how the user thinks about deployment?" — requires reasoning across memories, not just retrieval.
- **Contradiction detection**: "this memory says X — are there others that conflict?"
- **Explicit mutations**: annotate, archive, or link memories on demand.
- **On-demand consolidation**: merge a known-duplicate cluster without waiting for the periodic background job.

Two new surfaces handle these.

### 7.1 memory-tools (deterministic toolset)

A toolset exposed to any agent that needs read access to the memory store without LLM-driven reasoning. Fast, cheap, no LLM call. Implementation lives in `src/genome/memory-tools.ts`.

| Tool | Signature | Returns |
|---|---|---|
| `memory.search` | `(query: string, limit?: number, min_importance?: number)` | `Memory[]` via hybrid search |
| `memory.get` | `(id: string)` | `Memory \| null` |
| `memory.trace_links` | `(id: string, depth?: number)` | `Memory[]` via BFS over outbound links |
| `memory.entity_query` | `(entity_name: string)` | `Memory[]` tagged with that entity |
| `memory.find_by_segment` | `(segment_id: string)` | `Memory[]` extracted from that segment |

Read-only. Exposed broadly via the agent spec's `tools:` field — most specialist agents (engineer, architect, debugger, verifier) get these by default. They cost nothing in LLM tokens and provide a clean escape hatch when an agent's surfaced block doesn't have what it needs.

### 7.2 archivist (LLM-driven specialist agent)

A new top-level specialist that wraps memory-tools with reasoning. Used when the question requires investigation strategy, synthesis, or write operations. Spec lives at `genome/agents/archivist/archivist.md`:

```yaml
name: archivist
description: "Memory investigation, synthesis, and curation. Use when the
  surfaced memory block isn't sufficient — for targeted queries,
  contradiction detection, on-demand consolidation, or explicit
  annotation/archival/linking."
model: balanced
tools:
  # Read (also exposed broadly via memory-tools)
  - memory.search
  - memory.get
  - memory.trace_links
  - memory.entity_query
  - memory.find_by_segment
  # Write (archivist-only)
  - memory.annotate
  - memory.archive
  - memory.link
  - memory.consolidate
  # Synthesis
  - memory.synthesize_answer
agents: []
constraints:
  max_turns: 8
  timeout_ms: 60000
  can_learn: false
tags:
  - memory
  - investigation
```

The system prompt teaches the archivist:

- **Decision tree for query strategy**: semantic search for paraphrased questions; entity query for named-thing questions; link traversal for "related-to" questions; FTS5 for exact-string questions.
- **When to refuse**: if the question is fully covered by the caller's surfaced block, return a one-line "covered by surfaced memories" rather than duplicating retrieval work.
- **Citation discipline**: every claim cites a memory ID (`mem_XXXXXXXX`).
- **Mutation requires explicit instruction**: never annotate, archive, link, or consolidate without the caller asking for it directly.
- **Write authorization boundary**: additive mutations (`memory.annotate`,
  `memory.link`, `memory.synthesize_answer`) may proceed when explicitly
  requested and are tagged with `source: 'archivist:<session_id>'`. Destructive
  or meaning-changing mutations (`memory.archive`, `memory.consolidate`,
  superseding a user-authored/manual memory) require an explicit user
  confirmation turn and are blocked by code-level policy, not just by prompt
  instruction.
- **Structured output**: `{ answer: string, supporting_memory_ids: string[], confidence: 'high' | 'moderate' | 'low' }`.

Critical detail: **the archivist does not receive a surfaced memory block in its own system prompt.** Its job is to query memory; surfacing first would pollute its context with a working set that may not match the question being asked. It receives only the caller's question and any context the caller passes explicitly.

### 7.3 Routing rule

Encoded as a `RoutingRule` in the genome and surfaced in the `<routing_hints>` block of agents that have learned the pattern:

```
condition: "agent encounters a contradiction in surfaced memories OR needs to
  query memories not in surfaced block OR needs to mutate memory state"
preference: "archivist"
strength: 0.85
```

### 7.4 Who can delegate to archivist

By default in the agent tree:

- `root` — for direct user questions like "what do you know about X?"
- `quartermaster/qm-fabricator` — when building a new specialist, to query preferences relevant to its domain
- `quartermaster/qm-planner` — when scoping a complex task
- `quartermaster/qm-reconciler` — for genome-state audits ("are there orphan links?")
- `architect` — when designing a feature, for relevant constraints
- `debugger` — for prior-occurrence lookups

Other agents (engineer, verifier, utility/*) get memory-tools but not the archivist agent. They consume passively or query deterministically; they don't need an investigative specialist.

### 7.5 When NOT to use archivist

Explicit anti-patterns to encode in the archivist's description and the system prompts of agents that can delegate to it:

- **Don't call archivist for the surfaced block.** It's already in your prompt.
- **Don't call archivist for write-on-creation.** Memory creation goes through the extraction pipeline (§5), never archivist.
- **Don't call archivist as a search-of-last-resort with vague intent.** If you don't have a specific question, the surfaced block is the answer; calling archivist with vague intent burns tokens and produces vague results.

Practical guideline: ≤5–10 archivist calls per session. Beyond that, either the session goal is too broad (split it) or the recall pipeline isn't doing its job (tune the surfacing constants in §6.3).

### 7.6 Cost

Each archivist delegation is one balanced-tier LLM call (Sonnet, gpt-4o, or similar) plus 1–3 internal tool calls. memory-tools alone are free in LLM terms — they're SQL/JSONL reads. The split keeps routine memory access cheap and reserves LLM cost for genuine investigation work.

### 7.7 Why this isn't just "give every agent the tools"

The temptation: skip the archivist agent, just give every specialist the full memory-tools toolset including writes. Why not?

- **Mutation policy gets diffuse.** Annotate/archive/link decisions made by the engineer don't have the same context as decisions made by an investigation-focused agent. Centralizing mutations through archivist gives one place to encode write discipline.
- **Synthesis is investigation, not retrieval.** "What do we know about X?" needs a strategy — search + traverse + group + summarize — that the engineer shouldn't be deciding for itself mid-task. Archivist makes that strategy a specialist concern.
- **Cost containment.** If every agent could do unbounded memory queries, an engineer mid-implementation might burn turns spelunking through memory. Archivist's `max_turns: 8` and explicit-delegation gating put a soft budget on memory investigation.
- **Audit clarity.** Memory mutations attributed to "archivist call from qm-fabricator" are easier to reason about than "scattered writes from any agent that happened to need them."

The split — read tools broadly available, archivist for reasoning and writes — is the same pattern Sprout already uses for filesystem operations: any agent can `read_file`, but write paths are gated behind specialist agents like editor.

Normal specialist agents never write durable memories directly. They can read
via memory-tools and can return memory-worthy observations in their delegation
result; the root/session-collapse extraction pipeline decides what becomes
durable memory. Archivist is the only specialist with write tools, and those
tools run through the authorization boundary above.

---

## 8. Decay model

MIRA's activity-day clock doesn't fit Sprout. Replaced with a **per-project activity counter**.

### 8.1 The mismatch

MIRA's clock advances on the user's first message of each user-local day. Decay is computed against `cumulative_activity_days`. This works because MIRA users have ongoing daily-cadence conversations.

Sprout work is bursty. A user might work intensely on Project A for a week, ignore it for a month, return. During the dormant month, MIRA's formula would erode every memory tagged with Project A. That's wrong — when the user returns, those memories are exactly what they need.

### 8.2 The fix

Replace the global activity-day counter with per-project counters. Every memory is tagged with the project entity it pertains to (PROJECT-typed entity_link). The scoring formula uses the relevant project's counter for that memory's decay.

```ts
// Per-project counter increments on first session of each project per local day
project.cumulative_active_days: number
project.last_active_date: Date

// In the scoring formula:
const days_since_creation = project.cumulative_active_days - memory.activity_days_at_creation
const days_since_access = project.cumulative_active_days - memory.activity_days_at_last_access
```

A memory tagged with no specific project (cross-project knowledge like "always prefer pnpm over npm") uses the global counter (sum of all project counters). These memories decay only when the user is fully dormant.

### 8.3 The scoring formula

Same five-component structure as MIRA, with per-project clock:

```
raw_score = value_score
          + hub_score
          + entity_hub_score
          + mention_score
          + newness_boost(per-project clock)

importance = sigmoid(
    raw_score
    × recency_multiplier(per-project days_since_access)
    × temporal_multiplier(calendar happens_at/expires_at)
    × expiration_trailoff
    - 2.0
)
```

Constants are MIRA's defaults to start, tuned later based on observed memory lifecycles.

### 8.4 Implementation

Computed in TS at recall time over the working set (typically a few hundred candidates). Cache results for ~5 minutes. Bulk daily recompute against the full memory set runs as a background job, persists scores to SQLite for the index.

Project counters live in a new `projects.jsonl` in the genome. Project detection: the entity-extraction step in the extraction prompt assigns memories to PROJECT-typed entities. The orchestrator maintains per-session "active project" state from explicit user goal language, file paths, or git remote.

---

## 9. Cache strategy

Per-provider, since Sprout supports three.

### 9.1 Anthropic

Today's adapter places markers on system prompt and last tool. Add two more.

**Marker 3 — message history high-water mark**:

In `convertMessages` in `src/llm/anthropic.ts`, after the conversion loop:

```ts
// Place cache_control on the last stable assistant message in history.
// "Stable" = not the most recent message (which will be the live user turn or
// the in-progress assistant response).
if (result.length >= 2) {
  const stableIdx = result.length - 2; // skip newest
  // Find the last block in that message; mark it
  const msg = result[stableIdx];
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    msg.content[msg.content.length - 1].cache_control = { type: 'ephemeral' };
  }
}
```

This gives a moving cache water mark inside agent loops. Each iteration of Plan → Act extends the cached prefix by one turn. For a 10-turn agent, savings compound to ~10×.

**Marker 4 (optional) — synthetic HUD assistant message**:

If we want MIRA's HUD pattern (memories rendered as a sliding assistant message between cached history and new user turn), insert a synthetic assistant message containing the `<memories>` block immediately before the new user message. Mark the message *before* the HUD with cache_control; the HUD itself is fresh, the user turn is fresh, the response is fresh.

For v1, simpler: put memories at the top of the user message. Indistinguishable cache behavior, half the implementation complexity. Defer the synthetic-HUD pattern unless the autoregressive register matters.

**1-hour TTL beta**: opt in for system prompt and last tool by passing `betas: ['extended-cache-ttl-2025-04-11']` (or whatever the current beta header is) and `ttl: '1h'` on those markers. Slow-changing content stays cached across sessions within a 1h window. Configurable per-agent in the agent spec.

### 9.2 OpenAI

Today's adapter passes nothing for cache routing. Add `prompt_cache_key`.

In `src/llm/openai.ts`, add to the request:

```ts
const params: ChatCompletionCreateParams = {
  // ... existing fields ...
  prompt_cache_key: `${ctx.sessionId}:${ctx.agentName}`,
};
```

This routes all turns of one agent within one session to the same cache shard, hitting cached prefixes consistently. The `ctx` object needs threading through from the caller — minor plumbing.

Per-user is too coarse (might hit RPM ceiling); per-session+agent is the right grain for Sprout.

### 9.3 Gemini

Today's adapter only reads `cachedContentTokenCount` from usage; doesn't create cached content.

For now: defer. Gemini caching requires a separate API surface (CachedContent creation, name-tracking, TTL management) and Gemini-tier traffic in Sprout is mostly the cheap "fast" tier where caching matters less. Phase this in only if Gemini-tier token spend becomes meaningful.

When implemented: extract the system prompt + tool definitions to a CachedContent on first use, store the cache name in session state, reference it on subsequent calls with matching agent + session context. Invalidate when the system prompt changes.

### 9.4 Cross-provider invariant

Regardless of provider: **stable content first, volatile content last**. Identity, portrait, behavioral directives, tools belong at the top of the prompt where caching helps. Memories, current time, location, current goal belong at the bottom where freshness matters. This discipline pays on all three providers (explicit markers on Anthropic, automatic detection on OpenAI, CachedContent on Gemini).

---

## 10. Data model

### 10.1 Memory

Extended schema. Existing fields preserved, new fields added.

```ts
interface Memory {
  // Existing
  id: string;                    // UUID
  content: string;               // canonical memory text
  tags: string[];                // human-curated, kept for compat
  source: string;                // provenance (e.g., "learn-pipeline", "segment-collapse")
  created: number;               // epoch ms
  last_used: number;             // epoch ms
  use_count: number;
  confidence: number;            // previous scoring signal; no longer drives surfacing

  // New
  embedding?: number[];          // 768d for local MongoDB/mdbr-leaf-ir embeddings
  importance_score: number;      // [0,1], computed by scoring formula
  access_count: number;          // surfaced via recall
  mention_count: number;         // explicit mem_XXXXXXXX references in agent output
  last_accessed?: number;
  activity_days_at_creation?: number;        // per-project, snapshot at create time
  activity_days_at_last_access?: number;
  happens_at?: number;
  expires_at?: number;
  inbound_links: MemoryLinkEntry[];
  outbound_links: MemoryLinkEntry[];
  entity_links: EntityLinkEntry[];
  annotations: AnnotationEntry[];
  source_segment_id?: string;
  is_archived: boolean;
  archived_at?: number;
  consolidation_rejection_count: number;
  project_ids: string[];         // for per-project decay scoping; empty = global
}

interface MemoryLinkEntry {
  uuid: string;                  // target memory id
  type: RelationshipType;
  reasoning: string;
  created_at: number;
  extraction_bond?: string;
}

interface EntityLinkEntry {
  uuid: string;
  type: 'PROJECT' | 'LIBRARY' | 'FILE_PATH' | 'COMMAND' | 'ERROR_TYPE' | 'TECHNOLOGY' | 'PERSON';
  name: string;
}

interface AnnotationEntry {
  text: string;
  created_at: number;
  source: string;
  archived_source_ids?: string[];
  source_segment_ids?: string[];
}

type RelationshipType =
  | 'corroborates' | 'conflicts' | 'supersedes' | 'refines'
  | 'precedes' | 'contextualizes' | 'exemplifies' | 'extraction_ref' | 'null';
```

### 10.2 Entity

```ts
interface Entity {
  id: string;
  name: string;                  // canonical normalized
  entity_type: 'PROJECT' | 'LIBRARY' | ...;
  link_count: number;
  last_linked_at: number;
  created_at: number;
}
```

### 10.3 Segment

```ts
interface Segment {
  id: string;
  session_id: string;
  started_at: number;
  ended_at: number;
  collapse_reason: 'goal_complete' | 'idle_timeout';
  synopsis: string;              // 3-4 sentence first-person trace
  precis: string;                // 2-sentence compression
  display_title: string;         // ≤8 words
  complexity: 0.5 | 1 | 2 | 3;
  embedding: number[];
  tools_used: string[];
  project_ids: string[];
  memory_ids: string[];          // memories extracted from this segment
}
```

### 10.4 Project (new)

```ts
interface Project {
  id: string;                    // UUID
  name: string;                  // e.g., "sprout", "claude-pa-bot"
  worktree_path?: string;        // if applicable, used for auto-detection
  cumulative_active_days: number;
  last_active_date: string;      // YYYY-MM-DD in user-local
  created: number;
}
```

### 10.5 RoutingRule (unchanged)

```ts
interface RoutingRule {
  id: string;
  condition: string;
  preference: string;
  strength: number;
  source: string;
}
```

### 10.6 RecallResult (extended)

```ts
interface RecallResult {
  agents: AgentSpec[];
  surfacedBlock: string;         // pre-rendered <memories>...</memories>
  memories: Memory[];            // for inspection / debugging
  routing_hints: RoutingRule[];
}
```

---

## 11. Module layout

New and changed files in `src/genome/`, `src/llm/`, and the genome-on-disk.

```
src/
├── genome/
│   ├── memory-store.ts                # rewrite: SQLite-backed, hybrid search
│   ├── memory-tools.ts                # NEW: deterministic toolset (§7.1)
│   ├── recall.ts                      # rewrite: pipeline runner with caching
│   ├── recall-pipeline.ts             # NEW: subcortical → search → hub → rerank
│   ├── extraction.ts                  # NEW: extraction prompt invocation + parsing
│   ├── linking.ts                     # NEW: 3-axis discovery + relationship classification
│   ├── hub-discovery.ts               # NEW: entity-driven retrieval
│   ├── consolidation.ts               # NEW: connected-components + LLM merge
│   ├── scoring.ts                     # NEW: TS implementation of importance formula
│   ├── projects.ts                    # NEW: project detection + activity counter
│   ├── embedder.ts                    # NEW: provider-agnostic embedding interface
│   ├── hybrid-search.ts               # NEW: BM25 + cosine + RRF
│   ├── tfidf-store.ts                 # NEW: lazy-rebuild TF-IDF
│   ├── segment-collapse.ts            # NEW: time-based collapse trigger + extraction
│   ├── jsonl-store.ts                 # NEW: append-only JSONL primitive used by all stores
│   ├── index-builder.ts               # NEW: rebuild SQLite index from JSONL
│   ├── genome.ts                      # extend: wire new stores, route mutations
│   ├── read-only-genome.ts            # extend: wrap new methods
│   └── types.ts                       # extend: new types from §10
│
├── learn/
│   ├── learn-process.ts               # change: route through extraction.ts instead of direct write
│   └── ... (rest unchanged)
│
├── llm/
│   ├── anthropic.ts                   # extend: add markers 3 and 4, 1h TTL beta opt-in
│   ├── openai.ts                      # extend: prompt_cache_key threading
│   ├── gemini.ts                      # unchanged for now
│   └── embeddings.ts                  # NEW: local-first embedding provider adapter
│
├── kernel/
│   └── types.ts                       # extend: Memory, RecallResult shapes
│
└── core/                              # session lifecycle hooks
    ├── session-collapse.ts            # NEW: orchestrator hook for goal_complete + idle
    └── ... (existing)

genome/                                 # the user's genome on disk
├── memories/
│   ├── memories.jsonl                 # source of truth
│   ├── links.jsonl
│   ├── entities.jsonl
│   ├── segments.jsonl
│   ├── projects.jsonl
│   └── annotations.jsonl
├── routing-rules/                     # unchanged (now includes archivist routing rule)
├── agents/
│   ├── archivist/                     # NEW: investigation specialist (§7.2)
│   │   └── archivist.md
│   └── ... (existing agents unchanged)
└── prompts/                           # NEW: per-genome prompt templates
    ├── memory_extraction_system.txt
    ├── memory_extraction_user.txt
    ├── segment_summary_system.txt
    ├── segment_summary_user.txt
    ├── memory_consolidation_system.txt
    ├── memory_relationship_classification.txt
    ├── archivist_system.txt           # NEW: archivist's investigation playbook
    └── subcortical_system.txt
```

The `.cache/` directory at genome root is gitignored:

```
genome/.cache/
└── index.db                            # SQLite index, rebuildable
```

---

## 12. Greenfield Write Path

There are no legacy users for this port, so there is no one-shot memory
migration. The implementation should treat extended memory records as the
production persisted shape from the start:

1. **Creation**: every production memory write generates a local document
   embedding before appending to `memories.jsonl`.
2. **Persistence**: the JSONL line stores ready embedding metadata plus the
   768-dimensional vector.
3. **Index build**: SQLite is a derived cache rebuilt from JSONL. Rebuild fails
   if a production memory is missing a ready vector.
4. **Tolerant parsing**: normalization helpers may accept minimal records for
   tests and explicit internal construction, but that is not a legacy-data
   migration path.

Rollback is via normal git history for memory mutations and code changes.

---

## 13. Phased implementation

Each phase is independently testable and merge-able. Phase boundaries are chosen so each ships value on its own.

### Phase 1 — Foundation (1.5 weeks)

Goal: Hybrid search replaces keyword search. Extended schema in place. No behavior change visible to users beyond better recall quality.

- [ ] Extended `Memory` schema in `kernel/types.ts`
- [ ] `JsonlStore` primitive: append-only writes, full-rewrite for compactions
- [ ] Embedding provider adapter (`src/llm/embeddings.ts`), local mdbr default
- [ ] SQLite index with embedding BLOBs + FTS5
- [ ] `index-builder.ts`: rebuild from JSONL on cold start; sync mutations
- [ ] `hybrid-search.ts`: BM25 + cosine + RRF
- [ ] Migration script
- [ ] Tests against the existing recall test fixtures

Quality gate: existing recall tests pass with new backend; hybrid search demonstrably surfaces semantically-related memories the keyword search misses.

### Phase 2 — Extraction (1.5 weeks)

Goal: New memories created via the extraction prompt instead of hand-crafted.

- [ ] Extraction prompt + user template in `genome/prompts/`
- [ ] `extraction.ts`: run prompt, parse JSON with json_repair fallback, dedupe (fuzzy + vector), persist
- [ ] Rewire learn pipeline (`learn-process.ts`) to call extraction instead of direct write
- [ ] Manual creation API kept (already exists) but routes through embedding generation
- [ ] Tests: known stumbles produce well-formed memories

Quality gate: a learn-pipeline event produces an extracted memory whose text is at least as good as the current hand-written form, with embedding + entities populated.

### Phase 3 — Segment collapse (1 week)

Goal: Sessions produce summaries on collapse; memories extracted from session transcripts.

- [ ] Session collapse trigger in `core/session-collapse.ts`: hook on `goal_complete` + idle-timeout watch
- [ ] Segment summary prompt in `genome/prompts/`
- [ ] `segment-collapse.ts`: build transcript from audit log, call summary LLM, persist segment, call extraction LLM
- [ ] Project detection from session metadata + first user turn
- [ ] Tests: completed session produces a summary record + associated extracted memories

Quality gate: replaying a session through the collapse pipeline produces a non-empty summary and extracts at least one memory per major decision in the session.

### Phase 4 — Surfacing pipeline (1 week)

Goal: Recall uses the new pipeline; multi-agent visibility works.

- [ ] `recall-pipeline.ts`: vector + hub merge, debut boost, supersedes penalty
- [ ] `hub-discovery.ts`: entity-driven retrieval (LLM-extracted entities, no spaCy)
- [ ] Per-session caching in orchestrator: surface once at session start / goal change, reuse in delegations
- [ ] Render block in MIRA format with `[mem_XXXX]` short IDs
- [ ] Mention-count tracking: regex over agent output increments mention_count
- [ ] Tests: recall returns linked memories alongside primaries; same surfacedBlock visible in all agents in one session

Quality gate: a session with 5 delegations shows the same memory block in each agent's prompt; recall pipeline runs once.

### Phase 5 — Memory-tools and archivist (1 week)

Goal: Active memory access — agents can investigate beyond the surfaced block, and qm-family agents have an investigation specialist to delegate to.

- [ ] `memory-tools.ts`: deterministic toolset implementing `memory.search`, `memory.get`, `memory.trace_links`, `memory.entity_query`, `memory.find_by_segment`
- [ ] Wire read-only memory-tools into the toolset registry; expose to specialist agents
  (engineer, architect, debugger, verifier) via their agent specs
- [ ] Archivist write tools: `memory.annotate`, `memory.archive`, `memory.link`, `memory.consolidate` (one-shot consolidation of an explicit cluster), `memory.synthesize_answer`
- [ ] Archivist write policy: additive writes require explicit caller instruction;
  destructive/user-authored-memory writes require explicit user confirmation and
  code-level enforcement
- [ ] Archivist agent spec at `genome/agents/archivist/archivist.md`
- [ ] Archivist system prompt at `genome/prompts/archivist_system.txt` — query strategy decision tree, citation discipline, mutation policy
- [ ] Routing rule for archivist delegation; allow listing archivist as a delegation target on root, qm-fabricator, qm-planner, qm-reconciler, architect, debugger
- [ ] Tests: a known synthesis question routed through archivist returns a structured
  answer with cited memory IDs; an authorized write persists and shows up in
  subsequent reads; unauthorized destructive writes are blocked; archivist refuses
  cleanly when the question is fully covered by passive surfacing

Quality gate: a representative qm-fabricator session that needs to query memory completes the query via archivist with measurably fewer tokens than if the fabricator did the same investigation inline (because archivist's `max_turns: 8` and tool focus are more efficient than fabricator's broader context).

### Phase 6 — Link graph (1.5 weeks)

Goal: Memories form a graph, not a flat list.

- [ ] `linking.ts`: three-axis candidate discovery (vector + entity co-occurrence + TF-IDF)
- [ ] Relationship classification via cheap-tier LLM (Haiku or gpt-4o-mini)
- [ ] Bidirectional link creation in JSONL + index
- [ ] Link traversal with heal-on-read (drop dead refs)
- [ ] Reranking: type weight × inherited importance
- [ ] Tests: classified relationships persist round-trip; traversal returns related cluster

Quality gate: the relationship classifier achieves ≥80% agreement with hand-labeled pairs on a 50-pair eval set.

### Phase 7 — Decay (3-5 days)

Goal: Memories earn their keep; per-project clock prevents dormant-project erosion.

- [ ] `projects.ts`: project detection + activity counter increment
- [ ] `scoring.ts`: TS implementation of importance formula
- [ ] Daily background recompute over working set
- [ ] Access tracking on recall hit
- [ ] Mention count via regex on agent output
- [ ] Tests: scoring formula matches spec; project counter doesn't tick during dormancy

Quality gate: simulated 90-day timeline shows expected decay curves for project, library, and ephemeral memories.

### Phase 8 — Cache strategy (3-5 days)

Goal: Token spend on long agent loops drops measurably.

- [ ] Anthropic adapter: add markers 3 and 4, optional 1h TTL beta opt-in per agent
- [ ] OpenAI adapter: thread session+agent context, pass `prompt_cache_key`
- [ ] Telemetry: log cache_read_tokens / cache_creation_tokens per call
- [ ] Tests: marker placement verified; key threading verified

Quality gate: a 10-turn engineer agent shows >50% cache_read_input_tokens / total_input_tokens after the first turn on Anthropic; OpenAI shows similar improvement.

### Phase 9 — Consolidation + entity GC (1 week)

Goal: Store self-cleans. Duplicates merge. Entity sprawl contained.

- [ ] Consolidation cluster discovery (connected-components)
- [ ] Consolidation merge prompt + handler
- [ ] Entity GC: similar-entity grouping (FTS5-based, no pg_trgm) + LLM review
- [ ] Use-day scheduling (per-project): once per N project-active-days
- [ ] Archive (don't hard-delete)
- [ ] Tests: known duplicate clusters merge; rejected merges increment rejection count

Quality gate: a synthetic store with 20% duplicates collapses to <5% after one consolidation pass.

### Phase 10 (optional) — Subcortical pre-pass (3-5 days)

Goal: Recall quality jumps another 10-20% via query expansion.

- [ ] Subcortical prompt in `genome/prompts/`
- [ ] Cheap-LLM call before search; ~200ms budget
- [ ] Entity output feeds hub discovery directly
- [ ] Pinned-memory retention across session goal changes (`additionalContext` flow)
- [ ] Tests: known queries that miss without expansion now hit

Quality gate: side-by-side eval shows pre-pass surfaces strictly more relevant memories on a 30-query test set.

**Total**: 8-10 weeks of focused work for full parity with MIRA's memory architecture, adapted for Sprout. Phase 1+2 alone (~3 weeks) is a dramatic improvement over the current keyword-search system and is independently shippable. Phase 4+5 together (~2 weeks on top of Phase 1-3) deliver the full passive+active memory access story.

---

## 14. Open questions

These need answers before or during implementation. Items marked **Decision**
are resolved and should not halt implementation unless the existing code makes
the stated decision impossible.

1. **What counts as "session start" for surfacing?** First user message of a fresh session = obvious. But what about resumed sessions across restarts? Re-surface? Trust the cached block? Suggested: re-surface if cached block is older than 1 hour or if the user-supplied goal differs textually from the cached one.

2. **Project detection accuracy.** Auto-detection from `cwd`, git remote, file paths is heuristic. False positives (memory tagged with wrong project) cause incorrect decay scoping. Mitigation: explicit `--project` flag on session start; fallback to inferred project; allow re-tagging memories post-hoc.

   **Decision:** explicit project metadata wins. Use `--project`/session
   metadata when present; otherwise infer from `cwd`, git root, package name,
   and normalized git remote. If confidence is low, tag the memory as
   `global`/`unknown` and do not advance a project-specific decay clock. False
   negatives are safer than false positives because semantic recall and later
   re-tagging can recover unscoped memories, while wrong project tags corrupt
   decay behavior.

3. **Specialist agents writing to memory.** Should subagents be allowed to add memories during a session, or only on session collapse via the root's transcript? Current direction: only on collapse, to keep extraction quality consistent. Subagent observations propagate up via tool results and end up in the transcript regardless.

   **Decision:** normal specialists get read-only memory access only. Durable
   memory creation goes through manual root/user calls, learn-event extraction,
   or session-collapse extraction. Subagent observations should be summarized in
   delegation results and enter memory through the root transcript. Archivist is
   the sole specialist exception, and its write tools are constrained by §7.2's
   write authorization boundary.

4. **Memory visibility across genomes.** If a user has multiple Sprout genomes (different roles, different machines), do memories merge? Current direction: no, genomes are isolated. Cross-genome sync is a future feature, not v1.

5. **The qm-reconciler agent.** It currently understands the genome shape. After this change, its model of memory structure needs updating. The cleanest path: have qm-reconciler delegate memory-state audits to archivist (e.g., "find dead links," "find unreachable memories") rather than reading the schema directly. This decouples reconciler from the memory implementation.

6. **Embedding provider failure mode.** If local embedding model loading or inference fails, the memory operation fails visibly. Do not silently downgrade to another embedding provider or pretend a vector path succeeded. Text-only operations may still exist where explicitly designed, but vector-required paths fail fast and surface the infrastructure problem.

7. **Mention count reliability.** Agents may reference memories they didn't actually use ("see also mem_XXXX"). The signal is noisy. Mitigation: count only mentions in `assistant` blocks (not in tool results), require some context after the reference, dedupe within a single response.

8. **Cost.** Local embeddings avoid per-token embedding spend. Occasional extraction LLM calls and occasional consolidation LLM calls still add up. Per-active-user estimate depends mostly on extraction/consolidation cadence rather than recall volume.

9. **Genome compaction.** JSONL grows unbounded with annotations and link rewrites. Periodic compaction rewrites memories.jsonl with current state, drops archived rows, commits a "compaction" message. Cadence: weekly, opportunistic on idle.

10. **Backwards compatibility for existing tests.** Sprout's recall tests use simple Memory objects. They'll need updating to construct extended-schema memories. Most can be migrated mechanically; a few that exercise specific decay behaviors need rewrites.

11. **Archivist write-tool authorization boundary.** Should archivist be able to archive a memory the user explicitly created? Annotate without user knowledge? Default direction: archivist mutations during a session are tagged with `source: 'archivist:<session_id>'` for audit; user-created memories require a confirmation turn before archive (system prompt rule, not enforced in code).

   **Decision:** additive archivist writes are allowed only after explicit caller
   instruction and must be audit-tagged as `source: 'archivist:<session_id>'`.
   Destructive or meaning-changing writes require explicit user confirmation and
   must be blocked by code-level write policy when confirmation is absent.
   User-authored/manual memories are protected from archive, consolidation, or
   supersession without confirmation.

12. **Recursive archivist calls.** Can archivist call itself, or its own tools repeatedly, indefinitely? Currently `max_turns: 8` bounds it. Worth confirming that's enough headroom for multi-hop investigation (e.g., "find contradictions about X" → search → traverse links → synthesize) without being so large that runaway investigations are possible.

13. **Routing rule learning loop.** Currently the learn pipeline can write RoutingRules. Should archivist usage *patterns* feed back as routing rule updates ("this kind of question always benefits from archivist") or stay manually curated? Defer to post-v1.

---

## 15. Out of scope (explicit non-goals)

Things this design deliberately does not include, to keep scope honest:

- **Multi-tenant memory.** Sprout is single-user-per-genome; no Workspace concept.
- **The user model / Text-Based LoRA pipeline.** Sprout doesn't need the assessment-extractor / synthesizer / critic loop because the agent system prompts are largely fixed. If we ever want behavioral adaptation, that's a separate later design.
- **Sidebar agents (forage / overwatch).** Speculative research isn't part of Sprout's loop. The quartermaster does adjacent work but with different shape.
- **Domain documents.** The genome already serves this purpose — agent specs are essentially domain docs.
- **Memory-as-a-service backend.** No external service (Honcho, hosted MIRA, etc.). Genome stays self-contained.
- **Replacing the Anthropic Batch API path.** MIRA uses batch for extraction and consolidation. Sprout uses sync calls. Sync is fine at Sprout's volume; revisit if cost becomes a problem.
- **First-person voice for specialist agents.** Only the root speaks first-person. Specialists are referred to in third person within summaries ("I delegated to engineer, which discovered...").
- **Cross-genome sync.** Genomes stay isolated.
- **Workspace cache isolation (Anthropic Feb 2026 change).** Single-tenant; not relevant.

---

## 16. Success criteria

This design is successful if, after Phase 5 (the v1 milestone):

- Sprout's recall quality, measured by side-by-side evaluation on a held-out query set, beats the keyword-search baseline by ≥30% in human-rated relevance.
- A given memory ID appears as a surfaced item in at least one delegated agent's prompt within the same session that created it (via the learn pipeline OR via segment collapse).
- The genome's git log shows clean per-mutation commits for memory creation, link creation, archival.
- Cache_read_input_tokens / total_input_tokens > 40% on a 10-turn engineer agent on Anthropic.
- New memory writes produce ready local embeddings and appear in hybrid recall without a migration step.
- A representative qm-fabricator session that needs domain-specific memory context delegates to archivist, gets a structured answer with cited memory IDs, and uses those memories to inform the new agent it builds — without manually grepping the genome.

After Phase 9 (full parity):

- Memory store size remains bounded over a 6-month simulated timeline despite continuous creation (consolidation working).
- Per-project decay correctly preserves dormant-project memories.
- Mention count visibly affects ranking on memories the agent uses repeatedly.

---

## 17. Reference

- MIRA memory architecture: `/Users/jesse/git/claude-pa-dev/third-party/mira-OSS/MEMORY_SYSTEM_SPEC.md`
- CodeMira coding-context adaptation: https://github.com/taylorsatula/CodeMira (see `mira_lineage.md` for the lineage map pattern)
- Anthropic prompt caching: https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching
- OpenAI prompt caching + `prompt_cache_key`: https://platform.openai.com/docs/guides/prompt-caching
- Sprout existing memory: `src/genome/memory-store.ts`, `src/genome/recall.ts`
- Sprout existing learn pipeline: `src/learn/`
- Sprout LLM adapters: `src/llm/anthropic.ts`, `src/llm/openai.ts`, `src/llm/gemini.ts`

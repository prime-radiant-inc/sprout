# Genome

The genome is Sprout's git-backed runtime state. It stores agent overlays,
workspace tools, routing rules, long-term memories, prompts, metrics, logs, and
derived cache metadata under a user data directory.

## Directory Shape

Typical directories:
- `agents/` overlay agent specs and agent workspaces
- `memories/` JSONL memory, segment, project, and SQLite index files
- `routing/rules.yaml` learned routing hints
- `prompts/` overridable prompt files
- `metrics/` learn-process metrics and pending evaluations
- `.cache/` locks and non-audited operational state

Source of truth:
- `src/genome/genome.ts:DIRS`.

## Two-Layer Resolution

Root files are immutable product defaults. Genome files are mutable runtime
overrides. Agent lookup checks the genome overlay first, then root. Workspace
tools follow the same pattern: genome tool wins, root tool is fallback.

Source of truth:
- `src/genome/genome.ts:getAgent()`, `allAgents()`, `loadAgentToolsWithRoot()`.
- `src/agents/factory.ts` wires root loading and sync.

## Git Audit Trail

Genome mutations are committed to a local git repo. Agent changes, routing
rules, prompt updates, memory writes, and maintenance operations produce commits.
Rollback uses git revert, not file snapshots.

Source of truth:
- `src/genome/genome.ts:git()`, `init()`, `rollback()`, mutation methods.

## Memory

Memory JSONL is source of truth. Embeddings and SQLite/FTS indexes are derived
and rebuilt after writes. Active recall excludes archived and superseded
memories. Explicit compaction can remove inactive rows after git has the audit
history.

Source of truth:
- `src/genome/memory-store.ts`
- `src/genome/memory-index.ts`
- `src/genome/index-builder.ts`
- `src/genome/memory-lifecycle.ts`

## Routing Rules

Routing rules are not memories. They are decision metadata returned from recall
as `routing_hints` and rendered into the prompt. The learn pipeline can create
rules through the existing `RoutingRule` mutation path.

Source of truth:
- `src/kernel/types.ts:RoutingRule`
- `src/genome/genome.ts:addRoutingRule()`
- `src/genome/recall.ts`
- `src/learn/learn-process.ts:applyMutation()`

## Concurrency

Memory writes use a directory lock under `.cache` and restore snapshots when
save, index rebuild, or commit fails. This protects JSONL source files and the
derived memory index from partial writes.

Source of truth:
- `src/genome/file-lock.ts`
- `src/genome/genome.ts:withMemoryWriteLock()`

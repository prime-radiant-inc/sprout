# Quartermaster Self-Awareness Agents

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

**Date:** 2026-03-03
**Status:** Design approved, pending implementation plan
**Inspired by:** Microsoft Amplifier's `session-analyst` and `foundation-expert` agents

## Problem

Sprout has no specialized capability for reasoning about itself. It can't debug its
own failed sessions, explain how its own architecture works, or diagnose whether its
learn process is effective. Three gaps:

1. **Session analysis** — No agent understands session storage format, event taxonomy,
   or how to safely extract data from large JSONL logs. No repair capability.
2. **Architectural self-knowledge** — No agent carries deep knowledge of Sprout's
   internals (kernel loop, delegation model, genome, primitives, bus, compaction).
3. **Learning diagnostics** — No agent can analyze stumble patterns, evaluate mutation
   effectiveness, or diagnose why Sprout isn't improving from experience.

## Design

Three new subagents under the quartermaster, following the context sink pattern:
heavy knowledge loads only when the specialist is spawned.

### Agent Tree

```
quartermaster/
  agents/
    qm-indexer.md            (existing — capability discovery)
    qm-fabricator.md         (existing — agent builder)
    qm-planner.md            (existing — capability planning)
    qm-reconciler.md         (existing — genome reconciliation)
    qm-session-analyst.md    (NEW — session analysis + repair)
    qm-sprout-architect.md   (NEW — architectural self-knowledge)
    qm-session-doctor.md     (NEW — learn process diagnostics)
```

### Quartermaster Routing

Three new modes added to the quartermaster's system prompt:

- **Analyst Mode** — "What happened in session X? Why did it fail? Rewind it."
  Delegate to qm-session-analyst with session ID, project context, or search criteria.
- **Architect Mode** — "How does X work in Sprout? How should I design Y?"
  Delegate to qm-sprout-architect with the question or design context.
- **Doctor Mode** — "Is learning working? What are the stumble patterns?"
  Delegate to qm-session-doctor with agent name, time window, or specific concern.

Root agent also gets updated routing hints:
- "Need to understand how Sprout itself works?" → quartermaster
- "Need to debug a session?" → quartermaster
- "Need to check if learning is effective?" → quartermaster

---

## Agent Specifications

### qm-session-analyst

**Role:** Analyze, search, debug, and repair Sprout sessions.

**Activation triggers:**
- "Why did session X fail?"
- "What happened in my last session?"
- "Find the session where I worked on bus messaging"
- "Rewind session X to before the last prompt"
- "Why won't this session resume?"

| Field | Value |
|-------|-------|
| model | best |
| tools | [] (no direct primitives) |
| agents | utility/reader, utility/command-runner, utility/editor |
| can_spawn | true |
| max_depth | 3 |
| max_turns | 200 |

**Key knowledge loaded on demand from resource files:**
- Session storage layout: `~/.local/share/sprout-genome/projects/{slug}/sessions/`
  (metadata) and `logs/` (JSONL events)
- Event kind taxonomy (~30 EventKind values and their meaning)
- Safe extraction patterns — session JSONL lines can be large (full LLM messages
  with tool calls). Must delegate to command-runner with jq/sed for surgical
  extraction rather than reading raw logs.
- Replay mechanics — how `replayEventLog()` reconstructs history from events,
  which event kinds map to which Message types
- Session metadata schema (SessionMetadataSnapshot fields)
- Search workflow: metadata-first filtering → content search → synthesis

**Repair capability:**
- Rewind: truncate JSONL event log to a prior point, with `.bak` backup first
- History is reconstructed from events at resume time, so truncating the event
  log IS the repair mechanism
- Warning protocol for modifying the parent/running session (user must close
  and resume to see changes)

**Delegation pattern:** The analyst reasons about what to look for, then delegates
to utility agents with intent-expressing prompts. This keeps the analyst's context
clean — utility agents absorb raw log data, and only synthesized findings flow back.

### qm-sprout-architect

**Role:** Context sink carrying deep knowledge of Sprout's architecture and internals.
The "how does Sprout work?" agent.

**Activation triggers:**
- "How does delegation work in Sprout?"
- "What's the provider alignment model?"
- "How should I author a new agent?"
- "How does the genome overlay system work?"
- "What's the compaction strategy?"
- "How does the bus messaging work?"

| Field | Value |
|-------|-------|
| model | best |
| tools | [] (no direct primitives) |
| agents | utility/reader, project-explorer |
| can_spawn | true |
| max_depth | 3 |
| max_turns | 200 |

**Knowledge domains** (loaded on demand from resource files):
1. Agent tree — conventions, auto-discovery, path resolution, preambles
2. Genome — overlay model, two-layer resolution, version bumping, persistence
3. Delegation — in-process vs bus-based spawner, blocking/non-blocking/shared agents
4. Kernel loop — perceive → recall → plan → act → verify, learn (async)
5. Primitives — tool registry, provider-aligned primitives, workspace tools
6. LLM client — three providers, native APIs, streaming, retry, caching
7. Bus messaging — WebSocket pub/sub, spawner, per-process agents
8. Compaction — context compression, triggers
9. Session system — event emission, logging, metadata, replay/resume
10. Learn process — signals, mutation pipeline, evaluation, metrics

**Delegation pattern:** For conceptual questions, answers from its context knowledge.
For specifics or current-state-of-truth answers, delegates to project-explorer
or utility/reader to verify against source code.

### qm-session-doctor

**Role:** Diagnose learning effectiveness. Understands the learn process pipeline,
stumble patterns, metrics, mutation evaluation, and why Sprout may or may not be
improving from experience.

**Activation triggers:**
- "Why isn't Sprout learning from its mistakes?"
- "What stumble patterns exist for the engineer agent?"
- "Are the recent learn mutations helping or hurting?"
- "Show me the stumble rate trends"
- "Why was this mutation rolled back?"
- "What has the learn process changed recently?"

| Field | Value |
|-------|-------|
| model | best |
| tools | [] (no direct primitives) |
| agents | utility/reader, utility/command-runner |
| can_spawn | true |
| max_depth | 3 |
| max_turns | 200 |

**Key knowledge loaded on demand from resource files:**
1. Learn signal kinds — failure, timeout, error, inefficiency, retry — and triggers
2. Learn pipeline — signal → shouldLearn → LLM reasoning → mutation → evaluation
3. Mutation types — memory creation, agent spec updates, routing rule changes
4. Metrics store — `metrics.jsonl` format, stumble rate computation
5. Evaluation mechanics — action window, before/after comparison, rollback criteria
6. Genome mutations — pending evaluation location, how to inspect
7. Cross-session analysis — correlating stumble patterns across sessions

**What the doctor does that the analyst doesn't:**
- Analyst: "what happened in this session" (operational, event-level)
- Doctor: "is Sprout getting better at X over time" (longitudinal, pattern-level)
- Doctor reads metrics.jsonl and pending evaluations; analyst reads session event logs

---

## Context Files Strategy

### Directory Structure

```
root/agents/quartermaster/resources/
  agent-tree-spec.md              (existing)
  sprout-architecture/            (NEW)
    overview.md                   — high-level architecture, core loop, design philosophy
    agent-system.md               — agent tree, delegation, auto-discovery, preambles
    genome.md                     — overlay model, two-layer resolution, version bumping
    primitives-and-tools.md       — primitive registry, provider alignment, workspace tools
    llm-client.md                 — providers, native APIs, streaming, retry, caching
    bus-messaging.md              — WebSocket pub/sub, spawner, per-process agents
    session-system.md             — events, logging, metadata, replay/resume, compaction
    learn-process.md              — signals, pipeline, mutations, evaluation, metrics
```

### Two-Tier Knowledge Pattern

Each context file follows two tiers:

1. **Conceptual (evergreen):** Explains how and why the subsystem works.
   These change only when architecture changes. Written for stability.

2. **Source-of-truth pointers (self-refreshing):** Instead of inlining volatile
   details (event kind lists, type definitions, file paths), the docs point to
   authoritative source: "see `src/kernel/types.ts:EventKind` for the current
   event taxonomy." The architect reads source via project-explorer when it
   needs specifics.

### Context References by Agent

| Agent | Context files referenced |
|-------|------------------------|
| qm-sprout-architect | All files in sprout-architecture/ |
| qm-session-analyst | session-system.md |
| qm-session-doctor | learn-process.md, session-system.md |

### Documentation Maintenance

- Conceptual docs are updated alongside architectural changes (same as tests)
- Volatile details are always fetched from source, never cached in docs
- Future enhancement: qm-reconciler could detect doc drift by comparing
  doc claims against source signatures

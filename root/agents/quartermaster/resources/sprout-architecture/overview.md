# Sprout Architecture Overview

Sprout is a TypeScript/Bun multi-agent runtime. A root orchestrator receives a
goal, selects specialist agents, and coordinates work through an evented kernel.
Runtime behavior is defined by markdown agent specs under `root/` plus a
git-backed genome overlay in the user's data directory.

## Core Loop

Each agent follows the same broad loop:
1. Perceive the user goal or delegated subgoal.
2. Recall relevant agents, memories, and routing hints from the genome.
3. Plan the next LLM action with tool schemas and delegate choices.
4. Act by calling primitives, workspace tools, or subagents.
5. Verify act results and emit learn signals for stumbles.
6. Continue until completion, timeout, interruption, or turn limit.

Source of truth:
- `src/agents/agent.ts` owns the agent lifecycle.
- `src/agents/plan.ts` builds prompts and LLM requests.
- `src/agents/verify.ts` creates learn signals from act results.

## Major Subsystems

Agent system: markdown specs, recursive agent tree scanning, delegate resolution,
and prompt preambles. See `agent-system.md`.

Genome: git-backed mutable runtime state for agent overlays, routing rules,
memories, tools, prompts, metrics, and derived indexes. See `genome.md`.

Primitives and tools: built-in capabilities plus agent-specific workspace tools.
See `primitives-and-tools.md`.

LLM client: provider registry and native adapters for Anthropic, OpenAI, Gemini,
streaming, prompt caching, and model resolution. See `llm-client.md`.

Bus messaging: WebSocket server, clients, spawner, and per-process child agents.
See `bus-messaging.md`.

Session system: metadata, event logs, replay/resume, compaction, and memory
collapse. See `session-system.md`.

Learn process: stumble metrics, memory extraction, non-memory mutations, pending
evaluation, and rollback. See `learn-process.md`.

## Design Principles

JSONL and markdown are the durable source formats. SQLite and embeddings are
derived caches that can be rebuilt.

Agent specs are declarative. Runtime behavior should come from frontmatter,
prompt files, and genome state rather than hardcoded special cases.

No silent fallbacks. Missing model configuration, failed cache creation, invalid
memory writes, and stale indexes should fail with actionable errors.

Keep context sinks narrow. Heavy architecture or diagnostic knowledge lives in
Quartermaster specialists and resource files, not in root's prompt.

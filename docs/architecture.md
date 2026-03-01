# Sprout Architecture

Sprout is a self-improving coding agent. The full spec lives at `~/prime-radiant/serf/self-improving-agent-spec.md`.

## Core Loop

```
Perceive → Recall → Plan → Act → Verify ─── loop
                                  │
                                  └──→ Learn (async)
```

Five synchronous phases execute in sequence. Learn forks asynchronously from Verify and runs in the background.

## Key Principles

- **Everything is agents.** All Acts are goal-directed subagent delegations, not tool calls. Primitives (readFile, exec, etc.) are the base case.
- **Recursive.** Subagents can spawn sub-subagents. Depth-limited by constraint.
- **Goal + hints.** Subagents receive goals (what) not instructions (how), plus optional hints (context).
- **Recall surfaces, Plan selects.** Recall retrieves candidate agents/memories deterministically. Plan (the LLM) makes the selection.
- **Learn is async.** Doesn't block the main loop. Triggered by stumbles. Writes to genome.
- **Genome.** Population of agent specs + memories + routing rules, git-versioned.
- **Stumble rate is the fitness function.** Not user satisfaction but "did I stumble getting there?" Errors, retries, timeouts, failures.
- **Multi-provider.** Uses the unified LLM spec (Anthropic, OpenAI, Gemini).

## Immutable Kernel

These cannot be modified by Learn:
1. Core loop (Perceive → Recall → Plan → Act → Verify)
2. Primitives (read_file, write_file, edit_file, apply_patch, exec, grep, glob, fetch)
3. The Learn process itself
4. The audit log
5. Safety constraints

Agent names that shadow kernel primitives or reserved names are rejected at creation time.

## Agent Tree

Agents are defined as Markdown specs in `root/`, organized as a nested tree. Each directory's `agents/` subdirectory contains its children.

**Core utility agents (leaf workers):**

| Agent | Model | Role |
|-------|-------|------|
| utility/reader | fast | Finds and returns code (read_file, grep, glob) |
| utility/editor | balanced | Makes targeted edits (read_file, edit_file, write_file) |
| utility/command-runner | fast | Runs shell commands (exec) |
| utility/web-reader | fast | HTTP requests & web content |
| utility/mcp | fast | Model Context Protocol client |
| utility/task-manager | fast | Task tracking |

**Specialized orchestrators:** architect, debugger, project-explorer, tech-lead (with engineer, spec-reviewer, quality-reviewer), verifier

**Quartermaster subsystem (self-improvement):** quartermaster, qm-planner, qm-indexer, qm-fabricator, qm-reconciler

The full set lives in `root/`. New agents added here are synced to runtime genomes via genome reconciliation (see below).

## Genome Reconciliation

The root directory (`root/`) is the canonical source for agent definitions shipped with sprout. The runtime genome (`~/.local/share/sprout-genome/`) is a git-versioned copy that Learn can mutate at runtime. Genome reconciliation keeps them in sync.

### How it works

`syncRoot(rootDir)` performs a 4-way comparison using a **bootstrap manifest** (`bootstrap-manifest.json` inside the genome):

| # | Old Manifest | New Manifest | Genome | Action |
|---|-------------|-------------|--------|--------|
| 1 | missing | present | missing | **Add** — new root agent, copy to genome |
| 2 | missing | present | present | **Skip** — pre-manifest genome, treat as evolved |
| 3 | present | unchanged | any | **Skip** — root file unchanged |
| 4 | present | changed | matches old | **Update** — genome hasn't diverged, safe to overwrite |
| 5 | present | changed | diverged | **Conflict** — both sides evolved, report for manual resolution |

The manifest stores a `sha256:` content hash and version per agent, plus the root agent's capabilities at last sync.

### Root capability reconciliation

Root's capabilities list gets 3-way merged: new root capabilities are added, capabilities root removed are dropped, and genome-only capabilities (added by Learn) are preserved.

### Export learnings (reverse flow)

`exportLearnings(genomePath, rootDir)` compares genome agents back to root. Agents whose genome version exceeds their root version are "evolved" — their specs are exported to a staging directory for human review before promotion to root.

### Dev-mode detection

When running from source (both `root/` and `src/genome/` exist), agents receive a dev-mode postscript appended to their system prompt with development guidelines. This is injected idempotently using a sentinel comment marker.

## Implementation Decisions

### Manifest-aware root sync (Feb 2026)

The bootstrap manifest (`bootstrap-manifest.json`) enables safe bidirectional sync between root agents and genome. Without the manifest, there's no way to distinguish "root changed" from "genome evolved" — both look like a diff. The manifest records what was last synced, making the 4-way comparison possible.

### Single delegate tool (Feb 2026)

Instead of creating one tool definition per delegatable agent (which invalidates prompt cache when agents change), we use a single `delegate` tool with `agent_name`, `goal`, and `hints` parameters. Agent descriptions are rendered into the system prompt's `<agents>` XML block. The tool list stays stable across genome mutations.

This deviates from the spec's `agent_as_tool()` pattern (§6.3) but is functionally identical — the LLM still selects agents by name and provides goals.

### Primitives on subagents only (Feb 2026, spec §D.11 option b)

Agents that have a delegate tool don't get primitive tools. You either delegate or use primitives, never both. This enforces the "agents all the way down" pattern. Delegating agents think in goals, leaf agents execute with primitives.

### Dynamic agent discovery via genome (Feb 2026)

When spawning subagents, the agent looks up specs from the genome first (`genome.getAgent()`), falling back to the static `availableAgents` snapshot. This means agents created by Learn mid-session are immediately available to subagents, even though the parent's delegate tool enum was frozen at construction.

### Concurrent delegations (Feb 2026, spec §2.5)

Multiple delegations in a single Plan response execute via `Promise.all`. Results are collected by call ID and added to history in original tool call order, preserving deterministic message ordering regardless of completion order. Primitives remain sequential.

## Prior Art

| System | Key Contribution | Gap |
|--------|-----------------|-----|
| DGM (Sakana) | Self-modifying agent, SWE-bench 20%→50% | No persistent cross-session improvement |
| SICA (Bristol) | Self-improving coding agent, 17%→53% | No production deployment loop |
| Live-SWE-Agent | Invents tools at runtime, 77.4% SWE-bench | No persistent skill library |
| Voyager | Persistent skill library in Minecraft | Not a coding agent |
| DSPy | Metric-driven prompt optimization | Not agent-level self-improvement |

Nobody has built the full production + self-improving + persistent + closed-loop system. That's what sprout is.

## Baseline Data

From transcript analysis of 2,201 real coding agent sessions across 3 machines:
- 77,220 tool uses, 237,000 messages
- 3.7% average stumble rate (2,890 stumbles)
- Top stumble sources: command failures (33%), test failures (11%), file-not-found (8%)

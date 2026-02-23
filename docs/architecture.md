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

## Bootstrap Agents

Four agents. Minimum viable tree for read/edit/run:

| Agent | Model | Capabilities | Role |
|-------|-------|-------------|------|
| root | best | code-reader, code-editor, command-runner | Decomposes tasks, delegates |
| code-reader | fast | read_file, grep, glob | Finds and returns code |
| code-editor | balanced | read_file, edit_file, write_file | Makes targeted edits |
| command-runner | fast | exec | Runs shell commands |

## Implementation Decisions

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

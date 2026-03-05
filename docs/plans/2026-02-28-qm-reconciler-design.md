# Genome Reconciler & Internal Tool System

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the quartermaster a reconciliation sub-agent, add a `sprout-internal` tool interpreter, and move misplaced agent tools into bootstrap tool directories.

**Architecture:** Two-layer tool resolution (genome overrides bootstrap), a minimal ToolContext passing real objects, a qm-reconciler agent, and refactoring of existing agent tools from `src/` into `bootstrap/{agent}/tools/`.

**Tech Stack:** TypeScript, Bun, dynamic `import()`

---

## Motivation: Agent Tools Are Misplaced

Several agents already have dedicated tools, but they're buried in `src/` instead of living with their agents:

| Agent | Tool | Current Location | Should Be |
|-------|------|-----------------|-----------|
| task-manager | Task CLI (create, list, get, update, comment) | `src/tasks/cli.ts` + `store.ts` + `types.ts` | `bootstrap/task-manager/tools/` |
| mcp | MCP client CLI (list-servers, list-tools, call-tool) | `src/mcp-cli.ts` | `bootstrap/mcp/tools/` |

These agents invoke their tools via `exec` with hardcoded paths like `bun run src/tasks/cli.ts`. This is fragile (path depends on working directory) and violates the agent-tools convention documented in `qm-fabricator.yaml`.

Moving them into `bootstrap/{agent}/tools/` and loading them through the tool system fixes this: tools are discovered automatically, added to PATH, and registered as agent primitives.

---

## 1. The `sprout-internal` Interpreter

Agent tools today are shell scripts piped to an interpreter via stdin. A `sprout-internal` tool runs as a TypeScript module in the agent's process with direct access to the `Genome` instance and `ExecutionEnvironment`.

### Tool file format

A `.ts` file with YAML frontmatter, same convention as shell tools:

```
---
name: sync-genome
description: Sync bootstrap agents into the runtime genome
interpreter: sprout-internal
---
export default async function(ctx) {
  const result = await ctx.genome.syncBootstrap(ctx.env.working_directory());
  return {
    output: JSON.stringify(result, null, 2),
    success: true,
  };
}
```

### ToolContext

Four fields. No facade — pass the real objects.

```typescript
interface ToolContext {
  agentName: string;
  args: Record<string, unknown>;   // pre-parsed from JSON
  genome: Genome;                  // the live Genome instance
  env: ExecutionEnvironment;       // the agent's execution environment
}
```

Tools return the same shape as every other primitive: `{ output: string, success: boolean, error?: string }`.

The runtime pre-parses `args` via `JSON.parse` and wraps the call in try/catch, so an unhandled throw returns `{ success: false }` instead of crashing the agent loop.

### Why no facade

- Tools run in-process and can import anything. A facade restricts the documented surface but not the actual surface.
- Sprout is designed for self-modification. Restricting what tools can access defeats the purpose.
- The Genome class and ExecutionEnvironment are already tested and documented. Maintaining a parallel interface is pure overhead.
- When Genome evolves, bootstrap tools update in the same commit. Genome-authored tools were written against the API at that time; the fabricator can rewrite them.

### No imports needed

Tools access sprout through `ctx`, not through imports. A tool in `bootstrap/` could import from source via relative paths, but a tool in the genome can't. Using only `ctx` keeps tools portable across both layers.

---

## 2. Two-Layer Tool Resolution

Tools load from two directories with clear precedence, following the systemd model (`/usr/lib/` vs `/etc/`).

```
Resolution for agent "task-manager", tool "task-cli":
  1. genome/agents/task-manager/tools/task-cli    ← wins if present
  2. bootstrap/task-manager/tools/task-cli        ← fallback default
```

### Properties

- **Genome overrides bootstrap.** A same-named file in the genome overrides the bootstrap default.
- **Delete to reset.** Removing the genome override restores the bootstrap default.
- **No syncing between layers.** Bootstrap and genome are independent sources. This differs from agent YAML specs, which sync via the manifest.
- **Both layers support all interpreter types**, including `sprout-internal`. The fabricator can write internal tools to the genome.
- **Provenance tracked.** The loader records each tool's source layer for diagnostics.

### Directory structure

```
bootstrap/                              # Layer 2 (defaults)
  task-manager.yaml                    # agent spec
  task-manager/
    tools/
      task-cli                         # task management CLI
  mcp.yaml
  mcp/
    tools/
      sprout-mcp                       # MCP client CLI
  qm-reconciler.yaml
  qm-reconciler/
    tools/
      (none — uses file primitives)

~/.local/share/sprout-genome/           # Layer 1 (overrides)
  agents/
    task-manager/
      tools/
        task-cli                       # genome override (if present)
```

### Implementation

`loadAgentTools` in `genome.ts` already loads from `genome/agents/{name}/tools/`. Add a second source:

1. Load genome tools (existing behavior)
2. Load bootstrap tools from `bootstrap/{name}/tools/`
3. Merge: genome wins on name collision
4. Record provenance for each tool

Extend `agent.ts` to pass `bootstrapDir` through to the tool loader.

---

## 3. Refactoring Existing Agent Tools

### task-manager

**Move:** `src/tasks/cli.ts`, `src/tasks/store.ts`, `src/tasks/types.ts` → `bootstrap/task-manager/tools/`

The task CLI becomes a bootstrap-shipped tool with YAML frontmatter. The `task-manager.yaml` system prompt drops the hardcoded `bun run src/tasks/cli.ts` path — the tool is registered as a primitive automatically.

The supporting modules (`store.ts`, `types.ts`) move alongside the CLI. If other parts of sprout import from `src/tasks/types.ts`, those imports need updating or the types need to stay in a shared location.

### mcp

**Move:** `src/mcp-cli.ts` → `bootstrap/mcp/tools/sprout-mcp`

The MCP CLI becomes a bootstrap-shipped tool. The `mcp.yaml` system prompt drops the `sprout-mcp` PATH assumption — the tool is registered as a primitive and added to PATH automatically by the tool loader.

### Agent prompt updates

Both agents' system prompts simplify. Instead of documenting exact `exec` invocations with paths, they describe the tool by name. The tool system handles discovery and registration.

---

## 4. `--genome sync` CLI Command

Add `--genome sync` alongside `--genome export`:

```
sprout --genome sync     Sync bootstrap agents to runtime genome
sprout --genome export   Show learnings that evolved beyond bootstrap
```

Loads the genome, calls `syncBootstrap(bootstrapDir)`, prints results. Same operation that `factory.ts` runs at startup, but on demand with detailed output.

---

## 5. The qm-reconciler Agent

A leaf agent in the quartermaster subsystem. Uses standard file primitives — agents are already good at reading files and reasoning about content.

```yaml
name: qm-reconciler
description: "Reconcile genome/bootstrap differences and propose contributions"
model: fast
capabilities:
  - read_file
  - grep
  - glob
  - write_file
constraints:
  max_turns: 20
  max_depth: 0
  can_spawn: false
  timeout_ms: 120000
tags:
  - quartermaster
  - reconciliation
version: 1
```

### Two jobs

**Reconcile overlays** — When bootstrap updates an agent that the genome has customized (a conflict from `syncBootstrap`), the reconciler reads both versions, understands the diff, and recommends whether to absorb the bootstrap change, keep the genome version, or merge.

**Propose contributions** — Compares genome agents to their bootstrap counterparts. When the genome has evolved an agent beyond the bootstrap version, the reconciler reads both prompts, summarizes what changed, and proposes whether the improvement should be promoted to core.

### How it works

The reconciler reads files directly:
- `bootstrap/*.yaml` for bootstrap specs
- `~/.local/share/sprout-genome/agents/*.yaml` for genome specs
- `~/.local/share/sprout-genome/bootstrap-manifest.json` for sync state

No special tools — `read_file`, `grep`, `glob` for discovery and comparison, `write_file` for writing proposals.

---

## 6. Quartermaster Updates

### New mode

The quartermaster gains a fourth mode:

**Reconciler Mode** — "What's drifted? Reconcile overlays. Propose contributions."

Delegates to qm-reconciler to inspect state, reconcile conflicts, or propose genome improvements for promotion to bootstrap.

### Tool system documentation

The quartermaster's system prompt gains a section explaining the agent tool system:

- Agent tools: scripts in `agents/{name}/tools/` with YAML frontmatter
- Two interpreter types: shell scripts (`bash`, `python`, etc.) and `sprout-internal` (in-process TypeScript)
- Two-layer resolution: genome overrides bootstrap
- The ToolContext for `sprout-internal` tools: `{ agentName, args, genome, env }`
- A canonical template for writing internal tools
- Rules: return `{ output, success, error? }`, access sprout via `ctx.genome` and `ctx.env`

---

## Testing Strategy

- **Tool loader:** Test `sprout-internal` dispatch — dynamic import, context injection, try/catch error wrapping
- **Two-layer resolution:** Verify genome override wins, bootstrap falls back, provenance tracks correctly
- **Refactored tools:** Verify task-cli and sprout-mcp load correctly from bootstrap directories and register as primitives
- **`--genome sync` CLI:** Integration test via CLI entry point
- **qm-reconciler:** Agent spec validates; system prompt covers both jobs
- **Quartermaster:** System prompt includes tool documentation

---

## Deferred

- **Genome modules/plugins** — a richer extensibility model beyond two-layer tools
- **Bootstrap directory syncing** — syncing non-YAML content from bootstrap to genome via the manifest
- **Bun import caching** — internal tools loaded via `import()` may need cache-busting if the genome overrides a bootstrap tool after initial load (use the "copy to temp, import, delete" pattern from Appendix D when needed)

# Genome Reconciler & Internal Tool System

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the quartermaster a reconciliation sub-agent and add a `sprout-internal` tool interpreter for in-process TypeScript tools.

**Architecture:** Two-layer tool resolution (genome overrides bootstrap), a minimal ToolContext passing real objects, a qm-reconciler agent that reads files and reasons about genome state, and quartermaster prompt updates.

**Tech Stack:** TypeScript, Bun, dynamic `import()`

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
  const result = await ctx.genome.syncBootstrap(ctx.paths.bootstrap);
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
Resolution for agent "foo", tool "bar":
  1. genome/agents/foo/tools/bar.ts    ← wins if present
  2. bootstrap/foo/tools/bar.ts        ← fallback default
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
  foo.yaml                             # agent spec
  foo/
    tools/
      bar.ts                           # tool shipped with agent

~/.local/share/sprout-genome/           # Layer 1 (overrides)
  agents/
    foo/
      tools/
        bar.ts                         # genome override (if present)
```

### Implementation

`loadAgentTools` in `genome.ts` already loads from `genome/agents/{name}/tools/`. Add a second source:

1. Load genome tools (existing behavior)
2. Load bootstrap tools from `bootstrap/{name}/tools/`
3. Merge: genome wins on name collision
4. Record provenance for each tool

Extend `agent.ts` to pass `bootstrapDir` through to the tool loader.

---

## 3. `--genome sync` CLI Command

Add `--genome sync` alongside `--genome export`:

```
sprout --genome sync     Sync bootstrap agents to runtime genome
sprout --genome export   Show learnings that evolved beyond bootstrap
```

Loads the genome, calls `syncBootstrap(bootstrapDir)`, prints results. Same operation that `factory.ts` runs at startup, but on demand with detailed output.

---

## 4. The qm-reconciler Agent

A leaf agent in the quartermaster subsystem. Uses standard file primitives — no `sprout-internal` tools needed. Agents are already good at reading files and reasoning about content.

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

No special tools — just `read_file`, `grep`, `glob` for discovery and comparison, `write_file` for writing proposals.

---

## 5. Quartermaster Updates

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
- **`--genome sync` CLI:** Integration test via CLI entry point
- **qm-reconciler:** Test system prompt contains expected sections; agent spec validates
- **Quartermaster:** Verify system prompt includes tool documentation

---

## Deferred

- **Genome modules/plugins** — a richer extensibility model beyond two-layer tools
- **Bootstrap directory syncing** — syncing non-YAML content from bootstrap to genome via the manifest
- **Bun import caching** — internal tools loaded via `import()` may need cache-busting if the genome overrides a bootstrap tool after initial load (use the "copy to temp, import, delete" pattern from Appendix D when needed)

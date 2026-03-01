# Genome Reconciler & Internal Tool System

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the quartermaster a reconciliation sub-agent with bootstrap-shipped tools, powered by a new `sprout-internal` interpreter that runs TypeScript in-process.

**Architecture:** Two-layer tool resolution (genome overrides bootstrap), a stable ToolContext API for in-process tools, and a qm-reconciler agent with tools for genome sync and export.

**Tech Stack:** TypeScript, Bun, dynamic `import()`

---

## 1. The `sprout-internal` Interpreter

### What it does

Agent tools today are shell scripts piped to an interpreter via stdin. A `sprout-internal` tool runs as a TypeScript module in the agent's process, accessing sprout internals through a stable API.

### Tool file format

A `.ts` file with YAML frontmatter, following the same convention as shell tools:

```
---
name: reconcile-genome
description: Sync bootstrap agents into the runtime genome
interpreter: sprout-internal
---
export default async function(ctx) {
  const result = await ctx.genome.syncBootstrap();
  return {
    output: JSON.stringify(result, null, 2),
    success: true,
  };
}
```

### Tool execution

The tool loader in `src/kernel/tool-loading.ts` branches on the interpreter field:

```typescript
if (tool.interpreter === "sprout-internal") {
  const mod = await import(tool.scriptPath);
  const ctx = buildToolContext(agentName, args, genome, env);
  try {
    return await mod.default(ctx);
  } catch (err) {
    return { output: "", success: false, error: String(err) };
  }
} else {
  // existing: pipe script body to interpreter via stdin
}
```

The runtime wraps each call in try/catch, so an unhandled throw returns `{ success: false }` instead of crashing the agent loop.

### No imports needed

Tools access sprout through the `ToolContext` argument, not through imports. This keeps tools portable: they work in both bootstrap and genome. A tool that imports sprout source files directly will compile but is fragile and unsupported.

---

## 2. The ToolContext API

This is the stable contract between sprout and internal tools. Tools that use only `ctx` remain forward-compatible across sprout versions.

```typescript
interface ToolContext {
  /** Which agent is running this tool */
  agentName: string;

  /** Pre-parsed arguments from the calling agent (JSON object) */
  args: Record<string, unknown>;

  /** Key filesystem paths */
  paths: {
    genome: string;       // e.g., ~/.local/share/sprout-genome
    bootstrap: string;    // e.g., /path/to/sprout/bootstrap
    working: string;      // agent's working directory
  };

  /** Genome operations (facade, not the raw Genome class) */
  genome: {
    // Queries
    listAgents(): string[];
    getAgent(name: string): AgentSpec | undefined;
    getManifest(): Promise<BootstrapManifest>;

    // Mutations
    syncBootstrap(): Promise<SyncBootstrapResult>;
    exportLearnings(): Promise<ExportResult>;
  };

  /** Environment operations (same capabilities as agent primitives) */
  env: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    exec(command: string, opts?: { timeout_ms?: number }): Promise<ExecResult>;
    grep(pattern: string, path: string): Promise<string>;
    glob(pattern: string, path?: string): Promise<string[]>;
  };
}

interface ToolResult {
  output: string;
  success: boolean;
  error?: string;
}
```

### Design principles

- **Facade, not raw access.** `ctx.genome` exposes specific operations, not the `Genome` class. Internal refactors leave tools intact. Dangerous operations like `rollback()` stay off the facade.
- **Pre-parsed args.** The runtime calls `JSON.parse` before invoking the tool. Tools receive structured data, not a raw string.
- **`env` for I/O.** Tools call `ctx.env.readFile()` instead of importing `node:fs`. This enforces path constraints, logging, and execution environment rules. Tools that bypass `ctx.env` lose these guarantees.
- **Additive growth only.** Add new fields and methods freely. Never remove or change existing ones.

### Deliberately excluded (for now)

- Memory access (read/write memories)
- Routing rule management
- Bus/messaging operations
- AbortSignal/cancellation

Add these to the facade when a real tool needs them.

---

## 3. Two-Layer Tool Resolution

Tools load from two directories with clear precedence, following the systemd model (`/usr/lib/` vs `/etc/`).

```
Resolution for agent "qm-reconciler", tool "reconcile-genome":
  1. genome/agents/qm-reconciler/tools/reconcile-genome.ts   ← wins if present
  2. bootstrap/qm-reconciler/tools/reconcile-genome.ts       ← fallback default
```

### Properties

- **Genome overrides bootstrap.** A same-named file in the genome overrides the bootstrap tool.
- **Delete to reset.** Removing the genome override restores the bootstrap default.
- **No syncing between layers.** Bootstrap and genome are independent sources. The tool loader checks genome first, then falls back to bootstrap. This differs from agent YAML specs, which sync via the manifest.
- **Both layers support all interpreter types**, including `sprout-internal`. The fabricator can write internal tools to the genome.
- **Provenance tracked.** The loader records each tool's source layer (bootstrap or genome) for diagnostics and the reconciler's inspection mode.

### Directory structure

```
bootstrap/                              # Layer 2 (defaults)
  qm-reconciler.yaml                   # agent spec
  qm-reconciler/
    tools/
      reconcile-genome.ts              # sprout-internal tool
      export-learnings.ts              # sprout-internal tool

~/.local/share/sprout-genome/           # Layer 1 (overrides)
  agents/
    qm-reconciler/
      tools/
        reconcile-genome.ts            # overrides bootstrap version (if present)
```

### Implementation

`loadAgentTools` in `genome.ts` already loads from `genome/agents/{name}/tools/`. Add a second source:

1. Load genome tools (existing behavior)
2. Load bootstrap tools from `bootstrap/{name}/tools/`
3. Merge: genome tools win on name collision
4. Record provenance for each tool

The agent startup code in `agent.ts` already calls `genome.loadAgentTools()`. Extend it to accept a `bootstrapDir` parameter.

---

## 4. `--genome sync` CLI Command

Add `--genome sync` alongside `--genome export`:

```
sprout --genome sync     Sync bootstrap agents to runtime genome
sprout --genome export   Show learnings that evolved beyond bootstrap
```

`--genome sync` loads the genome, calls `syncBootstrap(bootstrapDir)`, and prints the results:

```
Added: debugger, engineer, quality-reviewer
Updated: root, editor
Conflicts: architect (genome preserved)
```

This runs the same operation that `factory.ts` runs at startup, but on demand and with detailed output.

---

## 5. The qm-reconciler Agent

A leaf agent in the quartermaster subsystem.

```yaml
name: qm-reconciler
description: "Inspect genome/bootstrap state and reconcile differences"
model: fast
capabilities:
  - read_file
  - grep
  - glob
  - exec
constraints:
  max_turns: 15
  max_depth: 0
  can_spawn: false
  timeout_ms: 60000
tags:
  - quartermaster
  - reconciliation
version: 1
```

### Bootstrap-shipped tools

| Tool | Interpreter | What it does |
|------|-------------|-------------|
| `reconcile-genome` | `sprout-internal` | Calls `ctx.genome.syncBootstrap()`, returns added/updated/conflicts |
| `export-learnings` | `sprout-internal` | Calls `ctx.genome.exportLearnings()`, returns evolved agents |

### System prompt (summary)

The qm-reconciler:
- Inspects the bootstrap manifest and reports sync state (current, drifted, conflicting)
- Runs `reconcile-genome` to sync bootstrap into the genome
- Runs `export-learnings` to find genome improvements worth promoting to bootstrap
- Summarizes results for the quartermaster

---

## 6. Quartermaster Updates

### New mode

The quartermaster gains a fourth mode:

**Reconciler Mode** — "Is my genome up to date? What changed? Sync it."

Delegates to qm-reconciler to inspect state, run a sync, or export learnings. Interprets and summarizes the results for the caller.

### Tool system documentation

The quartermaster's system prompt gains a section explaining the agent tool system, so the quartermaster can teach the fabricator:

- Agent tools: scripts in `agents/{name}/tools/` with YAML frontmatter
- Two interpreter types: shell scripts (`bash`, `python`, etc.) and `sprout-internal` (in-process TypeScript)
- Two-layer resolution: genome overrides bootstrap
- The ToolContext API for `sprout-internal` tools
- A canonical template for writing internal tools
- Rules: return `{ output, success, error? }`, use `ctx.env` for I/O, use `ctx.genome` for genome operations

---

## Testing Strategy

- **ToolContext facade:** Unit test each method against a real genome in a temp directory
- **Tool loader:** Test `sprout-internal` dispatch — dynamic import, context injection, error wrapping
- **Two-layer resolution:** Verify genome override wins, bootstrap falls back, provenance tracks correctly
- **`--genome sync` CLI:** Integration test via CLI entry point
- **qm-reconciler tools:** Test against a temp genome with known state
- **Quartermaster:** Verify the system prompt includes tool documentation

---

## Deferred

- **Genome modules/plugins** — a richer extensibility model beyond two-layer tools
- **Bootstrap directory syncing** — syncing non-YAML content (tools, files, docs) from bootstrap to genome via the manifest
- **Memory/routing/bus access on ToolContext** — add when a real tool needs them
- **AbortSignal/cancellation** — add when long-running tools exist
- **Tool parameter schemas** — tools currently receive a single `args` object; richer schemas can come later

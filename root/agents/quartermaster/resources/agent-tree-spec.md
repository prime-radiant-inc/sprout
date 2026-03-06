# Agent Tree Specification

Reference for creating and managing agents in the sprout agent tree.

## Agent Spec Format

Agent specs are YAML-fronted Markdown files. The YAML frontmatter defines structured fields; the markdown body is the system prompt.

```markdown
---
name: my-agent
description: "One-line summary shown to parent agents"
model: fast
tools:
  - read_file
  - grep
agents: []
constraints:
  max_turns: 20
  can_spawn: false
  timeout_ms: 120000
tags: [my-category]
version: 1
---
You are my-agent. You do X.

## Workflow

1. First step
2. Second step
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Unique kebab-case identifier |
| `description` | string | yes | One-line summary visible to parent agents |
| `model` | string | yes | `"fast"`, `"balanced"`, `"best"`, or a specific model ID |
| `tools` | string[] | no | Primitives and local tool references (defaults to `[]`) |
| `agents` | string[] | no | Explicit agent path references from root (defaults to `[]`) |
| `constraints` | object | no | Execution limits (see below) |
| `tags` | string[] | no | Informational labels |
| `version` | int | no | Bumped by genome updates (defaults to `1`) |
| `thinking` | bool/object | no | Extended thinking config (e.g. `{ budget_tokens: 5000 }`) |

### Constraints

| Field | Default | Description |
|-------|---------|-------------|
| `max_turns` | 50 | Maximum LLM round-trips |
| `can_spawn` | true | Whether this agent can delegate to others |
| `can_learn` | false | Whether experiences are persisted to memory |
| `timeout_ms` | 300000 | Hard timeout in milliseconds |

Workers (leaf agents) should use `can_spawn: false`.
Orchestrators need `can_spawn: true`.
The runtime enforces a global depth rail of 8 with root at depth 0.

### The `tools` Field

Two syntaxes:

- **Plain name** -- a primitive from the registry: `read_file`, `write_file`, `edit_file`, `exec`, `grep`, `glob`, `fetch`, `save_agent`
- **`./name`** -- a local tool from this agent's `tools/` directory: `./task-cli`, `./sprout-mcp`

Provider alignment is automatic: `edit_file` becomes `apply_patch` for OpenAI agents.

### The `agents` Field

Explicit cross-tree delegation targets. All paths are absolute from root:

```yaml
agents:
  - utility/reader          # shared reader agent
  - utility/task-manager    # shared task manager
  - project-explorer        # top-level agent
```

Agents listed here are available for delegation in addition to auto-discovered children.

## Directory Conventions

At every level, the same pattern applies:

```
<name>.md              # agent spec
<name>/agents/         # child agent specs
<name>/tools/          # agent's dedicated tools
<name>/resources/      # reference docs and data
```

### Current Tree

```
root/
  root.md
  agents/
    tech-lead.md
    tech-lead/agents/
      engineer.md
      spec-reviewer.md
      quality-reviewer.md
    quartermaster.md
    quartermaster/agents/
      qm-fabricator.md
      qm-indexer.md
      qm-planner.md
      qm-reconciler.md
    quartermaster/resources/
      agent-tree-spec.md        # this file
    architect.md
    verifier.md
    debugger.md
    project-explorer.md
    utility/agents/             # no utility.md -- namespace only
      reader.md
      editor.md
      command-runner.md
      web-reader.md
      mcp.md
      mcp/tools/
      task-manager.md
      task-manager/tools/
```

## Auto-Discovery

An agent automatically discovers its direct children -- the `.md` files in `<name>/agents/`.

| Agent | Auto-discovers |
|-------|---------------|
| root | tech-lead, architect, quartermaster, verifier, debugger, project-explorer |
| tech-lead | engineer, spec-reviewer, quality-reviewer |
| quartermaster | qm-fabricator, qm-indexer, qm-planner, qm-reconciler |
| leaf agents | nothing |

An agent's full delegation set = auto-discovered children + explicit `agents` field entries.

No agent auto-discovers `utility/` children. Each caller must list utility agents explicitly in its `agents` field.

## Path Resolution

All agent paths are absolute from root. The path maps to the directory tree:

| Path | Resolves to |
|------|------------|
| `tech-lead` | `root/agents/tech-lead.md` |
| `tech-lead/engineer` | `root/agents/tech-lead/agents/engineer.md` |
| `quartermaster/qm-fabricator` | `root/agents/quartermaster/agents/qm-fabricator.md` |
| `utility/reader` | `root/agents/utility/agents/reader.md` |

General rule: `a/b/c` resolves to `root/agents/a/agents/b/agents/c.md`.

## Placement Rules

When creating a new agent:

1. **Child of requester** -- if the agent serves a specific parent, place it under that parent's `agents/` directory. Example: a new code-formatter for tech-lead goes at `root/agents/tech-lead/agents/code-formatter.md`.

2. **Shared utility** -- if the agent is a general-purpose service any orchestrator might use, place it under `utility/agents/`. Example: `root/agents/utility/agents/code-formatter.md`. Callers must add `utility/code-formatter` to their `agents` field.

3. **Top-level** -- only for major organizational agents that root delegates to directly. Place at `root/agents/<name>.md`.

Prefer utility placement for reusable agents. Prefer child placement for specialized agents.

## Dynamic Delegation

An agent can delegate to a path it learned at runtime, not just its static delegation set. The path is resolved against the tree at delegation time.

Workflow:
1. Root asks quartermaster: "I need an agent that formats code"
2. Quartermaster creates `utility/code-formatter` via save_agent
3. Quartermaster returns: "Created agent at utility/code-formatter"
4. Root delegates to `utility/code-formatter` with a goal

The `agents` field defines static, always-available targets. Dynamic paths enable runtime extensibility without editing any spec files.

## Two-Layer Resolution

Agent specs resolve genome-first, then root:

1. Check genome: `~/.local/share/sprout-genome/root/agents/<path>.md`
2. Fall back to root: `root/agents/<path>.md`
3. Genome wins when both exist

New agents created by save_agent exist only in the genome layer. The root layer provides shipping defaults. Delete a genome override to restore the root default.

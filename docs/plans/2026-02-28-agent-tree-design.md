# Agent Tree & Delegation Redesign

**Goal:** Replace the prescriptive capabilities allowlist with directory-based auto-discovery, path-based delegation, and YAML-fronted Markdown agent specs.

**Problem:** Agents list their delegation targets in a flat `capabilities` field. New agents are invisible until someone manually updates every parent's capabilities list. This defeats the purpose of a self-improving system.

**Solution:** Agents auto-discover their children by directory structure. Cross-tree references use paths from root. The `capabilities` field splits into `tools` (primitives + local) and `agents` (explicit path references). Agent specs become YAML-fronted Markdown.

---

## Agent Spec Format

Agent specs change from pure YAML to YAML-fronted Markdown. The markdown body becomes the system prompt. The `system_prompt` and `capabilities` YAML fields disappear.

**Before (pure YAML):**

```yaml
name: reader
description: "Find and read files"
model: fast
capabilities:
  - read_file
  - grep
  - glob
constraints:
  max_turns: 20
  max_depth: 0
  can_spawn: false
system_prompt: |
  You are a reader. You find and read files...
```

**After (YAML-fronted Markdown):**

```markdown
---
name: reader
description: "Find and read files"
model: fast
tools:
  - read_file
  - grep
  - glob
agents: []
constraints:
  max_turns: 20
  max_depth: 0
  can_spawn: false
tags: [core, reading]
version: 2
---
You are a reader. You find and read files, then return the information requested.

CRITICAL: You are READ-ONLY. Never create, write, or save files...
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique agent identifier |
| `description` | string | One-line summary shown to parent agents |
| `model` | string | `"best"`, `"balanced"`, `"fast"`, or specific model |
| `tools` | string[] | Primitives and local tools (see below) |
| `agents` | string[] | Explicit agent references as paths from root |
| `constraints` | object | `max_turns`, `max_depth`, `can_spawn`, `can_learn`, `timeout_ms`, `allowed_write_paths` |
| `tags` | string[] | Informational labels |
| `version` | int | Bumped by genome updates |
| `thinking` | bool or object | Extended thinking config |

### The `tools` Field

Lists what an agent can use directly. Two syntaxes:

- **Plain name** — a primitive from the registry: `read_file`, `grep`, `glob`, `exec`, `write_file`, `edit_file`, `apply_patch`, `fetch`
- **`./name`** — a sprout-internal tool from this agent's `tools/` directory: `./task-cli`, `./sprout-mcp`

### The `agents` Field

Lists agent references beyond auto-discovered children. All paths are absolute from root:

```yaml
# Root opts into a utility agent
agents:
  - utility/task-manager

# Quartermaster opts into utility agents and a peer
agents:
  - utility/reader
  - project-explorer
```

---

## Directory Structure

The agent tree is a nested directory structure rooted at `root/`. The `bootstrap/` directory becomes `root/`.

```
root/
├── root.md                              # root agent spec
├── agents/                              # root's children
│   ├── tech-lead.md
│   ├── architect.md
│   ├── quartermaster.md
│   ├── verifier.md
│   ├── debugger.md
│   ├── project-explorer.md
│   │
│   ├── tech-lead/
│   │   └── agents/                      # tech-lead's children
│   │       ├── engineer.md
│   │       ├── spec-reviewer.md
│   │       └── quality-reviewer.md
│   │
│   ├── quartermaster/
│   │   ├── resources/
│   │   │   └── agent-tree-spec.md       # reference doc for agent creation
│   │   └── agents/                      # quartermaster's children
│   │       ├── qm-fabricator.md
│   │       ├── qm-indexer.md
│   │       ├── qm-planner.md
│   │       └── qm-reconciler.md
│   │
│   └── utility/
│       └── agents/                      # shared service agents
│           ├── reader.md
│           ├── editor.md
│           ├── command-runner.md
│           ├── web-reader.md
│           ├── mcp.md
│           └── task-manager.md
│
├── preambles/
│   ├── orchestrator.md
│   └── worker.md
│
└── (other non-agent resources)
```

### Conventions

At every level, the same pattern applies:

- **Agent spec:** `<name>.md`
- **Agent's children:** `<name>/agents/*.md`
- **Agent's tools:** `<name>/tools/`
- **Agent's resources:** `<name>/resources/`

Nesting depth is unlimited. If engineer needed sub-agents, they would live at `tech-lead/agents/engineer/agents/`.

### The `utility/` Namespace

`utility/` is a directory, not an agent. It has no `.md` spec file. It groups shared service agents (reader, editor, command-runner, etc.) that any orchestrator can reference by path.

No agent auto-discovers utility's children. Each caller must list an explicit entry in its `agents` field: `utility/reader`, `utility/task-manager`.

---

## Auto-Discovery

One rule, applied uniformly: **an agent auto-discovers its direct children.**

Children are the `.md` files in `<agent-name>/agents/`. Root's location is the `root/` directory, so root discovers `root/agents/*.md`.

| Agent | Discovers |
|-------|-----------|
| root | tech-lead, architect, quartermaster, verifier, debugger, project-explorer |
| tech-lead | engineer, spec-reviewer, quality-reviewer |
| quartermaster | qm-fabricator, qm-indexer, qm-planner, qm-reconciler |
| utility agents | nothing (leaves) |

An agent's full delegation set is: auto-discovered children + explicit `agents` field entries.

---

## Path Resolution & the Delegate Tool

### Paths

All agent paths are absolute from root. The path maps to the directory tree:

- `utility/reader` resolves to `root/agents/utility/agents/reader.md`
- `quartermaster/qm-indexer` resolves to `root/agents/quartermaster/agents/qm-indexer.md`
- `tech-lead/engineer` resolves to `root/agents/tech-lead/agents/engineer.md`
- `project-explorer` resolves to `root/agents/project-explorer.md`

Deeper nesting follows the pattern: `a/b/c` resolves to `root/agents/a/agents/b/agents/c.md`.

### The Delegate Tool

The delegate tool accepts any agent path as a string, not a restrictive enum. The system prompt lists known agents (auto-discovered + explicit) with descriptions in an `<agents>` block. The LLM can also delegate to a path it learned dynamically.

```
delegate(agent: string, goal: string, hints?: string[], blocking?: boolean)
```

If the path resolves to no valid agent, the tool returns an error.

### Dynamic Delegation

The quartermaster can create an agent and return its path. The calling agent then delegates to that path without any YAML update:

1. Root delegates to quartermaster: "I need an agent that formats code"
2. Quartermaster creates `utility/code-formatter` in the genome
3. Quartermaster returns: "Created agent at `utility/code-formatter`"
4. Root delegates to `utility/code-formatter` with a goal

The `agents` field defines static, always-available delegation targets. Dynamic paths enable runtime extensibility.

---

## Two-Layer Resolution

Agent specs resolve genome-first, then bootstrap — the same overlay model as tools.

For a path like `utility/reader`:

1. Check genome: `~/.local/share/sprout-genome/root/agents/utility/agents/reader.md`
2. Fall back to bootstrap: `root/agents/utility/agents/reader.md`
3. Genome wins when both exist

New agents created by the quartermaster exist only in the genome layer. The bootstrap layer provides the shipping defaults.

---

## Quartermaster Resources

The quartermaster and its sub-agents (especially qm-fabricator) need a reference document describing these conventions. This lives at `root/agents/quartermaster/resources/agent-tree-spec.md` and covers:

1. Agent spec format (YAML frontmatter fields + markdown body)
2. Directory conventions (`<name>.md`, `<name>/agents/`, `<name>/tools/`)
3. Field definitions (`tools` and `agents`)
4. Auto-discovery rules
5. Path resolution
6. Placement rules for new agents
7. Dynamic delegation

The quartermaster's system prompt references this resource and instructs sub-agents to follow these conventions when creating or modifying agents.

---

## What Changes

| What | Before | After |
|------|--------|-------|
| File format | `.yaml` | `.md` (YAML frontmatter + markdown body) |
| System prompt | `system_prompt:` YAML field | Markdown body |
| Tool/agent field | `capabilities` (mixed) | `tools` + `agents` (separate) |
| Tool syntax | plain names only | plain = primitive, `./` = local sprout-internal |
| Agent references | prescriptive allowlist | auto-discovery + explicit paths from root |
| Directory name | `bootstrap/` | `root/` |
| Directory layout | flat | nested agent tree |
| Delegate tool | enum of allowed names | any path, resolved at runtime |

## What Stays

- All frontmatter fields except `capabilities` and `system_prompt`
- Preamble system (orchestrator.md, worker.md prepended by role)
- Provider-aligned primitives (edit_file vs apply_patch swap)
- InternalToolContext for sprout-internal tools
- Bus-based spawning and in-process delegation
- Two-layer genome-over-bootstrap resolution

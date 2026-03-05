# Root Agent Delegation Architecture

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](./README.md)
- [Architecture](./architecture.md)
- [Testing](./testing.md)
- [Plans Index](./plans/README.md)
- [Audits Index](./audits/README.md)
- [Delegation Quick Start](./QUICK_START_DELEGATION_GUIDE.md)
<!-- DOCS_NAV:END -->

> Canonical doc (2026-03-04): this is the single source of truth for current delegation runtime behavior. Historical delegation guides were moved to `docs/archive/delegation/`.

## Overview

The orchestrator (root agent) is configured via Markdown specs (with YAML frontmatter) and determines available agents for delegation through an **agent tree routing system**. There is no hardcoded "shadow" list — agents are dynamically loaded from the root directory tree and the genome (git-backed agent repository).

> Contract update (2026-03-04): delegation routing is based on `spec.agents` (not `capabilities`), and runtime specs are markdown-based (`*.md`) rather than YAML files.

---

## 1. Root Agent Configuration

### File: `root/root.md`

The root agent is configured with:
- **Name**: `root`
- **Model**: `best` (resolves to the best available model from the LLM client)
- **Agents**: Subagent paths it can delegate to
  ```yaml
  agents:
    - utility/reader
    - utility/editor
    - utility/command-runner
    - utility/web-reader
    - utility/mcp
    - quartermaster
    - tech-lead
    - architect
    - verifier
    - debugger
  ```
- **Constraints**: 
  - `max_turns`: 200
  - `max_depth`: 3 (can spawn subagents up to depth 2)
  - `timeout_ms`: 0 (no timeout)
  - `can_learn`: true
- **Tags**: `[core, orchestration]`
- **System Prompt**: Instructs the agent to decompose tasks and delegate to specialists

### Key Design

The root agent's **system_prompt** explicitly states:
```
You NEVER read files, edit files, run commands, or fetch URLs directly.
You think at the level of goals: understand, find, edit, test, verify, research.
You delegate each goal to the appropriate specialist.
```

---

## 2. How Available Agents Are Determined

### Static Snapshot vs. Dynamic Loading

When a root agent is created, it receives a snapshot of available agents:

```typescript
// File: src/agents/factory.ts, line 108
const agent = new Agent({
  spec: rootSpec,
  env,
  client,
  primitiveRegistry: registry,
  availableAgents: genome.allAgents(),  // ← All agents from the genome
  genome,  // ← Also passed for dynamic lookup during execution
  events,
  learnProcess,
  sessionId,
  logBasePath,
  initialHistory: options.initialHistory,
  modelOverride: options.model,
});
```

The genome loads agents from disk:

```typescript
// File: src/genome/genome.ts, lines 253-266
async loadFromDisk(): Promise<void> {
  const agentsDir = join(this.rootPath, "agents");
  // ... read agents/directory
  const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of yamlFiles) {
    const spec = await loadAgentSpec(join(agentsDir, file));
    this.agents.set(spec.name, spec);
  }
}
```

And root initialization:

```typescript
// File: src/genome/genome.ts
async initFromRoot(rootDir: string): Promise<void> {
  const specs = await loadRootAgents(rootDir);
  for (const spec of specs) {
    const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
    await writeFile(yamlPath, serializeAgentSpec(spec));
    this.agents.set(spec.name, spec);
  }
}
```

---

## 3. Delegation Routing Logic

### Constructor: Building Agent Tools

When the root agent is constructed, it checks its `can_spawn` constraint. If true, it builds delegation tools from the agents listed in `spec.agents`:

```typescript
// File: src/agents/agent.ts
if (this.spec.constraints.can_spawn) {
  const delegatableAgents = this.getDelegatableAgents();
  if (delegatableAgents.length > 0) {
    this.agentTools.push(buildDelegateTool(delegatableAgents));
  }
}
```

**Key Points:**
1. Only agents listed in the root's `agents` list are made available for delegation
2. These agents are resolved from live genome/tree state
3. A single `delegate` tool is created with string params; available choices are shown in prompt context

### Runtime: Dynamic Delegation

During execution, the agent calls `getDelegatableAgents()` to get the current list:

```typescript
// File: src/agents/agent.ts
private getDelegatableAgents(): AgentSpec[] {
  // Resolve by tree path/name from spec.agents against live source.
  // (See resolver.ts for current path-aware behavior.)
}
```

**Key Insight:** If a genome exists, it prefers live agent specs from the genome over the static snapshot. This allows agents learned/updated since initialization to be available.

### Rendering for LLM Prompt

Before each planning step, delegatable agents are rendered into the system prompt:

```typescript
// File: src/agents/agent.ts, lines 425-428
if (this.spec.constraints.can_spawn) {
  const delegatableAgents = this.getDelegatableAgents();
  systemPrompt += renderAgentsForPrompt(delegatableAgents);
}
```

This produces XML like:
```xml
<agents>
  <agent name="reader">Read and analyze file contents</agent>
  <agent name="editor">Edit or create files</agent>
  ...
</agents>
```

### Tool Definition

The `delegate` tool accepts a string `agent_name`; known agents are provided in the `<agents>` prompt block:

```typescript
// File: src/agents/plan.ts, lines 14-41
export function buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
  const agentEnum = agents.map((a) => a.name);
  return {
    name: DELEGATE_TOOL_NAME,  // "delegate"
    description: "Delegate a task to a specialist agent...",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent to delegate to",
          enum: agentEnum.length > 0 ? agentEnum : undefined,
        },
        goal: { type: "string", description: "What you want this agent to achieve" },
        hints: { type: "array", items: { type: "string" }, description: "Optional context" },
      },
      required: ["agent_name", "goal"],
    },
  };
}
```

---

## 4. Execution: Delegation to Subagents

When the root agent issues a delegation, it executes it as follows:

```typescript
// File: src/agents/agent.ts, lines 220-268
private async executeDelegation(delegation: Delegation, agentId: string) {
  // Lookup subagent spec from genome or static snapshot
  const subagentSpec =
    this.genome?.getAgent(delegation.agent_name) ??
    this.availableAgents.find((a) => a.name === delegation.agent_name);

  if (!subagentSpec) {
    // Unknown agent — return error
    return { toolResultMsg: Msg.toolResult(delegation.call_id, errorMsg, true), stumbles: 1 };
  }

  // Create subagent instance with the same genome and availableAgents
  const subagent = new Agent({
    spec: subagentSpec,
    env: this.env,
    client: this.client,
    primitiveRegistry: this.primitiveRegistry,
    availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
    genome: this.genome,
    depth: this.depth + 1,
    // ... other options
  });

  const subResult = await subagent.run(subGoal, this.signal);
  // ... process result
}
```

**Inheritance Pattern:**
- Subagents receive the same `availableAgents` list (from genome or static snapshot)
- Subagents also receive the `genome` reference, so they can learn from it
- Each subagent respects its own `agents` list to determine what it can delegate to

---

## 5. Agent Spec Structure

Agents are defined as Markdown files with YAML frontmatter. The frontmatter contains configuration; the Markdown body becomes the system prompt.

```markdown
---
name: <agent-name>
description: "<human-readable description>"
model: <model-name>  # e.g., "best", "balanced", "fast"
tools:
  - <primitive-tool-name>
agents:                # Only for orchestrators
  - <subagent-path>
constraints:
  max_turns: <number>
  max_depth: <number>  # 0 = leaf agent, 1+ = can spawn subagents
  timeout_ms: <number>  # 0 = no timeout
  can_spawn: <boolean>   # Usually true for orchestrators, false for leaf agents
  can_learn: <boolean>
tags:
  - <tag>
version: <number>
---

<system prompt instructions in Markdown>
```

### Example: Reader Agent

```markdown
---
name: reader
description: "Read and understand file contents, search for patterns"
model: fast
tools:
  - read_file
  - grep
  - glob
constraints:
  max_turns: 50
  max_depth: 0
  can_spawn: false
  can_learn: true
tags:
  - leaf
  - read
version: 2
---

You specialize in reading and analyzing file contents...
```

---

## 6. No Hardcoded "Shadow" List

**Important:** There is **no hardcoded list of available agents elsewhere** in the codebase.

The available agents are always determined by:
1. **Bootstrap markdown specs** in the `root/` tree (initially loaded)
2. **Genome directory** `agents/` subdirectory (dynamically loaded and persisted)
3. **Root agent's `agents` list + runtime tree resolution** (restricts which agents it can delegate to)

Evidence:
- `src/agents/loader.ts`: Dynamically reads markdown agent specs from the root tree
- `src/genome/genome.ts`: Loads agents from the genome's `agents/` directory at startup
- `src/agents/factory.ts`: Creates agent with `availableAgents: genome.allAgents()` — no hardcoding
- `src/agents/agent.ts`: Filters delegatable agents via `spec.agents` + tree resolution

---

## 7. Root Agent Synchronization

When a new root agent is added:

```typescript
// File: src/agents/factory.ts
if (isExisting) {
  await genome.loadFromDisk();
  // Sync root agents using manifest-aware 4-way comparison
  if (options.rootDir) {
    const result = await genome.syncRoot(options.rootDir);
    if (result.added.length > 0) {
      console.error(`Synced new root agents: ${result.added.join(", ")}`);
    }
    if (result.updated.length > 0) {
      console.error(`Updated root agents: ${result.updated.join(", ")}`);
    }
    if (result.conflicts.length > 0) {
      console.error(`Root sync conflicts (genome preserved): ${result.conflicts.join(", ")}`);
    }
  }
}
```

The `syncRoot` method returns `{ added, updated, conflicts }` using a manifest-aware
4-way comparison (old manifest, new manifest, genome state, root state):
```typescript
// File: src/genome/genome.ts
async syncRoot(rootDir: string): Promise<SyncRootResult> {
  // Reads root files once, builds manifest from content hashes,
  // compares against old manifest and genome to determine:
  // - Case 1: New agent (not in genome) → add
  // - Case 2: Pre-manifest genome agent → skip (treat as evolved)
  // - Case 3: Root unchanged → skip
  // - Case 4: Root changed, genome unchanged → update
  // - Case 5: Both changed → conflict (genome preserved)
}
```

**Key Insight:** Evolved genome agents are never overwritten. Conflicts are reported but the genome version is preserved. Root metadata/tooling is reconciled via manifest-aware merge.

---

## 8. Current Root Agents (as of latest sync)

The `root/` directory tree contains:
- `root.md` — Root orchestrator (can_spawn: true, delegates to all others)
- `agents/utility/agents/reader.md` — File reading and analysis
- `agents/utility/agents/editor.md` — File editing
- `agents/utility/agents/command-runner.md` — Shell command execution
- `agents/utility/agents/web-reader.md` — Web fetching
- `agents/utility/agents/mcp.md` — Model Context Protocol integration
- `agents/utility/agents/task-manager.md` — Task tracking
- `agents/tech-lead.md` — Engineering orchestrator
- `agents/tech-lead/agents/engineer.md` — Implementation
- `agents/tech-lead/agents/spec-reviewer.md` — Spec compliance
- `agents/tech-lead/agents/quality-reviewer.md` — Code quality
- `agents/architect.md` — System design
- `agents/verifier.md` — Test & build verification
- `agents/debugger.md` — Systematic debugging
- `agents/project-explorer.md` — Codebase analysis
- `agents/quartermaster.md` — Quartermaster orchestrator
- `agents/quartermaster/agents/qm-fabricator.md` — Agent fabrication
- `agents/quartermaster/agents/qm-indexer.md` — Capability indexing
- `agents/quartermaster/agents/qm-planner.md` — Plan design
- `agents/quartermaster/agents/qm-reconciler.md` — Genome reconciliation

These are loaded dynamically via agent tree scanning, not hardcoded.

---

## 9. Summary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ root/ directory tree (source of truth for initial agents)       │
│ - root.md                                                       │
│ - agents/utility/agents/reader.md                               │
│ - agents/utility/agents/editor.md                               │
│ - agents/tech-lead.md, agents/quartermaster.md, etc.            │
└────────────────┬────────────────────────────────────────────────┘
                 │ (loadRootAgents)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Genome (genome/agents/ directory)                               │
│ - Persists all agents in git-backed repo                        │
│ - New root agents synced on startup                             │
│ - Learned/evolved agents stored here                            │
└────────────────┬────────────────────────────────────────────────┘
                 │ (genome.allAgents())
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Root Agent Instance (src/agents/agent.ts)                       │
│ - availableAgents: AgentSpec[] (from genome)                    │
│ - spec.agents: ["utility/reader", "utility/editor", ...]       │
│ - constraints.can_spawn: true                                   │
└────────────────┬────────────────────────────────────────────────┘
                 │ (agent tree resolution)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Delegate Tool (single tool for all agents)                      │
│ - String param: agent_name (choices supplied in prompt context) │
│ - Parameters: agent_name, goal, hints                           │
│ - Rendered in system prompt as <agents> section                 │
└────────────────┬────────────────────────────────────────────────┘
                 │ (LLM chooses agent_name from listed context)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Subagent Execution                                              │
│ - Create Agent(spec: subagentSpec, availableAgents: [...], ...) │
│ - Subagent respects its own agents/tools lists                  │
│ - Subagent can spawn further subagents (up to max_depth)        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Key Takeaways

1. **No hardcoded agent lists**: All agents are dynamically loaded from the root directory tree and the genome directory.

2. **Tree-based routing**: The root agent can only delegate to agents listed in its `agents` field or discovered via agent tree scanning.

3. **Dynamic vs. static**: At construction time, agents receive a static snapshot of available agents. At runtime, they prefer the genome's live copy if available.

4. **Genome is source of truth**: Once initialized, the genome becomes the persistent store for agents. New root agents are synced but don't overwrite learned agents.

5. **Recursive delegation**: Each agent respects its own `agents` list, allowing hierarchical delegation up to `max_depth`.

6. **Single delegate tool**: Instead of separate tools per agent, there's one `delegate` tool with an enum parameter, preserving prompt cache.

7. **System prompt guidance**: The LLM is instructed via the agent's system_prompt to decompose tasks and delegate appropriately. Agent descriptions appear in the `<agents>` XML section.

8. **Constraints enforce hierarchy**: `can_spawn: false` and `max_depth: 0` prevent leaf agents from spawning subagents.

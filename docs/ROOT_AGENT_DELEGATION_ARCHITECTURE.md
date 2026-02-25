# Root Agent Delegation Architecture

## Overview

The orchestrator (root agent) is configured via YAML and determines available agents for delegation through a **capability-based routing system**. There is no hardcoded "shadow" list — agents are dynamically loaded from the bootstrap directory and the genome (git-backed agent repository).

---

## 1. Root Agent Configuration

### File: `bootstrap/root.yaml`

The root agent is configured with:
- **Name**: `root`
- **Model**: `best` (resolves to the best available model from the LLM client)
- **Capabilities**: List of agent names it can delegate to
  ```yaml
  capabilities:
    - reader
    - editor
    - command-runner
    - web-reader
    - mcp
    - quartermaster
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

And bootstrap initialization:

```typescript
// File: src/genome/genome.ts, lines 283-296
async initFromBootstrap(bootstrapDir: string): Promise<void> {
  const specs = await loadBootstrapAgents(bootstrapDir);
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

When the root agent is constructed, it checks its `can_spawn` constraint. If true, it builds delegation tools based on its capabilities:

```typescript
// File: src/agents/agent.ts, lines 122-134
if (this.spec.constraints.can_spawn) {
  const delegatableAgents: AgentSpec[] = [];
  for (const cap of this.spec.capabilities) {
    if (cap === this.spec.name) continue;  // Don't delegate to itself
    const agentSpec = this.availableAgents.find((a) => a.name === cap);
    if (agentSpec) {
      delegatableAgents.push(agentSpec);
    }
  }
  if (delegatableAgents.length > 0) {
    this.agentTools.push(buildDelegateTool(delegatableAgents));
  }
}
```

**Key Points:**
1. Only agents listed in the root's `capabilities` are made available for delegation
2. These agents are looked up by name in the `availableAgents` snapshot
3. A single `delegate` tool is created with an enum of agent names

### Runtime: Dynamic Delegation

During execution, the agent calls `getDelegatableAgents()` to get the current list:

```typescript
// File: src/agents/agent.ts, lines 207-217
private getDelegatableAgents(): AgentSpec[] {
  const agents: AgentSpec[] = [];
  const source = this.genome ? this.genome.allAgents() : this.availableAgents;
  for (const cap of this.spec.capabilities) {
    if (cap === this.spec.name) continue;
    const agentSpec = source.find((a) => a.name === cap);
    if (agentSpec) agents.push(agentSpec);
  }
  return agents;
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

The `delegate` tool definition includes an enum of available agent names:

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
- Each subagent respects its own `capabilities` list to determine what it can delegate to

---

## 5. Agent YAML Structure

All agents in the bootstrap directory follow the same structure:

```yaml
name: <agent-name>
description: "<human-readable description>"
model: <model-name>  # e.g., "best", "gpt-4", "claude-opus"
capabilities:
  - <delegatable-agent-name>
  - <delegatable-agent-name>
  - <primitive-capability-name>
constraints:
  max_turns: <number>
  max_depth: <number>  # 0 = leaf agent, 1+ = can spawn subagents
  timeout_ms: <number>  # 0 = no timeout
  can_spawn: <boolean>   # Usually true for orchestrators, false for leaf agents
  can_learn: <boolean>
tags:
  - <tag>
version: <number>
system_prompt: |
  <detailed instructions for this agent>
```

### Example: Reader Agent

```yaml
name: reader
description: "Read and understand file contents, search for patterns"
model: best
capabilities:
  - read_file
  - grep
  - find_files
constraints:
  max_turns: 50
  max_depth: 0  # Leaf agent — cannot spawn subagents
  timeout_ms: 0
  can_spawn: false
  can_learn: true
tags:
  - leaf
  - read
version: 2
system_prompt: |
  You specialize in reading and analyzing file contents...
```

---

## 6. No Hardcoded "Shadow" List

**Important:** There is **no hardcoded list of available agents elsewhere** in the codebase.

The available agents are always determined by:
1. **Bootstrap YAML files** in `bootstrap/` directory (initially loaded)
2. **Genome directory** `agents/` subdirectory (dynamically loaded and persisted)
3. **Root agent's capabilities list** (restricts which agents it can delegate to)

Evidence:
- `src/agents/loader.ts`: Dynamically reads all `.yaml` and `.yml` files from the bootstrap directory
- `src/genome/genome.ts`: Loads agents from the genome's `agents/` directory at startup
- `src/agents/factory.ts`: Creates agent with `availableAgents: genome.allAgents()` — no hardcoding
- `src/agents/agent.ts`: Always filters delegatable agents based on the spec's capabilities list

---

## 7. Bootstrap Agent Synchronization

When a new bootstrap agent is added:

```typescript
// File: src/agents/factory.ts, lines 55-62
if (isExisting) {
  await genome.loadFromDisk();
  // Sync any new bootstrap agents that were added since the genome was initialized
  if (options.bootstrapDir) {
    const added = await genome.syncBootstrap(options.bootstrapDir);
    if (added.length > 0) {
      console.error(`Synced new bootstrap agents: ${added.join(", ")}`);
    }
  }
}
```

The `syncBootstrap` method:
```typescript
// File: src/genome/genome.ts, lines 304-327
async syncBootstrap(bootstrapDir: string): Promise<string[]> {
  const specs = await loadBootstrapAgents(bootstrapDir);
  const added: string[] = [];

  for (const spec of specs) {
    if (this.agents.has(spec.name)) continue;  // Skip existing agents

    const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
    await writeFile(yamlPath, serializeAgentSpec(spec));
    this.agents.set(spec.name, spec);
    added.push(spec.name);
  }

  if (added.length > 0) {
    await git(this.rootPath, "add", ".");
    await git(this.rootPath, "commit", "-m", `genome: sync bootstrap agents (${added.join(", ")})`);
  }

  return added;
}
```

**Key Insight:** New bootstrap agents are only added if they don't already exist in the genome. Learned/evolved agents are never overwritten.

---

## 8. Current Bootstrap Agents (as of latest sync)

File: `bootstrap/` directory contains:
- `root.yaml` — Orchestrator (can_spawn: true, delegates to all others)
- `reader.yaml` — File reading and analysis
- `editor.yaml` — File editing
- `command-runner.yaml` — Shell command execution
- `web-reader.yaml` — Web fetching
- `mcp.yaml` — Model Context Protocol integration
- `quartermaster.yaml` — Quartermaster orchestrator
- `qm-fabricator.yaml` — Quartermaster task fabricator
- `qm-indexer.yaml` — Quartermaster indexer
- `qm-planner.yaml` — Quartermaster planner

These are loaded dynamically, not hardcoded.

---

## 9. Summary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ bootstrap/ directory (source of truth for initial agents)       │
│ - root.yaml                                                     │
│ - reader.yaml                                                   │
│ - editor.yaml                                                   │
│ - etc.                                                          │
└────────────────┬────────────────────────────────────────────────┘
                 │ (loadBootstrapAgents)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Genome (genome/agents/ directory)                               │
│ - Persists all agents in git-backed repo                        │
│ - New bootstrap agents synced on startup                        │
│ - Learned/evolved agents stored here                            │
└────────────────┬────────────────────────────────────────────────┘
                 │ (genome.allAgents())
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Root Agent Instance (src/agents/agent.ts)                       │
│ - availableAgents: AgentSpec[] (from genome)                    │
│ - spec.capabilities: ["reader", "editor", "command-runner", ...] │
│ - constraints.can_spawn: true                                   │
└────────────────┬────────────────────────────────────────────────┘
                 │ (constructor filters by capabilities)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Delegate Tool (single tool for all agents)                      │
│ - Enum: ["reader", "editor", "command-runner", ...]            │
│ - Parameters: agent_name, goal, hints                           │
│ - Rendered in system prompt as <agents> section                 │
└────────────────┬────────────────────────────────────────────────┘
                 │ (LLM can choose any agent from enum)
                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ Subagent Execution                                              │
│ - Create Agent(spec: subagentSpec, availableAgents: [...], ...) │
│ - Subagent respects its own capabilities list                   │
│ - Subagent can spawn further subagents (up to max_depth)        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Key Takeaways

1. **No hardcoded agent lists**: All agents are dynamically loaded from bootstrap YAML files and the genome directory.

2. **Capability-based routing**: The root agent can only delegate to agents listed in its `capabilities` field.

3. **Dynamic vs. static**: At construction time, agents receive a static snapshot of available agents. At runtime, they prefer the genome's live copy if available.

4. **Genome is source of truth**: Once initialized, the genome becomes the persistent store for agents. New bootstrap agents are synced but don't overwrite learned agents.

5. **Recursive delegation**: Each agent respects its own `capabilities` list, allowing hierarchical delegation up to `max_depth`.

6. **Single delegate tool**: Instead of separate tools per agent, there's one `delegate` tool with an enum parameter, preserving prompt cache.

7. **System prompt guidance**: The LLM is instructed via the agent's system_prompt to decompose tasks and delegate appropriately. Agent descriptions appear in the `<agents>` XML section.

8. **Constraints enforce hierarchy**: `can_spawn: false` and `max_depth: 0` prevent leaf agents from spawning subagents.

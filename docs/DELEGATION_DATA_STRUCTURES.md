# Agent Delegation Data Structures

This document shows the key TypeScript interfaces and how data flows through the system.

---

## AgentSpec: Core Agent Definition

```typescript
// src/kernel/types.ts
export interface AgentSpec {
  name: string;                    // "root", "reader", "editor", etc.
  description: string;             // Human-readable description
  model: string;                   // "best", "gpt-4-turbo", "claude-opus", etc.
  capabilities: string[];          // List of delegatable agents OR primitive capabilities
  constraints: AgentConstraints;   // Max turns, depth, timeout, etc.
  tags: string[];                  // ["core", "leaf", "orchestration", etc.]
  version: number;                 // For tracking agent evolution
  system_prompt?: string;          // Instructions for this agent
  thinking?: boolean | { budget_tokens: number };  // Extended thinking config
}

export interface AgentConstraints {
  max_turns: number;               // 0 = unlimited
  max_depth: number;               // 0 = leaf (no spawning), 1+ = can spawn
  timeout_ms: number;              // 0 = no timeout
  can_spawn: boolean;              // Whether agent can delegate to subagents
  can_learn: boolean;              // Whether agent can be improved via learn process
}

export const DEFAULT_CONSTRAINTS: AgentConstraints = {
  max_turns: 50,
  max_depth: 0,    // Default: leaf agent
  timeout_ms: 0,
  can_spawn: false,
  can_learn: true,
};
```

---

## Root Agent YAML Example

```yaml
# bootstrap/root.yaml
name: root
description: "Decompose tasks into subgoals and delegate to specialist agents"
model: best
capabilities:
  - reader           # Delegatable agents
  - editor
  - command-runner
  - web-reader
  - mcp
  - quartermaster
constraints:
  max_turns: 200
  max_depth: 3       # Can create subagents up to depth 2
  timeout_ms: 0
  can_spawn: true    # ← KEY: This is what allows delegation
  can_learn: true
tags:
  - core
  - orchestration
version: 2
system_prompt: |
  You are a general-purpose agentic system that decomposes tasks and delegates to specialists.
  
  You NEVER read files, edit files, run commands, or fetch URLs directly.
  You think at the level of goals: understand, find, edit, test, verify, research.
  You delegate each goal to the appropriate specialist.
  
  When you receive a task:
  1. Break it into clear subgoals
  2. Delegate each subgoal to the right agent
  3. Verify the results
  4. Report completion or iterate if something failed
```

---

## Leaf Agent YAML Example

```yaml
# bootstrap/reader.yaml
name: reader
description: "Read and analyze file contents, search for patterns"
model: best
capabilities:
  - read_file      # Primitive capabilities (not agents)
  - grep
  - find_files
constraints:
  max_turns: 50
  max_depth: 0     # ← KEY: Leaf agent cannot spawn subagents
  timeout_ms: 0
  can_spawn: false # ← This is false for leaf agents
  can_learn: true
tags:
  - leaf
  - read
version: 2
system_prompt: |
  You are a file reading specialist. Your job is to read, search, and analyze file contents.
  
  You have access to these primitives:
  - read_file: Read a file from the filesystem
  - grep: Search file contents using regex patterns
  - find_files: Find files matching a glob pattern
  
  When asked to analyze files:
  1. Use find_files to locate relevant files
  2. Use grep to search for patterns
  3. Use read_file to examine interesting matches
  4. Return a clear summary of your findings
```

---

## AgentOptions: Constructor Parameters

```typescript
// src/agents/agent.ts
export interface AgentOptions {
  spec: AgentSpec;
  env: ExecutionEnvironment;
  client: Client;
  primitiveRegistry: PrimitiveRegistry;
  availableAgents: AgentSpec[];      // ← All agents in the system (filtered by capabilities)
  genome?: Genome;                   // ← Reference to persistent agent store
  depth?: number;                    // Current depth (0 = root, 1 = subagent, etc.)
  events?: AgentEventEmitter;
  sessionId?: string;
  learnProcess?: LearnProcess;
  logBasePath?: string;
  initialHistory?: Message[];
  modelOverride?: string;
}
```

---

## ToolDefinition: What Gets Sent to LLM

```typescript
// src/llm/types.ts
export interface ToolDefinition {
  name: string;                     // "delegate" or primitive name
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ParameterDef>;
    required: string[];
  };
}

// The actual delegate tool built by the root agent:
{
  name: "delegate",
  description: "Delegate a task to a specialist agent. See the <agents> section in your instructions for available agents and their descriptions.",
  parameters: {
    type: "object",
    properties: {
      agent_name: {
        type: "string",
        description: "Name of the agent to delegate to",
        enum: ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"],
        // ^ These come from root.capabilities that match agents in availableAgents
      },
      goal: {
        type: "string",
        description: "What you want this agent to achieve",
      },
      hints: {
        type: "array",
        items: { type: "string" },
        description: "Optional context that might help",
      },
    },
    required: ["agent_name", "goal"],
  },
}
```

---

## Delegation: What the LLM Produces

```typescript
// src/kernel/types.ts
export interface Delegation {
  call_id: string;       // Unique ID for this tool call
  agent_name: string;    // Which agent to delegate to
  goal: string;          // What the agent should do
  hints?: string[];      // Optional hints/context
}

// Example: LLM produces tool call
{
  id: "call_12345",
  name: "delegate",
  arguments: {
    agent_name: "reader",
    goal: "Find all TypeScript files in src/ and count the total lines of code",
    hints: [
      "Look for .ts and .tsx files",
      "Use grep to count lines efficiently"
    ]
  }
}

// Gets parsed into Delegation:
{
  call_id: "call_12345",
  agent_name: "reader",
  goal: "Find all TypeScript files in src/ and count the total lines of code",
  hints: ["Look for .ts and .tsx files", "Use grep to count lines efficiently"]
}
```

---

## Genome: Persistent Agent Store

```typescript
// src/genome/genome.ts
export class Genome {
  private readonly rootPath: string;
  private readonly agents = new Map<string, AgentSpec>();  // ← In-memory map
  readonly memories: MemoryStore;
  private routingRules: RoutingRule[] = [];

  // Key methods for agent management:
  
  agentCount(): number {
    return this.agents.size;
  }

  allAgents(): AgentSpec[] {
    return [...this.agents.values()];  // ← Used as availableAgents in Agent constructor
  }

  getAgent(name: string): AgentSpec | undefined {
    return this.agents.get(name);
  }

  async addAgent(spec: AgentSpec): Promise<void> {
    // Write to genome/agents/{name}.yaml and commit to git
  }

  async loadFromDisk(): Promise<void> {
    // Read all YAML files from genome/agents/ into this.agents map
  }

  async initFromBootstrap(bootstrapDir: string): Promise<void> {
    // Read bootstrap/ directory and write each agent to genome/agents/
  }

  async syncBootstrap(bootstrapDir: string): Promise<string[]> {
    // Add any new bootstrap agents that aren't already in genome
  }
}
```

---

## Delegation Flow Data Structure

```
┌─────────────────────────────────────────────────────┐
│ root.yaml (bootstrap/root.yaml)                     │
├─────────────────────────────────────────────────────┤
│ name: "root"                                        │
│ capabilities: ["reader", "editor", "command-      │
│               "runner", "web-reader", "mcp",       │
│               "quartermaster"]                     │
│ constraints: { can_spawn: true, max_depth: 3, ... }│
└──────────────────┬──────────────────────────────────┘
                   │
                   │ loadBootstrapAgents("bootstrap/")
                   ▼
┌─────────────────────────────────────────────────────┐
│ AgentSpec[] (loaded from YAML)                      │
├─────────────────────────────────────────────────────┤
│ [                                                   │
│   { name: "root", capabilities: [...], ... },     │
│   { name: "reader", capabilities: [...], ... },   │
│   { name: "editor", capabilities: [...], ... },   │
│   ...                                               │
│ ]                                                   │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ genome.initFromBootstrap()
                   │ or genome.syncBootstrap()
                   ▼
┌─────────────────────────────────────────────────────┐
│ Genome.agents Map<string, AgentSpec>               │
├─────────────────────────────────────────────────────┤
│ {                                                   │
│   "root" → { name: "root", capabilities: [...] }  │
│   "reader" → { name: "reader", ... }              │
│   "editor" → { name: "editor", ... }              │
│   ...                                               │
│ }                                                   │
│                                                     │
│ ← Persisted to: genome/agents/{name}.yaml         │
│ ← Tracked in git with commits                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ createAgent() calls:
                   │ new Agent({
                   │   spec: root,
                   │   availableAgents: genome.allAgents()
                   │ })
                   ▼
┌─────────────────────────────────────────────────────┐
│ Agent Constructor                                   │
├─────────────────────────────────────────────────────┤
│ this.availableAgents = [                           │
│   { name: "reader", ... },                         │
│   { name: "editor", ... },                         │
│   { name: "command-runner", ... },                 │
│   { name: "web-reader", ... },                     │
│   { name: "mcp", ... },                            │
│   { name: "quartermaster", ... }                   │
│ ]                                                   │
│                                                     │
│ For each capability in root.capabilities:         │
│   agentSpec = this.availableAgents.find(...)      │
│   if (agentSpec) delegatableAgents.push(...)      │
│                                                     │
│ this.agentTools = [                                │
│   buildDelegateTool(delegatableAgents)             │
│ ]                                                   │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ buildDelegateTool()
                   ▼
┌─────────────────────────────────────────────────────┐
│ ToolDefinition (delegate tool)                      │
├─────────────────────────────────────────────────────┤
│ {                                                   │
│   name: "delegate",                                │
│   description: "Delegate a task to a specialist...",│
│   parameters: {                                     │
│     type: "object",                                │
│     properties: {                                   │
│       agent_name: {                                │
│         type: "string",                            │
│         enum: ["reader", "editor", "command-      │
│                 "runner", "web-reader", "mcp",    │
│                 "quartermaster"]                   │
│         // ← Limited by root's capabilities       │
│       },                                            │
│       goal: { type: "string", ... },              │
│       hints: { type: "array", ... }               │
│     },                                              │
│     required: ["agent_name", "goal"]              │
│   }                                                 │
│ }                                                   │
│                                                     │
│ ← Sent to LLM in request                          │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ LLM generates tool call
                   ▼
┌─────────────────────────────────────────────────────┐
│ ToolCall (LLM output)                               │
├─────────────────────────────────────────────────────┤
│ {                                                   │
│   id: "call_abc123",                               │
│   name: "delegate",                                │
│   arguments: {                                      │
│     agent_name: "reader",                          │
│     goal: "Find TypeScript files and count LOC",  │
│     hints: ["Use grep for efficiency"]            │
│   }                                                 │
│ }                                                   │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ parsePlanResponse()
                   ▼
┌─────────────────────────────────────────────────────┐
│ Delegation                                          │
├─────────────────────────────────────────────────────┤
│ {                                                   │
│   call_id: "call_abc123",                          │
│   agent_name: "reader",                            │
│   goal: "Find TypeScript files and count LOC",    │
│   hints: ["Use grep for efficiency"]              │
│ }                                                   │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ executeDelegation()
                   ├─ genome.getAgent("reader") → AgentSpec
                   ├─ new Agent({
                   │    spec: reader,
                   │    availableAgents: genome.allAgents()
                   │  })
                   ├─ subagent.run(goal)
                   └─ Return ActResult
                   ▼
┌─────────────────────────────────────────────────────┐
│ ActResult                                           │
├─────────────────────────────────────────────────────┤
│ {                                                   │
│   agent_name: "reader",                            │
│   goal: "Find TypeScript files and count LOC",    │
│   output: "Found 42 TS files, 12,847 total LOC",  │
│   success: true,                                   │
│   stumbles: 0,                                      │
│   turns: 3,                                         │
│   timed_out: false                                 │
│ }                                                   │
│                                                     │
│ ← Converted to tool result message                │
│ ← Added back to conversation history              │
└─────────────────────────────────────────────────────┘
```

---

## Memory Map: Agents in Genome

After loading, the Genome object contains:

```typescript
Genome {
  rootPath: "/path/to/genome",
  agents: Map {
    "root" → AgentSpec { name: "root", capabilities: [...], ... },
    "reader" → AgentSpec { name: "reader", ... },
    "editor" → AgentSpec { name: "editor", ... },
    "command-runner" → AgentSpec { name: "command-runner", ... },
    "web-reader" → AgentSpec { name: "web-reader", ... },
    "mcp" → AgentSpec { name: "mcp", ... },
    "quartermaster" → AgentSpec { name: "quartermaster", ... },
    // ... any learned/evolved agents ...
  },
  memories: MemoryStore { ... },
  routingRules: [
    { id: "rule_1", condition: "when task is about coding", agents: [...], ... },
    // ... routing hints learned from past delegations ...
  ]
}
```

The agents are also persisted on disk:
```
genome/
├─ agents/
│  ├─ root.yaml
│  ├─ reader.yaml
│  ├─ editor.yaml
│  ├─ command-runner.yaml
│  ├─ web-reader.yaml
│  ├─ mcp.yaml
│  ├─ quartermaster.yaml
│  └─ ... (any newly learned agents)
├─ memories/
│  └─ memories.jsonl
├─ routing/
│  └─ rules.yaml
├─ embeddings/
├─ metrics/
├─ logs/
└─ .git/  (version control)
```

---

## Recursion: Building Subagents

When a parent agent creates a subagent:

```typescript
// Parent Agent (e.g., root)
const parentAgent = new Agent({
  spec: rootSpec,
  availableAgents: [reader, editor, command-runner, ...],  // From genome
  genome: genomeInstance,
  depth: 0,
});

// When parent delegations to reader:
const subagent = new Agent({
  spec: readerSpec,
  availableAgents: [reader, editor, command-runner, ...],  // SAME list
  genome: genomeInstance,  // SAME genome
  depth: 1,  // Incremented
});

// Reader can then delegate to agents in ITS capabilities:
// readerSpec.capabilities = ["read_file", "grep", ...]
// But if it had [other_agent_name], it could delegate further

// Building even deeper:
const subsubagent = new Agent({
  spec: otherAgentSpec,
  availableAgents: [reader, editor, command-runner, ...],
  genome: genomeInstance,
  depth: 2,
});

// Stops when depth >= maxDepth or can_spawn = false
```

---

## Key Insights on Data Flow

1. **No data duplication**: `availableAgents` is derived from `genome.allAgents()`, not copied
2. **Live references**: genome is passed to subagents, so learned agents are immediately visible
3. **Capability filtering**: Each agent only delegates to agents it explicitly lists
4. **YAML as single source of truth**: All agent definitions come from YAML files, never hardcoded
5. **Tool enum is restrictive**: The delegate tool's enum limits what the LLM can choose
6. **Validation happens early**: `parsePlanResponse()` validates agent names before delegation
7. **Recursive architecture**: Each subagent gets the same availableAgents and genome, enabling arbitrary nesting

---

## Constraints Enforcement

```typescript
// Constructor: Check if agent can spawn at all
if (this.spec.constraints.can_spawn) {
  // Build delegate tool
}

// Agent.run(): Check if agent exceeded depth
if (this.spec.constraints.max_depth > 0 && this.depth >= this.spec.constraints.max_depth) {
  throw new Error(`Agent exceeds max depth...`);
}

// Agent.run(): Check turn limit
if (turns >= this.spec.constraints.max_turns) {
  success = false;
  break;
}

// Agent.run(): Check timeout
if (this.spec.constraints.timeout_ms > 0 && elapsed >= this.spec.constraints.timeout_ms) {
  break;
}
```

---

## Summary

The data structures are:
- **AgentSpec**: YAML-loaded definition of an agent
- **Genome**: In-memory map of AgentSpecs, persisted to git
- **ToolDefinition**: What gets sent to LLM (includes enum from capabilities)
- **Delegation**: Parsed tool call from LLM
- **ActResult**: Subagent execution result

The flow is:
1. Load YAML → AgentSpec[]
2. Persist to Genome
3. Create Agent with Genome.allAgents()
4. Filter by capabilities → build delegate tool
5. LLM sees tool enum → picks agent
6. Validate and execute delegation
7. Create subagent with same availableAgents
8. Recursive loop

# File Reference Guide - Agent Delegation

Quick reference for all files involved in agent delegation and configuration.

---

## Bootstrap Agent Configuration Files

### `bootstrap/root.yaml` (Lines 1-47)
The root agent orchestrator configuration.

**Key fields:**
- `name: root` - Orchestrator name
- `capabilities: [reader, editor, command-runner, web-reader, mcp, quartermaster]` - Available agents
- `constraints.can_spawn: true` - Enables delegation
- `constraints.max_depth: 3` - Can create nested subagents
- `system_prompt: |` - Instructions to decompose and delegate

**Usage:** Loaded during `createAgent()` → becomes the agent that decomposes tasks

---

### `bootstrap/reader.yaml` (example leaf agent)
Example of a non-delegating agent.

**Key fields:**
- `name: reader` - Agent name
- `capabilities: [read_file, grep, find_files]` - Primitive capabilities, not agents
- `constraints.can_spawn: false` - Cannot delegate
- `constraints.max_depth: 0` - Leaf agent

---

### `bootstrap/` Directory Structure
```
bootstrap/
├─ root.yaml                  ← Orchestrator
├─ quartermaster.yaml         ← Another orchestrator
├─ qm-fabricator.yaml        ├─ Quartermaster subagents
├─ qm-indexer.yaml           │
├─ qm-planner.yaml           ├─
├─ reader.yaml               ← Leaf agents
├─ editor.yaml               │
├─ command-runner.yaml       ├─
├─ web-reader.yaml           │
└─ mcp.yaml                  ├─
```

All `.yaml` and `.yml` files are automatically loaded.

---

## Agent Loading and Setup

### `src/agents/loader.ts` (Lines 1-32)
Loads agent YAML files from disk.

**Functions:**

#### `loadBootstrapAgents(dir: string): Promise<AgentSpec[]>` (lines 28-32)
```typescript
export async function loadBootstrapAgents(dir: string): Promise<AgentSpec[]> {
  const files = await readdir(dir);
  const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  return Promise.all(yamlFiles.map((f) => loadAgentSpec(join(dir, f))));
}
```
- Reads all YAML/YML files from bootstrap directory
- Parses each into AgentSpec
- Returns array of AgentSpec objects

#### `loadAgentSpec(path: string): Promise<AgentSpec>` (lines 6-26)
```typescript
export async function loadAgentSpec(path: string): Promise<AgentSpec> {
  const content = await readFile(path, "utf-8");
  const raw = parse(content);  // YAML parse
  
  // Validate required fields: name, description, system_prompt, model
  // ...
  
  return {
    name: raw.name,
    description: raw.description,
    system_prompt: raw.system_prompt,
    model: raw.model,
    capabilities: raw.capabilities ?? [],
    constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
    tags: raw.tags ?? [],
    version: raw.version ?? 1,
  };
}
```
- Parses single YAML file
- Validates required fields
- Merges constraints with defaults
- Returns AgentSpec object

---

### `src/agents/factory.ts` (Lines 49-128)
Factory for creating Agent instances with genome setup.

**Function:**

#### `createAgent(options: CreateAgentOptions): Promise<CreateAgentResult>` (lines 49-128)
Main entry point for creating an agent.

**Flow (lines 50-116):**
1. `new Genome(options.genomePath)` - Create genome instance
2. `existsSync(join(options.genomePath, ".git"))` - Check if genome exists
3. If existing: `genome.loadFromDisk()` (line 56)
4. If new: `genome.init()` then `genome.initFromBootstrap()` (lines 65-68)
5. `genome.getAgent(rootName)` - Get root agent spec (line 72)
6. `new Agent({ spec: rootSpec, availableAgents: genome.allAgents(), genome, ... })` (lines 103-116)

**Returns:** CreateAgentResult with agent, genome, events, learnProcess, client, model

**Key line 108:** `availableAgents: genome.allAgents()` - All agents passed to root agent

---

## Genome: Persistent Agent Store

### `src/genome/genome.ts` (Lines 1-400+)
Manages persistent storage of agents in git.

**Class:** `Genome`

#### Constructor (lines 36-39)
```typescript
constructor(rootPath: string) {
  this.rootPath = rootPath;
  this.memories = new MemoryStore(join(rootPath, "memories", "memories.jsonl"));
  // Agents map initialized empty
}
```

#### Agent Methods

##### `allAgents(): AgentSpec[]` (lines 81-83)
```typescript
allAgents(): AgentSpec[] {
  return [...this.agents.values()];
}
```
**Usage:** Called in factory.ts line 108 to get `availableAgents` for root agent

##### `getAgent(name: string): AgentSpec | undefined` (lines 86-88)
```typescript
getAgent(name: string): AgentSpec | undefined {
  return this.agents.get(name);
}
```
**Usage:** Called in agent.ts to look up subagent specs during delegation

##### `loadFromDisk(): Promise<void>` (lines 252-280)
```typescript
async loadFromDisk(): Promise<void> {
  const agentsDir = join(this.rootPath, "agents");
  const files = await readdir(agentsDir);
  const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of yamlFiles) {
    const spec = await loadAgentSpec(join(agentsDir, file));
    this.agents.set(spec.name, spec);
  }
  // Also load memories and routing rules
}
```
**Usage:** Called in factory.ts line 56 for existing genomes
**Key line 264:** Calls `loadAgentSpec()` for each YAML file

##### `initFromBootstrap(bootstrapDir: string): Promise<void>` (lines 282-297)
```typescript
async initFromBootstrap(bootstrapDir: string): Promise<void> {
  if (this.agents.size > 0) {
    throw new Error("Cannot initialize from bootstrap: agents already exist");
  }
  
  const specs = await loadBootstrapAgents(bootstrapDir);
  for (const spec of specs) {
    const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
    await writeFile(yamlPath, serializeAgentSpec(spec));
    this.agents.set(spec.name, spec);
  }
  
  await git(this.rootPath, "add", ".");
  await git(this.rootPath, "commit", "-m", "genome: initialize from bootstrap agents");
}
```
**Usage:** Called in factory.ts line 67 for new genomes
**Key lines:**
- 288: `loadBootstrapAgents(bootstrapDir)` - Load all YAML files
- 292: `this.agents.set(spec.name, spec)` - Store in memory
- 295-296: Commit to git

##### `syncBootstrap(bootstrapDir: string): Promise<string[]>` (lines 304-327)
```typescript
async syncBootstrap(bootstrapDir: string): Promise<string[]> {
  const specs = await loadBootstrapAgents(bootstrapDir);
  const added: string[] = [];

  for (const spec of specs) {
    if (this.agents.has(spec.name)) continue;  // Don't overwrite existing

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
**Usage:** Called in factory.ts line 59 to add new bootstrap agents to existing genome
**Key insight line 309:** Skip agents that already exist - never overwrite learned agents

---

## Agent: Core Orchestration Logic

### `src/agents/agent.ts` (Lines 1-746)
Main Agent class that handles delegation.

**Class:** `Agent`

#### Constructor (lines 94-157)
**Key lines for delegation:**

Lines 122-134: Build delegate tool if can_spawn
```typescript
if (this.spec.constraints.can_spawn) {
  const delegatableAgents: AgentSpec[] = [];
  for (const cap of this.spec.capabilities) {
    if (cap === this.spec.name) continue;
    const agentSpec = this.availableAgents.find((a) => a.name === cap);  // ← CRITICAL lookup
    if (agentSpec) {
      delegatableAgents.push(agentSpec);
    }
  }
  if (delegatableAgents.length > 0) {
    this.agentTools.push(buildDelegateTool(delegatableAgents));
  }
}
```
**Logic:**
1. Check `can_spawn: true`
2. For each capability in agent spec
3. Find matching agent in `availableAgents` by name
4. Add to delegatable list
5. Build single delegate tool with enum

#### getDelegatableAgents (lines 207-217)
```typescript
private getDelegatableAgents(): AgentSpec[] {
  const agents: AgentSpec[] = [];
  const source = this.genome ? this.genome.allAgents() : this.availableAgents;  // ← Dynamic vs static
  for (const cap of this.spec.capabilities) {
    if (cap === this.spec.name) continue;
    const agentSpec = source.find((a) => a.name === cap);
    if (agentSpec) agents.push(agentSpec);
  }
  return agents;
}
```
**Purpose:** Get current agents at runtime
**Key line 210:** Prefer genome (live) over availableAgents (static)

#### run (lines 330-745)
Main agent execution loop.

**Key sections for delegation:**

Lines 425-428: Render agents to prompt
```typescript
if (this.spec.constraints.can_spawn) {
  const delegatableAgents = this.getDelegatableAgents();
  systemPrompt += renderAgentsForPrompt(delegatableAgents);
}
```

Lines 476-484: Build LLM request with delegate tool
```typescript
const request = buildPlanRequest({
  systemPrompt,
  history,
  agentTools: this.agentTools,     // ← Contains delegate tool
  primitiveTools: this.primitiveTools,
  model: this.resolved.model,
  provider: this.resolved.provider,
  thinking: this.spec.thinking,
});
```

Lines 561-592: Parse delegations and execute
```typescript
const agentNames = new Set(this.availableAgents.map((a) => a.name));
const { delegations, errors: delegationErrors } = parsePlanResponse(toolCalls, agentNames);

// Execute all delegations concurrently
const delegationPromises = delegations.map((delegation) =>
  this.executeDelegation(delegation, agentId).then((dr) => {
    resultByCallId.set(delegation.call_id, dr.toolResultMsg);
    delegationStumbles += dr.stumbles;
    if (dr.output !== undefined) lastOutput = dr.output;
  }),
);
await Promise.all(delegationPromises);
```

#### executeDelegation (lines 219-328)
Execute a delegation to a subagent.

**Key lookup lines 229-231:**
```typescript
const subagentSpec =
  this.genome?.getAgent(delegation.agent_name) ??  // ← Prefer genome
  this.availableAgents.find((a) => a.name === delegation.agent_name);
```

**Create subagent lines 254-266:**
```typescript
const subagent = new Agent({
  spec: subagentSpec,
  env: this.env,
  client: this.client,
  primitiveRegistry: this.primitiveRegistry,
  availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,  // ← Pass same list
  genome: this.genome,  // ← Pass same genome
  depth: this.depth + 1,
  events: this.events,
  sessionId: this.sessionId,
  learnProcess: this.learnProcess,
  logBasePath: subLogBasePath,
});
```
**Key insights:**
- Subagent gets same `availableAgents`
- Subagent gets same `genome`
- Depth incremented
- Subagent.run() called recursively

---

## Planning and Delegation

### `src/agents/plan.ts` (Lines 1-260)
Handles prompt generation and delegation parsing.

#### buildDelegateTool (lines 14-41)
```typescript
export function buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
  const agentEnum = agents.map((a) => a.name);  // ← ["reader", "editor", ...]
  return {
    name: DELEGATE_TOOL_NAME,  // "delegate"
    description: "Delegate a task to a specialist agent...",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent to delegate to",
          enum: agentEnum.length > 0 ? agentEnum : undefined,  // ← LLM constraint
        },
        goal: { type: "string", description: "What you want this agent to achieve" },
        hints: { type: "array", items: { type: "string" }, description: "Optional context" },
      },
      required: ["agent_name", "goal"],
    },
  };
}
```
**Purpose:** Create single tool with enum limiting choices
**Key line 26:** enum parameter restricts LLM to valid agent names

#### renderAgentsForPrompt (lines 46-52)
```typescript
export function renderAgentsForPrompt(agents: AgentSpec[]): string {
  if (agents.length === 0) return "";
  const entries = agents
    .map((a) => `  <agent name="${a.name}">${a.description}</agent>`)
    .join("\n");
  return `\n\n<agents>\n${entries}\n</agents>`;
}
```
**Purpose:** Inject agent descriptions into system prompt
**Output:** XML section with agent list for LLM

#### buildSystemPrompt (lines 90-115)
```typescript
export function buildSystemPrompt(
  spec: AgentSpec,
  workDir: string,
  platform: string,
  osVersion: string,
  recallContext?: { memories?: Memory[]; routingHints?: RoutingRule[] },
): string {
  const today = new Date().toISOString().slice(0, 10);
  let prompt = `${spec.system_prompt}

<environment>
Working directory: ${workDir}
Platform: ${platform}
OS version: ${osVersion}
Today's date: ${today}
</environment>`;
  // Add memories and routing hints...
  return prompt;
}
```
**Purpose:** Build complete system prompt for agent
**Usage:** In agent.ts line 416

#### buildPlanRequest (lines 120-153)
```typescript
export function buildPlanRequest(opts: {
  systemPrompt: string;
  history: Message[];
  agentTools: ToolDefinition[];
  primitiveTools: ToolDefinition[];
  model: string;
  provider: string;
  maxTokens?: number;
  thinking?: boolean | { budget_tokens: number };
}): Request {
  const request: Request = {
    model: opts.model,
    provider: opts.provider,
    messages: [Msg.system(opts.systemPrompt), ...opts.history],
    tools: [...opts.agentTools, ...opts.primitiveTools],  // ← Includes delegate tool
    tool_choice: "auto",
    max_tokens: opts.maxTokens ?? 16384,
  };
  // Handle thinking mode...
  return request;
}
```
**Purpose:** Build LLM request with tools and system prompt
**Key line 134:** Tools array includes delegate tool

#### parsePlanResponse (lines 167-228)
```typescript
export function parsePlanResponse(
  toolCalls: ToolCall[],
  agentNames?: Set<string>,
): {
  delegations: Delegation[];
  primitiveCalls: ToolCall[];
  errors: DelegationError[];
} {
  // ... parse tool calls into delegations and primitives ...
  
  for (const call of toolCalls) {
    if (call.name === DELEGATE_TOOL_NAME) {
      const agentName = call.arguments.agent_name;
      if (typeof agentName !== "string" || agentName.length === 0) {
        errors.push({ call_id: call.id, error: "..." });
        continue;
      }
      const goal = call.arguments.goal;
      if (typeof goal !== "string" || goal.length === 0) {
        errors.push({ call_id: call.id, error: "..." });
        continue;
      }
      delegations.push({
        call_id: call.id,
        agent_name: agentName,
        goal,
        hints: Array.isArray(call.arguments.hints) ? call.arguments.hints : undefined,
      });
    } else {
      primitiveCalls.push(call);
    }
  }

  return { delegations, primitiveCalls, errors };
}
```
**Purpose:** Validate and parse LLM tool calls into delegations
**Key validations:**
- agent_name must be non-empty string
- goal must be non-empty string
- hints must be array if present

---

## Type Definitions

### `src/kernel/types.ts`

#### AgentSpec (lines TBD)
```typescript
export interface AgentSpec {
  name: string;
  description: string;
  model: string;
  capabilities: string[];
  constraints: AgentConstraints;
  tags: string[];
  version: number;
  system_prompt?: string;
  thinking?: boolean | { budget_tokens: number };
}

export interface AgentConstraints {
  max_turns: number;
  max_depth: number;
  timeout_ms: number;
  can_spawn: boolean;
  can_learn: boolean;
}

export const DEFAULT_CONSTRAINTS: AgentConstraints = {
  max_turns: 50,
  max_depth: 0,
  timeout_ms: 0,
  can_spawn: false,
  can_learn: true,
};
```

#### Delegation (lines TBD)
```typescript
export interface Delegation {
  call_id: string;
  agent_name: string;
  goal: string;
  hints?: string[];
}

export interface ActResult {
  agent_name: string;
  goal: string;
  output: string;
  success: boolean;
  stumbles: number;
  turns: number;
  timed_out: boolean;
}
```

---

## LLM Types

### `src/llm/types.ts`

#### ToolDefinition
```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ParameterDef>;
    required: string[];
  };
}
```

#### ToolCall
```typescript
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

---

## Summary: Call Chain

```
main/cli.ts
  ↓
createAgent() [src/agents/factory.ts:49]
  ├─ new Genome() [src/genome/genome.ts:36]
  ├─ genome.loadFromDisk() [src/genome/genome.ts:252]
  │  └─ loadAgentSpec() [src/agents/loader.ts:6]
  ├─ genome.getAgent("root") [src/genome/genome.ts:86]
  └─ new Agent() [src/agents/agent.ts:94]
     ├─ buildDelegateTool(delegatableAgents) [src/agents/plan.ts:14]
     └─ return agent
       ↓
agent.run(goal) [src/agents/agent.ts:330]
  ├─ getDelegatableAgents() [src/agents/agent.ts:207]
  ├─ renderAgentsForPrompt() [src/agents/plan.ts:46]
  ├─ buildSystemPrompt() [src/agents/plan.ts:90]
  ├─ buildPlanRequest() [src/agents/plan.ts:120]
  │  └─ client.complete(request) [call LLM with delegate tool]
  ├─ LLM returns tool calls
  ├─ parsePlanResponse(toolCalls) [src/agents/plan.ts:167]
  ├─ executeDelegation(delegation) [src/agents/agent.ts:219]
  │  ├─ genome.getAgent(agent_name) [src/genome/genome.ts:86]
  │  └─ new Agent() [src/agents/agent.ts:94] ← Recursive
  │     └─ subagent.run(goal)
  └─ continue loop
```

---

## Files NOT Involved

These files exist but are NOT part of the core delegation logic:

- `src/host/` - Session management, not delegation routing
- `src/learn/` - Learning process, not delegation
- `src/tui/` - Terminal UI, not delegation
- `src/llm/openai.ts`, `src/llm/anthropic.ts`, etc. - LLM clients, not delegation logic
- Test files - Not part of runtime
- `src/index.ts`, `src/mcp-cli.ts` - Entry points, not core logic

---

## Files You Should Know

To understand delegation completely, read in this order:

1. **Start here:**
   - `bootstrap/root.yaml` - See the configuration
   - `src/kernel/types.ts` - Understand AgentSpec and types

2. **Loading:**
   - `src/agents/loader.ts` - How YAML is loaded
   - `src/genome/genome.ts` - How agents are persisted

3. **Creation:**
   - `src/agents/factory.ts` - How agent is created
   - `src/agents/agent.ts` lines 94-157 - Constructor that builds delegate tool

4. **Planning:**
   - `src/agents/plan.ts` - All prompt and tool generation
   - `src/agents/agent.ts` lines 330-441 - Main loop and planning

5. **Execution:**
   - `src/agents/agent.ts` lines 219-328 - Delegation execution
   - Understand the recursion in `executeDelegation()`

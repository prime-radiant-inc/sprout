# Delegation Code Flow - Detailed Walkthrough

This document traces exactly how the root agent determines what agents are available for delegation.

---

## Phase 1: Agent Factory Setup

When a session starts, the main entry point calls `createAgent()`:

```typescript
// src/agents/factory.ts, lines 49-128
export async function createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
  // Step 1: Initialize genome (git-backed agent repository)
  const genome = new Genome(options.genomePath);

  // Step 2: Check if genome exists or needs bootstrap
  const isExisting = existsSync(join(options.genomePath, ".git"));

  if (isExisting) {
    // Step 3a: Load existing agents from genome directory
    await genome.loadFromDisk();
    
    // Step 3b: Sync new bootstrap agents (if any added since initialization)
    if (options.bootstrapDir) {
      const added = await genome.syncBootstrap(options.bootstrapDir);
      if (added.length > 0) {
        console.error(`Synced new bootstrap agents: ${added.join(", ")}`);
      }
    }
  } else {
    // Step 4a: Initialize new genome
    await genome.init();
    
    // Step 4b: Load bootstrap agents into new genome
    if (options.bootstrapDir) {
      await genome.initFromBootstrap(options.bootstrapDir);
    }
  }

  // Step 5: Get root agent spec from genome
  const rootName = options.rootAgent ?? "root";
  const rootSpec = genome.getAgent(rootName);
  if (!rootSpec) {
    throw new Error(`Root agent '${rootName}' not found...`);
  }

  // Step 6: Create LLM client and primitives registry
  const client = options.client ?? Client.fromEnv();
  const registry = createPrimitiveRegistry(env);

  // Step 7: Create root agent with genome.allAgents() as available agents
  const agent = new Agent({
    spec: rootSpec,
    env,
    client,
    primitiveRegistry: registry,
    availableAgents: genome.allAgents(),  // ← KEY: All agents from genome
    genome,                                 // ← Also pass genome for runtime lookup
    events,
    learnProcess,
    sessionId,
    logBasePath,
    initialHistory: options.initialHistory,
    modelOverride: options.model,
  });

  return { agent, genome, events, learnProcess, client, model, provider };
}
```

---

## Phase 2: Bootstrap Agent Loading

When `genome.loadFromDisk()` or `genome.initFromBootstrap()` is called:

### 2a. Load from Existing Genome

```typescript
// src/genome/genome.ts, lines 252-280
async loadFromDisk(): Promise<void> {
  // Load agents
  const agentsDir = join(this.rootPath, "agents");
  let files: string[];
  try {
    files = await readdir(agentsDir);
  } catch {
    files = [];
  }
  
  // Filter YAML files
  const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  
  // Load each agent YAML
  for (const file of yamlFiles) {
    const spec = await loadAgentSpec(join(agentsDir, file));
    this.agents.set(spec.name, spec);  // ← Store in memory map
  }

  // Also load memories and routing rules
  await this.memories.load();
  const rulesPath = join(this.rootPath, "routing", "rules.yaml");
  try {
    const content = await readFile(rulesPath, "utf-8");
    const parsed = parse(content);
    this.routingRules = Array.isArray(parsed) ? parsed : [];
  } catch {
    this.routingRules = [];
  }
}
```

### 2b. Initialize from Bootstrap

```typescript
// src/genome/genome.ts, lines 282-297
async initFromBootstrap(bootstrapDir: string): Promise<void> {
  if (this.agents.size > 0) {
    throw new Error("Cannot initialize from bootstrap: agents already exist");
  }

  // Load all YAML files from bootstrap directory
  const specs = await loadBootstrapAgents(bootstrapDir);
  
  // Write each to genome/agents/ and store in memory
  for (const spec of specs) {
    const yamlPath = join(this.rootPath, "agents", `${spec.name}.yaml`);
    await writeFile(yamlPath, serializeAgentSpec(spec));
    this.agents.set(spec.name, spec);
  }

  // Commit to git
  await git(this.rootPath, "add", ".");
  await git(this.rootPath, "commit", "-m", "genome: initialize from bootstrap agents");
}
```

### 2c. Load Bootstrap Agents

```typescript
// src/agents/loader.ts, lines 28-32
export async function loadBootstrapAgents(dir: string): Promise<AgentSpec[]> {
  const files = await readdir(dir);
  
  // Filter and sort YAML files
  const yamlFiles = files
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  
  // Load each one
  return Promise.all(yamlFiles.map((f) => loadAgentSpec(join(dir, f))));
}

// src/agents/loader.ts, lines 6-26
export async function loadAgentSpec(path: string): Promise<AgentSpec> {
  const content = await readFile(path, "utf-8");
  const raw = parse(content);  // YAML parse

  // Validate required fields
  for (const field of ["name", "description", "system_prompt", "model"] as const) {
    if (!raw[field] || typeof raw[field] !== "string") {
      throw new Error(`Invalid agent spec at ${path}: missing or invalid '${field}'`);
    }
  }

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

---

## Phase 3: Agent Constructor - Building Delegate Tool

When the root Agent is constructed in `src/agents/agent.ts`:

```typescript
// src/agents/agent.ts, lines 94-157
constructor(options: AgentOptions) {
  this.spec = options.spec;                           // root.yaml spec
  this.env = options.env;
  this.client = options.client;
  this.primitiveRegistry = options.primitiveRegistry;
  this.availableAgents = options.availableAgents;     // genome.allAgents()
  this.genome = options.genome;
  this.depth = options.depth ?? 0;
  
  // ... validation ...

  // Resolve model
  this.resolved = resolveModel(options.modelOverride ?? this.spec.model, this.client.providers());

  // CRITICAL: Build delegate tool based on capabilities
  this.agentTools = [];

  if (this.spec.constraints.can_spawn) {
    // root.yaml has can_spawn: true (default)
    const delegatableAgents: AgentSpec[] = [];
    
    // Loop through root.yaml's capabilities
    for (const cap of this.spec.capabilities) {
      if (cap === this.spec.name) continue;  // Don't delegate to self
      
      // Look up each capability as an agent name
      const agentSpec = this.availableAgents.find((a) => a.name === cap);
      if (agentSpec) {
        delegatableAgents.push(agentSpec);
      }
    }
    
    if (delegatableAgents.length > 0) {
      // Create single "delegate" tool with enum of all agents
      this.agentTools.push(buildDelegateTool(delegatableAgents));
    }
  }

  // Build primitive tools (only for leaf agents)
  this.primitiveTools = [];
  if (this.agentTools.length === 0) {
    // This agent doesn't delegate, so it needs primitives
    const filteredPrimitiveNames = primitivesForAgent(
      this.spec.capabilities,
      this.primitiveRegistry.names(),
      this.resolved.provider,
    );

    for (const name of filteredPrimitiveNames) {
      const prim = this.primitiveRegistry.get(name);
      if (prim) {
        this.primitiveTools.push({
          name: prim.name,
          description: prim.description,
          parameters: prim.parameters,
        });
      }
    }
  }
}
```

### buildDelegateTool

```typescript
// src/agents/plan.ts, lines 14-41
export function buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
  const agentEnum = agents.map((a) => a.name);  // ["reader", "editor", "command-runner", ...]
  
  return {
    name: DELEGATE_TOOL_NAME,  // "delegate"
    description: "Delegate a task to a specialist agent. See the <agents> section in your instructions for available agents and their descriptions.",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent to delegate to",
          enum: agentEnum.length > 0 ? agentEnum : undefined,  // ← LLM can only pick from this enum
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
  };
}
```

---

## Phase 4: Agent Execution Loop - Planning

Inside `agent.run()`, before each LLM call:

```typescript
// src/agents/agent.ts, lines 330-441
async run(goal: string, signal?: AbortSignal): Promise<AgentResult> {
  // ... initialization ...

  // Build system prompt
  let systemPrompt = buildSystemPrompt(
    this.spec,
    this.env.working_directory(),
    this.env.platform(),
    this.env.os_version(),
    recallContext,
  );

  // CRITICAL: Append available agents to system prompt
  if (this.spec.constraints.can_spawn) {
    const delegatableAgents = this.getDelegatableAgents();  // ← Get current agents
    systemPrompt += renderAgentsForPrompt(delegatableAgents);
  }

  // ... more prompt building ...

  // Core loop
  while (turns < this.spec.constraints.max_turns) {
    // ... prepare for LLM call ...

    // Build LLM request with tools
    const request = buildPlanRequest({
      systemPrompt,
      history,
      agentTools: this.agentTools,     // Contains the delegate tool
      primitiveTools: this.primitiveTools,
      model: this.resolved.model,
      provider: this.resolved.provider,
      thinking: this.spec.thinking,
    });

    // Call LLM
    let response: LLMResponse;
    response = await this.client.complete(request);  // ← LLM sees delegate tool and <agents> section

    // ... handle response ...
  }
}
```

### getDelegatableAgents (Dynamic Lookup)

```typescript
// src/agents/agent.ts, lines 207-217
/** Get the current list of agents this agent can delegate to, preferring genome over static snapshot. */
private getDelegatableAgents(): AgentSpec[] {
  const agents: AgentSpec[] = [];
  
  // Prefer genome (live) over availableAgents (static snapshot)
  const source = this.genome ? this.genome.allAgents() : this.availableAgents;
  
  // Filter by capabilities
  for (const cap of this.spec.capabilities) {
    if (cap === this.spec.name) continue;
    const agentSpec = source.find((a) => a.name === cap);
    if (agentSpec) agents.push(agentSpec);
  }
  
  return agents;
}
```

### renderAgentsForPrompt

```typescript
// src/agents/plan.ts, lines 46-52
export function renderAgentsForPrompt(agents: AgentSpec[]): string {
  if (agents.length === 0) return "";
  
  const entries = agents
    .map((a) => `  <agent name="${a.name}">${a.description}</agent>`)
    .join("\n");
  
  return `\n\n<agents>\n${entries}\n</agents>`;
}
```

Produces:
```xml
<agents>
  <agent name="reader">Read and analyze file contents</agent>
  <agent name="editor">Edit or create files</agent>
  <agent name="command-runner">Execute shell commands</agent>
  <agent name="web-reader">Fetch and analyze web content</agent>
  <agent name="mcp">Model Context Protocol integration</agent>
  <agent name="quartermaster">Task planning and decomposition</agent>
</agents>
```

---

## Phase 5: Delegation Execution

When the LLM calls the delegate tool:

```typescript
// src/agents/agent.ts, lines 561-592
// Parse tool calls into delegations and primitive calls
const agentNames = new Set(this.availableAgents.map((a) => a.name));
const { delegations, errors: delegationErrors } = parsePlanResponse(toolCalls, agentNames);

// ... handle errors ...

// Launch all delegations concurrently
const delegationPromises = delegations.map((delegation) =>
  this.executeDelegation(delegation, agentId).then((dr) => {
    resultByCallId.set(delegation.call_id, dr.toolResultMsg);
    delegationStumbles += dr.stumbles;
    if (dr.output !== undefined) lastOutput = dr.output;
  }),
);
await Promise.all(delegationPromises);
```

### parsePlanResponse

```typescript
// src/agents/plan.ts, lines 167-228
export function parsePlanResponse(
  toolCalls: ToolCall[],
  agentNames?: Set<string>,
): {
  delegations: Delegation[];
  primitiveCalls: ToolCall[];
  errors: DelegationError[];
} {
  const delegations: Delegation[] = [];
  const primitiveCalls: ToolCall[] = [];
  const errors: DelegationError[] = [];

  for (const call of toolCalls) {
    // Auto-correct: LLM used agent name directly instead of delegate
    if (call.name !== DELEGATE_TOOL_NAME && agentNames?.has(call.name)) {
      // Convert direct call to delegation
      delegations.push({
        call_id: call.id,
        agent_name: call.name,
        goal: call.arguments.goal ?? call.arguments.task ?? call.arguments.command,
        hints: Array.isArray(call.arguments.hints) ? call.arguments.hints : undefined,
      });
      continue;
    }

    if (call.name === DELEGATE_TOOL_NAME) {
      // Parse delegate tool call
      const agentName = call.arguments.agent_name;
      if (typeof agentName !== "string" || agentName.length === 0) {
        errors.push({
          call_id: call.id,
          error: "Delegation missing required 'agent_name' argument",
        });
        continue;
      }
      const goal = call.arguments.goal;
      if (typeof goal !== "string" || goal.length === 0) {
        errors.push({
          call_id: call.id,
          error: `Agent delegation to '${agentName}' missing required 'goal' argument`,
        });
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

### executeDelegation

```typescript
// src/agents/agent.ts, lines 219-328
private async executeDelegation(
  delegation: Delegation,
  agentId: string,
): Promise<{ toolResultMsg: Message; stumbles: number; output?: string }> {
  this.emitAndLog("act_start", agentId, this.depth, {
    agent_name: delegation.agent_name,
    goal: delegation.goal,
  });

  // Look up subagent spec
  const subagentSpec =
    this.genome?.getAgent(delegation.agent_name) ??  // ← Prefer genome
    this.availableAgents.find((a) => a.name === delegation.agent_name);

  if (!subagentSpec) {
    const errorMsg = `Unknown agent: ${delegation.agent_name}`;
    const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
    this.emitAndLog("act_end", agentId, this.depth, {
      agent_name: delegation.agent_name,
      success: false,
      error: errorMsg,
      tool_result_message: toolResultMsg,
    });
    return { toolResultMsg, stumbles: 1 };
  }

  try {
    let subGoal = delegation.goal;
    if (delegation.hints && delegation.hints.length > 0) {
      subGoal += `\n\nHints:\n${delegation.hints.map((h) => `- ${h}`).join("\n")}`;
    }

    const subLogBasePath = this.logBasePath
      ? `${this.logBasePath}/subagents/${ulid()}`
      : undefined;
    
    // Create subagent
    const subagent = new Agent({
      spec: subagentSpec,
      env: this.env,
      client: this.client,
      primitiveRegistry: this.primitiveRegistry,
      availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
      genome: this.genome,
      depth: this.depth + 1,
      events: this.events,
      sessionId: this.sessionId,
      learnProcess: this.learnProcess,
      logBasePath: subLogBasePath,
    });

    // Run subagent
    const subResult = await subagent.run(subGoal, this.signal);

    // ... verify and log result ...

    return {
      toolResultMsg,
      stumbles: verify.stumbled ? 1 : 0,
      output: subResult.output,
    };
  } catch (err) {
    const errorMsg = `Subagent '${delegation.agent_name}' failed: ${String(err)}`;
    const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
    this.emitAndLog("act_end", agentId, this.depth, {
      agent_name: delegation.agent_name,
      success: false,
      error: errorMsg,
      tool_result_message: toolResultMsg,
    });
    return { toolResultMsg, stumbles: 1 };
  }
}
```

---

## Key Control Flow Summary

```
User Goal
  ↓
createAgent(options)
  ├─ Genome.loadFromDisk() or initFromBootstrap()
  │  └─ loadBootstrapAgents(bootstrap/) → Read all YAML files
  │     └─ Agent specs loaded into Genome.agents map
  ├─ genome.getAgent("root") → Gets root.yaml spec
  └─ new Agent({
       spec: root,
       availableAgents: genome.allAgents(),  ← All agents from genome
       genome,
     })
       ├─ Constructor analyzes root.capabilities: ["reader", "editor", ...]
       ├─ For each capability:
       │  └─ Find matching agent in availableAgents
       └─ buildDelegateTool(delegatableAgents) → Create single tool with enum
          └─ Tool enum = ["reader", "editor", "command-runner", ...]

Agent.run(goal)
  ├─ Per turn:
  │  ├─ getDelegatableAgents()
  │  │  ├─ if genome exists, use genome.allAgents()  (dynamic)
  │  │  └─ else use availableAgents  (static snapshot)
  │  ├─ renderAgentsForPrompt(delegatableAgents)
  │  │  └─ Inject <agents> XML section into system prompt
  │  ├─ buildPlanRequest(...)
  │  │  └─ Include delegate tool with enum in request
  │  ├─ LLM response with tool calls
  │  └─ For each delegation tool call:
  │     ├─ parsePlanResponse() validates agent_name
  │     ├─ executeDelegation(delegation)
  │     │  ├─ Look up subagent spec (genome first, then availableAgents)
  │     │  └─ new Agent({
  │     │       spec: subagent,
  │     │       availableAgents: genome.allAgents(),  ← Same list
  │     │       genome,
  │     │     })
  │     │     └─ Subagent.run(...) recursively
  │     └─ Return tool result with subagent output
  └─ Continue until done or limit hit
```

---

## Important Insights

1. **No hardcoding**: All agent names and specs come from YAML files
2. **Capability matching**: `root.capabilities` is the master list of what the root can delegate to
3. **Dynamic lookup at runtime**: `getDelegatableAgents()` prefers live genome over initial snapshot
4. **Single tool pattern**: Instead of N tools (one per agent), there's 1 tool with agent_name enum
5. **Recursive inheritance**: Each subagent receives same `availableAgents` and `genome`, allowing hierarchical delegation
6. **Validation at parse time**: `parsePlanResponse()` ensures agent names are valid before delegation
7. **Genome precedence**: When a genome exists, it's always preferred for agent lookups

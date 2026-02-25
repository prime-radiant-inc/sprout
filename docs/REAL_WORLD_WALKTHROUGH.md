# Real-World Walkthrough: How the Root Agent Delegates

This document traces a complete example of how the root agent processes a user goal and delegates to subagents.

---

## Scenario: User Asks Root Agent to "Count Python files in src/ directory"

### Step 1: System Startup (createAgent)

**User starts the CLI:**
```bash
$ sprout
> Count Python files in src/ directory
```

**Code path:** `src/agents/factory.ts:49` createAgent()

```typescript
// factory.ts:50
const genome = new Genome(options.genomePath);

// factory.ts:53
const isExisting = existsSync(join(options.genomePath, ".git"));

// First time? No, genome exists.
// factory.ts:56
await genome.loadFromDisk();
```

**What happens in loadFromDisk:**

```typescript
// genome.ts:254-266
async loadFromDisk(): Promise<void> {
  const agentsDir = join(this.rootPath, "agents");
  const files = await readdir(agentsDir);
  // Returns: ["root.yaml", "reader.yaml", "editor.yaml", "command-runner.yaml", ...]
  
  const yamlFiles = files.filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  
  for (const file of yamlFiles) {
    const spec = await loadAgentSpec(join(agentsDir, file));
    // Parses YAML → AgentSpec
    // Example for root.yaml:
    // AgentSpec {
    //   name: "root",
    //   description: "Decompose tasks and delegate...",
    //   model: "best",
    //   capabilities: ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"],
    //   constraints: { can_spawn: true, max_depth: 3, max_turns: 200, ... },
    //   system_prompt: "You are a general-purpose agentic system...",
    //   tags: ["core", "orchestration"],
    //   version: 2
    // }
    
    this.agents.set(spec.name, spec);
  }
}
// After loop: genome.agents Map contains all 10 agents
// {
//   "root" → AgentSpec,
//   "reader" → AgentSpec,
//   "editor" → AgentSpec,
//   "command-runner" → AgentSpec,
//   "web-reader" → AgentSpec,
//   "mcp" → AgentSpec,
//   "quartermaster" → AgentSpec,
//   "qm-fabricator" → AgentSpec,
//   "qm-indexer" → AgentSpec,
//   "qm-planner" → AgentSpec
// }
```

**Back in createAgent:**

```typescript
// factory.ts:71-79
const rootName = options.rootAgent ?? "root";
const rootSpec = genome.getAgent(rootName);
// Returns the root AgentSpec we just loaded

if (!rootSpec) {
  throw new Error(`Root agent '${rootName}' not found...`);
}

// factory.ts:84-85
const client = options.client ?? Client.fromEnv();
const registry = createPrimitiveRegistry(env);

// factory.ts:103-116
const agent = new Agent({
  spec: rootSpec,                      // ← Root spec from genome
  env,
  client,
  primitiveRegistry: registry,
  availableAgents: genome.allAgents(), // ← ALL 10 agents! [root, reader, editor, ...]
  genome,                              // ← Genome reference for runtime lookup
  events,
  learnProcess,
  sessionId,
  logBasePath,
  initialHistory: options.initialHistory,
  modelOverride: options.model,
});
```

### Step 2: Agent Constructor - Building Delegate Tool

**Code path:** `src/agents/agent.ts:94` Agent constructor

```typescript
constructor(options: AgentOptions) {
  this.spec = options.spec;                      // rootSpec
  this.availableAgents = options.availableAgents; // [root, reader, editor, ...]
  this.genome = options.genome;
  this.depth = options.depth ?? 0;               // 0 for root
  
  // ... validation ...
  
  // Line 122: Check if root can spawn
  if (this.spec.constraints.can_spawn) {  // root has can_spawn: true ✓
    const delegatableAgents: AgentSpec[] = [];
    
    // Line 124: Loop through root's capabilities
    for (const cap of this.spec.capabilities) {
      // Iteration 1: cap = "reader"
      
      if (cap === this.spec.name) continue;  // "reader" === "root"? NO
      
      // Line 126: Find reader in availableAgents
      const agentSpec = this.availableAgents.find((a) => a.name === cap);
      // Finds: AgentSpec { name: "reader", ... } ✓
      
      if (agentSpec) {
        delegatableAgents.push(agentSpec);  // Added to list
      }
    }
    
    // Similar for "editor", "command-runner", "web-reader", "mcp", "quartermaster"
    // All found in availableAgents
    
    // delegatableAgents = [reader, editor, command-runner, web-reader, mcp, quartermaster]
    
    // Line 132: Build delegate tool
    if (delegatableAgents.length > 0) {  // Yes, 6 agents ✓
      this.agentTools.push(buildDelegateTool(delegatableAgents));
    }
  }
  
  // Line 139: No delegate tool means no agent tools → get primitives instead
  this.primitiveTools = [];
  if (this.agentTools.length === 0) {  // We have agentTools, so skip this
    // Not executed for root
  }
}
```

**Inside buildDelegateTool:**

```typescript
// plan.ts:14-41
export function buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
  // agents = [reader, editor, command-runner, web-reader, mcp, quartermaster]
  
  const agentEnum = agents.map((a) => a.name);
  // agentEnum = ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"]
  
  return {
    name: DELEGATE_TOOL_NAME,  // "delegate"
    description: "Delegate a task to a specialist agent...",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent to delegate to",
          enum: ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"],
          // ↑ LLM can ONLY pick from this list
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

**Result after constructor:**
- Root agent has `agentTools = [delegateTool]`
- Root agent has `primitiveTools = []` (orchestrators don't use primitives)
- Root agent ready to run

---

### Step 3: Agent Execution - Planning Phase

**Code path:** `src/agents/agent.ts:330` agent.run(goal)

```typescript
async run(goal: string, signal?: AbortSignal): Promise<AgentResult> {
  const agentId = this.spec.name;  // "root"
  
  // ... initialization ...
  
  // Line 352: Initialize history with user goal
  const history: Message[] = [Msg.user("Count Python files in src/ directory")];
  
  // Line 416: Build system prompt
  let systemPrompt = buildSystemPrompt(
    this.spec,
    this.env.working_directory(),      // "/Users/jesse/prime-radiant/sprout"
    this.env.platform(),               // "darwin"
    this.env.os_version(),             // "25.3.0"
    recallContext,
  );
  
  // Result:
  // "You are a general-purpose agentic system that decomposes tasks and delegates to specialists.
  //
  // <environment>
  // Working directory: /Users/jesse/prime-radiant/sprout
  // Platform: darwin
  // OS version: 25.3.0
  // Today's date: 2026-02-25
  // </environment>"
  
  // Line 425-428: Append agent descriptions to prompt
  if (this.spec.constraints.can_spawn) {  // root has can_spawn: true ✓
    const delegatableAgents = this.getDelegatableAgents();
    // Calls line 207-217, returns filtered agents from genome/availableAgents
    // delegatableAgents = [reader, editor, command-runner, web-reader, mcp, quartermaster]
    
    systemPrompt += renderAgentsForPrompt(delegatableAgents);
  }
  
  // renderAgentsForPrompt adds:
  // "
  // <agents>
  //   <agent name="reader">Read and analyze file contents, search for patterns</agent>
  //   <agent name="editor">Edit or create files, refactor code</agent>
  //   <agent name="command-runner">Execute shell commands, run scripts</agent>
  //   <agent name="web-reader">Fetch and analyze web content</agent>
  //   <agent name="mcp">Model Context Protocol integration</agent>
  //   <agent name="quartermaster">Task planning and decomposition</agent>
  // </agents>"
  
  // Now systemPrompt includes:
  // 1. Root's system_prompt
  // 2. Environment variables
  // 3. Agent descriptions
  
  // --- MAIN LOOP ---
  // Line 443-688
  while (turns < this.spec.constraints.max_turns) {  // 200
    turns++;  // Turn 1
    
    // Line 476-484: Build LLM request
    const request = buildPlanRequest({
      systemPrompt,  // ← With agents section!
      history: [
        Msg.system(systemPrompt),
        Msg.user("Count Python files in src/ directory")
      ],
      agentTools: this.agentTools,      // [delegateTool with enum]
      primitiveTools: this.primitiveTools, // []
      model: this.resolved.model,       // "gpt-4-turbo" (if "best" → gpt-4-turbo)
      provider: this.resolved.provider, // "openai"
      thinking: this.spec.thinking,
    });
    
    // request = {
    //   model: "gpt-4-turbo",
    //   provider: "openai",
    //   messages: [
    //     { role: "system", content: "You are a general-purpose...agents section..."},
    //     { role: "user", content: "Count Python files in src/ directory" }
    //   ],
    //   tools: [
    //     {
    //       name: "delegate",
    //       parameters: {
    //         agent_name: {
    //           enum: ["reader", "editor", "command-runner", ...]
    //         },
    //         goal: { type: "string" },
    //         hints: { type: "array" }
    //       }
    //     }
    //   ],
    //   tool_choice: "auto",
    //   max_tokens: 16384
    // }
    
    // Line 502: Call LLM
    response = await this.client.complete(request);
    
    // LLM receives:
    // - System prompt with agent descriptions
    // - User goal "Count Python files in src/ directory"
    // - Available tool: delegate with agent_name enum limiting choices
    //
    // LLM thinks:
    // "User wants to count Python files. I need to:
    //  1. Find all Python files in src/
    //  2. Count the total
    //
    //  Looking at available agents:
    //  - reader: 'Read and analyze file contents, search for patterns' ← This agent can find files!
    //  - editor: Edit files ← Not relevant
    //  - command-runner: Execute commands ← Possible but reader is more precise
    //  - web-reader: Fetch web content ← Not relevant
    //  - mcp: Model Context Protocol ← Not relevant
    //  - quartermaster: Task planning ← Not relevant
    //
    //  I should delegate to 'reader' with goal 'Find all Python files in src/ and count them'"
    //
    // LLM generates tool call:
    response.message = {
      role: "assistant",
      content: "I'll help you count the Python files in the src/ directory. Let me delegate this to the reader agent who specializes in finding and analyzing files.",
      tool_calls: [
        {
          id: "call_0a7b2f1e",
          name: "delegate",
          arguments: {
            agent_name: "reader",
            goal: "Find all Python (.py) files in src/ directory and count them",
            hints: ["Use grep or find command to locate .py files"]
          }
        }
      ]
    };
    
    // Line 517: Add assistant message to history
    history.push(response.message);
    
    // Line 531: Extract tool calls
    const toolCalls = messageToolCalls(assistantMessage);
    // toolCalls = [{ id: "call_0a7b2f1e", name: "delegate", arguments: {...} }]
    
    // Line 562-563: Parse into delegations
    const agentNames = new Set(this.availableAgents.map((a) => a.name));
    // agentNames = {"root", "reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster", ...}
    
    const { delegations, errors: delegationErrors } = parsePlanResponse(toolCalls, agentNames);
    
    // Inside parsePlanResponse (plan.ts:199-222):
    // for (const call of toolCalls) {
    //   if (call.name === DELEGATE_TOOL_NAME) {  // "delegate" ✓
    //     const agentName = call.arguments.agent_name;  // "reader"
    //     if (typeof agentName !== "string" || agentName.length === 0) {
    //       errors.push({...});  // Validate: is non-empty string? ✓
    //     }
    //     const goal = call.arguments.goal;  // "Find all Python files..."
    //     if (typeof goal !== "string" || goal.length === 0) {
    //       errors.push({...});  // Validate: is non-empty string? ✓
    //     }
    //     delegations.push({
    //       call_id: "call_0a7b2f1e",
    //       agent_name: "reader",
    //       goal: "Find all Python files in src/ directory and count them",
    //       hints: ["Use grep or find command..."]
    //     });
    //   }
    // }
    
    // delegations = [{ call_id: "call_0a7b2f1e", agent_name: "reader", ... }]
    // errors = []
    
    // Line 584-591: Execute all delegations concurrently
    const delegationPromises = delegations.map((delegation) =>
      this.executeDelegation(delegation, agentId).then((dr) => {
        resultByCallId.set(delegation.call_id, dr.toolResultMsg);
        // ... more ...
      }),
    );
    await Promise.all(delegationPromises);
```

---

### Step 4: Execute Delegation to Reader Agent

**Code path:** `src/agents/agent.ts:219` executeDelegation()

```typescript
private async executeDelegation(
  delegation: Delegation,  // { call_id, agent_name: "reader", goal: "Find Python files...", hints }
  agentId: string,         // "root"
): Promise<{ toolResultMsg: Message; stumbles: number; output?: string }> {
  
  this.emitAndLog("act_start", agentId, this.depth, {
    agent_name: "reader",
    goal: "Find all Python files...",
  });
  
  // Line 230-231: Look up reader agent spec
  const subagentSpec =
    this.genome?.getAgent("reader") ??  // ← Prefer genome (live)
    this.availableAgents.find((a) => a.name === "reader");
  
  // Returns: AgentSpec {
  //   name: "reader",
  //   description: "Read and analyze file contents...",
  //   model: "best",
  //   capabilities: ["read_file", "grep", "find_files"],
  //   constraints: { can_spawn: false, max_depth: 0, ... },
  //   system_prompt: "You specialize in reading and analyzing files...",
  //   tags: ["leaf", "read"],
  //   version: 2
  // }
  
  if (!subagentSpec) {
    // Subagent found ✓
  }
  
  try {
    let subGoal = "Find all Python files in src/ directory and count them";
    if (delegation.hints && delegation.hints.length > 0) {
      subGoal += "\n\nHints:\n- Use grep or find command to locate .py files";
    }
    
    // Line 254-266: Create reader subagent
    const subagent = new Agent({
      spec: subagentSpec,                    // reader spec
      env: this.env,
      client: this.client,
      primitiveRegistry: this.primitiveRegistry,
      availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
      // ↑ Same list of all agents (though reader will filter by its own capabilities)
      genome: this.genome,                   // Same genome reference
      depth: this.depth + 1,                 // 0 → 1
      events: this.events,
      sessionId: this.sessionId,
      learnProcess: this.learnProcess,
      logBasePath: subLogBasePath,
    });
    
    // Subagent constructor (agent.ts:122-134):
    // if (subagentSpec.constraints.can_spawn) {  // reader has can_spawn: false ✗
    //   // Skip — don't build delegate tool
    // }
    //
    // Line 139: Get primitives instead (line 140-155)
    // const filteredPrimitiveNames = primitivesForAgent(
    //   ["read_file", "grep", "find_files"],  // reader's capabilities
    //   ["read_file", "grep", "find_files", "write_file", "edit_file", "exec", "background", "stop"],
    //   "openai"  // provider
    // );
    // // Returns: ["read_file", "grep", "find_files"] ✓
    //
    // for (const name of filteredPrimitiveNames) {
    //   const prim = this.primitiveRegistry.get(name);
    //   this.primitiveTools.push({
    //     name: prim.name,
    //     description: prim.description,
    //     parameters: prim.parameters
    //   });
    // }
    //
    // subagent.primitiveTools = [
    //   { name: "read_file", description: "Read a file from the filesystem", ... },
    //   { name: "grep", description: "Search file contents using regex patterns", ... },
    //   { name: "find_files", description: "Find files matching a glob pattern", ... }
    // ]
    
    // Line 268: Run reader subagent
    const subResult = await subagent.run(
      "Find all Python files in src/ directory and count them\n\nHints:\n- Use grep or find command...",
      this.signal
    );
  } catch (err) {
    // Handle errors
  }
}
```

---

### Step 5: Reader Subagent Execution

**Code path:** `src/agents/agent.ts:330` subagent.run()

```typescript
// Reader agent (depth: 1, can_spawn: false, max_depth: 0)
async run(goal: string) {
  // Line 352: Initialize history
  const history: Message[] = [
    Msg.user("Find all Python files in src/ directory and count them\n\nHints:\n- Use grep or find command to locate .py files")
  ];
  
  // Line 416-428: Build system prompt
  let systemPrompt = buildSystemPrompt(...);
  // reader's system_prompt: "You specialize in reading and analyzing files..."
  
  // Line 425-428: Can reader spawn subagents?
  if (this.spec.constraints.can_spawn) {  // false ✗
    // Skip — don't add agent descriptions
  }
  // Reader gets NO agent descriptions, just its system prompt + environment
  
  // --- MAIN LOOP ---
  while (turns < this.spec.constraints.max_turns) {  // 50
    turns++;  // Turn 1
    
    // Line 476-484: Build LLM request
    const request = buildPlanRequest({
      systemPrompt: "You specialize in reading...",  // NO agents section
      history: [
        Msg.system("You specialize in reading..."),
        Msg.user("Find all Python files in src/ and count them...")
      ],
      agentTools: this.agentTools,      // [] — empty! no delegate tool
      primitiveTools: this.primitiveTools,  // [read_file, grep, find_files]
      model: "gpt-4-turbo",
      provider: "openai",
    });
    
    // LLM receives:
    // - No agent descriptions (reader can't delegate)
    // - Primitive tools: read_file, grep, find_files
    //
    // LLM thinks:
    // "User wants to find all Python files in src/ and count them.
    //  I have these tools:
    //  - find_files: Find files matching a glob pattern ← Perfect!
    //  - grep: Search file contents using regex patterns
    //  - read_file: Read a file
    //
    //  I should use find_files to find all .py files"
    //
    // LLM generates:
    response.message = {
      role: "assistant",
      content: "I'll find all Python files in the src/ directory using the find_files primitive.",
      tool_calls: [
        {
          id: "call_reader_001",
          name: "find_files",
          arguments: {
            pattern: "src/**/*.py"
          }
        }
      ]
    };
    
    // Line 531-553: Handle tool calls
    const toolCalls = messageToolCalls(response.message);
    // toolCalls = [{ id: "call_reader_001", name: "find_files", arguments: {...} }]
    
    // Line 562-563: Parse delegations
    const agentNames = new Set(this.availableAgents.map(a => a.name));
    const { delegations, errors } = parsePlanResponse(toolCalls, agentNames);
    // delegations = [] — find_files is not an agent name ✓
    
    // Line 594-651: Execute primitives
    for (const call of toolCalls) {
      if (delegationByCallId.has(call.id) || resultByCallId.has(call.id)) continue;
      
      this.emitAndLog("primitive_start", agentId, this.depth, {
        name: "find_files",
        args: { pattern: "src/**/*.py" }
      });
      
      // Line 603: Execute primitive
      const result = await this.primitiveRegistry.execute("find_files", { pattern: "src/**/*.py" }, signal);
      
      // result = {
      //   success: true,
      //   output: "src/agents/agent.ts\nsrc/agents/factory.ts\nsrc/agents/plan.ts\nsrc/agents/loader.ts\nsrc/genome/genome.ts\nsrc/host/session.ts\n...",
      //   error: null
      // }
      
      const toolResultMsg = Msg.toolResult(call.id, result.output, !result.success);
      
      this.emitAndLog("primitive_end", agentId, this.depth, {
        name: "find_files",
        success: true,
        output: result.output
      });
      
      resultByCallId.set(call.id, toolResultMsg);
      lastOutput = result.output;
    }
    
    // Line 653-657: Add all tool results to history
    for (const call of toolCalls) {
      const msg = resultByCallId.get(call.id);
      if (msg) history.push(msg);
    }
    // history now includes primitive result
    
    // --- Turn 2 ---
    turns++;
    
    // LLM sees history with find_files result
    // LLM reads the file list from primitive result
    // LLM counts: "12 Python files found"
    // LLM generates: "I found 12 Python files in src/: agent.ts, factory.ts, ..."
    // No more tool calls
    
    // Line 556: Natural completion (no tool calls)
    if (toolCalls.length === 0) {  // ✓
      lastOutput = "I found 12 Python files in src/: src/agents/agent.ts, src/agents/factory.ts, ... (total 12 files)";
      break;  // Exit while loop
    }
  }
  
  // Line 727-734: Emit session_end
  this.emitAndLog("session_end", agentId, this.depth, {
    session_id: this.sessionId,
    success: true,
    stumbles: 0,
    turns: 2,
    timed_out: false,
    output: "I found 12 Python files in src/..."
  });
  
  return {
    output: "I found 12 Python files in src/...",
    success: true,
    stumbles: 0,
    turns: 2,
    timed_out: false
  };
}
```

---

### Step 6: Back to Root - Processing Delegation Result

**Back in root's executeDelegation:**

```typescript
// Line 268: subResult from reader
const subResult = {
  output: "I found 12 Python files in src/...",
  success: true,
  stumbles: 0,
  turns: 2,
  timed_out: false
};

// Line 270-278: Create ActResult
const actResult: ActResult = {
  agent_name: "reader",
  goal: "Find all Python files in src/ directory and count them",
  output: "I found 12 Python files in src/...",
  success: true,
  stumbles: 0,
  turns: 2,
  timed_out: false
};

// Line 297: Create tool result for root
const resultContent = truncateToolOutput("I found 12 Python files...", "reader");
const toolResultMsg = Msg.toolResult("call_0a7b2f1e", resultContent);

// Line 312-316: Return to root
return {
  toolResultMsg,
  stumbles: 0,
  output: "I found 12 Python files in src/..."
};
```

---

### Step 7: Root Continues - Processing Tool Result

**Back in root's run() loop:**

```typescript
// Line 653-657: Add tool result to history
for (const call of toolCalls) {
  const msg = resultByCallId.get("call_0a7b2f1e");  // The delegation result
  if (msg) {
    history.push(Msg.toolResult("call_0a7b2f1e", "I found 12 Python files in src/..."));
  }
}

// Now history:
// [
//   { role: "system", content: "You are a general-purpose..." },
//   { role: "user", content: "Count Python files in src/ directory" },
//   { role: "assistant", content: "...", tool_calls: [...] },
//   { role: "tool", content: "I found 12 Python files in src/...", tool_call_id: "call_0a7b2f1e" }
// ]

// --- Turn 2 of root ---
turns++;

// Line 476-484: Build new LLM request with updated history
const request = buildPlanRequest({
  systemPrompt: "You are a general-purpose...",
  history: [
    // ↑ Now includes the tool result from reader
    { role: "user", content: "Count Python files in src/ directory" },
    { role: "assistant", content: "I'll delegate to reader...", tool_calls: [...] },
    { role: "tool", content: "I found 12 Python files in src/..." }
  ],
  agentTools: [delegateTool],
  primitiveTools: [],
  model: "gpt-4-turbo",
  provider: "openai"
});

// LLM receives:
// - User goal: "Count Python files in src/ directory"
// - Assistant delegated to reader
// - Tool result: "I found 12 Python files in src/"
//
// LLM thinks:
// "The reader has already completed the task. They found 12 Python files.
//  I have the answer the user wanted. I should summarize and conclude."
//
// LLM generates:
response.message = {
  role: "assistant",
  content: "Perfect! I've delegated the task to the reader agent, who found 12 Python files in the src/ directory. Here's what they found:\n\n- src/agents/agent.ts\n- src/agents/factory.ts\n- ...(12 total files)",
  tool_calls: []  // ← No more delegations
};

// Line 531: Extract tool calls
const toolCalls = messageToolCalls(response.message);
// toolCalls = [] — no more tool calls

// Line 556-559: Natural completion
if (toolCalls.length === 0) {  // ✓ True
  lastOutput = "Perfect! I've delegated the task...";
  break;  // Exit while loop
}
```

---

### Step 8: Root Returns Final Result

```typescript
// Line 727-734: Emit session_end
this.emitAndLog("session_end", "root", 0, {
  session_id: "...",
  success: true,
  stumbles: 0,
  turns: 2,
  timed_out: false,
  output: "Perfect! I've delegated the task..."
});

// Line 738-745: Return AgentResult
return {
  output: "Perfect! I've delegated the task to the reader agent, who found 12 Python files in the src/ directory...",
  success: true,
  stumbles: 0,
  turns: 2,
  timed_out: false
};
```

---

### Step 9: Display Result to User

```bash
$ sprout
> Count Python files in src/ directory

Perfect! I've delegated the task to the reader agent, who found 12 Python files in the src/ directory. Here's what they found:

- src/agents/agent.ts
- src/agents/factory.ts
- src/agents/loader.ts
- src/agents/plan.ts
- src/agents/factory.ts
- src/agents/events.ts
- ... (12 total files)
```

---

## Key Insights from This Walkthrough

1. **No hardcoding**: Root agent learned about "reader" from YAML files, not hardcode
2. **Capability matching**: Root could delegate because "reader" was in its capabilities list
3. **Enum constraint**: The delegate tool's `agent_name: {enum: [...]}` prevented hallucination
4. **Agent descriptions**: LLM knew reader was for file analysis from the `<agents>` section
5. **Recursive creation**: Subagent created with same `availableAgents` and `genome`
6. **Different tools**: Root had delegate tool, reader had primitive tools
7. **Depth progression**: Root (depth 0) → Reader (depth 1), both within constraints
8. **Genome lookup**: Reader spec was found via `genome.getAgent("reader")`
9. **History management**: Tool results added back to history for context
10. **Natural completion**: When LLM had the answer, no more tool calls — task done

---

## What If Something Was Different?

### What if "reader" was not in root's capabilities?
```yaml
# bootstrap/root.yaml
capabilities:
  - editor              # ← reader removed
  - command-runner
  - web-reader
  - mcp
  - quartermaster
```
**Result**: 
- `availableAgents.find(a => a.name === "reader")` returns undefined (line 126)
- "reader" never added to delegatableAgents
- Delegate tool enum = ["editor", "command-runner", ...] (reader missing)
- LLM cannot pick "reader" even if it wanted to
- Root would delegate to a different agent or fail

### What if "reader" didn't exist in the genome?
**Result**:
- Agent would still be in availableAgents (static snapshot)
- It would be in the delegate tool enum
- When root tries to delegate: `genome.getAgent("reader")` returns undefined
- `executeDelegation` returns error: "Unknown agent: reader"
- Tool result: error message about unknown agent

### What if reader had can_spawn: true?
```yaml
# bootstrap/reader.yaml
constraints:
  can_spawn: true  # Changed from false
```
**Result**:
- Reader constructor would build a delegate tool
- Reader's system prompt would include agent descriptions
- Reader could delegate to other agents (though "reader" has no agent capabilities, only primitives)
- Reader could theoretically create sub-subagents

### What if root had max_depth: 1?
```yaml
# bootstrap/root.yaml
constraints:
  max_depth: 1  # Changed from 3
```
**Result**:
- Root at depth 0 can exist (0 < 1) ✓
- Creates reader subagent at depth 1
- Reader constructor check (line 110):
  - `max_depth: 0 > 0? NO` → OK (depth check only if max_depth > 0)
  - If reader had max_depth: 1, would check: 1 >= 1? YES → ERROR

---

## Summary

This walkthrough shows:
1. **Loading**: YAML files → Genome → availableAgents
2. **Capability filtering**: root.capabilities → delegatableAgents
3. **LLM guidance**: System prompt + tool enum constrain choices
4. **Execution**: Parse delegation → Create subagent → Recursive run
5. **Completion**: Tool result added to history → Continue loop or done
6. **Return**: AgentResult bubbles up to user

All driven by YAML configuration, with no hardcoded agent lists anywhere.

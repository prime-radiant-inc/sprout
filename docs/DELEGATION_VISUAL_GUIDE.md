# Delegation Visual Guide

ASCII diagrams and visual representations of agent delegation.

---

## 1. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                          User Input                                │
│                       (Goal/Task)                                  │
└───────────────────────────┬────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│                    Root Agent (Orchestrator)                       │
│                     bootstrap/root.yaml                            │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │ capabilities: [reader, editor, command-runner, ...]     │     │
│  │ constraints: {can_spawn: true, max_depth: 3}            │     │
│  │                                                          │     │
│  │ Capabilities → Delegates To:                            │     │
│  │   - reader        → reader agent                        │     │
│  │   - editor        → editor agent                        │     │
│  │   - command-run.  → command-runner agent                │     │
│  │   - web-reader    → web-reader agent                    │     │
│  │   - mcp           → mcp agent                           │     │
│  │   - quartermaster → quartermaster agent                 │     │
│  └──────────────────────────────────────────────────────────┘     │
│                            │                                       │
│                            ▼                                       │
│  Decompose task into subgoals and delegate                        │
└───────┬──────────┬──────────┬────────────┬───────────┬────────────┘
        │          │          │            │           │
        ▼          ▼          ▼            ▼           ▼
    ┌────────┐┌────────┐┌─────────┐┌──────────┐┌─────┐
    │ Reader ││ Editor ││ Command  ││ Web      ││ MCP │
    │ Agent  ││ Agent  ││ Runner   ││ Reader   ││Agent│
    │        ││        ││ Agent    ││ Agent    ││     │
    │ LEAF   ││ LEAF   ││ LEAF     ││ LEAF     ││LEAF │
    │        ││        ││          ││          ││     │
    └────────┘└────────┘└─────────┘└──────────┘└─────┘
        │          │          │            │           │
        │          │          │            │           │
        └──────────┴──────────┴────────────┴───────────┘
                           │
                           ▼
                  Return Results to Root
                    (Tool Results)
                           │
                           ▼
              Root synthesizes and completes
```

---

## 2. Agent Tree Structure

```
Depth 0                        Depth 1                    Depth 2
────────────────────────────────────────────────────────────────────

                          Root (max_depth: 3, can_spawn: true)
                    (can delegate to anyone)
                                │
                ┌───────────────┼───────────────┬──────────────┐
                │               │               │              │
                ▼               ▼               ▼              ▼
            Reader          Editor          Command          Web
            Agent           Agent           Runner           Reader
            (depth:1)       (depth:1)       Agent            Agent
            can_spawn: false (depth:1)      (depth:1)       (depth:1)
                            can_spawn: false can_spawn: false can_spawn: false
                                │
                    ┌───────────┼───────────┐
                    │           │           │
                    ▼           ▼           ▼
                Reader      Grep         Find
                Primitive   Primitive    Primitive
                (if delegated with different goal)


Key:
- Boxes = Agents
- Lines = Possible delegation paths
- can_spawn: false = Cannot create subagents
- max_depth: Can only exist at depths < max_depth
- Depth 0 = root, Depth 1 = subagents, Depth 2 = sub-subagents, etc.
```

---

## 3. Capability Matching

```
Root Agent YAML                    Available Agents (from Genome)
──────────────────────────────────────────────────────────────────

capabilities:                      Genome.agents Map:
  - reader        ──────────────► {name: "reader", ...}      ✓ Match
  - editor        ──────────────► {name: "editor", ...}      ✓ Match
  - command-runner ────────────► {name: "command-runner", ...} ✓ Match
  - web-reader    ──────────────► {name: "web-reader", ...}  ✓ Match
  - mcp           ──────────────► {name: "mcp", ...}         ✓ Match
  - quartermaster ──────────────► {name: "quartermaster", ...} ✓ Match
  - (other_cap)   ───────────────X (not found in genome)     ✗ Skip
  - (invalid)     ───────────────X (not found in genome)     ✗ Skip

Filter Result: delegatableAgents = [reader, editor, command-runner, web-reader, mcp, quartermaster]

                              ▼
                    Create Delegate Tool
                        (Single Tool)
                    
                    enum: ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"]
                    
                    (LLM can only pick from this enum)
```

---

## 4. Agent Construction - Tool Building

```
new Agent({
  spec: rootSpec,
  availableAgents: [reader, editor, command-runner, web-reader, mcp, quartermaster]
})
            │
            ▼
       Constructor Logic
            │
            ├─ Check: this.spec.constraints.can_spawn = true? ✓
            │
            ├─ For each capability in this.spec.capabilities:
            │  (["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"])
            │
            │  ├─ "reader" (skip if === this.spec.name)
            │  │  ├─ Look up in availableAgents.find(a => a.name === "reader")
            │  │  └─ Found? ✓ → Add to delegatableAgents
            │  │
            │  ├─ "editor"
            │  │  └─ Found? ✓ → Add to delegatableAgents
            │  │
            │  ├─ "command-runner"
            │  │  └─ Found? ✓ → Add to delegatableAgents
            │  │
            │  └─ ... (repeat for all capabilities)
            │
            ├─ delegatableAgents = [reader, editor, command-runner, web-reader, mcp, quartermaster]
            │
            ├─ buildDelegateTool(delegatableAgents)
            │  │
            │  └─ ToolDefinition {
            │       name: "delegate",
            │       parameters: {
            │         agent_name: {
            │           enum: ["reader", "editor", "command-runner", ...]  ← Constraint!
            │         },
            │         goal: { type: "string" },
            │         hints: { type: "array" }
            │       }
            │     }
            │
            └─ this.agentTools = [delegateTool]
```

---

## 5. Execution Loop - Agent Delegation Sequence

```
Agent.run(goal) Start
        │
        ▼
    Turn N
        │
        ├─ getDelegatableAgents()
        │  ├─ Check: genome? (prefer live)
        │  ├─ source = this.genome?.allAgents() || this.availableAgents
        │  └─ Filter by this.spec.capabilities
        │
        ├─ renderAgentsForPrompt(delegatableAgents)
        │  └─ Inject XML:
        │     <agents>
        │       <agent name="reader">Read and analyze file contents</agent>
        │       <agent name="editor">Edit or create files</agent>
        │       ...
        │     </agents>
        │
        ├─ buildSystemPrompt() + agent descriptions
        │
        ├─ buildPlanRequest({
        │    systemPrompt: "..." + agent descriptions,
        │    history: [...],
        │    agentTools: [delegateTool],  ← WITH enum constraint
        │    primitiveTools: [],
        │  })
        │
        ├─ LLM Call
        │  │
        │  └─ LLM generates:
        │     ToolCall {
        │       name: "delegate",
        │       arguments: {
        │         agent_name: "reader",  ← Must be in enum
        │         goal: "...",
        │         hints: [...]
        │       }
        │     }
        │
        ├─ parsePlanResponse([toolCall])
        │  │
        │  ├─ Validate agent_name in agentNames set
        │  ├─ Validate goal is non-empty string
        │  ├─ Validate hints is array (if present)
        │  │
        │  └─ Create Delegation:
        │     {
        │       call_id: "call_123",
        │       agent_name: "reader",
        │       goal: "...",
        │       hints: [...]
        │     }
        │
        ├─ executeDelegation(delegation)
        │  │
        │  ├─ Look up spec:
        │  │  subagentSpec = genome.getAgent("reader") || availableAgents.find(...)
        │  │
        │  ├─ Create new Agent:
        │  │  new Agent({
        │  │    spec: readerSpec,
        │  │    availableAgents: genome.allAgents() || availableAgents,  ← SAME list
        │  │    genome: genome,  ← SAME genome
        │  │    depth: depth + 1,  ← 0 → 1
        │  │    ...
        │  │  })
        │  │
        │  └─ subagent.run(goal)  ← RECURSIVE
        │     │
        │     ├─ Turn 1 of subagent
        │     ├─ Check constraints:
        │     │  ├─ readerSpec.constraints.can_spawn = false
        │     │  │  └─ No delegate tool built!
        │     │  ├─ readerSpec.constraints.max_depth = 0
        │     │  │  └─ Check: depth (1) >= max_depth (0)? NO → OK to execute
        │     │  └─ readerSpec.capabilities = [read_file, grep, find_files]
        │     │     └─ These are primitives, not agents
        │     │
        │     ├─ Build primitiveTools from capabilities
        │     │  (read_file, grep, find_files)
        │     │
        │     ├─ LLM Call with primitive tools
        │     │
        │     ├─ Execute primitives (read_file, grep, etc.)
        │     │
        │     └─ Return AgentResult:
        │        {
        │          output: "Found 42 TS files",
        │          success: true,
        │          stumbles: 0,
        │          turns: 3,
        │          timed_out: false
        │        }
        │
        ├─ Get ActResult
        │
        ├─ Return tool result to parent
        │  Msg.toolResult(call_id, output, !success)
        │
        └─ Add tool result to history
            │
            ├─ More tool calls? → Continue loop
            └─ No tool calls? → Done (success)
```

---

## 6. Genome Loading Process

```
Session Start
        │
        ▼
   createAgent()
        │
        ├─ new Genome(path)
        │
        ├─ existsSync(join(path, ".git"))?
        │
        ├─ YES: Existing Genome
        │  │
        │  ├─ genome.loadFromDisk()
        │  │  │
        │  │  ├─ readdir(genome/agents/)
        │  │  │
        │  │  ├─ For each .yaml/.yml file:
        │  │  │  ├─ loadAgentSpec(file)
        │  │  │  └─ this.agents.set(name, spec)
        │  │  │
        │  │  └─ Load memories, routing rules
        │  │
        │  ├─ genome.syncBootstrap(bootstrapDir)
        │  │  │
        │  │  ├─ loadBootstrapAgents(bootstrapDir)
        │  │  │
        │  │  ├─ For each spec in bootstrap:
        │  │  │  ├─ this.agents.has(spec.name)?
        │  │  │  ├─ NO: Write to genome/agents/ and add to map
        │  │  │  └─ YES: Skip (don't overwrite learned agents)
        │  │  │
        │  │  └─ git commit "genome: sync bootstrap agents"
        │  │
        │  └─ genome.agents Map populated with all agents
        │
        └─ NO: New Genome
           │
           ├─ genome.init()
           │  │
           │  ├─ mkdir(genome/)
           │  ├─ git init
           │  ├─ Create .gitignore
           │  └─ git commit "genome: initialize"
           │
           ├─ genome.initFromBootstrap(bootstrapDir)
           │  │
           │  ├─ loadBootstrapAgents(bootstrapDir)
           │  │
           │  ├─ For each spec:
           │  │  ├─ Write to genome/agents/{name}.yaml
           │  │  └─ this.agents.set(name, spec)
           │  │
           │  └─ git commit "genome: initialize from bootstrap agents"
           │
           └─ genome.agents Map populated with bootstrap agents
        
        │
        ▼
   Get Root Agent Spec
        │
        ├─ rootSpec = genome.getAgent("root")
        │  └─ Returns AgentSpec from genome.agents map
        │
        ▼
   Create Root Agent
        │
        └─ new Agent({
             spec: rootSpec,
             availableAgents: genome.allAgents(),  ← All loaded agents!
             genome: genome,
             ...
           })
```

---

## 7. Cascading Constraints

```
Root Agent (depth: 0)
├─ max_depth: 3 → Can exist at depths 0, 1, 2 (not 3+)
├─ can_spawn: true → Can create delegate tool
└─ Recursively creates:
   │
   └─ Subagent (depth: 1)
      ├─ max_depth: 0 → Can exist at depth 0 only (not 1+)
      │                 BUT depth is 1, so... ERROR? No!
      │                 (Constraint checked in constructor)
      │
      ├─ max_depth: 3 → Can exist at depths 0, 1, 2 (not 3+)
      │  ├─ can_spawn: true → Can create delegate tool
      │  └─ Can recursively create:
      │     │
      │     └─ Sub-subagent (depth: 2)
      │        ├─ max_depth: 0 → Can't be created at depth 2 (limit is 0)
      │        ├─ max_depth: 1 → Can't be created at depth 2 (limit is 1)
      │        └─ max_depth: 3 → OK, can be created at depth 2 (limit is 3)
      │           ├─ can_spawn: true → Can create delegate tool
      │           └─ Can recursively create:
      │              │
      │              └─ Sub³-agent (depth: 3)
      │                 └─ max_depth: 3 → Can't be created (limit is 3, need depth < 3)
      │
      └─ max_depth: 0 → Can't delegate (leaf agent)
         └─ Gets primitive tools instead (read_file, grep, etc.)


Depth Constraint Check (in Agent constructor):
if (this.spec.constraints.max_depth > 0 && this.depth >= this.spec.constraints.max_depth) {
  throw new Error(`Agent exceeds max depth...`);
}

Examples:
- Agent at depth 0 with max_depth 3: 0 < 3 ✓ OK
- Agent at depth 1 with max_depth 3: 1 < 3 ✓ OK
- Agent at depth 2 with max_depth 3: 2 < 3 ✓ OK
- Agent at depth 3 with max_depth 3: 3 >= 3 ✗ ERROR
- Agent at depth 1 with max_depth 0: max_depth 0 means leaf (0 < 1) ✗ ERROR
```

---

## 8. Data Flow from YAML to LLM

```
bootstrap/root.yaml
├─ name: "root"
├─ description: "Decompose tasks..."
├─ capabilities: [reader, editor, command-runner, web-reader, mcp, quartermaster]
├─ model: "best"
└─ system_prompt: "You are a general-purpose agentic system..."
        │
        ▼
   loadAgentSpec()
        │
        ▼
   AgentSpec {
      name: "root",
      description: "Decompose tasks...",
      capabilities: ["reader", "editor", ...],
      model: "best",
      system_prompt: "You are a general-purpose agentic system...",
      constraints: {...},
      tags: ["core", "orchestration"],
      version: 2
   }
        │
        ├──────┬────────┬─────────────┬──────────┬─────────┐
        ▼      ▼        ▼             ▼          ▼         ▼
   Reader  Editor  Command      Web-Reader     MCP   Quartermaster
   Spec    Spec    Runner Spec   Spec          Spec  Spec
                    Spec
        │      │        │             │          │         │
        └──────┴────────┴─────────────┴──────────┴─────────┘
               │
               ▼
        availableAgents: AgentSpec[]
        (Used by root constructor)
               │
               ▼
        new Agent({ availableAgents: [...] })
        (Constructor processes capabilities)
               │
               ├─ "reader" → Find in availableAgents ✓
               ├─ "editor" → Find in availableAgents ✓
               ├─ "command-runner" → Find in availableAgents ✓
               ├─ "web-reader" → Find in availableAgents ✓
               ├─ "mcp" → Find in availableAgents ✓
               └─ "quartermaster" → Find in availableAgents ✓
               │
               ▼
        delegatableAgents: [reader, editor, command-runner, web-reader, mcp, quartermaster]
               │
               ▼
        buildDelegateTool(delegatableAgents)
               │
               ▼
        ToolDefinition {
          name: "delegate",
          parameters: {
            agent_name: {
              enum: ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"]
            }
          }
        }
               │
               ▼
        buildPlanRequest({ agentTools: [delegateTool], ... })
               │
               ▼
        Request to LLM API {
          messages: [
            { role: "system", content: "You are a general-purpose agentic system...\n\n<agents>\n  <agent name=\"reader\">Read and analyze file contents</agent>\n  ...\n</agents>" },
            { role: "user", content: "User goal/task" }
          ],
          tools: [
            {
              name: "delegate",
              parameters: {
                agent_name: {
                  enum: ["reader", "editor", "command-runner", "web-reader", "mcp", "quartermaster"]
                }
              }
            }
          ]
        }
               │
               ▼
        LLM Response {
          tool_calls: [
            {
              id: "call_123",
              name: "delegate",
              arguments: {
                agent_name: "reader",  ← LLM picks from enum!
                goal: "...",
                hints: [...]
              }
            }
          ]
        }
```

---

## 9. Root Agent Visibility

```
What the Root Agent "Sees"

1. System Prompt:
   ┌─────────────────────────────────────────────────────┐
   │ You are a general-purpose agentic system that       │
   │ decomposes tasks and delegates to specialists.      │
   │                                                     │
   │ Available specialists will be presented as tools.  │
   │ Each takes a "goal" (what you want achieved)        │
   │ and optional "hints" (context that might help).     │
   │                                                     │
   │ <agents>                                            │
   │   <agent name="reader">Read and analyze files</agent>│
   │   <agent name="editor">Edit or create files</agent> │
   │   <agent name="command-runner">Execute commands</agent>│
   │   <agent name="web-reader">Fetch web content</agent>│
   │   <agent name="mcp">Model Context Protocol</agent>  │
   │   <agent name="quartermaster">Quartermaster</agent> │
   │ </agents>                                           │
   │                                                     │
   │ <environment>                                       │
   │ Working directory: /Users/jesse/prime-radiant/sprout│
   │ Platform: darwin                                    │
   │ OS version: 25.3.0                                  │
   │ Today's date: 2026-02-25                            │
   │ </environment>                                      │
   └─────────────────────────────────────────────────────┘

2. Available Tools:
   ┌─────────────────────────────────────────────────────┐
   │ Tool: delegate                                      │
   │ ─────────────────────────────────────────────────────│
   │ Description: Delegate a task to a specialist agent │
   │                                                     │
   │ Parameters:                                         │
   │   - agent_name: string (enum: [reader, editor, ..])│
   │   - goal: string (required)                         │
   │   - hints: array of strings (optional)              │
   │                                                     │
   │ Example:                                            │
   │ {                                                   │
   │   "agent_name": "reader",                           │
   │   "goal": "Find all Python files",                  │
   │   "hints": ["Look in src/ directory"]               │
   │ }                                                   │
   └─────────────────────────────────────────────────────┘

The root agent CANNOT see:
- Primitives (read_file, grep, etc.) - only leaf agents see those
- Other agents' internal tools
- Genome directory structure
- Bootstrap directory
- Anything hardcoded - only what's in the YAML and prompt!
```

---

## 10. Error Handling Flow

```
ExecuteDelegation Error Scenarios

Scenario 1: Unknown Agent
─────────────────────────
delegation = {
  agent_name: "nonexistent",
  goal: "...",
}
  │
  ├─ genome.getAgent("nonexistent") → undefined
  ├─ availableAgents.find(...) → undefined
  │
  ├─ subagentSpec is null/undefined
  │
  └─ Return error:
     {
       toolResultMsg: Msg.toolResult(call_id, "Unknown agent: nonexistent", true),
       stumbles: 1
     }


Scenario 2: Subagent Execution Fails
──────────────────────────────────────
new Agent({ spec: ..., ...}).run(goal)
  └─ Throws exception (out of memory, LLM error, etc.)
       │
       └─ Catch block:
          {
            toolResultMsg: Msg.toolResult(call_id, "Subagent failed: ...", true),
            stumbles: 1
          }


Scenario 3: Invalid Delegation (no goal)
─────────────────────────────────────────
toolCall = {
  name: "delegate",
  arguments: {
    agent_name: "reader"
    // goal is missing!
  }
}
  │
  ├─ parsePlanResponse(toolCall)
  │  ├─ Check: goal = arguments.goal
  │  ├─ goal is undefined
  │  └─ Push error:
  │     {
  │       call_id: "...",
  │       error: "Agent delegation missing required 'goal' argument"
  │     }
  │
  └─ Return error tool result:
     {
       call_id: "...",
       message: "Error: Agent delegation missing required 'goal' argument"
     }


Scenario 4: Agent Name Not in Enum (LLM Hallucination)
──────────────────────────────────────────────────────
LLM tries to call:
{
  name: "delegate",
  arguments: {
    agent_name: "hallucinated_agent",
    goal: "..."
  }
}

Most LLM providers will reject this at the API level (because
agent_name doesn't match the enum). If it somehow gets through:
  │
  └─ parsePlanResponse() might still create Delegation with invalid agent_name
     │
     └─ executeDelegation() will catch:
        subagentSpec = genome.getAgent("hallucinated_agent") → null
        │
        └─ Return error (Scenario 1)


Key: Enum constraint prevents most scenarios!
```

---

## 11. Memory Layout: Agent in Constructor

```
Agent Instance (after constructor)

┌─────────────────────────────────────────────────────────────────┐
│ Agent {                                                         │
│   spec: AgentSpec {                                            │
│     name: "root",                                              │
│     description: "...",                                        │
│     model: "best",                                             │
│     capabilities: ["reader", "editor", ...],                  │
│     constraints: { can_spawn: true, ... },                    │
│     system_prompt: "You are a general-purpose...",            │
│     ...                                                        │
│   },                                                           │
│                                                                │
│   availableAgents: [  ← Static snapshot from genome           │
│     AgentSpec { name: "reader", ... },                        │
│     AgentSpec { name: "editor", ... },                        │
│     AgentSpec { name: "command-runner", ... },                │
│     AgentSpec { name: "web-reader", ... },                    │
│     AgentSpec { name: "mcp", ... },                           │
│     AgentSpec { name: "quartermaster", ... }                  │
│   ],                                                           │
│                                                                │
│   genome: Genome {  ← Reference to live store                │
│     agents: Map {                                             │
│       "root" → AgentSpec,                                     │
│       "reader" → AgentSpec,                                   │
│       "editor" → AgentSpec,                                   │
│       ...                                                      │
│     },                                                         │
│     ...                                                        │
│   },                                                           │
│                                                                │
│   agentTools: [  ← Built in constructor                      │
│     ToolDefinition {                                          │
│       name: "delegate",                                       │
│       parameters: {                                           │
│         agent_name: {                                         │
│           enum: ["reader", "editor", ...]                     │
│         }                                                      │
│       }                                                        │
│     }                                                          │
│   ],                                                           │
│                                                                │
│   primitiveTools: [],  ← Empty (orchestrator doesn't use)   │
│                                                                │
│   depth: 0,                                                    │
│   env: ExecutionEnvironment { ... },                          │
│   client: Client { ... },                                     │
│   primitiveRegistry: PrimitiveRegistry { ... },               │
│   ...                                                          │
│ }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 12. Delegation Path Example

```
User: "Count lines of code in all Python files"
        │
        ▼
Root Agent Turn 1
├─ Goal: "Count lines of code in all Python files"
├─ LLM thinks: "Need to find Python files and count lines"
├─ LLM calls: delegate(agent_name="reader", goal="Find all .py files", hints=[])
│
└─ ExecuteDelegation to Reader
   │
   ├─ Reader Agent Turn 1
   │  ├─ Goal: "Find all .py files"
   │  ├─ LLM thinks: "I need to search the codebase"
   │  ├─ LLM calls: find_files(pattern="**/*.py")
   │  │
   │  └─ Primitive Result: "Found: main.py, lib.py, utils.py, test.py"
   │
   ├─ Reader Agent Turn 2
   │  ├─ LLM thinks: "Good, now I need to count lines"
   │  ├─ LLM calls: read_file(path="main.py") + read_file(path="lib.py") + ...
   │  │
   │  └─ Primitive Results:
   │     ├─ main.py: 150 lines
   │     ├─ lib.py: 320 lines
   │     ├─ utils.py: 85 lines
   │     └─ test.py: 200 lines
   │
   ├─ Reader Agent Turn 3
   │  ├─ LLM thinks: "Total = 150 + 320 + 85 + 200 = 755"
   │  ├─ No more tool calls
   │  │
   │  └─ Output: "Found 4 Python files with 755 total lines of code"
   │
   └─ Return to Root: ActResult { output: "Found 4 Python files..." }
        │
        └─ Tool Result: "Found 4 Python files with 755 total lines of code"
                │
                ▼
Root Agent Turn 2
├─ History now includes:
│  ├─ User goal: "Count lines of code..."
│  ├─ Tool call: delegate(agent_name="reader", ...)
│  ├─ Tool result: "Found 4 Python files with 755 total lines of code"
│
├─ LLM thinks: "Task complete, the reader found the answer"
├─ LLM generates: "I've analyzed your codebase. There are 4 Python files with a total of 755 lines of code."
└─ No more tool calls

        │
        ▼
Return to User
└─ "I've analyzed your codebase. There are 4 Python files with a total of 755 lines of code."
```

---

## Summary Diagram: The Complete Picture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           SPROUT AGENT ARCHITECTURE                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  USER INPUT                                                                 │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────┐       │
│  │  ROOT AGENT (Orchestrator)                                      │       │
│  │                                                                 │       │
│  │  Reads: bootstrap/root.yaml                                    │       │
│  │  Capabilities: [reader, editor, command-runner, ...]          │       │
│  │  Can Spawn: true (can delegate)                                │       │
│  │  Max Depth: 3 (can create nested subagents)                    │       │
│  │                                                                 │       │
│  │  Delegate Tool: {                                              │       │
│  │    name: "delegate",                                           │       │
│  │    agent_name: {enum: [reader, editor, ...]}                  │       │
│  │    goal: string,                                               │       │
│  │    hints: array                                                │       │
│  │  }                                                              │       │
│  └──┬──────────────────────────────────────────────────────────────┘       │
│     │ Decompose goal and delegate                                          │
│     │                                                                       │
│     ├─────────────────────────────────────────────────────────────┐        │
│     │                                                             │        │
│     ▼                                                             ▼        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐        │
│  │  READER AGENT    │  │  EDITOR AGENT    │  │  COMMAND-RUNNER  │        │
│  │  (Leaf)          │  │  (Leaf)          │  │  (Leaf)          │        │
│  │                  │  │                  │  │                  │        │
│  │  Can Spawn: false│  │  Can Spawn: false│  │  Can Spawn: false│        │
│  │  Max Depth: 0    │  │  Max Depth: 0    │  │  Max Depth: 0    │        │
│  │                  │  │                  │  │                  │        │
│  │  Primitives:     │  │  Primitives:     │  │  Primitives:     │        │
│  │  • read_file     │  │  • write_file    │  │  • exec          │        │
│  │  • grep          │  │  • edit_file     │  │  • background    │        │
│  │  • find_files    │  │  • create_file   │  │  • stop          │        │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘        │
│                                                                             │
│  DATA FLOW:                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ bootstrap/ YAML files                                               │  │
│  │        ↓                                                             │  │
│  │ loadBootstrapAgents() → AgentSpec[]                                │  │
│  │        ↓                                                             │  │
│  │ Genome (persistent store)                                          │  │
│  │        ↓                                                             │  │
│  │ genome.allAgents() → availableAgents                               │  │
│  │        ↓                                                             │  │
│  │ Agent constructor (filter by capabilities)                         │  │
│  │        ↓                                                             │  │
│  │ buildDelegateTool(delegatableAgents) → ToolDefinition             │  │
│  │        ↓                                                             │  │
│  │ buildPlanRequest() → LLM API request with tool enum constraint     │  │
│  │        ↓                                                             │  │
│  │ LLM sees: agent descriptions in <agents> XML + tool enum          │  │
│  │        ↓                                                             │  │
│  │ LLM generates delegation (pick agent from enum + goal)             │  │
│  │        ↓                                                             │  │
│  │ parsePlanResponse() → Delegation                                   │  │
│  │        ↓                                                             │  │
│  │ executeDelegation() → Create subagent → Recursive run()            │  │
│  │        ↓                                                             │  │
│  │ Return tool result to parent → Continue loop                       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

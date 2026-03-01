# Quick Start: Agent Delegation Architecture

**TL;DR**: Root agent reads `root/root.md`, resolves subagents from the agent tree, builds a single `delegate` tool with agent names as an enum, and can recursively create subagents that respect the same availability constraints.

---

## Key Files

| File | Purpose | Key Content |
|------|---------|-------------|
| `root/root.md` | Root agent config | `agents: [utility/reader, utility/editor, ...]` |
| `src/agents/loader.ts` | Load specs → AgentSpec | `loadRootAgents(dir)` |
| `src/genome/genome.ts` | Persist agents in git | `allAgents()`, `getAgent(name)` |
| `src/agents/factory.ts` | Create agent + genome | `createAgent(options)` → Agent |
| `src/agents/agent.ts` | Main agent logic | Constructor builds delegate tool, `run()` loop, `executeDelegation()` |
| `src/agents/plan.ts` | LLM request building | `buildDelegateTool()`, `renderAgentsForPrompt()`, `parsePlanResponse()` |

---

## The Critical Path

### 1. Root Agent Loading
```typescript
// src/agents/loader.ts
loadRootAgents("root/")
  → Recursively scans agent tree
  → Parses each .md/.yaml spec into AgentSpec
  → Returns AgentSpec[]
```

### 2. Genome Persistence
```typescript
// src/genome/genome.ts
genome.initFromRoot(rootDir)
  → Calls loadRootAgents()
  → Writes each spec to genome/agents/{name}.yaml
  → Stores in this.agents Map<string, AgentSpec>
  → Commits to git
```

### 3. Agent Creation
```typescript
// src/agents/factory.ts:108
new Agent({
  spec: rootSpec,
  availableAgents: genome.allAgents(),  // ← ALL agents from genome
  genome,  // ← For runtime dynamic lookup
  ...
})
```

### 4. Delegate Tool Building (Constructor)
```typescript
// src/agents/agent.ts:122-134
if (this.spec.constraints.can_spawn) {  // ← root has true
  for (const cap of this.spec.capabilities) {  // ← [reader, editor, ...]
    const agent = this.availableAgents.find(a => a.name === cap);
    if (agent) delegatableAgents.push(agent);
  }
  this.agentTools.push(buildDelegateTool(delegatableAgents));
}
```

### 5. Delegate Tool Definition
```typescript
// src/agents/plan.ts:14-41
buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
  return {
    name: "delegate",
    parameters: {
      agent_name: {
        enum: agents.map(a => a.name),  // ← ["reader", "editor", ...]
      },
      goal: { type: "string" },
      hints: { type: "array" }
    }
  };
}
```

### 6. LLM Prompt Rendering
```typescript
// src/agents/plan.ts:46-52
renderAgentsForPrompt(agents)
  → `<agents>\n<agent name="reader">...</agent>\n...</agents>`
  → Injected into system prompt

// src/agents/agent.ts:427
systemPrompt += renderAgentsForPrompt(delegatableAgents);
```

### 7. LLM Call with Enum Constraint
```typescript
// src/agents/plan.ts:120-153
buildPlanRequest({
  systemPrompt: "... <agents>...</agents>",
  agentTools: [delegateTool],  // ← With agent_name enum
  ...
})
// LLM can only pick agent_name from the enum!
```

### 8. LLM Response & Parsing
```typescript
// LLM generates:
{
  name: "delegate",
  arguments: {
    agent_name: "reader",  // ← Must be in enum
    goal: "Find Python files",
    hints: [...]
  }
}

// src/agents/plan.ts:199-222
parsePlanResponse(toolCalls)
  → Validate agent_name is string and non-empty
  → Validate goal is string and non-empty
  → Create Delegation { agent_name, goal, hints }
```

### 9. Delegation Execution
```typescript
// src/agents/agent.ts:219-328
executeDelegation(delegation) {
  // Look up subagent spec (prefer genome)
  const subagentSpec = 
    this.genome?.getAgent(delegation.agent_name) ??
    this.availableAgents.find(a => a.name === delegation.agent_name);
  
  // Create subagent with SAME availableAgents and genome
  const subagent = new Agent({
    spec: subagentSpec,
    availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
    genome: this.genome,
    depth: this.depth + 1,  // Incremented
    ...
  });
  
  // Recursive call
  const subResult = await subagent.run(goal);
  
  return { toolResultMsg, stumbles, output };
}
```

### 10. Recursion & Constraints
```typescript
// Each subagent checks its constraints:

// Can this agent spawn subagents?
if (this.spec.constraints.can_spawn) {
  // Build delegate tool
}

// Did this agent exceed its max depth?
if (this.spec.constraints.max_depth > 0 && 
    this.depth >= this.spec.constraints.max_depth) {
  throw new Error("Exceeds max depth");
}

// Leaf agents (can_spawn: false, max_depth: 0)
// Get primitives instead of delegate tool
```

---

## No Hardcoding!

**Truth**: All agent names and specs come from YAML files.

**Evidence**:
- `loader.ts`: recursively scans root directory dynamically
- `genome.ts`: `loadFromDisk()` reads genome/agents/ dynamically
- `agent.ts` line 126: `availableAgents.find(a => a.name === cap)` lookup is dynamic
- `plan.ts` line 15: `agents.map(a => a.name)` builds enum from input array

**What's hardcoded**: Only the structure (e.g., "look for .yaml files", "check can_spawn constraint")

---

## Delegation Rules

### Root Agent Can Delegate To:
- Any agent listed in `root/root.md` `agents` field, or discovered via agent tree scanning
- ONLY if that agent exists in the genome
- Agent names used as parameter enum in delegate tool

### Subagent Can Delegate To:
- Any agent listed in its own spec's `agents` field, or resolved via the agent tree
- Receives same `availableAgents` list from parent
- Can only delegate if `constraints.can_spawn: true`

### Depth Constraints:
```
Root (depth 0, max_depth 3):
  ├─ Can create subagent at depth 1 ✓
  │  └─ If subagent.max_depth > 1, can create sub-subagent at depth 2 ✓
  │     └─ If sub-subagent.max_depth > 2, can create at depth 3 ✗ ERROR
  │
  └─ If root.max_depth = 0, cannot exist at depth 0 ✗ (caught in constructor)

Leaf Agent (can_spawn: false):
  └─ Cannot build delegate tool, gets primitives instead
```

---

## Data Flow Summary

```
root/root.md
    ↓ (loadRootAgents)
AgentSpec[] from root/
    ↓ (Genome.initFromRoot or syncRoot)
Genome.agents Map<string, AgentSpec>
    ↓ (Genome.allAgents)
availableAgents: AgentSpec[] passed to Agent constructor
    ↓ (Agent tree resolution or capabilities fallback)
delegatableAgents: AgentSpec[]
    ↓ (buildDelegateTool)
ToolDefinition with agent_name enum
    ↓ (buildPlanRequest)
LLM Request with tool definition
    ↓ (LLM generates tool call)
ToolCall with agent_name from enum
    ↓ (parsePlanResponse)
Delegation { agent_name, goal, hints }
    ↓ (executeDelegation)
New Agent with same availableAgents
    ↓ (Recursive)
ActResult returned to parent
```

---

## Test Cases to Verify Understanding

### Test 1: Agent Not in Genome
```yaml
# root/root.md frontmatter
agents:
  - nonexistent_agent
```
**Result**: Agent tree resolution finds no matching spec, agent not added to delegatableAgents, no enum option for it, LLM can't pick it.

### Test 2: New Root Agent Added
**Before**: genome/agents has [reader, editor]
**Add**: command-runner to root/
**Then**: Call `genome.syncRoot()` (manifest-aware 4-way sync)
**Result**: command-runner added to genome, available for new delegates.

### Test 3: Leaf Agent Trying to Delegate
```yaml
# Some leaf agent
constraints:
  can_spawn: false
```
**Result**: Constructor skips delegate tool building (line 122), `this.agentTools` is empty, agent only gets `primitiveTools`. ✓

### Test 4: Max Depth Exceeded
```
Root (depth: 0, max_depth: 1)
├─ Subagent A (depth: 1, max_depth: 1)
│  └─ Subagent B (depth: 2, max_depth: 1)
│     └─ Constructor check (line 110):
│        110 >= 1? YES → throw error
```
**Result**: Can't create Sub-subagent B. ✓

### Test 5: Dynamic Genome Update
During execution, a learned agent is added to genome. Next delegation lookup:
```typescript
// line 210
const source = this.genome ? this.genome.allAgents() : this.availableAgents;
// ↑ Prefers live genome over static snapshot
```
**Result**: New agent is visible. ✓

---

## Common Questions

**Q: Is there a hardcoded list of agents somewhere?**
A: No. All agents come from spec files in root/ and genome/agents/.

**Q: How does the LLM know which agents exist?**
A: 
1. Agent descriptions injected into system prompt as `<agents>` XML
2. Agent names in delegate tool's `agent_name` enum parameter
Both derived from the same AgentSpec[] source.

**Q: Can the root agent delegate to any agent?**
A: Only agents listed in `root/root.md` `agents` field (or resolved from the agent tree) that exist in the genome.

**Q: What stops an agent from delegating to itself?**
A: Line 125 in agent.ts: `if (cap === this.spec.name) continue;` skips self-reference.

**Q: How many levels of delegation can happen?**
A: Up to `root.constraints.max_depth` - 1 levels (e.g., max_depth: 3 allows depths 0, 1, 2).

**Q: Are subagents created fresh each time?**
A: Yes, new Agent instance each time (line 254). Each has own state but same availableAgents and genome reference.

---

## To Modify Delegation

### Add a New Agent
1. Create `root/agents/my-agent.md` with YAML frontmatter:
   - `name: my-agent`
   - `description: "..."`
   - `model: "..."`
   - `tools: [...]` (primitive tools)
   - `agents: [...]` (subagent paths, if orchestrator)
   - `constraints: {...}`
   - Markdown body becomes the system prompt

2. The agent tree scanner auto-discovers agents from the directory structure, or explicitly add to parent's `agents` list.

3. Restart or call `genome.syncRoot(rootDir)`

4. Parent agent will now show new agent in `<agents>` and delegate tool enum

### Remove Agent Delegation
1. Remove the agent's `.md` file from `root/agents/`
2. Or remove it from the parent's `agents` list in frontmatter

3. The agent will no longer be available for delegation

### Change Agent Tools
Edit the agent's spec file (e.g., `root/agents/utility/agents/editor.md`):
```yaml
tools:
  - write_file      # Change these
  - edit_file
  - new_primitive   # Add this
```

Subagents will get updated tools on next construction.

---

## Debugging: Agent Availability

### To see what agents are available:
```typescript
const agent = new Agent({ ... });
const tools = agent.resolvedTools();
// Look at toolDefinition.parameters.agent_name.enum
```

Or check genome directly:
```typescript
const genome = new Genome(path);
await genome.loadFromDisk();
console.log(genome.allAgents().map(a => a.name));
```

### To trace a delegation:
1. Set breakpoint in `src/agents/agent.ts` line 220 (`executeDelegation`)
2. Check `delegation.agent_name` value
3. Check `subagentSpec` is found
4. Check subagent constructor (line 254) has correct spec and availableAgents

### To see what the LLM saw:
Check event logs or look at:
1. System prompt built by `buildSystemPrompt()` + `renderAgentsForPrompt()`
2. Tool definitions in `buildPlanRequest()` argument
3. LLM request message in client library

---

## Performance Notes

- **Enum parameter**: Restricts LLM choices, preventing hallucinated agent names
- **Single delegate tool**: Better than N separate tools (preserves prompt caching)
- **Capability filtering**: Only agents matching capabilities are in the enum (smaller constraint set)
- **Genome preference**: Dynamic lookup at runtime allows learned agents without reload

---

## Summary Checklist

- [ ] Root agent loaded from `root/root.md`
- [ ] Agent tree determines which agents each orchestrator can delegate to
- [ ] Delegate tool has agent names listed in system prompt
- [ ] Agent descriptions injected into system prompt via `<agents>` XML
- [ ] LLM selects from known agent names (no hallucination)
- [ ] Subagents created recursively with same availableAgents and genome
- [ ] Each agent respects its own tools, agents, and constraints
- [ ] Depth and can_spawn constraints prevent invalid recursion
- [ ] Genome is source of truth, not hardcoded list
- [ ] New root agents synced via `syncRoot()` on startup
- [ ] Learned agents never overwritten by root sync

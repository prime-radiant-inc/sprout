# Quick Start: Agent Delegation Architecture

**TL;DR**: Root agent reads `bootstrap/root.yaml`, filters agents by `capabilities` list, builds a single `delegate` tool with agent names as an enum, and can recursively create subagents that respect the same availability constraints.

---

## Key Files

| File | Purpose | Key Content |
|------|---------|-------------|
| `bootstrap/root.yaml` | Root agent config | `capabilities: [reader, editor, ...]` |
| `src/agents/loader.ts` | Load YAML → AgentSpec | `loadBootstrapAgents(dir)` |
| `src/genome/genome.ts` | Persist agents in git | `allAgents()`, `getAgent(name)` |
| `src/agents/factory.ts` | Create agent + genome | `createAgent(options)` → Agent |
| `src/agents/agent.ts` | Main agent logic | Constructor builds delegate tool, `run()` loop, `executeDelegation()` |
| `src/agents/plan.ts` | LLM request building | `buildDelegateTool()`, `renderAgentsForPrompt()`, `parsePlanResponse()` |

---

## The Critical Path

### 1. Bootstrap Loading
```typescript
// src/agents/loader.ts
loadBootstrapAgents("bootstrap/") 
  → Reads all .yaml/.yml files
  → Parses each into AgentSpec
  → Returns AgentSpec[]
```

### 2. Genome Persistence
```typescript
// src/genome/genome.ts
genome.initFromBootstrap(bootstrapDir)
  → Calls loadBootstrapAgents()
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
- `loader.ts`: `readdir()` reads bootstrap directory dynamically
- `genome.ts`: `loadFromDisk()` reads genome/agents/ dynamically
- `agent.ts` line 126: `availableAgents.find(a => a.name === cap)` lookup is dynamic
- `plan.ts` line 15: `agents.map(a => a.name)` builds enum from input array

**What's hardcoded**: Only the structure (e.g., "look for .yaml files", "check can_spawn constraint")

---

## Delegation Rules

### Root Agent Can Delegate To:
- Any agent listed in `bootstrap/root.yaml` `capabilities` array
- ONLY if that agent exists in the genome
- Agent names used as parameter enum in delegate tool

### Subagent Can Delegate To:
- Any agent listed in its own spec's `capabilities` array
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
bootstrap/root.yaml
    ↓ (loadBootstrapAgents)
AgentSpec[] from bootstrap/
    ↓ (Genome.initFromBootstrap or syncBootstrap)
Genome.agents Map<string, AgentSpec>
    ↓ (Genome.allAgents)
availableAgents: AgentSpec[] passed to Agent constructor
    ↓ (Constructor filters by root.capabilities)
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

### Test 1: Capability Not in Genome
```yaml
# bootstrap/root.yaml
capabilities:
  - nonexistent_agent
```
**Result**: `availableAgents.find()` returns undefined, agent not added to delegatableAgents, no enum option for it, LLM can't pick it. ✓

### Test 2: New Bootstrap Agent Added
**Before**: genome/agents has [reader, editor]
**Add**: commander-runner to bootstrap/
**Then**: Call `genome.syncBootstrap()`
**Result**: commander-runner added to genome (line 309 check `if (this.agents.has())` passes), available for new delegates. ✓

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
A: No. All agents come from YAML files in bootstrap/ and genome/agents/.

**Q: How does the LLM know which agents exist?**
A: 
1. Agent descriptions injected into system prompt as `<agents>` XML
2. Agent names in delegate tool's `agent_name` enum parameter
Both derived from the same AgentSpec[] source.

**Q: Can the root agent delegate to any agent?**
A: Only agents in `root.yaml` `capabilities` list that exist in the genome.

**Q: What stops an agent from delegating to itself?**
A: Line 125 in agent.ts: `if (cap === this.spec.name) continue;` skips self-reference.

**Q: How many levels of delegation can happen?**
A: Up to `root.constraints.max_depth` - 1 levels (e.g., max_depth: 3 allows depths 0, 1, 2).

**Q: Are subagents created fresh each time?**
A: Yes, new Agent instance each time (line 254). Each has own state but same availableAgents and genome reference.

---

## To Modify Delegation

### Add a New Agent
1. Create `bootstrap/my-agent.yaml` with:
   - `name: my-agent`
   - `description: "..."`
   - `model: "..."`
   - `capabilities: [...]` (primitives or other agents)
   - `constraints: {...}`
   - `system_prompt: |...`

2. Add to `bootstrap/root.yaml` capabilities:
   ```yaml
   capabilities:
     - reader
     - editor
     - my-agent  ← Add here
   ```

3. Restart or call `genome.syncBootstrap(bootstrapDir)`

4. Root agent will now show new agent in `<agents>` and delegate tool enum

### Remove Agent Delegation
1. Edit `bootstrap/root.yaml` capabilities:
   ```yaml
   capabilities:
     - reader
     - editor
     # - removed-agent  ← Comment out or delete
   ```

2. Root agent will no longer be able to delegate to it

### Change Agent Capabilities
Edit the agent's YAML file (e.g., `bootstrap/editor.yaml`):
```yaml
capabilities:
  - write_file      ← Change these
  - edit_file
  - new_primitive   ← Add this
```

Subagents will get updated capabilities on next construction (either primitive tools or delegation options depending on what the names match to).

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

- [ ] Root agent loaded from `bootstrap/root.yaml`
- [ ] Root capabilities list determines which agents it can delegate to
- [ ] Delegate tool has enum parameter limiting agent names
- [ ] Agent descriptions injected into system prompt via `<agents>` XML
- [ ] LLM can only pick from enum (no hallucination)
- [ ] Subagents created recursively with same availableAgents and genome
- [ ] Each agent respects its own capabilities and constraints
- [ ] Depth and can_spawn constraints prevent invalid recursion
- [ ] Genome is source of truth, not hardcoded list
- [ ] New bootstrap agents synced via `syncBootstrap()` on startup
- [ ] Learned agents never overwritten by bootstrap sync

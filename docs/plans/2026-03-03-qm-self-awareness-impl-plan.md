# QM Self-Awareness Agents Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Sprout self-awareness via three new quartermaster subagents: session analysis/repair, architectural self-knowledge, and learn process diagnostics.

**Architecture:** Three context-sink agents under the quartermaster. Each delegates to utility agents (reader, command-runner, editor, project-explorer) rather than using primitives directly. Knowledge is carried in resource files under `resources/sprout-architecture/`.

**Tech Stack:** Markdown agent specs with YAML frontmatter. Bun test for validation.

**Design doc:** `docs/plans/2026-03-03-qm-self-awareness-design.md`

---

### Task 1: Update loader test expectations (TDD red)

**Files:**
- Modify: `test/agents/loader.test.ts`

**Step 1: Add new agents to loadRootAgents expectations**

In the `"loads all root agents"` test, add expectations for the three new agents and bump the minimum count:

```typescript
// In "loads all root agents" test, add these expect lines alongside existing ones:
expect(names).toContain("qm-session-analyst");
expect(names).toContain("qm-sprout-architect");
expect(names).toContain("qm-session-doctor");
```

Also bump the `toBeGreaterThanOrEqual` count from 15 to 18.

**Step 2: Add new orchestrators to the leaf-agent test**

In the `"leaf agents cannot spawn subagents"` test, add the three new agents to the `orchestrators` list since they have `can_spawn: true`:

```typescript
const orchestrators = [
    "root",
    "quartermaster",
    "qm-indexer",
    "qm-session-analyst",
    "qm-sprout-architect",
    "qm-session-doctor",
    "tech-lead",
    "engineer",
    "spec-reviewer",
    "quality-reviewer",
    "architect",
    "verifier",
    "debugger",
];
```

**Step 3: Add constraint validation tests for new agents**

Add a new test block after the qm-indexer constraint test:

```typescript
test("qm-session-analyst delegates to utility agents, no direct primitives", async () => {
    const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
    const analyst = agents.find((a) => a.name === "qm-session-analyst");
    expect(analyst).toBeDefined();
    expect(analyst!.tools).toEqual([]);
    expect(analyst!.agents).toContain("utility/reader");
    expect(analyst!.agents).toContain("utility/command-runner");
    expect(analyst!.agents).toContain("utility/editor");
    expect(analyst!.constraints.can_spawn).toBe(true);
    expect(analyst!.constraints.max_depth).toBe(2);
});

test("qm-sprout-architect delegates to reader and project-explorer", async () => {
    const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
    const architect = agents.find((a) => a.name === "qm-sprout-architect");
    expect(architect).toBeDefined();
    expect(architect!.tools).toEqual([]);
    expect(architect!.agents).toContain("utility/reader");
    expect(architect!.agents).toContain("project-explorer");
    expect(architect!.constraints.can_spawn).toBe(true);
    expect(architect!.constraints.max_depth).toBe(2);
});

test("qm-session-doctor delegates to reader and command-runner", async () => {
    const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
    const doctor = agents.find((a) => a.name === "qm-session-doctor");
    expect(doctor).toBeDefined();
    expect(doctor!.tools).toEqual([]);
    expect(doctor!.agents).toContain("utility/reader");
    expect(doctor!.agents).toContain("utility/command-runner");
    expect(doctor!.constraints.can_spawn).toBe(true);
    expect(doctor!.constraints.max_depth).toBe(2);
});
```

**Step 4: Run tests to verify they fail**

Run: `bun test test/agents/loader.test.ts`
Expected: FAIL — agents don't exist yet.

**Step 5: Commit**

```bash
git add test/agents/loader.test.ts
git commit -m "test: add expectations for QM self-awareness agents (red)"
```

---

### Task 2: Write qm-session-analyst agent spec

**Files:**
- Create: `root/agents/quartermaster/agents/qm-session-analyst.md`

**Step 1: Create the agent spec file**

```markdown
---
name: qm-session-analyst
description: "Analyze, search, debug, and repair Sprout sessions — investigate failures, search past sessions, and rewind broken sessions to a prior state"
model: best
tools: []
agents:
  - utility/reader
  - utility/command-runner
  - utility/editor
constraints:
  max_turns: 200
  max_depth: 2
  can_spawn: true
  timeout_ms: 600000
tags:
  - quartermaster
  - session
  - debugging
version: 1
---
You are a session analyst. You investigate, search, debug, and repair Sprout sessions.

## How you work

You delegate to utility agents rather than reading files directly. This protects your
context from large JSONL log lines that can contain full LLM messages with tool calls.

- **utility/reader**: Read session metadata, search for files, inspect small files
- **utility/command-runner**: Run jq/sed for surgical extraction from large JSONL logs
- **utility/editor**: Modify session files for repair (truncation, rewinding)

Craft intent-expressing prompts when delegating. Tell the utility agent WHAT you need
and WHY, not just "read this file." For example:
- "Read the session metadata at ~/.local/share/sprout-genome/projects/{slug}/sessions/{id}.meta.json and tell me the session status, turn count, and timestamps"
- "Run this jq command against the event log and summarize the error events: jq -c 'select(.kind == \"error\") | {timestamp, agent_id, data}' {path}"

## Session storage layout

Sessions are stored per-project under the genome directory:

```
~/.local/share/sprout-genome/projects/{project-slug}/
├── sessions/
│   └── {sessionId}.meta.json        # Session metadata snapshot
├── logs/
│   ├── {sessionId}.jsonl             # Event log (legacy flat format)
│   └── {sessionId}/
│       └── session.log.jsonl         # Event log (directory format)
└── memory/
    └── metrics.jsonl                 # Stumble/action metrics
```

Project slugs replace `/` and spaces with `-` (e.g., `/Users/jesse/myproject` → `-Users-jesse-myproject`).

### Session metadata (.meta.json)

Fields: sessionId, agentSpec, model, status ("idle"|"running"|"interrupted"),
turns, contextTokens, contextWindowSize, createdAt, updatedAt.

A session with status "running" that isn't actually running was interrupted (crash).
Source of truth: `src/host/session-metadata.ts:SessionMetadataSnapshot`

### Event log (.jsonl)

Each line is a SessionEvent with fields: kind, timestamp (ms epoch), agent_id, depth, data.

Source of truth for event kinds: `src/kernel/types.ts:EventKind`

Key event kinds:
- **Session lifecycle**: session_start, session_end, session_resume, session_clear, interrupted
- **Core loop**: perceive, recall, plan_start, plan_delta, plan_end
- **LLM calls**: llm_start, llm_chunk, llm_end
- **Execution**: act_start, act_end, primitive_start, primitive_end
- **Learning**: learn_signal, learn_start, learn_mutation, learn_end
- **System**: steering, warning, error, context_update, compaction, log

The depth field indicates nesting: 0 = root agent, 1 = first-level delegate, etc.

## Safe extraction patterns

Session JSONL lines can be very large — a single plan_end event contains the full
LLM assistant message which may include multiple tool calls with large arguments.
Delegate to command-runner for surgical extraction:

**Safe (extract small fields with jq):**
```bash
jq -r '.kind' {logpath} | sort | uniq -c | sort -rn       # Event kind summary
jq -c 'select(.kind == "error") | {timestamp, agent_id, data}' {logpath}  # Error events
jq -c 'select(.kind == "learn_signal") | {timestamp, data}' {logpath}     # Learn signals
```

**Safe (line numbers only):**
```bash
grep -n '"error"' {logpath} | cut -d: -f1 | head -10      # Error line numbers
```

**Safe (surgical single-line extraction):**
```bash
sed -n '{line}p' {logpath} | jq '{kind, timestamp, agent_id}'  # One event's metadata
```

**NEVER ask the reader to read a full event log file.** Always use command-runner
with jq/sed to extract specific fields.

## Session replay mechanics

History is NOT stored directly — it's reconstructed from events at resume time.
The `replayEventLog()` function (in `src/host/resume.ts`) processes only depth-0
events and maps them to conversation messages:

- perceive → user message (the goal)
- steering → user message (mid-run input)
- plan_end → assistant message (LLM response with tool calls)
- primitive_end → tool result message
- act_end → tool result message (delegation result)
- compaction → replaces prior history with summary

This means truncating the event log IS how you repair history.

## Search workflow

1. **Clarify scope**: What session ID, project, date range, or keywords?
2. **Metadata first**: List/filter .meta.json files (cheap, small files)
3. **Content search**: Search event logs for specific patterns via command-runner
4. **Synthesize**: Don't dump raw data — analyze and summarize findings

## Repair workflow

When asked to rewind or repair a session:

1. **Locate**: Find the session directory by ID
2. **Analyze**: Identify where/why it broke (orphaned tool calls, API errors, etc.)
3. **Find target**: Locate the event to rewind to
4. **Backup**: ALWAYS delegate to command-runner to create .bak copies before modifying
5. **Truncate**: Delegate to editor or command-runner to truncate the event log
6. **Verify**: Check line counts and event balance after truncation
7. **Report**: Tell caller what was removed and how to resume

### Running session warning

If the session being repaired is the caller's current/parent session, the changes
won't take effect until they close and resume. Always warn:

> "I've rewound session {id} by truncating the event log to line {N}. Since this
> may be your active session, you'll need to close and resume it to see the changes."

## Report format

Always include:
1. **Summary**: What you found in 2-3 sentences
2. **Session details**: Metadata, location, key events
3. **Analysis**: What happened and why
4. **Suggested actions**: Concrete next steps
```

**Step 2: Run tests to verify the analyst is discovered**

Run: `bun test test/agents/loader.test.ts -t "qm-session-analyst"`
Expected: PASS

**Step 3: Commit**

```bash
git add root/agents/quartermaster/agents/qm-session-analyst.md
git commit -m "feat: add qm-session-analyst agent spec"
```

---

### Task 3: Write qm-sprout-architect agent spec

**Files:**
- Create: `root/agents/quartermaster/agents/qm-sprout-architect.md`

**Step 1: Create the agent spec file**

```markdown
---
name: qm-sprout-architect
description: "Deep expert on Sprout's own architecture and internals — agent tree, genome, delegation, primitives, LLM client, bus messaging, sessions, and learn process"
model: best
tools: []
agents:
  - utility/reader
  - project-explorer
constraints:
  max_turns: 200
  max_depth: 2
  can_spawn: true
  timeout_ms: 600000
tags:
  - quartermaster
  - architecture
  - self-knowledge
version: 1
---
You are Sprout's architectural expert. You carry deep knowledge of how Sprout works
internally and can answer questions about any subsystem, explain design decisions,
and guide agent authoring.

## How you work

You carry conceptual knowledge of Sprout's architecture in your context (see sections
below). For current-state-of-truth details — specific type definitions, exact file
paths, current implementations — delegate to project-explorer or utility/reader to
verify against source code.

- **Conceptual questions**: Answer directly from your knowledge sections
- **Specific questions**: Delegate to project-explorer ("Find how compaction triggers
  in the codebase and summarize the logic") or utility/reader ("Read src/kernel/types.ts
  and list the EventKind values")
- **Design guidance**: Combine your conceptual knowledge with source verification

## Operating modes

### EXPLAIN Mode — "How does X work?"
Explain the subsystem's architecture, design rationale, and key interactions.
Reference source files for current details.

### GUIDE Mode — "How should I build/design Y?"
Apply Sprout's patterns and conventions to the question. Reference existing code
that follows the same patterns as examples.

### AUDIT Mode — "Is X consistent with Sprout's design?"
Evaluate whether a proposal or implementation follows Sprout's architectural
patterns and flag deviations.

---

## Core Architecture

Sprout is a self-improving coding agent built on Bun (TypeScript runtime).

### The Core Loop

Every agent runs the same loop: **Perceive → Recall → Plan → Act → Verify**, with
**Learn** running asynchronously in the background.

- **Perceive**: Receive a goal from caller (user or parent agent)
- **Recall**: Search genome for relevant memories and routing rules
- **Plan**: LLM generates a response (may include tool calls)
- **Act**: Execute tool calls (primitives or delegation)
- **Verify**: Check results, detect stumbles, generate learn signals
- **Learn**: Background process analyzes stumbles and mutates the genome

Source of truth: `src/agents/agent.ts:run()` method

### Agent Tree

Agents are defined as markdown files with YAML frontmatter. They live in a
directory tree under `root/`:

```
root/
  root.md                          # Top-level orchestrator
  agents/
    tech-lead.md                   # Code work orchestrator
      agents/
        engineer.md                # Implementation
        spec-reviewer.md           # Pre-implementation review
        quality-reviewer.md        # Post-implementation review
    quartermaster.md               # Capability expert
      agents/
        qm-indexer.md              # Capability discovery
        qm-fabricator.md           # Agent builder
        qm-planner.md             # Capability planning
        qm-reconciler.md          # Genome reconciliation
        qm-session-analyst.md     # Session debugging
        qm-sprout-architect.md    # This agent (self-knowledge)
        qm-session-doctor.md      # Learn process diagnostics
    architect.md                   # Design/planning
    verifier.md                    # Runtime verification
    debugger.md                    # Bug investigation
    project-explorer.md            # Codebase exploration
    utility/agents/                # Shared services
      reader.md                    # File reading
      editor.md                    # File writing
      command-runner.md            # Shell execution
      web-reader.md                # URL fetching
      mcp.md                       # MCP server access
      task-manager.md              # Task tracking
      project-memory.md            # Project context
```

**Auto-discovery**: Agents automatically discover children in their `{name}/agents/`
directory. No explicit wiring needed.

**Path resolution**: All agent references use absolute paths from root
(e.g., `utility/reader` → `root/agents/utility/agents/reader.md`).

Source of truth: `src/agents/loader.ts` (scanAgentTree, loadRootAgents)

Conventions: `root/agents/quartermaster/resources/agent-tree-spec.md`

### Delegation Model

Agents delegate by calling the `delegate` tool with a goal and target agent name.
Two execution modes:

**In-process**: Parent creates a child Agent instance in the same process.
Used at the root level. Source: `src/agents/agent.ts:executeDelegation()`

**Bus-based (subprocess)**: Parent sends a spawn message via WebSocket.
A spawner process creates the child in a new Bun.spawn() process.
Source: `src/bus/spawner.ts`, `src/bus/agent-process.ts`

Delegation options:
- **blocking** (default): Parent waits for child to complete
- **non-blocking**: Parent gets a handle immediately, child runs in background
- **shared**: Handle persists after completion, accepts follow-up messages

Source of truth: `src/kernel/types.ts:Delegation`, `src/agents/agent.ts`

### Genome System

Two-layer agent resolution: **genome** (overlay) + **root** (defaults).

- **Root layer**: Shipping defaults in `root/agents/`
- **Genome layer**: Learned/customized agents in `~/.local/share/sprout-genome/agents/`
- **Resolution**: Genome-first, fall back to root
- **Version bumping**: When genome modifies an agent, version auto-increments
- **Git-tracked**: The genome directory is a git repository

Source of truth: `src/genome/genome.ts` (Genome class)

### Primitives and Tools

**Primitives** are built-in kernel tools: read_file, write_file, edit_file,
apply_patch, exec, grep, glob, fetch.

**Provider alignment**: Each agent's primitives match its LLM provider.
Anthropic/Gemini get edit_file; OpenAI gets apply_patch. Handled automatically
in `primitivesForAgent()`.

**Workspace tools**: Dynamic per-agent tools stored in `agents/{name}/tools/`.
Two interpreter types:
- **Shell** (bash, python, node): Script piped to interpreter
- **sprout-internal**: TypeScript module with access to Genome and ExecutionEnvironment

Source of truth: `src/kernel/primitives.ts`, `src/kernel/workspace-tools.ts`

### LLM Client

Three provider implementations using native APIs (not OpenAI-compatible wrappers):
- **Anthropic**: Claude models, cache_control annotations
- **Google**: Gemini models, synthetic tool call IDs
- **OpenAI**: Responses API (not Chat Completions), reasoning tokens

Source of truth: `src/llm/anthropic.ts`, `src/llm/gemini.ts`, `src/llm/openai.ts`

### Bus Messaging

WebSocket-based pub/sub for inter-process agent communication.

- **Server** (`src/bus/server.ts`): localhost with random port
- **Client** (`src/bus/client.ts`): connects via WebSocket
- **Spawner** (`src/bus/spawner.ts`): launches agent subprocesses via Bun.spawn()
- **Topics** (`src/bus/topics.ts`): per-agent topics for events and results

### Session System

Sessions persist as JSONL event logs. History is reconstructed from events at
resume time (not stored directly).

- **Events**: `src/kernel/types.ts:EventKind` — 26 event types
- **Logging**: `src/host/logger.ts:SessionLogger` — append-only JSONL
- **Metadata**: `src/host/session-metadata.ts` — session snapshots
- **Resume**: `src/host/resume.ts:replayEventLog()` — history reconstruction
- **Compaction**: `src/host/compaction.ts` — LLM-summarized context compression

### Learn Process

Background process that turns stumbles into genome improvements.

- **Signal detection**: `src/agents/verify.ts:verifyActResult()`
- **Pipeline**: `src/learn/learn-process.ts:LearnProcess`
- **Metrics**: `src/learn/metrics-store.ts:MetricsStore`
- **Signal kinds**: error, retry, inefficiency, timeout, failure
- **Mutation types**: create_memory, update_agent, create_agent, create_routing_rule
- **Evaluation**: Compare stumble rates before/after, rollback if harmful
```

**Step 2: Run tests to verify the architect is discovered**

Run: `bun test test/agents/loader.test.ts -t "qm-sprout-architect"`
Expected: PASS

**Step 3: Commit**

```bash
git add root/agents/quartermaster/agents/qm-sprout-architect.md
git commit -m "feat: add qm-sprout-architect agent spec"
```

---

### Task 4: Write qm-session-doctor agent spec

**Files:**
- Create: `root/agents/quartermaster/agents/qm-session-doctor.md`

**Step 1: Create the agent spec file**

```markdown
---
name: qm-session-doctor
description: "Diagnose learning effectiveness — analyze stumble patterns, evaluate mutations, and determine whether Sprout is improving from experience"
model: best
tools: []
agents:
  - utility/reader
  - utility/command-runner
constraints:
  max_turns: 200
  max_depth: 2
  can_spawn: true
  timeout_ms: 600000
tags:
  - quartermaster
  - learning
  - diagnostics
version: 1
---
You are a learning diagnostician. You analyze whether Sprout is effectively learning
from its experience, diagnose stumble patterns, and evaluate mutation effectiveness.

## How you work

You delegate to utility agents to inspect the genome, metrics, and session data:

- **utility/reader**: Read genome files, pending evaluations, agent specs
- **utility/command-runner**: Run jq queries against metrics.jsonl and event logs

Craft intent-expressing prompts. Example:
- "Run `jq -c 'select(.type == \"stumble\") | {agent_name, kind, timestamp}' {metrics_path}` and summarize the stumble patterns by agent and kind"

## The learn process pipeline

Source of truth: `src/learn/learn-process.ts`

### Signal detection

When a delegation completes, `verifyActResult()` (in `src/agents/verify.ts`) checks
the result and creates a LearnSignal if it detects a stumble:

| Signal kind    | Trigger condition                              |
|---------------|-----------------------------------------------|
| timeout       | Agent timed out (`timed_out === true`)         |
| failure       | Agent failed (`success === false`, not timeout)|
| error         | Agent had stumbles (`stumbles > 0`)            |
| inefficiency  | Agent used >10 turns despite success           |

Signal fields: kind, goal, agent_name, details (ActResult), session_id, timestamp.
Source of truth: `src/kernel/types.ts:LearnSignal`

### Processing pipeline

1. **Queue**: Signals pushed to `learnProcess.push(signal)`, processed sequentially
2. **Filter**: `shouldLearn()` checks if this agent:kind pair was recently addressed
3. **LLM reasoning**: Asks the LLM to suggest a mutation given the stumble context
4. **Mutation application**: Applies the structured mutation to the genome
5. **Pending evaluation**: Saves mutation with commitHash for later evaluation

### Mutation types

| Type                | What it does                                    |
|--------------------|------------------------------------------------|
| create_memory      | Stores a factual learning (content + tags)      |
| update_agent       | Modifies an agent's system_prompt               |
| create_agent       | Creates a new specialist agent                  |
| create_routing_rule| Records a delegation preference (condition)     |

### Evaluation and rollback

After MIN_ACTIONS_FOR_EVALUATION (5) post-improvement actions, the process compares
stumble rates before and after the mutation:

- **Helpful**: stumble rate decreased by >0.05 → keep
- **Harmful**: stumble rate increased by >0.05 → rollback via genome.rollbackCommit()
- **Neutral**: within ±0.05 → keep

Source of truth: `src/learn/learn-process.ts:evaluateImprovement()`

## Where to find data

### Metrics store

Location: `~/.local/share/sprout-genome/projects/{slug}/memory/metrics.jsonl`

Two entry types:
```jsonl
{"type": "stumble", "agent_name": "engineer", "kind": "error", "timestamp": 1709474400000}
{"type": "action", "agent_name": "engineer", "timestamp": 1709474400000}
```

Stumble rate = total stumbles / total actions per agent.
Source of truth: `src/learn/metrics-store.ts`

### Pending evaluations

Location: `~/.local/share/sprout-genome/projects/{slug}/memory/pending-evaluations.json`

Array of PendingEvaluation objects:
```json
{"agentName": "engineer", "mutationType": "update_agent", "timestamp": 1709474400000, "commitHash": "abc123", "description": "..."}
```

### Genome mutations

The genome is a git repository at `~/.local/share/sprout-genome/`.
Use `git log` (via command-runner) to inspect recent commits from the learn process.
Commit messages describe the mutation applied.

### Session event logs

Learn events in session logs (via command-runner with jq):
```bash
jq -c 'select(.kind | startswith("learn")) | {kind, timestamp, data}' {logpath}
```

## Diagnostic workflows

### "Is learning working?"

1. Read metrics.jsonl to get overall stumble rates by agent
2. Check pending evaluations for recent mutations
3. Check genome git log for applied/rolled-back mutations
4. Report: stumble trends, active mutations, evaluation outcomes

### "Why isn't agent X improving?"

1. Filter metrics.jsonl for agent X's stumble/action counts
2. Check if learn signals are being generated (session logs)
3. Check if shouldLearn() is filtering them out (recently addressed)
4. Check if mutations are being applied and evaluated
5. Check if mutations are being rolled back (harmful)

### "What has the learn process changed?"

1. Read genome git log (recent commits)
2. Read pending evaluations
3. Cross-reference with metrics to show before/after stumble rates
4. Report: each mutation, its trigger, its evaluation status

## Report format

Always include:
1. **Summary**: Overall learning health in 2-3 sentences
2. **Stumble rates**: Per-agent breakdown with trends
3. **Recent mutations**: What was changed, why, evaluation status
4. **Diagnosis**: What's working, what's not, and why
5. **Recommendations**: Concrete actions to improve learning effectiveness
```

**Step 2: Run all loader tests to verify all three agents pass**

Run: `bun test test/agents/loader.test.ts`
Expected: ALL PASS — the three new agents are discovered, have correct constraints.

**Step 3: Commit**

```bash
git add root/agents/quartermaster/agents/qm-session-doctor.md
git commit -m "feat: add qm-session-doctor agent spec"
```

---

### Task 5: Update quartermaster with new routing modes

**Files:**
- Modify: `root/agents/quartermaster.md`

**Step 1: Add new modes to the quartermaster system prompt**

After the existing "Reconciler Mode" section and before "How to choose modes:", add:

```markdown
**Analyst Mode** — "What happened in session X? Why did it fail? Rewind it."
Delegate to qm-session-analyst. Provide session ID, project context, or search
criteria. Use this when:
- Investigating why a session failed or won't resume
- Searching for past sessions by topic, date, or ID
- Rewinding a session to a prior state

**Architect Mode** — "How does X work in Sprout? How should I design Y?"
Delegate to qm-sprout-architect. Provide the architecture or design question.
Use this when:
- Someone asks how a Sprout subsystem works
- Designing a new agent or tool
- Checking whether a proposal follows Sprout's patterns

**Doctor Mode** — "Is learning working? What are the stumble trends?"
Delegate to qm-session-doctor. Provide agent name, time window, or concern.
Use this when:
- Checking whether the learn process is effective
- Investigating stumble patterns for a specific agent
- Understanding why mutations are being rolled back
```

Update the "How to choose modes:" section to include:

```markdown
- Questions about what happened in a session → Analyst
- Questions about how Sprout works → Architect
- Questions about learning effectiveness → Doctor
```

**Step 2: Run the full test suite to verify nothing is broken**

Run: `bun test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add root/agents/quartermaster.md
git commit -m "feat: add analyst/architect/doctor modes to quartermaster"
```

---

### Task 6: Update root agent routing hints

**Files:**
- Modify: `root/root.md`

**Step 1: Add routing hints for self-awareness queries**

In the "Common routing" section of root.md, add these lines:

```markdown
- Need to debug a past session? → quartermaster (analyst mode)
- Need to understand how Sprout works? → quartermaster (architect mode)
- Need to check if learning is effective? → quartermaster (doctor mode)
```

**Step 2: Run the full test suite**

Run: `bun test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add root/root.md
git commit -m "feat: add self-awareness routing hints to root agent"
```

---

### Task 7: Create context documentation — overview.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/overview.md`

**Step 1: Write the overview**

This file provides a high-level map of Sprout's architecture. It should cover:

- What Sprout is (self-improving coding agent, TypeScript on Bun)
- The core loop (perceive → recall → plan → act → verify, learn async)
- Key subsystems and where to find them:
  - Agent system: `src/agents/` — agent lifecycle, delegation, tree scanning
  - Genome: `src/genome/` — two-layer resolution, persistence, learning
  - Kernel: `src/kernel/` — types, primitives, execution environment
  - LLM: `src/llm/` — three providers, native APIs
  - Host: `src/host/` — session management, logging, compaction, CLI
  - Bus: `src/bus/` — WebSocket messaging, spawner, subprocess agents
  - Learn: `src/learn/` — learn process, metrics, evaluation
  - TUI: `src/tui/` — terminal user interface (Ink/React)
- Design principles: YAGNI, provider alignment, two-layer genome, context sinks

Keep it under 100 lines. Point to other docs in this directory for subsystem details.
Point to source files as the ultimate authority.

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/overview.md
git commit -m "docs: add sprout architecture overview for self-knowledge agents"
```

---

### Task 8: Create context documentation — agent-system.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/agent-system.md`

**Step 1: Write the agent system doc**

Cover:
- Agent spec format (YAML frontmatter + markdown body)
- Directory conventions (`{name}.md` + `{name}/agents/`, `{name}/tools/`, `{name}/resources/`)
- Auto-discovery (agents find children in their `{name}/agents/` directory)
- Path resolution (absolute from root, e.g., `utility/reader`)
- Preambles (global.md, orchestrator.md, worker.md — injected into system prompts)
- Two types: orchestrators (can_spawn, delegate tool) vs workers (primitives)
- The delegate tool: agent_name, goal, description, hints, blocking, shared
- Source of truth pointers: `src/agents/loader.ts`, `src/agents/agent.ts`, `src/agents/resolver.ts`
- Reference: `root/agents/quartermaster/resources/agent-tree-spec.md`

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/agent-system.md
git commit -m "docs: add agent system architecture doc"
```

---

### Task 9: Create context documentation — genome.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/genome.md`

**Step 1: Write the genome doc**

Cover:
- Two-layer model: root (shipping defaults) + genome (learned overlay)
- Resolution order: genome-first, fall back to root
- Genome location: `~/.local/share/sprout-genome/`
- Git-tracked: the genome directory is a git repository
- Genome class methods: allAgents(), getAgent(), addAgent(), updateAgent(), removeAgent()
- Version bumping: auto-increments above max(root_version, overlay_version)
- Bootstrap sync: copies root agents to genome on first run, detects conflicts on update
- Memories: JSONL at `memories.jsonl` (content, tags, confidence, timestamps)
- Routing rules: JSONL at `routing_rules.jsonl` (condition, agent, strength)
- Source of truth: `src/genome/genome.ts`, `src/genome/recall.ts`

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/genome.md
git commit -m "docs: add genome architecture doc"
```

---

### Task 10: Create context documentation — primitives-and-tools.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/primitives-and-tools.md`

**Step 1: Write the primitives and tools doc**

Cover:
- Built-in primitives: read_file, write_file, edit_file, apply_patch, exec, grep, glob, fetch
- Provider alignment: edit_file for Anthropic/Gemini, apply_patch for OpenAI
- Automatic selection via `primitivesForAgent()`
- Workspace tools: per-agent tools in `agents/{name}/tools/`
- Tool format: YAML frontmatter (name, description, interpreter) + script body
- Two interpreter types: shell (bash/python/node) and sprout-internal (TypeScript)
- ToolContext for sprout-internal: `{ agentName, args, genome, env }`
- Two-layer resolution: genome tools override root tools
- Source of truth: `src/kernel/primitives.ts`, `src/kernel/workspace-tools.ts`

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/primitives-and-tools.md
git commit -m "docs: add primitives and tools architecture doc"
```

---

### Task 11: Create context documentation — llm-client.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/llm-client.md`

**Step 1: Write the LLM client doc**

Cover:
- Three providers: Anthropic, Google (Gemini), OpenAI — each with native API implementation
- No OpenAI-compatible wrappers — each provider uses its own API shape
- Anthropic: cache_control annotations for 90% token savings, Messages API
- Gemini: no tool call IDs (synthetic ones generated), GenerateContent API
- OpenAI: Responses API (not Chat Completions), reasoning tokens
- Model resolution: "fast"/"balanced"/"best" mapped to concrete models per provider
- Streaming: all providers support streaming responses
- Retry: exponential backoff with jitter
- Source of truth: `src/llm/anthropic.ts`, `src/llm/gemini.ts`, `src/llm/openai.ts`, `src/llm/client.ts`

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/llm-client.md
git commit -m "docs: add LLM client architecture doc"
```

---

### Task 12: Create context documentation — bus-messaging.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/bus-messaging.md`

**Step 1: Write the bus messaging doc**

Cover:
- WebSocket-based pub/sub for inter-process agent communication
- Why WebSocket over SSE (bidirectional needed)
- localhost with random port (Bun WS client doesn't support `ws+unix://`)
- Server: `src/bus/server.ts` — manages connections, routes messages
- Client: `src/bus/client.ts` — connects, subscribes to topics, sends messages
- Spawner: `src/bus/spawner.ts` — launches agent subprocesses via Bun.spawn()
- Agent process: `src/bus/agent-process.ts` — the subprocess entry point
- Topics: `src/bus/topics.ts` — per-agent topics for events and results
- Message types: spawn, result, event, message_agent, wait_agent
- Source of truth: `src/bus/` directory

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/bus-messaging.md
git commit -m "docs: add bus messaging architecture doc"
```

---

### Task 13: Create context documentation — session-system.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/session-system.md`

**Step 1: Write the session system doc**

This file is referenced by both qm-session-analyst and qm-session-doctor. Cover:
- Session storage layout (projects/{slug}/sessions/, logs/, memory/)
- Session metadata schema (SessionMetadataSnapshot)
- Event log format (JSONL, SessionEvent structure)
- Full event kind taxonomy with brief descriptions
- Event emission flow: Agent.emitAndLog() → EventBus → SessionLogger
- Session replay: replayEventLog() reconstructs history from depth-0 events
- Compaction: LLM-summarized context compression, replaces prior history
- Session lifecycle: start, running, idle, interrupted, resume, clear
- Crashed session detection: status="running" on reload → mark "interrupted"
- Source of truth: `src/host/session-controller.ts`, `src/host/logger.ts`,
  `src/host/resume.ts`, `src/host/session-metadata.ts`, `src/host/compaction.ts`

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/session-system.md
git commit -m "docs: add session system architecture doc"
```

---

### Task 14: Create context documentation — learn-process.md

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/learn-process.md`

**Step 1: Write the learn process doc**

This file is referenced by qm-session-doctor. Cover:
- Learn signal detection: verifyActResult() in src/agents/verify.ts
- Signal kinds and their triggers (error, retry, inefficiency, timeout, failure)
- Learn process pipeline: signal → shouldLearn → LLM reasoning → mutation → evaluation
- Mutation types: create_memory, update_agent, create_agent, create_routing_rule
- Metrics store: metrics.jsonl with stumble/action entries, stumble rate computation
- Pending evaluations: JSON file tracking unevaluated mutations
- Evaluation: MIN_ACTIONS_FOR_EVALUATION (5), before/after stumble rate comparison
- Rollback criteria: harmful (delta > 0.05), helpful (delta < -0.05), neutral
- Integration: learn signals emitted as events, visible in session logs
- Source of truth: `src/learn/learn-process.ts`, `src/learn/metrics-store.ts`,
  `src/agents/verify.ts`

**Step 2: Commit**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/learn-process.md
git commit -m "docs: add learn process architecture doc"
```

---

### Task 15: Final validation

**Step 1: Run the full test suite**

Run: `bun test`
Expected: ALL PASS

**Step 2: Verify agent tree scanning picks up all new agents**

Run: `bun test test/agents/loader.test.ts test/agents/tree-scanner.test.ts`
Expected: ALL PASS

**Step 3: Verify no untracked files were missed**

Run: `git status`
Expected: clean working tree

**Step 4: Verify the quartermaster children list is correct**

Run: `ls root/agents/quartermaster/agents/`
Expected: qm-fabricator.md, qm-indexer.md, qm-planner.md, qm-reconciler.md,
qm-session-analyst.md, qm-session-doctor.md, qm-sprout-architect.md

**Step 5: Verify the resources directory is complete**

Run: `ls root/agents/quartermaster/resources/sprout-architecture/`
Expected: overview.md, agent-system.md, genome.md, primitives-and-tools.md,
llm-client.md, bus-messaging.md, session-system.md, learn-process.md

# QM Self-Awareness Agents Implementation Plan

<!-- DOCS_NAV:START -->
## Related Docs
- [Docs Home](../README.md)
- [Plans Index](./README.md)
- [Architecture](../architecture.md)
- [Testing](../testing.md)
- [Audit Backlog Plan](./2026-03-04-audit-refactor-backlog-yagni-dry.md)
- [Audits Index](../audits/README.md)
<!-- DOCS_NAV:END -->

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Sprout self-awareness via three new quartermaster subagents: session analysis/repair, architectural self-knowledge, and learn process diagnostics.

**Architecture:** Three context-sink agents under the quartermaster. Each delegates to utility agents (reader, command-runner, editor, project-explorer) rather than using primitives directly. Domain knowledge lives in resource files under `resources/sprout-architecture/`; agent system prompts are thin (workflow instructions + pointers to resource files loaded on demand via utility/reader).

**Tech Stack:** Markdown agent specs with YAML frontmatter. Bun test for validation.

**Design doc:** `docs/plans/2026-03-03-qm-self-awareness-design.md`

**Review findings applied:**
- `max_depth: 3` (not 2) — agents run at depth 2 (root→QM→agent), depth check is `>=`, so 2 would crash
- `max_turns: 200` (not 0) — 0 means zero iterations, not unlimited
- Agent count in tests bumped to 24 (actual ~21 existing + 3 new)
- Agent system prompts are thin; heavy knowledge in resource files read on demand
- Pre-existing bug noted: qm-indexer has `max_depth: 1` (same latent issue) — fix included

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

Also bump the `toBeGreaterThanOrEqual` count from 15 to 24.

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

Add new test blocks after the qm-indexer constraint test:

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
    expect(analyst!.constraints.max_depth).toBe(3);
});

test("qm-sprout-architect delegates to reader and project-explorer", async () => {
    const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
    const architect = agents.find((a) => a.name === "qm-sprout-architect");
    expect(architect).toBeDefined();
    expect(architect!.tools).toEqual([]);
    expect(architect!.agents).toContain("utility/reader");
    expect(architect!.agents).toContain("project-explorer");
    expect(architect!.constraints.can_spawn).toBe(true);
    expect(architect!.constraints.max_depth).toBe(3);
});

test("qm-session-doctor delegates to reader and command-runner", async () => {
    const agents = await loadRootAgents(join(import.meta.dir, "../../root"));
    const doctor = agents.find((a) => a.name === "qm-session-doctor");
    expect(doctor).toBeDefined();
    expect(doctor!.tools).toEqual([]);
    expect(doctor!.agents).toContain("utility/reader");
    expect(doctor!.agents).toContain("utility/command-runner");
    expect(doctor!.constraints.can_spawn).toBe(true);
    expect(doctor!.constraints.max_depth).toBe(3);
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

### Task 2: Fix pre-existing qm-indexer max_depth bug

**Files:**
- Modify: `root/agents/quartermaster/agents/qm-indexer.md`
- Modify: `test/agents/loader.test.ts`

The qm-indexer specifies `max_depth: 1` but runs at depth 2 (root→QM→indexer).
The depth check `depth >= max_depth` means it would throw at depth 2 with max_depth 1.
This hasn't been hit because no integration test exercises the full chain.

**Step 1: Fix qm-indexer max_depth**

In `root/agents/quartermaster/agents/qm-indexer.md`, change `max_depth: 1` to `max_depth: 3`.

The indexer delegates to utility/mcp (depth 3), so it needs max_depth 3 minimum.

**Step 2: Update the qm-indexer test**

In `test/agents/loader.test.ts`, the test `"qm-indexer has write path constraints and no exec"` at line 83 asserts `max_depth` is 1. Change to:

```typescript
expect(indexer!.constraints.max_depth).toBe(3);
```

**Step 3: Run qm-indexer test**

Run: `bun test test/agents/loader.test.ts -t "qm-indexer"`
Expected: PASS

**Step 4: Commit**

```bash
git add root/agents/quartermaster/agents/qm-indexer.md test/agents/loader.test.ts
git commit -m "fix: qm-indexer max_depth 1→3 (was unreachable at depth 2)"
```

---

### Task 3: Create context resource files (sprout-architecture/)

**Files:**
- Create: `root/agents/quartermaster/resources/sprout-architecture/overview.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/agent-system.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/genome.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/primitives-and-tools.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/llm-client.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/bus-messaging.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/session-system.md`
- Create: `root/agents/quartermaster/resources/sprout-architecture/learn-process.md`

These are the knowledge base that the agents load on demand via utility/reader.
Each file follows the two-tier pattern: conceptual explanations (evergreen) +
source-of-truth pointers to authoritative code (self-refreshing).

Write each file by reading the relevant source code and distilling it into
clear, accurate documentation. Each file should be 50-120 lines covering the
subsystem's architecture, key types, design decisions, and source pointers.

**Step 1: Create overview.md**

Cover: what Sprout is, core loop, key subsystems (with source directories),
design principles. Under 100 lines. Points to other docs in this directory.

**Step 2: Create agent-system.md**

Cover: agent spec format, directory conventions, auto-discovery, path resolution,
preambles, orchestrators vs workers, delegate tool parameters.
Source of truth: `src/agents/loader.ts`, `src/agents/agent.ts`, `src/agents/resolver.ts`

**Step 3: Create genome.md**

Cover: two-layer model, resolution order, genome location, git tracking,
Genome class methods, version bumping, bootstrap sync, memories, routing rules.
Source of truth: `src/genome/genome.ts`, `src/genome/recall.ts`

**Step 4: Create primitives-and-tools.md**

Cover: built-in primitives, provider alignment, workspace tools, tool format,
interpreter types, ToolContext, two-layer resolution.
Source of truth: `src/kernel/primitives.ts`, `src/kernel/workspace-tools.ts`

**Step 5: Create llm-client.md**

Cover: three providers with native APIs, provider-specific details (Anthropic caching,
Gemini synthetic IDs, OpenAI Responses API), model resolution, streaming, retry.
Source of truth: `src/llm/anthropic.ts`, `src/llm/gemini.ts`, `src/llm/openai.ts`

**Step 6: Create bus-messaging.md**

Cover: WebSocket pub/sub, why WS over SSE, localhost random port, server/client/spawner/
agent-process/topics, message types.
Source of truth: `src/bus/` directory

**Step 7: Create session-system.md**

Cover: session storage layout, metadata schema, event log format, event kind taxonomy,
emission flow, replay mechanics, compaction, session lifecycle, crash detection.
Source of truth: `src/host/session-controller.ts`, `src/host/logger.ts`, `src/host/resume.ts`

**Step 8: Create learn-process.md**

Cover: signal detection, signal kinds and triggers, processing pipeline, mutation types,
metrics store format, pending evaluations, evaluation mechanics, rollback criteria.
Source of truth: `src/learn/learn-process.ts`, `src/learn/metrics-store.ts`, `src/agents/verify.ts`

**Step 9: Commit all resource files**

```bash
git add root/agents/quartermaster/resources/sprout-architecture/
git commit -m "docs: add sprout architecture resource files for self-knowledge agents"
```

---

### Task 4: Write qm-session-analyst agent spec

**Files:**
- Create: `root/agents/quartermaster/agents/qm-session-analyst.md`

**Step 1: Create the agent spec file**

The system prompt is thin — workflow instructions and delegation guidance.
Domain knowledge (session storage, events, replay) lives in
`resources/sprout-architecture/session-system.md`, loaded on demand.

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
  max_depth: 3
  can_spawn: true
  timeout_ms: 600000
tags:
  - quartermaster
  - session
  - debugging
version: 1
---
You are a session analyst. You investigate, search, debug, and repair Sprout sessions.

## First step: Load domain knowledge

Before starting any analysis, delegate to utility/reader:
"Read root/agents/quartermaster/resources/sprout-architecture/session-system.md
and return its full contents."

This file contains session storage layout, event taxonomy, replay mechanics,
and metadata schema. You need this knowledge to do your job effectively.

## How you work

You delegate to utility agents rather than reading files directly. This protects your
context from large JSONL log lines that can contain full LLM messages with tool calls.

- **utility/reader**: Read session metadata, search for files, inspect small files
- **utility/command-runner**: Run jq/sed for surgical extraction from large JSONL logs
- **utility/editor**: Modify session files for repair (truncation, rewinding)

Craft intent-expressing prompts when delegating. Tell the utility agent WHAT you need
and WHY, not just "read this file." For example:
- "Read the session metadata at {path} and tell me the session status, turn count, and timestamps"
- "Run this jq command against the event log and summarize the error events: jq -c 'select(.kind == \"error\") | {timestamp, agent_id, data}' {path}"

## Safe extraction patterns

Session JSONL lines can be very large — a single plan_end event contains the full
LLM assistant message which may include multiple tool calls with large arguments.
Delegate to command-runner for surgical extraction:

**Safe (extract small fields with jq):**
```bash
jq -r '.kind' {logpath} | sort | uniq -c | sort -rn       # Event kind summary
jq -c 'select(.kind == "error") | {timestamp, agent_id, data}' {logpath}
```

**Safe (line numbers only):**
```bash
grep -n '"error"' {logpath} | cut -d: -f1 | head -10
```

**Safe (surgical single-line extraction):**
```bash
sed -n '{line}p' {logpath} | jq '{kind, timestamp, agent_id}'
```

**NEVER ask the reader to read a full event log file.**

## Search workflow

1. **Clarify scope**: What session ID, project, date range, or keywords?
2. **Metadata first**: Delegate to reader to list/filter .meta.json files
3. **Content search**: Delegate to command-runner for event log queries
4. **Synthesize**: Analyze and summarize findings — don't dump raw data

## Repair workflow

When asked to rewind or repair a session:

1. **Locate**: Find the session directory by ID
2. **Analyze**: Identify where/why it broke (orphaned tool calls, API errors, etc.)
3. **Find target**: Locate the event to rewind to
4. **Backup**: ALWAYS delegate to command-runner to create .bak copies before modifying
5. **Truncate**: Delegate to command-runner to truncate the event log
6. **Verify**: Check line counts and event balance after truncation
7. **Report**: Tell caller what was removed and how to resume

### Running session warning

If the session being repaired is the caller's current/parent session, warn:

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

### Task 5: Write qm-sprout-architect agent spec

**Files:**
- Create: `root/agents/quartermaster/agents/qm-sprout-architect.md`

**Step 1: Create the agent spec file**

The system prompt is thin — operating modes and delegation instructions.
All architectural knowledge lives in `resources/sprout-architecture/`, loaded on demand.

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
  max_depth: 3
  can_spawn: true
  timeout_ms: 600000
tags:
  - quartermaster
  - architecture
  - self-knowledge
version: 1
---
You are Sprout's architectural expert. You have deep knowledge of how Sprout works
internally and can answer questions about any subsystem, explain design decisions,
and guide agent authoring.

## First step: Load relevant knowledge

Your architectural knowledge lives in resource files. Before answering, delegate to
utility/reader to load the relevant file(s):

| Question about... | Load this file |
|-------------------|---------------|
| High-level architecture | `root/agents/quartermaster/resources/sprout-architecture/overview.md` |
| Agent tree, delegation, authoring | `root/agents/quartermaster/resources/sprout-architecture/agent-system.md` |
| Genome, two-layer resolution | `root/agents/quartermaster/resources/sprout-architecture/genome.md` |
| Primitives, workspace tools | `root/agents/quartermaster/resources/sprout-architecture/primitives-and-tools.md` |
| LLM providers, streaming, retry | `root/agents/quartermaster/resources/sprout-architecture/llm-client.md` |
| WebSocket bus, spawner | `root/agents/quartermaster/resources/sprout-architecture/bus-messaging.md` |
| Sessions, events, logging | `root/agents/quartermaster/resources/sprout-architecture/session-system.md` |
| Learn process, mutations, metrics | `root/agents/quartermaster/resources/sprout-architecture/learn-process.md` |

For broad questions ("how does Sprout work?"), load overview.md first, then relevant
subsystem files as needed. Don't load all files at once — load what's relevant.

## How you work

- **Conceptual questions**: Load the relevant resource file, answer from it
- **Specific questions**: After loading the resource file, delegate to project-explorer
  or utility/reader to verify details against source code
- **Design guidance**: Combine resource knowledge with source verification

## Operating modes

### EXPLAIN Mode — "How does X work?"
Load the relevant resource file. Explain the subsystem's architecture, design
rationale, and key interactions. Delegate to project-explorer for implementation
details when the resource file points to source code.

### GUIDE Mode — "How should I build/design Y?"
Apply Sprout's patterns and conventions. Delegate to project-explorer to find
existing code that follows the same patterns as examples.

### AUDIT Mode — "Is X consistent with Sprout's design?"
Load the relevant resource files and evaluate whether a proposal follows Sprout's
architectural patterns. Delegate to project-explorer to verify against actual code.

## Report format

Always include:
1. **Answer**: Direct response to the question
2. **Source references**: File paths and line numbers where relevant
3. **Related subsystems**: What else connects to this topic
4. **Caveats**: Where the resource docs might be stale (check source when in doubt)
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

### Task 6: Write qm-session-doctor agent spec

**Files:**
- Create: `root/agents/quartermaster/agents/qm-session-doctor.md`

**Step 1: Create the agent spec file**

The system prompt is thin — diagnostic workflows and delegation instructions.
Learn process knowledge lives in resource files, loaded on demand.

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
  max_depth: 3
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

## First step: Load domain knowledge

Before starting any diagnosis, delegate to utility/reader to load:
1. "Read root/agents/quartermaster/resources/sprout-architecture/learn-process.md"
2. If session analysis is also needed: "Read root/agents/quartermaster/resources/sprout-architecture/session-system.md"

These files contain the learn pipeline, signal types, metrics format, and evaluation
mechanics you need to do your job.

## How you work

You delegate to utility agents to inspect the genome, metrics, and session data:

- **utility/reader**: Read genome files, pending evaluations, agent specs, resource docs
- **utility/command-runner**: Run jq queries against metrics.jsonl and event logs

Craft intent-expressing prompts. Example:
- "Run `jq -c 'select(.type == \"stumble\") | {agent_name, kind, timestamp}' {metrics_path}` and summarize the stumble patterns by agent and kind"

## Key data locations

- **Metrics**: `~/.local/share/sprout-genome/projects/{slug}/memory/metrics.jsonl`
- **Pending evaluations**: `~/.local/share/sprout-genome/projects/{slug}/memory/pending-evaluations.json`
- **Genome git log**: `~/.local/share/sprout-genome/` (git repository)
- **Session event logs**: `~/.local/share/sprout-genome/projects/{slug}/logs/`

## Diagnostic workflows

### "Is learning working?"

1. Load learn-process.md resource file
2. Read metrics.jsonl to get overall stumble rates by agent
3. Check pending evaluations for recent mutations
4. Check genome git log for applied/rolled-back mutations
5. Report: stumble trends, active mutations, evaluation outcomes

### "Why isn't agent X improving?"

1. Load learn-process.md resource file
2. Filter metrics.jsonl for agent X's stumble/action counts
3. Check if learn signals are being generated (session logs)
4. Check if mutations are being applied and evaluated
5. Check if mutations are being rolled back (harmful)

### "What has the learn process changed?"

1. Read genome git log (recent commits via command-runner)
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
Expected: ALL PASS

**Step 3: Commit**

```bash
git add root/agents/quartermaster/agents/qm-session-doctor.md
git commit -m "feat: add qm-session-doctor agent spec"
```

---

### Task 7: Update quartermaster with new routing modes

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

**Step 2: Run the full test suite**

Run: `bun test`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add root/agents/quartermaster.md
git commit -m "feat: add analyst/architect/doctor modes to quartermaster"
```

---

### Task 8: Update root agent routing hints

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

### Task 9: Final validation

**Step 1: Run the full test suite**

Run: `bun test`
Expected: ALL PASS

**Step 2: Verify agent tree scanning picks up all new agents**

Run: `bun test test/agents/loader.test.ts test/agents/tree-scanner.test.ts`
Expected: ALL PASS

**Step 3: Verify no untracked files were missed**

Run: `git status`
Expected: clean working tree

**Step 4: Verify the quartermaster children list**

Run: `ls root/agents/quartermaster/agents/`
Expected: qm-fabricator.md, qm-indexer.md, qm-planner.md, qm-reconciler.md,
qm-session-analyst.md, qm-session-doctor.md, qm-sprout-architect.md

**Step 5: Verify the resources directory**

Run: `ls root/agents/quartermaster/resources/sprout-architecture/`
Expected: overview.md, agent-system.md, genome.md, primitives-and-tools.md,
llm-client.md, bus-messaging.md, session-system.md, learn-process.md

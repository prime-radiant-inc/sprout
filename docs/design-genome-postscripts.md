# Design: Genome Postscripts

## Problem

Bootstrap preambles establish system-wide behavioral defaults, but users need a way
to customize agent behavior for their specific deployment. Currently the only way
to do this is to edit bootstrap files directly, which doesn't survive updates.

The genome is the right place for user customization — it persists across sessions,
is git-backed, and is the user's "personality layer" for the system.

## Prompt Assembly Order

The full prompt layering after this work:

```
bootstrap preamble (global + role)     ← system defaults, first
agent system_prompt                     ← agent identity and behavior
genome postscripts (global + role)      ← user customization, overrides defaults
environment                             ← working dir, platform, date
memories                                ← recalled from genome
routing hints                           ← recalled from genome
available agents                        ← for orchestrators only
workspace tools                         ← if any
```

Genome postscripts come AFTER the agent prompt so they get higher LLM attention
weight, allowing user customizations to effectively override system defaults.

## Postscript Types

### By scope

| File | Applies to | Purpose |
|------|-----------|---------|
| `postscripts/global.md` | All agents | Universal user customization |
| `postscripts/orchestrator.md` | Agents with `can_spawn: true` | Orchestrator-specific overrides |
| `postscripts/worker.md` | Agents with `can_spawn: false` | Worker-specific overrides |

### By agent name

| File | Applies to | Purpose |
|------|-----------|---------|
| `postscripts/agents/<name>.md` | Single named agent | Per-agent customization |

Named postscripts allow fine-grained control: "the reader agent should always
include line numbers" or "the command-runner should use zsh not bash."

## Assembly Logic for Postscripts

For a given agent with name `N` and role `R` (orchestrator or worker):

1. Load `postscripts/global.md` (if exists)
2. Load `postscripts/{R}.md` (if exists, where R is "orchestrator" or "worker")
3. Load `postscripts/agents/{N}.md` (if exists)
4. Concatenate non-empty parts with `\n\n` separator

This means a named postscript can further specialize the role postscript,
which further specializes the global postscript.

## Genome Directory Structure

```
genome/
├── agents/           ← agent specs (existing)
├── memories/         ← learned memories (existing)
├── routing/          ← routing rules (existing)
├── postscripts/      ← NEW
│   ├── global.md
│   ├── orchestrator.md
│   ├── worker.md
│   └── agents/
│       ├── reader.md
│       ├── command-runner.md
│       └── ...
├── metrics/          ← (existing)
└── logs/             ← (existing)
```

## Code Changes

### genome.ts

Add methods to the Genome class:

```typescript
async loadPostscripts(): Promise<Postscripts>
// Returns { global, orchestrator, worker } from genome/postscripts/

async loadAgentPostscript(agentName: string): Promise<string>
// Returns content of genome/postscripts/agents/{agentName}.md or ""

async savePostscript(name: string, content: string): Promise<void>
// Write a postscript file and commit
```

### loader.ts

Extend the `Preambles` type or create a parallel `Postscripts` type:

```typescript
export interface Postscripts {
  global: string;
  orchestrator: string;
  worker: string;
  agent: string;  // the per-agent-name postscript for THIS agent
}
```

### plan.ts — buildSystemPrompt

Add `postscripts?: Postscripts` parameter. Insert after agent system_prompt,
before environment block:

```typescript
// After spec.system_prompt, before <environment>
if (postscripts) {
  const role = spec.constraints.can_spawn ? postscripts.orchestrator : postscripts.worker;
  const parts = [postscripts.global, role, postscripts.agent].filter(p => p.length > 0);
  if (parts.length > 0) {
    prompt += "\n\n" + parts.join("\n\n");
  }
}
```

### agent.ts

- Add `postscripts` to AgentOptions
- In the run() method, load the agent-specific postscript for the current agent name
- Compose the full postscripts object and pass to buildSystemPrompt
- When spawning children, pass the genome reference (already done) — children
  load their own agent-specific postscript

### factory.ts

- Load role postscripts from genome (global, orchestrator, worker) once at startup
- Pass to root agent; root passes to children

## Open Questions

1. **Should postscripts be git-committed on write?** Probably yes, for consistency
   with how agent specs and memories work. Every genome mutation is a commit.

2. **Can the learn process write postscripts?** If the system learns that an agent
   needs behavioral adjustment, it could write a named postscript rather than
   modifying the agent spec. This keeps the bootstrap spec clean and puts all
   learned customizations in the genome layer.

3. **Should there be a `prelude` equivalent?** We have bootstrap preambles (before)
   and genome postscripts (after). Should the genome ALSO have a preamble layer
   that goes before the agent prompt? Current thinking: no — the bootstrap preamble
   is the "before" slot, the genome postscript is the "after" slot. If users want
   to override the bootstrap preamble, they should edit the genome postscript to
   contradict it, and recency bias will do the rest.

4. **Postscript size limits?** Postscripts consume context window. Should there be
   a warning or hard limit? Probably a warning in the assembly function if total
   postscript content exceeds some threshold (e.g., 2000 tokens).

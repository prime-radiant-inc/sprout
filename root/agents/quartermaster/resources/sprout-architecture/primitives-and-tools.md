# Primitives And Tools

Sprout exposes capabilities to agents as LLM tools. There are two families:
built-in primitives from the kernel and agent-specific workspace tools loaded
from root/genome files.

## Built-In Primitives

Primitives are TypeScript implementations registered in a `PrimitiveRegistry`.
Agents receive only the primitives listed in their `tools` frontmatter, except
the delegate/wait/message agent tools generated for orchestrators.

Provider alignment happens before tools are sent to the model. For example,
OpenAI uses `apply_patch` instead of `edit_file` where needed.

Source of truth:
- `src/kernel/primitives.ts`
- `src/agents/plan.ts:primitivesForAgent()`
- `test/agents/plan.test.ts`

## Memory Primitives

Read-only memory tools can be exposed broadly. Archivist-only mutation tools are
registered only for the `archivist` agent and enforce write authorization.

Source of truth:
- `src/genome/memory-tools.ts`
- `src/genome/memory-write-authorization.ts`
- `src/genome/memory-write-policy.ts`

## Workspace Tools

Workspace tools are files with YAML frontmatter and a script body:
- `name`
- `description`
- `interpreter`
- optional `display_name`

Tools load from genome first and root second. Genome overrides root on name
collision.

Source of truth:
- `src/genome/genome.ts:saveAgentTool()` and `loadAgentToolsWithRoot()`
- `src/kernel/tool-loading.ts`

## Interpreters

Shell-style tools are piped to the selected interpreter and receive an `args`
string as positional arguments. They should not be used for tools that need live
Genome access.

`sprout-internal` tools are TypeScript modules imported in-process. They receive:
`{ agentName, args, genome, env, projectDataDir, sessionId }`

Use `sprout-internal` for tools that need memory/genome access or structured
arguments. Avoid stdin-dependent workflows for agents without shell execution.

Source of truth:
- `src/kernel/tool-context.ts`
- `src/kernel/tool-loading.ts`
- `test/kernel/tool-loading.test.ts`

## Tool Boundaries

Tool availability is part of the agent contract. If an agent cannot write files,
run commands, or delegate, that boundary is intentional and should be routed
through an appropriate specialist instead of bypassed.

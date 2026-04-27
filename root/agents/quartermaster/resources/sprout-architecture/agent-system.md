# Agent System

Agents are markdown files with YAML frontmatter and a system prompt body.
Bootstrap agents live under `root/`; runtime overlays live under
`~/.local/share/sprout-genome/agents/`.

## Spec Format

Frontmatter fields include `name`, `description`, `model`, `tools`, `agents`,
`constraints`, `tags`, `version`, plus optional runtime controls like
`prompt_cache` and `subcortical_recall`.

Source of truth:
- `src/kernel/types.ts` defines `AgentSpec`, constraints, and events.
- `src/agents/markdown-loader.ts` parses and serializes markdown specs.
- `test/agents/markdown-loader.test.ts` covers frontmatter validation.

## Tree Layout

Root agent: `root/root.md`.

Nested agents:
- `root/agents/{name}.md`
- `root/agents/{name}/agents/{child}.md`
- deeper children follow the same `agents/` convention.

Tools and files live next to an agent:
- `root/agents/{path}/tools/{tool-name}`
- `root/agents/{path}/files/{file-name}`

Source of truth:
- `src/agents/loader.ts` scans the tree and resolves root tool directories.
- `src/agents/resolver.ts` resolves auto-discovered children and explicit refs.

## Delegation

An agent can delegate to auto-discovered children plus explicit entries in its
`agents` field. Tree paths such as `utility/reader` disambiguate nested agents.
The agent sees delegates as LLM tools generated from the current allowlist.

Source of truth:
- `src/agents/agent.ts:getDelegatableAgents()` and `resolveDelegationTarget()`.
- `src/agents/plan.ts:buildDelegateTool()`.

## Runtime Overlay

The genome can add or update agents without changing root files. Overlay agents
win over root specs by `name`. Root sync detects new root agents and conflicts
while preserving user-evolved overlays.

Source of truth:
- `src/genome/genome.ts` agent CRUD and `syncRoot()`.
- `src/genome/export-learnings.ts` for reviewing evolved agents.

## Preambles And Postscripts

Preambles live under `root/preambles/` and are added by role. Genome postscripts
can append global, role, or agent-specific guidance without rewriting root specs.

Source of truth:
- `src/agents/loader.ts:loadPreambles()`.
- `src/genome/genome.ts` postscript methods.
- `src/agents/plan.ts:buildSystemPrompt()`.

# Phase 3: Core Loop + Bootstrap Agents — Design

## Scope

Implement the core agent loop (Perceive -> Plan -> Act -> Verify) and the 4 bootstrap agent YAML specs. Skip Recall (pass all available agents to Plan). Skip Learn (log stumbles to a queue, don't process them).

## Architecture

```
src/agents/
├── agent.ts          # Agent class — the core loop
├── plan.ts           # Build LLM request, parse response
├── verify.ts         # Stumble detection, LearnSignal generation
├── events.ts         # EventEmitter for typed SessionEvents
├── model-resolver.ts # Symbolic model name resolution
├── loader.ts         # Load AgentSpec from YAML files
├── index.ts          # Barrel exports

bootstrap/
├── root.yaml
├── code-reader.yaml
├── code-editor.yaml
└── command-runner.yaml
```

## Agent Class

```typescript
class Agent {
  spec: AgentSpec
  env: ExecutionEnvironment
  client: Client
  primitiveRegistry: PrimitiveRegistry
  history: Message[]
  learnQueue: LearnSignal[]
  depth: number
  events: EventEmitter
}
```

- `agent.run(goal: string) -> AgentResult` — main entry point
- Adds goal as user message, loops until natural completion or limits
- Returns `{ output, success, stumbles, turns }`

## Plan — Tool Mapping

The LLM sees two kinds of tools:

1. **Agent tools** — each available agent becomes a tool via `agent_as_tool()` with `goal` (required string) and `hints` (optional string array) parameters
2. **Primitive tools** — the agent's allowed primitives, provider-aligned

When the LLM calls a tool:
- Primitive name match -> execute via PrimitiveRegistry, return result
- Agent name match -> spawn subagent, run its loop, return result

## Provider Alignment

Based on the agent's model provider:
- Anthropic/Gemini: read_file, write_file, edit_file, exec, grep, glob, fetch
- OpenAI: read_file, write_file, apply_patch, exec, grep, glob, fetch

## Model Resolution

Symbolic names resolve to concrete models:
- `"best"` -> opus/gpt-5.2/gemini-pro (first available)
- `"fast"` -> haiku/gpt-4.1-mini/gemini-flash (first available)

Simple map, improvable by Learn later.

## Subagent Lifecycle

1. Look up AgentSpec by name from available agents
2. Create new Agent with depth + 1
3. Subagent gets goal as initial input, hints appended to system prompt context
4. Run subagent.run(goal)
5. Return result as tool result to parent conversation
6. Depth checked against max_depth constraint

## Natural Completion

LLM responds with text and no tool calls -> agent is done. Return text as output.

## Verify (Simplified)

After each delegation or primitive execution:
- Check success/stumbles from result
- If stumbled, create LearnSignal, push to queue
- Log only (Learn doesn't process until Phase 6)

## Bootstrap Agents

Four YAML specs loaded at startup:
- **root** — decomposes tasks, delegates to specialists, never touches files directly
- **code-reader** — finds and returns relevant code (read_file, grep, glob)
- **code-editor** — writes and edits code (read_file, write_file, edit_file/apply_patch, exec)
- **command-runner** — executes shell commands (exec, read_file, grep)

## Events

Typed SessionEvent objects emitted via EventEmitter (async iterable). Events include: session_start/end, perceive, plan_start/end, act_start/end, primitive_start/end, verify, learn_signal, warning, error.

## Testing Strategy

- Unit tests: agent-as-tool mapping, model resolution, YAML loading, verify logic, event emission
- Integration tests with real API calls: root agent decomposes "Create hello.py", delegates to code-editor, file gets created

# Sprout Agent Tooling and Agent Communication

**Scope:** This document describes the implementation in this Sprout checkout, based on source inspection. It covers agent tool surfaces, subagent delegation primitives, bus/subprocess messaging, observer/watch mechanisms, and parent/subagent communication and control flows. It is intentionally Sprout-only documentation.

## Source map

Primary implementation files inspected:

- Agent and run loop: `src/agents/agent.ts`
- Planning/tool schemas: `src/agents/plan.ts`
- Agent spec and event/command types: `src/kernel/types.ts`
- Markdown/frontmatter agent loading: `src/agents/markdown-loader.ts`
- Agent tree loader: `src/agents/loader.ts`
- Agent factory: `src/agents/factory.ts`
- Built-in primitives: `src/kernel/primitives.ts`
- Custom agent tools: `src/kernel/tool-loading.ts`, `src/kernel/tool-context.ts`, `src/genome/genome.ts`
- Bus message schemas and topics: `src/bus/types.ts`, `src/bus/topics.ts`
- Subprocess spawner and agent process: `src/bus/spawner.ts`, `src/bus/agent-process.ts`
- Host session controller and event bus: `src/host/session-controller.ts`, `src/host/event-bus.ts`
- Static/delegate observers: `src/host/observer-registry.ts`, `src/agents/observers.ts`
- UI active-work derivation: `src/shared/agent-display.ts`
- Current root/observer specs: `root/root.md`, `root/agents/metacognitive.md`, `root/preambles/observer.md`

## Terminology

Sprout uses several identities that should not be conflated:

- **Agent name**: the genome/root spec name, for example `root`, `metacognitive`, `utility/reader` as a path reference, or `reader` as a leaf spec name.
- **Handle ID**: an addressable runtime handle for a spawned process. `root` is the in-process root handle; spawned handles are usually ULIDs or deterministic observer handle IDs. Defined in `AgentAddress.handleId` (`src/bus/types.ts:5-10`).
- **Agent ID**: stable event identity for one runtime handle (`src/bus/types.ts:5-10`, `src/bus/spawner.ts:86-90`).
- **Depth**: absolute depth in the agent tree; root is depth 0 and `MAX_AGENT_DEPTH` is 8 (`src/kernel/types.ts:62-63`).
- **Observer**: an ordinary agent whose runtime address may include `role: "observer"` (`src/bus/types.ts:5-10`) and whose spec usually has the `observer` tag (`root/agents/metacognitive.md:15-18`). Observation is a runtime relationship, not a separate actor type.

## Agent specs and tree loading

### Markdown AgentSpec shape

Agent specs are YAML-frontmatter Markdown files. `parseAgentMarkdown()` reads frontmatter into `AgentSpec` and uses the Markdown body as `system_prompt` (`src/agents/markdown-loader.ts:20-24`, `src/agents/markdown-loader.ts:65-75`). Core fields include:

```ts
interface AgentSpec {
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  constraints: AgentConstraints;
  tags: string[];
  version: number;
  thinking?: boolean | { budget_tokens: number };
  sampling?: { temperature?: number };
  output?: { max_tokens: number };
  task_payload?: true;
  prompt_cache?: { enabled: true; ttl?: "5m" | "1h" };
  subcortical_recall?: boolean | { enabled?: boolean; max_tokens?: number };
  observers?: AgentObserverConfig[];
  observe_delegates?: AgentDelegateObserverConfig[];
  tools: string[];
  agents: string[];
}
```

Source: `src/kernel/types.ts:265-296`.

`tools` lists primitive/tool names the agent may call. `agents` lists subagents it may delegate to (`src/kernel/types.ts:290-293`). Unknown frontmatter fields are preserved in `_extra` for parse/serialize round trips (`src/kernel/types.ts:294-295`, `src/agents/markdown-loader.ts:101-109`).

Default constraints are:

```ts
{
  max_turns: 50,
  timeout_ms: 300_000,
  can_spawn: true,
  can_learn: false,
}
```

Source: `src/kernel/types.ts:36-60`. Agent names cannot shadow kernel primitive names (`read_file`, `write_file`, `edit_file`, `apply_patch`, `exec`, `grep`, `glob`, `fetch`) or reserved kernel/core-loop names (`learn`, `kernel`, `perceive`, `recall`, `plan`, `act`, `verify`) (`src/kernel/types.ts:1-34`).

### Tree layout and delegation allowlist

Root agents are loaded from `root.md` and recursive child specs under `root/agents/...` (`src/agents/loader.ts:18-38`). The tree scanner builds a `Map<string, AgentTreeEntry>` from paths such as `utility/reader` or `tech-lead/engineer` (`src/agents/loader.ts:105-146`).

The runtime resolves delegatable agents from the scanned tree if available; otherwise it falls back to explicit `spec.agents` lookups in the genome/allAgents list. Tree mode supports both auto-discovered children and explicit references (`src/agents/agent.ts:800-823`, `src/agents/agent.ts:915-929`). Runtime-created genome agents can refresh the delegation list mid-session; when new delegates are detected, the agent receives a steering-style user message announcing the new agents (`src/agents/agent.ts:825-883`, `src/agents/agent.ts:2338-2345`).

Current root config demonstrates this pattern: `root/root.md` has no primitive tools, delegates to utility agents, enables learning and subcortical recall, and configures two observers (`root/root.md:7-23`, `root/root.md:23-41`).

## Tool surfaces exposed to agents

Sprout exposes three categories of tools to the LLM.

### 1. Built-in primitives

The built-in primitive registry includes filesystem, shell/search, network fetch, and genome/memory primitives. The base primitive list is built in `buildPrimitives()`:

- `read_file`
- `write_file`
- `edit_file`
- `apply_patch`
- `exec`
- `grep`
- `glob`
- `fetch`

Source: `src/kernel/primitives.ts:87-97`.

If a `GenomeContext` is provided, `createPrimitiveRegistry()` also registers workspace/genome primitives. In eval mode it only registers read-memory primitives; otherwise it registers `save_tool`, `save_file`, `save_agent`, read-memory primitives, and write-memory primitives only for `archivist` (`src/kernel/primitives.ts:48-66`, `src/kernel/primitives.ts:100-107`).

Primitive calls are executed sequentially after delegations and agent commands. Path constraints are checked before primitive execution, results are verified, `primitive_start`/`primitive_end`/`verify` events are emitted, and tool results are appended back to LLM history in original tool-call order (`src/agents/agent.ts:2185-2284`).

Provider alignment changes edit-tool exposure: OpenAI agents get `apply_patch` for `edit_file`, while Anthropic/Gemini agents get `edit_file` for `apply_patch` (`src/agents/plan.ts:149-180`).

### 2. Custom agent workspace tools

Agents can have tools in root or genome agent tool directories. During `Agent.run()`, Sprout loads tools for the current agent from the genome and root tree, wraps them as primitives, registers them in the primitive registry, exposes them as LLM tool definitions, and adds both genome and root tool dirs to PATH (`src/agents/agent.ts:1899-1935`). The system prompt also gets an `<agent_tools>` block listing those tools (`src/agents/agent.ts:1978-1981`, `src/agents/plan.ts:562-567`).

Tool loading details:

- `Genome.loadAgentTools(agentName)` reads `${genome}/agents/<agentName>/tools` (`src/genome/genome.ts:1297-1301`).
- `Genome.loadAgentToolsWithRoot()` merges genome tools and root tools; genome tools override root tools with the same name (`src/genome/genome.ts:1303-1316`).
- Loaded `AgentToolDefinition`s contain `name`, `displayName`, `description`, `interpreter`, `scriptPath`, and provenance (`src/genome/genome.ts:1318-1346`).
- `buildAgentToolPrimitives()` wraps each tool as a primitive with a single string `args` parameter (`src/kernel/tool-loading.ts:151-168`).

For `sprout-internal` tools, Sprout dynamically imports the TypeScript body and calls the default export with a `ToolContext`:

```ts
interface ToolContext {
  agentName: string;
  args: Record<string, unknown>;
  genome: Genome;
  env: ExecutionEnvironment;
  projectDataDir?: string;
  sessionId?: string;
}
```

Source: `src/kernel/tool-context.ts:4-17`; runtime construction at `src/kernel/tool-loading.ts:171-190`.

For non-internal tools, the script is piped to its configured interpreter with `SPROUT_TOOL_DIR` set, and the provided `args` string is passed after `/dev/stdin` (`src/kernel/tool-loading.ts:196-224`).

### 3. Agent-control tools

The agent-control tools are ordinary LLM tool definitions:

- `delegate`
- `wait_agent`
- `message_agent`

The constructor adds `delegate` when `constraints.can_spawn` is true and the agent has delegatable agents. If a bus spawner is present, it also adds `wait_agent` and `message_agent` (`src/agents/agent.ts:381-393`). An agent may also be explicitly granted `message_agent` in `tools` even without delegation rights, as used by observer agents (`src/agents/agent.ts:484-488`, `root/agents/metacognitive.md:7-9`).

The delegate tool schema is:

```json
{
  "name": "delegate",
  "parameters": {
    "type": "object",
    "properties": {
      "agent_name": { "type": "string" },
      "goal": { "type": "string" },
      "description": { "type": "string" },
      "hints": { "type": "array", "items": { "type": "string" } },
      "payload": { "type": "object" },
      "blocking": { "type": "boolean" },
      "shared": { "type": "boolean" }
    },
    "required": ["agent_name", "goal", "description"]
  }
}
```

Source: `src/agents/plan.ts:28-81`.

The wait/message tool schemas are:

```json
{ "name": "wait_agent", "parameters": { "required": ["handle"], "properties": { "handle": { "type": "string" } } } }
```

```json
{ "name": "message_agent", "parameters": { "required": ["handle", "message"], "properties": { "handle": { "type": "string" }, "message": { "type": "string" }, "blocking": { "type": "boolean" } } } }
```

Source: `src/agents/plan.ts:83-135`.

`parsePlanResponse()` classifies LLM tool calls into delegations, agent commands, and primitives; it validates required fields and returns malformed calls as tool-result errors instead of throwing. It also supports a compatibility path where a direct tool call to a known agent name is converted to a delegation if it contains a goal/task/command argument (`src/agents/plan.ts:412-541`).

## Delegation data model

The internal delegation and agent command types are:

```ts
interface Delegation {
  call_id: string;
  agent_name: string;
  goal: string;
  description?: string;
  hints?: string[];
  payload?: Record<string, unknown>;
  blocking?: boolean; // default true
  shared?: boolean;   // default false
}

interface WaitAgentCommand {
  kind: "wait_agent";
  call_id: string;
  handle: string;
}

interface MessageAgentCommand {
  kind: "message_agent";
  call_id: string;
  handle: string;
  message: string;
  blocking?: boolean; // default true
}
```

Source: `src/kernel/types.ts:319-352`.

Structured payloads are opt-in: only targets with `task_payload: true` accept a delegation payload (`src/kernel/types.ts:280-281`, `src/agents/agent.ts:1094-1108`, `src/agents/agent.ts:1569-1585`). Payloads are canonicalized, must be plain JSON-compatible objects, max depth 8, max size 64 KiB, no cycles, finite numbers only (`src/agents/delegation-payload.ts:1-37`, `src/agents/delegation-payload.ts:60-107`). If present, the child receives the payload embedded in the goal as:

```xml
<task_payload type="json">
...
</task_payload>
```

Source: `src/agents/delegation-payload.ts:39-58`.

## In-process vs bus-based subagents

Sprout supports two execution paths.

### In-process fallback

When no `AgentSpawner` is present, `executeDelegation()` constructs a child `Agent` object in the same process, with:

- depth incremented by 1;
- shared `ExecutionEnvironment`, `Client`, `Genome`, event emitter, and learn process;
- child-specific primitive registry and memory authorization;
- `self` address with generated child handle/agent ID;
- `caller` set to the parent agent's address;
- root/tree context for resolving the child's own delegates.

Source: `src/agents/agent.ts:1038-1186`.

The parent emits `act_start`, runs the child, verifies the `ActResult`, emits `verify`, possible `learn_signal`, and `act_end`, and returns the child output as the LLM tool result (`src/agents/agent.ts:1066-1238`).

### Bus-based subprocess path

When an `AgentSpawner` is present, `executeSpawnerDelegation()` uses subprocess handles. It creates separate `handleId` and `childId` ULIDs, emits `act_start`, validates target/payload/depth, then calls `spawner.spawnAgent()` with runtime context (`src/agents/agent.ts:1498-1625`).

Blocking behavior:

- `blocking` defaults to true (`src/agents/agent.ts:1511-1513`).
- Blocking `spawnAgent()` returns a `ResultMessage`; the parent verifies it, emits `verify`, possible `learn_signal`, records action metrics, emits `act_end`, and returns a tool result containing truncated output plus `Handle: <handle_id>` (`src/agents/agent.ts:1647-1714`).
- Non-blocking `spawnAgent()` returns the handle string immediately; parent emits `act_end` with success and returns `Agent started. Handle: <handle>` (`src/agents/agent.ts:1627-1645`).

Concurrency model:

- All delegations from one planning turn are launched concurrently.
- `wait_agent` and `message_agent` commands run after all delegations complete, sequentially.
- Primitive calls then run sequentially.
- Tool-result messages are appended to history in the original LLM tool-call order.

Source: `src/agents/agent.ts:2152-2284`.

## Bus transport and topic layout

### Pub/sub server and client

The bus is a WebSocket topic pub/sub server. Clients send JSON actions:

```ts
type ClientAction =
  | { action: "subscribe"; topic: string }
  | { action: "unsubscribe"; topic: string }
  | { action: "publish"; topic: string; payload: string };
```

Source: `src/bus/client.ts:1-5`, `src/bus/server.ts:3-10`.

The server records topic subscribers and sends a `{ action: "subscribed", topic }` ack for subscribe. On publish, it delivers `{ topic, payload }` to all subscribers except the publishing WebSocket (`src/bus/server.ts:115-172`). The client waits for subscribe acks before resolving `subscribe()` or `waitForMessage()` (`src/bus/client.ts:91-121`, `src/bus/client.ts:139-190`, `src/bus/client.ts:260-276`).

### Topics

Topic builders are in `src/bus/topics.ts`:

```ts
agentInbox(sessionId, handleId)  => session/{session}/agent/{handle}/inbox
agentEvents(sessionId, handleId) => session/{session}/agent/{handle}/events
agentReady(sessionId, handleId)  => session/{session}/agent/{handle}/ready
agentResult(sessionId, handleId) => session/{session}/agent/{handle}/result
agentMessageAck(sessionId, id)   => session/{session}/agent-message-ack/{id}
commandsTopic(sessionId)         => session/{session}/commands
sessionEvents(sessionId)         => session/{session}/events
```

Source: `src/bus/topics.ts:17-53`.

`parseTopic()` recognizes agent inbox/events/ready/result, agent-message acks, genome topics, command topics, and session events (`src/bus/topics.ts:55-80`).

### Bus message schemas

`src/bus/types.ts` defines runtime wire messages:

```ts
interface AgentAddress {
  agentName: string;
  depth: number;
  handleId: string;
  agentId: string;
  role?: "observer";
}

interface StartMessage {
  kind: "start";
  handle_id: string;
  genome_path: string;
  session_id: string;
  self: AgentAddress;
  caller: AgentAddress;
  goal: string;
  hints?: string[];
  payload?: Record<string, unknown>;
  shared: boolean;
  eval_mode?: boolean;
  provider_id?: string;
  resolver_settings?: ResolverSettings;
  trusted_user_instruction?: string;
  surfaced_memory_block?: string;
}

interface ContinueMessage {
  kind: "continue";
  message: string;
  caller: AgentAddress;
  trusted_user_instruction?: string;
}

interface SteerMessage {
  kind: "steer";
  message: string;
  trusted_user_instruction?: string;
}

interface AgentMessageMessage {
  kind: "agent_message";
  message: string;
  from: AgentAddress;
  to: AgentAddress;
  ack_topic?: string;
}

interface ResultMessage {
  kind: "result";
  handle_id: string;
  output: string;
  success: boolean;
  stumbles: number;
  turns: number;
  timed_out: boolean;
}

interface EventMessage {
  kind: "event";
  handle_id: string;
  event: SessionEvent;
}
```

Source: `src/bus/types.ts:4-88`. `parseBusMessage()` validates kind, required fields, `AgentAddress` shapes, optional strings, and optional plain-object payloads (`src/bus/types.ts:99-207`).

## AgentSpawner lifecycle and handle state

`AgentSpawner` manages subprocess lifecycle (`src/bus/spawner.ts:207-213`). Each handle tracks:

```ts
interface AgentHandle {
  handleId: string;
  agentId: string;
  address: AgentAddress;
  process: { kill(signal?: "SIGTERM" | "SIGKILL"): void; exited: Promise<number> };
  status: "running" | "idle" | "completed";
  result?: ResultMessage;
  keepAlive: boolean;
  visibility: "private" | "shared";
  isObserver: boolean;
  pendingWaiters: PendingWaiter[];
  owner: AgentAddress;
  agentName: string;
  genomePath: string;
  caller: AgentAddress;
  workDir: string;
  rootDir?: string;
  projectDataDir?: string;
  resultTopic?: string;
  mnemonicName?: string;
  evalMode?: boolean;
  providerIdOverride?: string;
  resolverSettings?: ResolverSettings;
  trustedUserInstruction?: string;
  surfacedMemoryBlock?: string;
  resultRecoveryLogOffset?: number | null;
}
```

Source: `src/bus/spawner.ts:85-116`.

### Spawn handshake

`spawnAgent()` flow:

1. Choose/generate handle ID and agent ID.
2. Compute visibility: explicit option, otherwise `shared` delegates become public and non-shared delegates stay private (`src/bus/spawner.ts:526-536`).
3. Spawn `sprout agent-process` with environment variables including `SPROUT_BUS_URL`, `SPROUT_HANDLE_ID`, `SPROUT_SESSION_ID`, `SPROUT_GENOME_PATH`, `SPROUT_WORK_DIR`, and parent PID (`src/bus/spawner.ts:539-548`).
4. Register handle and subscribe to its result topic (`src/bus/spawner.ts:558-587`).
5. Wait for the child to publish ready on `agentReady()` or exit first (`src/bus/spawner.ts:337-355`, `src/bus/spawner.ts:589-590`).
6. Publish `StartMessage` to the child's inbox (`src/bus/spawner.ts:592-611`).
7. If blocking, wait for result; otherwise return the handle (`src/bus/spawner.ts:613-617`).

The child process starts by connecting to the bus, subscribing to its inbox, publishing ready, then waiting for a `start` message (`src/bus/agent-process.ts:201-243`, `src/bus/agent-process.ts:495-551`). This ready-before-start handshake avoids publishing a start message before the subprocess inbox subscription exists.

### Result settlement and recovery

The spawner subscribes to `agentResult(session, handle)` and stores the first result (`src/bus/spawner.ts:501-518`). `settleHandleResult()` changes status to `idle` for keep-alive handles, otherwise `completed`, and resolves all pending waiters (`src/bus/spawner.ts:323-335`). If a process exits without a result, the spawner attempts durable log recovery, then synthesizes a failed `ResultMessage` if needed (`src/bus/spawner.ts:247-296`).

`registerCompletedHandle()` can install a completed handle from a previous session so `wait_agent` returns cached results immediately on resume (`src/bus/spawner.ts:917-988`). Agent subprocesses also replay prior handle logs and register completed child handles into their own child spawners (`src/bus/agent-process.ts:306-349`).

### Waiting and access control

`waitAgent(handleId, caller?)` returns cached results immediately, otherwise creates a waiter with a timeout. Access rules:

- Observer callers cannot wait on raw handles (`src/bus/spawner.ts:653-655`).
- Private handles may be waited only by their exact owner handle/agent ID (`src/bus/spawner.ts:657-665`).
- Shared handles may be waited by non-owner agents.

Source: `src/bus/spawner.ts:639-683`.

### Messaging and control

`messageAgent(handleId, message, caller, blocking, trustedUserInstruction?, callerTarget?)` handles several cases (`src/bus/spawner.ts:685-846`):

1. **`handleId === "root"`**: only root may use this raw root path, and it must be non-blocking. It publishes an `agent_message` to root's inbox (`src/bus/spawner.ts:702-717`).
2. **`handleId === "caller"`**: runtime alias used especially by observers. It must be non-blocking and requires a trusted `callerTarget`. The spawner publishes `agent_message` to the caller target inbox and waits for an ack (`src/bus/spawner.ts:719-738`, `src/bus/spawner.ts:1030-1071`).
3. **Observer raw handle restriction**: observer callers can only use `handle: "caller"`; raw shared/private handle messaging is rejected (`src/bus/spawner.ts:739-741`).
4. **Normal handle**: unknown handles fail; private handles require owner identity (`src/bus/spawner.ts:743-755`).
5. **Target running**: sends an `AgentMessageMessage`. Blocking is forbidden for running targets (`src/bus/spawner.ts:757-772`).
6. **Target idle**: clears cached result, marks running, sends `ContinueMessage`, and optionally waits for the new result (`src/bus/spawner.ts:774-795`).
7. **Target completed**: respawns the same handle, waits for ready, publishes a new `StartMessage` using the follow-up as the new goal. The child process replays its previous log as history (`src/bus/spawner.ts:798-845`, `src/bus/agent-process.ts:306-314`).

Agent-side `executeAgentCommand()` routes `wait_agent` and `message_agent` through the spawner, emits `act_end` for success/failure, and returns a tool result. If no spawner is available, these commands fail as tool results (`src/agents/agent.ts:1738-1825`).

## Agent-to-agent guidance path

Sprout distinguishes agent-originated guidance from user steering.

### Receiving an agent message

When an agent receives an `AgentMessageMessage`, it queues the message and emits an `agent_message` session event with `from`, `to`, and a preview (`src/agents/agent.ts:604-612`). During the next planning turn, queued messages are rendered into the system prompt inside:

```xml
<IMPORTANT>
<sprout:agent-messages>
These are runtime messages from other agents.
...
<message from="metacognitive" role="observer">
...
</message>
</sprout:agent-messages>
</IMPORTANT>
```

Source: `src/agents/agent.ts:658-679`.

The prompt guidance explicitly says to treat messages seriously but validate them against higher-priority instructions, the user's request, and evidence (`src/agents/agent.ts:664-669`). Rendered messages are removed from the queue after the planning cycle by `clearRenderedAgentMessagesForPrompt()` (`src/agents/agent.ts:681-686`).

### Steering is separate

User/frontend steering is queued by `agent.steer()` and injected as a user message on the next loop iteration, emitting a `steering` event (`src/agents/agent.ts:597-602`, `src/agents/agent.ts:2328-2336`). Agent messages are not pushed as user messages; they are runtime guidance in the system prompt.

### Root bridge

The root agent runs in-process, not as a spawned handle. `SessionController` subscribes to root inbox messages through `spawner.subscribeRootMessages()` and delivers them to `agent.receiveAgentMessage()`. If delivery succeeds, the spawner publishes an ack for messages that requested one (`src/host/session-controller.ts:527-539`, `src/bus/spawner.ts:400-409`, `src/bus/spawner.ts:478-499`).

## Subprocess agent process lifecycle

`runAgentProcess()` documents and implements the child process lifecycle (`src/bus/agent-process.ts:201-213`):

1. Connect to the bus and subscribe to the inbox.
2. Publish ready and wait for a `StartMessage`.
3. Load the genome and agent spec.
4. Inject caller identity into the child system prompt (`src/bus/agent-process.ts:276-281`; rendered shape in `src/agents/plan.ts:625-628`).
5. Build the primitive registry, event emitter, child spawner, tree context, and `Agent` instance (`src/bus/agent-process.ts:282-408`).
6. Subscribe to the inbox during the initial run for `steer` and `agent_message` messages (`src/bus/agent-process.ts:418-436`).
7. Run the agent and publish a `ResultMessage` to its result topic (`src/bus/agent-process.ts:439-457`, `src/bus/agent-process.ts:480-485`).
8. If shared/keep-alive, enter `idleLoop()`; otherwise disconnect and exit.

Child events are published both to a per-handle topic and to the session-wide topic so the UI and observer facilities can receive events from any depth without relaying through parent spawners (`src/bus/agent-process.ts:316-331`).

For keep-alive/shared agents, `idleLoop()` listens for:

- `steer`: queues user steering;
- `agent_message`: queues runtime guidance and publishes an ack if requested;
- `continue`: runs `agent.continue()` and publishes a fresh result.

Continue messages are queued and processed sequentially (`src/bus/agent-process.ts:553-650`).

## Event model and watch surfaces

All agent loop events are `SessionEvent` values:

```ts
interface SessionEvent {
  kind: EventKind;
  timestamp: number;
  agent_id: string;
  depth: number;
  data: Record<string, unknown>;
}
```

Source: `src/kernel/types.ts:491-535`. Event kinds include session lifecycle, perceive/recall/plan/act/primitive/verify/learn, `steering`, `agent_message`, warnings/errors, context update, compaction, interruption, logs, and task updates (`src/kernel/types.ts:491-523`).

`AgentEventEmitter` is a simple in-process collector/subscriber that emits to listeners synchronously (`src/agents/events.ts:1-34`). The host `EventBus` implements the same shape plus command channels; it caps retained events and catches listener errors (`src/host/event-bus.ts:7-20`, `src/host/event-bus.ts:27-113`).

`SessionController` relays root events to the bus through the default factory (`src/host/session-controller.ts:241-251`). With a spawner, it subscribes once to the session-wide subprocess event topic and re-emits those events into the host bus (`src/host/session-controller.ts:497-526`).

The TUI active-work display is derived from events, not from direct process state. `deriveActiveAgentWork()` tracks `act_start`/`act_end`, child `session_start`/`session_end`, blocking `wait_agent`/`message_agent` plan calls, and memory-collapse `context_update` events to show `Waiting on <agent>` or `Saving memory` (`src/shared/agent-display.ts:35-45`, `src/shared/agent-display.ts:76-215`).

## Observer/watch/notify mechanisms

Sprout's current notification mechanism is observer-frame delivery plus optional `message_agent` guidance. There is no separate `notify_agent` or persistent notification inbox in the inspected implementation; observers send advisory comments through the same `message_agent` primitive.

### Observer frontmatter schemas

Static observers attached to a root/session are configured in agent frontmatter as:

```ts
interface AgentObserverConfig {
  agent: string;
  target: "root" | "session";
  events: EventKind[];
  trigger: { every: number; event: EventKind };
  delivery?: { max_events?: number; max_chars?: number };
}
```

Delegate-final observers are configured as:

```ts
interface AgentDelegateObserverConfig {
  agent: string;
  trigger: "on_delegate_final";
  events: EventKind[];
  delivery?: { max_events?: number; max_chars?: number };
}
```

Source: `src/kernel/types.ts:206-233`.

`parseAgentMarkdown()` validates observer configs: `target` must be `root` or `session`, `events` must be non-empty known event kinds, `trigger.every` must be a positive integer, trigger event must be included in events, delegate observer trigger must be `on_delegate_final`, and delegate observer events must include `act_end` (`src/agents/markdown-loader.ts:151-207`, `src/agents/markdown-loader.ts:223-284`).

Current root config uses two static root observers. `the-balcony` fires every root `plan_end`; `metacognitive` fires every third root `plan_end` (`root/root.md:23-41`). The current metacognitive observer is a normal agent with only `message_agent`, `can_spawn: false`, `can_learn: false`, and `tags: [observer, diagnostics]` (`root/agents/metacognitive.md:1-18`). Its prompt instructs it to use `message_agent` with `handle: "caller"` and `blocking: false` only when a concise nudge is likely to improve the next turn (`root/agents/metacognitive.md:20-55`). The observer preamble says frames are observations, not task requests (`root/preambles/observer.md:1-14`).

### Observer frames

Observer frames are bounded, redacted summaries of selected events:

```ts
interface ObserverFrame {
  sessionId: string;
  events: ObserverFrameEvent[];
  truncated: boolean;
}

interface ObserverFrameEvent {
  index: number;
  kind: EventKind;
  timestamp: number;
  agentId: string;
  depth: number;
  summary: string;
  quote?: string;
}
```

Source: `src/agents/observers.ts:16-30`.

`buildObserverFrame()` filters by configured event kinds, keeps the last `maxEvents`, then trims oldest events until `renderObserverFrame()` fits `maxChars` (`src/agents/observers.ts:32-67`). Quotes are extracted from event data fields such as `goal`, `text`, `message`, `error`, `output`, `result`, or tool result content; quotes are redacted and truncated (`src/agents/observers.ts:90-157`). Rendered frames use `<sprout:observer-frame>` (`src/agents/observers.ts:69-88`).

### Static root/session observer flow

`SessionController` builds static observer configs from the root agent spec (`src/host/session-controller.ts:92-122`). If a spawner exists, the controller creates an `ObserverRegistry`, subscribes to all session-wide subprocess events, and forwards host bus events to `observerRegistry.handleEvent()` (`src/host/session-controller.ts:497-526`, `src/host/session-controller.ts:656-664`).

`ObserverRegistry.handleEvent()`:

1. Ignores observer telemetry to prevent observer self-feedback (`src/host/observer-registry.ts:109-111`, `src/host/observer-registry.ts:323-336`).
2. Buffers events if configs are not ready yet, up to 64 events (`src/host/observer-registry.ts:111-117`).
3. For each subscription, keeps matching event kinds and trims pending events to `maxEvents * 4` (`src/host/observer-registry.ts:118-127`, `src/host/observer-registry.ts:293-297`).
4. Triggers only on the configured trigger event; root observers require depth 0 (`src/host/observer-registry.ts:164-168`).
5. Flushes every N triggers (`src/host/observer-registry.ts:123-127`).
6. On root `session_end`, requests observer completion and emits observer `act_end` when delivery is idle (`src/host/observer-registry.ts:128-133`, `src/host/observer-registry.ts:270-290`).

`flush()` builds an observer frame, delivers it through `spawner.deliverObserverFrame()`, and on failure requeues events and emits a warning (`src/host/observer-registry.ts:170-218`). Delivery is serialized per subscription using `deliveryInFlight` and `flushRequested` state (`src/host/observer-registry.ts:170-217`).

Observer lifecycle events are visible: first delivery emits an `act_start` with `observer: true`, `observed_target`, owner IDs, handle ID, and child ID (`src/host/observer-registry.ts:229-268`). Completion emits `act_end` with `observer: true` and success state (`src/host/observer-registry.ts:270-290`).

### Delegate-final observer flow

Delegate observers are configured on the delegating agent via `observe_delegates`. Runtime configs are built in the agent constructor; the observer handle ID is deterministic from the owner address, index, and observer agent name (`src/agents/agent.ts:890-907`, `src/agents/agent.ts:2609`).

Only blocking bus delegations participate in delegate observer capture (`src/agents/agent.ts:1511-1516`). The parent begins capture before spawning, subscribes to session-wide events through the spawner, and records events whose `agent_id` is the child ID. Parent-owned `act_start`/`act_end` events for that child are also captured directly (`src/agents/agent.ts:1281-1348`, `src/agents/agent.ts:1536-1546`, `src/agents/agent.ts:1686-1699`). Capture is bounded to the largest configured `max_events * 4` (`src/agents/agent.ts:1350-1358`).

After the blocking child result is available, the parent builds a `<sprout:delegate-observer-frame>` containing instructions, caller identity, delegation goal/description/hints, last visible caller plan text, child result fields, and the rendered observer frame (`src/agents/agent.ts:1426-1486`). It delivers frames to all configured delegate observers concurrently and bounds each delivery with a timeout (default 1500 ms) so observer latency does not indefinitely block the owner (`src/agents/agent.ts:1360-1420`, defaults at `src/agents/agent.ts:160-162`). Failures produce warning events rather than failing the parent delegation (`src/agents/agent.ts:1412-1424`).

### Observer frame delivery and persistence

`AgentSpawner.deliverObserverFrame()` serializes deliveries per observer handle via an `observerDeliveryChains` map (`src/bus/spawner.ts:848-863`). `deliverObserverFrameNow()`:

- Spawns the observer the first time with `blocking: true`, `keepAlive: true`, `visibility: "private"`, and `isObserver: true` (`src/bus/spawner.ts:865-893`).
- Requires existing observer handles to be marked observer handles and owned by the same caller handle/agent ID (`src/bus/spawner.ts:896-906`).
- Sends later frames with `messageAgent(handleId, frame, caller, true)` and requires a successful result (`src/bus/spawner.ts:908-914`).

This means observers are long-lived, private, stateful agent processes. They receive each new frame as a continuation of their own transcript, but ordinary agents cannot address observer handles directly unless they are the owner/runtime facility.

### Observer comments back to the watched agent

Observers use `message_agent(handle: "caller", blocking: false)`. The spawner resolves `caller` from the observer agent's trusted runtime caller address, not from model input (`src/bus/spawner.ts:719-738`). `executeAgentCommand()` passes the current agent's `callerAddress` as the `callerTarget` to `spawner.messageAgent()` (`src/agents/agent.ts:1777-1786`). Observer raw-handle access is blocked (`src/bus/spawner.ts:739-741`).

The target receives an `agent_message` and sees the guidance in `<sprout:agent-messages>` on its next planning turn (`src/agents/agent.ts:604-612`, `src/agents/agent.ts:658-679`). This is the implementation's notify-like path.

### Observer telemetry exclusion

Observer telemetry is intentionally filtered from observer feedback and memory evidence:

- `ObserverRegistry` ignores events with `data.observer === true`, event IDs beginning with `observer-`, or `agent_message` events involving observer addresses (`src/host/observer-registry.ts:323-336`).
- `kernel/observer-telemetry.ts` collects observer IDs from `act_start` events where `observer === true` and identifies events as observer telemetry if they are observer lifecycle events, emitted by observer IDs, refer to observer child/handle IDs, or are `agent_message` events involving observer addresses (`src/kernel/observer-telemetry.ts:3-29`).

## Session controller control plane

The host side has two channels:

- **Events up**: agents and subprocesses emit `SessionEvent` values to frontends/logging/observer registry.
- **Commands down**: frontends send `Command` values such as `submit_goal`, `steer`, `interrupt`, `compact`, `clear`, `switch_model`, and `quit` (`src/kernel/types.ts:537-551`, `src/host/event-bus.ts:7-20`).

`SessionController` subscribes to commands and maps them to controller behavior: submit a goal, steer the running agent, interrupt, compact, clear, switch model, or quit (`src/host/session-controller.ts:542-579`). If `submitGoal()` is called while a run is already active, it becomes steering for the running agent rather than a new root run (`src/host/session-controller.ts:721-727`).

On `/clear`, the controller interrupts the current run, resets session state, calls `spawner.clearHandles()` and `spawner.updateSessionId()`, resets observer registry state, and emits `session_clear` with the new session ID (`src/host/session-controller.ts:621-654`).

## End-to-end flow sketches

### Blocking delegate with bus spawner

```text
LLM tool call: delegate(agent_name, goal, description)
  Agent.parsePlanResponse -> Delegation
  Agent.executeToolCalls launches executeSpawnerDelegation
    emit act_start(handle_id, child_id)
    AgentSpawner.spawnAgent(blocking=true)
      spawn sprout agent-process with SPROUT_* env
      child subscribes inbox, publishes ready
      parent publishes StartMessage
      child runs Agent.run(goal)
      child publishes EventMessage to per-handle and session-wide topics
      child publishes ResultMessage
      spawner settles handle status completed/idle
    parent verifies result, emits verify/learn_signal/act_end
    parent returns tool_result(output + Handle)
```

Sources: `src/agents/agent.ts:1498-1714`, `src/bus/spawner.ts:526-617`, `src/bus/agent-process.ts:201-213`, `src/bus/agent-process.ts:316-331`.

### Non-blocking delegate then wait

```text
LLM: delegate(..., blocking=false, shared?)
  spawnAgent returns handle immediately
  tool_result: "Agent started. Handle: <handle>"

Later LLM: wait_agent(handle)
  access check: observer denied; private requires owner; shared allows others
  if result cached, return immediately
  else wait with timeout for ResultMessage
```

Sources: `src/agents/agent.ts:1627-1645`, `src/bus/spawner.ts:639-683`.

### Agent message to idle/completed target

```text
LLM: message_agent(handle, message, blocking=true)
  if handle idle:
    clear cached result, mark running
    publish ContinueMessage
    optionally wait for ResultMessage
  if handle completed:
    respawn same handle
    child replays prior event log into history
    publish StartMessage with follow-up as goal
    optionally wait for ResultMessage
```

Sources: `src/bus/spawner.ts:774-845`, `src/bus/agent-process.ts:306-314`, `src/bus/agent-process.ts:553-650`.

### Observer nudge to root/caller

```text
ObserverRegistry or delegate observer builds bounded frame
  spawner.deliverObserverFrame starts/continues private observer handle
  observer LLM decides whether to call message_agent(handle="caller", blocking=false)
  Agent.executeAgentCommand passes trusted callerAddress to spawner
  spawner publishes AgentMessageMessage to caller inbox with ack
  caller Agent.receiveAgentMessage queues guidance
  next caller planning request includes <sprout:agent-messages>
```

Sources: `src/host/observer-registry.ts:170-255`, `src/bus/spawner.ts:848-914`, `src/bus/spawner.ts:719-738`, `src/agents/agent.ts:1777-1786`, `src/agents/agent.ts:604-679`.

## Implementation notes and gotchas

1. **Agent messages are not user steering.** They are rendered in the system prompt as `<sprout:agent-messages>` and are explicitly advisory (`src/agents/agent.ts:658-679`). User/front-end steering is a user message (`src/agents/agent.ts:2328-2336`).

2. **Private handle access uses exact runtime identity.** Owner checks compare both handle ID and agent ID, not just agent name (`src/bus/spawner.ts:657-665`, `src/bus/spawner.ts:748-755`).

3. **Observers are private but persistent.** Observer delivery uses `keepAlive: true`, `visibility: "private"`, and `isObserver: true` (`src/bus/spawner.ts:868-879`). This separates stateful observation from public addressability.

4. **`handle: "caller"` is runtime-resolved.** The model supplies the literal alias; runtime supplies the actual target from the agent's trusted caller context (`src/bus/spawner.ts:719-738`, `src/agents/agent.ts:1777-1786`).

5. **Running-target messages are non-blocking only.** `message_agent` to a currently running handle rejects `blocking: true` (`src/bus/spawner.ts:759-762`).

6. **Completed handles are resumable.** A completed shared/private handle can be messaged; Sprout respawns the process with the same handle and prior log replay (`src/bus/spawner.ts:798-845`, `src/bus/agent-process.ts:306-314`).

7. **Delegations in one LLM turn are concurrent.** If order matters, the agent must split work across turns or use explicit waits/messages. The implementation launches all delegations and awaits `Promise.all()` (`src/agents/agent.ts:2163-2175`).

8. **Static observers can be configured after agent creation.** `SessionController` constructs an `ObserverRegistry` before factory completion, then configures it once the genome is available if it was not already configured (`src/host/session-controller.ts:497-519`, `src/host/session-controller.ts:889-895`).

9. **Observer delivery failure is non-fatal to the main run.** Static observer failures requeue events and emit warnings; delegate observer failures emit warnings and continue (`src/host/observer-registry.ts:196-205`, `src/agents/agent.ts:1412-1424`).

10. **Tool boundaries are prompt-level guardrails.** Sprout appends `<tool_boundaries>` stating unavailable capabilities to discourage hallucinated tool use (`src/agents/plan.ts:574-623`). Actual enforcement happens through the tool registry and command validators.

11. **No separate notification store exists in this implementation.** The notify-like path is observer frame -> `message_agent` -> `agent_message` event -> `<sprout:agent-messages>` prompt injection. Source search and implementation files show no distinct notification inbox primitive in the agent runtime; the implemented watch/notify mechanism is observer delivery plus agent-message guidance.

## Quick reference tables

### Runtime states

| State | Meaning | Entered by | Exited by |
|---|---|---|---|
| `running` | process is executing initial run or continuation | spawn, idle continuation, completed respawn | result settlement or process exit |
| `idle` | keep-alive process completed a turn and can receive `continue` | result settlement when `keepAlive` true | `messageAgent()` continuation |
| `completed` | process exited or non-keepalive handle has final result | result settlement when `keepAlive` false; process exit | `messageAgent()` completed-handle respawn |

Source: `src/bus/spawner.ts:86-116`, `src/bus/spawner.ts:323-335`, `src/bus/spawner.ts:774-845`.

### Common event fields for agent work

| Event | Key data fields | Source |
|---|---|---|
| `act_start` for delegate | `agent_name`, `goal`, `description`, `handle_id`, `child_id`, `mnemonic_name` | `src/agents/agent.ts:1536-1546` |
| `act_end` for delegate | `agent_name`, `success`, `handle_id`, `turns`, `timed_out`, `child_id`, `tool_result_message` | `src/agents/agent.ts:1686-1699` |
| `act_end` for wait/message | `agent_name`, `success`, `child_id`, `target_agent_name`, `tool_result_message` | `src/agents/agent.ts:1761-1825` |
| `agent_message` | `from`, `to`, `textPreview` | `src/agents/agent.ts:604-612` |
| observer lifecycle | `observer: true`, `observed_target`, `owner_handle_id`, `owner_agent_id`, `handle_id`, `child_id` | `src/host/observer-registry.ts:257-290`, `src/agents/agent.ts:1377-1388` |

### Access rules

| Operation | Allowed callers | Notes |
|---|---|---|
| `wait_agent(private)` | owner exact `handleId` + `agentId` | observers denied |
| `wait_agent(shared)` | any non-observer agent with handle | cached results return immediately |
| `message_agent(private)` | owner exact `handleId` + `agentId` | observers denied except `caller` |
| `message_agent(shared)` | non-observer agents with handle | running targets require `blocking=false` |
| `message_agent(caller)` | any agent with runtime caller target, especially observers | requires `blocking=false`, uses ack |
| observer frame delivery | runtime observer facility only | verifies observer handle and owner |

Sources: `src/bus/spawner.ts:648-683`, `src/bus/spawner.ts:694-846`, `src/bus/spawner.ts:865-914`.

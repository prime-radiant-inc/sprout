# Async Agent Messaging Implementation Plan

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

**Goal:** Replace the current one-shot synchronous delegation model with a WebSocket bus-based, per-process agent architecture supporting async delegation, conversational sub-agents, and durable resume.

**Architecture:** A single WebSocket message bus (over Unix domain socket) connects all participants: the session host, agent processes, the TUI, and the genome service. Each agent runs in its own Bun subprocess. Three new tools (`delegate`, `wait_agent`, `message_agent`) replace the current synchronous `executeDelegation()` call. Event logs per agent handle provide durable state for crash recovery.

**Tech Stack:** Bun (runtime + `Bun.serve()` WebSocket + `Bun.spawn()` subprocesses), TypeScript, Unix domain sockets

**Design Doc:** `docs/plans/2026-02-25-async-agent-messaging-design.md`

---

## Phase 1: Bus Protocol Types

### Task 1: Define bus message types

**Files:**
- Create: `src/bus/types.ts`
- Test: `test/bus/types.test.ts`

**Step 1: Write the failing test**

```typescript
// test/bus/types.test.ts
import { describe, expect, test } from "bun:test";
import {
  type StartMessage,
  type ContinueMessage,
  type SteerMessage,
  type ResultMessage,
  type EventMessage,
  parseBusMessage,
} from "../../src/bus/types.ts";

describe("parseBusMessage", () => {
  test("parses a valid start message", () => {
    const raw = JSON.stringify({
      kind: "start",
      handle_id: "01ABC",
      agent_name: "code-editor",
      genome_path: "/tmp/genome",
      session_id: "01SESSION",
      caller: { agent_name: "root", depth: 0 },
      goal: "Fix the bug",
      shared: false,
    });
    const msg = parseBusMessage(raw);
    expect(msg.kind).toBe("start");
    expect((msg as StartMessage).agent_name).toBe("code-editor");
  });

  test("parses a valid result message", () => {
    const raw = JSON.stringify({
      kind: "result",
      handle_id: "01ABC",
      output: "Done",
      success: true,
      stumbles: 0,
      turns: 3,
      timed_out: false,
    });
    const msg = parseBusMessage(raw);
    expect(msg.kind).toBe("result");
    expect((msg as ResultMessage).success).toBe(true);
  });

  test("throws on unknown message kind", () => {
    expect(() => parseBusMessage(JSON.stringify({ kind: "bogus" }))).toThrow();
  });

  test("throws on invalid JSON", () => {
    expect(() => parseBusMessage("not json")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/bus/types.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/bus/types.ts

/** Caller identity block — tells a sub-agent who spawned it. */
export interface CallerIdentity {
  agent_name: string;
  depth: number;
}

/** Sent to a new agent's inbox to start it. */
export interface StartMessage {
  kind: "start";
  handle_id: string;
  agent_name: string;
  genome_path: string;
  session_id: string;
  caller: CallerIdentity;
  goal: string;
  hints?: string[];
  shared: boolean;
}

/** Sent to a completed/idle agent to continue with new input. */
export interface ContinueMessage {
  kind: "continue";
  message: string;
  caller: CallerIdentity;
}

/** Injected between turns of a running agent. */
export interface SteerMessage {
  kind: "steer";
  message: string;
}

/** Published by an agent on completion. */
export interface ResultMessage {
  kind: "result";
  handle_id: string;
  output: string;
  success: boolean;
  stumbles: number;
  turns: number;
  timed_out: boolean;
}

/** Published by an agent throughout execution. */
export interface EventMessage {
  kind: "event";
  handle_id: string;
  event: import("../kernel/types.ts").SessionEvent;
}

/** Union of all bus message types. */
export type BusMessage =
  | StartMessage
  | ContinueMessage
  | SteerMessage
  | ResultMessage
  | EventMessage;

const VALID_KINDS = new Set(["start", "continue", "steer", "result", "event"]);

/** Parse a raw JSON string into a typed BusMessage. Throws on invalid input. */
export function parseBusMessage(raw: string): BusMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in bus message: ${raw.slice(0, 100)}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
    throw new Error("Bus message missing 'kind' field");
  }
  const kind = (parsed as Record<string, unknown>).kind;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    throw new Error(`Unknown bus message kind: ${kind}`);
  }
  return parsed as BusMessage;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/bus/types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bus/types.ts test/bus/types.test.ts
git commit -m "feat: add bus message type definitions and parser"
```

---

### Task 2: Define bus topic helpers

**Files:**
- Create: `src/bus/topics.ts`
- Test: `test/bus/topics.test.ts`

**Step 1: Write the failing test**

```typescript
// test/bus/topics.test.ts
import { describe, expect, test } from "bun:test";
import { agentInbox, agentEvents, agentResult, commandsTopic, genomeMutations, genomeEvents, parseTopic } from "../../src/bus/topics.ts";

describe("topic builders", () => {
  test("agentInbox", () => {
    expect(agentInbox("S1", "H1")).toBe("session/S1/agent/H1/inbox");
  });
  test("agentEvents", () => {
    expect(agentEvents("S1", "H1")).toBe("session/S1/agent/H1/events");
  });
  test("agentResult", () => {
    expect(agentResult("S1", "H1")).toBe("session/S1/agent/H1/result");
  });
  test("commandsTopic", () => {
    expect(commandsTopic("S1")).toBe("session/S1/commands");
  });
  test("genomeMutations", () => {
    expect(genomeMutations("S1")).toBe("session/S1/genome/mutations");
  });
  test("genomeEvents", () => {
    expect(genomeEvents("S1")).toBe("session/S1/genome/events");
  });
});

describe("parseTopic", () => {
  test("parses agent inbox topic", () => {
    const parsed = parseTopic("session/S1/agent/H1/inbox");
    expect(parsed).toEqual({ session_id: "S1", handle_id: "H1", channel: "inbox" });
  });
  test("parses commands topic", () => {
    const parsed = parseTopic("session/S1/commands");
    expect(parsed).toEqual({ session_id: "S1", channel: "commands" });
  });
  test("returns null for unrecognized topic", () => {
    expect(parseTopic("random/junk")).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/bus/topics.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/bus/topics.ts

export function agentInbox(sessionId: string, handleId: string): string {
  return `session/${sessionId}/agent/${handleId}/inbox`;
}
export function agentEvents(sessionId: string, handleId: string): string {
  return `session/${sessionId}/agent/${handleId}/events`;
}
export function agentResult(sessionId: string, handleId: string): string {
  return `session/${sessionId}/agent/${handleId}/result`;
}
export function commandsTopic(sessionId: string): string {
  return `session/${sessionId}/commands`;
}
export function genomeMutations(sessionId: string): string {
  return `session/${sessionId}/genome/mutations`;
}
export function genomeEvents(sessionId: string): string {
  return `session/${sessionId}/genome/events`;
}

export interface ParsedAgentTopic {
  session_id: string;
  handle_id: string;
  channel: string;
}

export interface ParsedSessionTopic {
  session_id: string;
  channel: string;
}

export type ParsedTopic = ParsedAgentTopic | ParsedSessionTopic;

const AGENT_TOPIC_RE = /^session\/([^/]+)\/agent\/([^/]+)\/([^/]+)$/;
const SESSION_TOPIC_RE = /^session\/([^/]+)\/([^/]+)$/;

export function parseTopic(topic: string): ParsedTopic | null {
  let m = AGENT_TOPIC_RE.exec(topic);
  if (m) return { session_id: m[1]!, handle_id: m[2]!, channel: m[3]! };
  m = SESSION_TOPIC_RE.exec(topic);
  if (m) return { session_id: m[1]!, channel: m[2]! };
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/bus/topics.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bus/topics.ts test/bus/topics.test.ts
git commit -m "feat: add bus topic builder and parser helpers"
```

---

## Phase 2: WebSocket Bus Server and Client

### Task 3: Build the bus server

The bus server is a WebSocket server on a Unix domain socket. Clients connect, subscribe to topics (glob patterns), publish to topics. The server routes published messages to all matching subscribers.

**Files:**
- Create: `src/bus/server.ts`
- Test: `test/bus/server.test.ts`

**Step 1: Write the failing test**

```typescript
// test/bus/server.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusServer } from "../../src/bus/server.ts";

describe("BusServer", () => {
  let tempDir: string;
  let socketPath: string;
  let server: BusServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sprout-bus-"));
    socketPath = join(tempDir, "bus.sock");
    server = new BusServer(socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("starts and accepts WebSocket connections", async () => {
    const ws = new WebSocket(`ws+unix://${socketPath}`);
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("routes published messages to subscribers", async () => {
    const ws1 = new WebSocket(`ws+unix://${socketPath}`);
    const ws2 = new WebSocket(`ws+unix://${socketPath}`);
    await Promise.all([
      new Promise<void>((r) => { ws1.onopen = () => r(); }),
      new Promise<void>((r) => { ws2.onopen = () => r(); }),
    ]);

    // ws2 subscribes to a topic
    ws2.send(JSON.stringify({ action: "subscribe", topic: "session/S1/agent/H1/events" }));
    await new Promise((r) => setTimeout(r, 50));

    // ws1 publishes to that topic
    const received: string[] = [];
    ws2.onmessage = (e) => { received.push(typeof e.data === "string" ? e.data : ""); };

    ws1.send(JSON.stringify({ action: "publish", topic: "session/S1/agent/H1/events", payload: '{"kind":"event"}' }));
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBe(1);
    const msg = JSON.parse(received[0]!);
    expect(msg.topic).toBe("session/S1/agent/H1/events");
    expect(msg.payload).toBe('{"kind":"event"}');

    ws1.close();
    ws2.close();
  });

  test("does not deliver messages to non-subscribers", async () => {
    const ws1 = new WebSocket(`ws+unix://${socketPath}`);
    const ws2 = new WebSocket(`ws+unix://${socketPath}`);
    await Promise.all([
      new Promise<void>((r) => { ws1.onopen = () => r(); }),
      new Promise<void>((r) => { ws2.onopen = () => r(); }),
    ]);

    // ws2 subscribes to topic A, ws1 publishes to topic B
    ws2.send(JSON.stringify({ action: "subscribe", topic: "topicA" }));
    await new Promise((r) => setTimeout(r, 50));

    const received: string[] = [];
    ws2.onmessage = (e) => { received.push(typeof e.data === "string" ? e.data : ""); };

    ws1.send(JSON.stringify({ action: "publish", topic: "topicB", payload: "hello" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBe(0);

    ws1.close();
    ws2.close();
  });

  test("unsubscribe stops delivery", async () => {
    const ws = new WebSocket(`ws+unix://${socketPath}`);
    await new Promise<void>((r) => { ws.onopen = () => r(); });

    ws.send(JSON.stringify({ action: "subscribe", topic: "T1" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ action: "unsubscribe", topic: "T1" }));
    await new Promise((r) => setTimeout(r, 50));

    const received: string[] = [];
    ws.onmessage = (e) => { received.push(typeof e.data === "string" ? e.data : ""); };

    // Publish from a second client
    const ws2 = new WebSocket(`ws+unix://${socketPath}`);
    await new Promise<void>((r) => { ws2.onopen = () => r(); });
    ws2.send(JSON.stringify({ action: "publish", topic: "T1", payload: "data" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(received.length).toBe(0);

    ws.close();
    ws2.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/bus/server.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

The bus server uses `Bun.serve()` with a WebSocket upgrade. It maintains a `Map<topic, Set<ws>>` for subscriptions. The wire protocol is simple JSON: clients send `{ action: "subscribe"|"unsubscribe"|"publish", topic, payload? }`. Server delivers `{ topic, payload }` to matching subscribers.

```typescript
// src/bus/server.ts
import { unlinkSync } from "node:fs";
import type { ServerWebSocket } from "bun";

interface BusAction {
  action: "subscribe" | "unsubscribe" | "publish";
  topic: string;
  payload?: string;
}

export class BusServer {
  private readonly socketPath: string;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private subscriptions = new Map<string, Set<ServerWebSocket<unknown>>>();

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    // Remove stale socket file if present
    try { unlinkSync(this.socketPath); } catch {}

    this.server = Bun.serve({
      unix: this.socketPath,
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("Upgrade required", { status: 426 });
      },
      websocket: {
        open: () => {},
        close: (ws) => {
          // Remove from all subscriptions
          for (const subs of this.subscriptions.values()) {
            subs.delete(ws);
          }
        },
        message: (ws, raw) => {
          const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          let msg: BusAction;
          try { msg = JSON.parse(text); } catch { return; }

          switch (msg.action) {
            case "subscribe": {
              let subs = this.subscriptions.get(msg.topic);
              if (!subs) {
                subs = new Set();
                this.subscriptions.set(msg.topic, subs);
              }
              subs.add(ws);
              break;
            }
            case "unsubscribe": {
              this.subscriptions.get(msg.topic)?.delete(ws);
              break;
            }
            case "publish": {
              const delivery = JSON.stringify({ topic: msg.topic, payload: msg.payload });
              const subs = this.subscriptions.get(msg.topic);
              if (subs) {
                for (const sub of subs) {
                  if (sub !== ws) sub.send(delivery);
                }
              }
              break;
            }
          }
        },
      },
    });
  }

  async stop(): Promise<void> {
    this.server?.stop(true);
    this.subscriptions.clear();
    try { unlinkSync(this.socketPath); } catch {}
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/bus/server.test.ts`
Expected: PASS

Note: Bun's WebSocket `ws+unix://` support needs to be verified. If Bun doesn't support Unix socket WebSocket clients natively, fall back to `localhost:<random-port>` for the socket and plan to revisit Unix domain sockets when remote transport is needed. The bus abstraction doesn't change.

**Step 5: Commit**

```bash
git add src/bus/server.ts test/bus/server.test.ts
git commit -m "feat: add WebSocket bus server with topic-based pub/sub"
```

---

### Task 4: Build the bus client

A lightweight client that agents and the host use to connect to the bus. Provides `subscribe(topic, callback)`, `publish(topic, payload)`, `unsubscribe(topic)`.

**Files:**
- Create: `src/bus/client.ts`
- Test: `test/bus/client.test.ts`

**Step 1: Write the failing test**

```typescript
// test/bus/client.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";

describe("BusClient", () => {
  let tempDir: string;
  let socketPath: string;
  let server: BusServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sprout-bus-client-"));
    socketPath = join(tempDir, "bus.sock");
    server = new BusServer(socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("connect and disconnect", async () => {
    const client = new BusClient(socketPath);
    await client.connect();
    expect(client.connected).toBe(true);
    await client.disconnect();
    expect(client.connected).toBe(false);
  });

  test("publish and subscribe between two clients", async () => {
    const pub = new BusClient(socketPath);
    const sub = new BusClient(socketPath);
    await pub.connect();
    await sub.connect();

    const received: string[] = [];
    await sub.subscribe("test/topic", (payload) => { received.push(payload); });

    await pub.publish("test/topic", "hello");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["hello"]);

    await pub.disconnect();
    await sub.disconnect();
  });

  test("unsubscribe stops delivery", async () => {
    const pub = new BusClient(socketPath);
    const sub = new BusClient(socketPath);
    await pub.connect();
    await sub.connect();

    const received: string[] = [];
    await sub.subscribe("T", (p) => { received.push(p); });
    await sub.unsubscribe("T");

    await pub.publish("T", "nope");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([]);

    await pub.disconnect();
    await sub.disconnect();
  });

  test("waitForMessage resolves on first matching message", async () => {
    const pub = new BusClient(socketPath);
    const sub = new BusClient(socketPath);
    await pub.connect();
    await sub.connect();

    const promise = sub.waitForMessage("T");
    await pub.publish("T", '{"kind":"result"}');
    const msg = await promise;
    expect(msg).toBe('{"kind":"result"}');

    await pub.disconnect();
    await sub.disconnect();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/bus/client.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

`BusClient` wraps a WebSocket connection. `subscribe` sends a subscribe action and registers a local callback. `publish` sends a publish action. `waitForMessage` returns a Promise that resolves on the first message to a topic.

```typescript
// src/bus/client.ts
type Callback = (payload: string) => void;

export class BusClient {
  private readonly socketPath: string;
  private ws: WebSocket | null = null;
  private callbacks = new Map<string, Set<Callback>>();
  private _connected = false;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(`ws+unix://${this.socketPath}`);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => { this._connected = true; resolve(); };
      this.ws!.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (e) => {
      const text = typeof e.data === "string" ? e.data : "";
      try {
        const { topic, payload } = JSON.parse(text);
        const cbs = this.callbacks.get(topic);
        if (cbs) for (const cb of cbs) cb(payload);
      } catch {}
    };
    this.ws.onclose = () => { this._connected = false; };
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this._connected = false;
    this.callbacks.clear();
  }

  async subscribe(topic: string, callback: Callback): Promise<void> {
    let cbs = this.callbacks.get(topic);
    if (!cbs) {
      cbs = new Set();
      this.callbacks.set(topic, cbs);
      this.ws?.send(JSON.stringify({ action: "subscribe", topic }));
      await new Promise((r) => setTimeout(r, 10)); // Let server process
    }
    cbs.add(callback);
  }

  async unsubscribe(topic: string): Promise<void> {
    this.callbacks.delete(topic);
    this.ws?.send(JSON.stringify({ action: "unsubscribe", topic }));
  }

  async publish(topic: string, payload: string): Promise<void> {
    this.ws?.send(JSON.stringify({ action: "publish", topic, payload }));
    await new Promise((r) => setTimeout(r, 10)); // Let server route
  }

  /** Wait for the first message on a topic. Subscribes, resolves, unsubscribes. */
  async waitForMessage(topic: string, timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unsubscribe(topic);
        reject(new Error(`Timeout waiting for message on ${topic}`));
      }, timeoutMs);
      this.subscribe(topic, (payload) => {
        clearTimeout(timer);
        this.unsubscribe(topic);
        resolve(payload);
      });
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/bus/client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bus/client.ts test/bus/client.test.ts
git commit -m "feat: add WebSocket bus client with subscribe/publish/wait"
```

---

## Phase 3: Agent Process Refactoring

### Task 5: Promote Agent history to instance field, extract runLoop()

Currently `Agent.run()` holds `history` as a local variable. We need it as an instance field so `continue()` can append to the existing conversation. Extract the core loop into a `runLoop()` method that both `run()` and a future `continue()` can call.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

Add a test that verifies history is accessible after run completes (needed for continue support):

```typescript
// In test/agents/agent.test.ts, add:
test("history is preserved after run completes", async () => {
  // Use existing VCR/mock setup to run an agent with a simple goal.
  // After run(), call agent.currentHistory() and verify it contains
  // both the user message and assistant response.
  const agent = /* create agent using existing test helpers */;
  await agent.run("say hello");
  const history = agent.currentHistory();
  expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant
});
```

The exact test setup should follow the existing patterns in `test/agents/agent.test.ts` — use the VCR cassette approach with mocked LLM responses.

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/agent.test.ts`
Expected: FAIL — `agent.currentHistory` is not a function

**Step 3: Implement**

In `src/agents/agent.ts`:
1. Change `const history: Message[]` in `run()` to `this.history` (private instance field, initialized in constructor from `initialHistory ?? []`).
2. Add a public `currentHistory(): Message[]` getter that returns a copy.
3. Extract the while loop from `run()` into a private `runLoop(agentId, startTime, callHistory)` method. `run()` becomes: set up initial state (goal, recall, system prompt), call `runLoop()`, return result.
4. All existing tests must continue to pass unchanged.

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/agent.test.ts && bun test test/agents/agent.integration.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "refactor: promote Agent history to instance field, add currentHistory()"
```

---

### Task 6: Add Agent.continue() method

Add a `continue(message)` method that appends a user message to the existing history and runs another planning cycle without re-doing recall or rebuilding the system prompt.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

```typescript
// In test/agents/agent.test.ts, add:
test("continue() appends message and runs another cycle", async () => {
  // Set up agent with VCR cassette that has two exchanges:
  // 1. First run: user sends goal, LLM responds with text (no tools → done)
  // 2. Continue: user sends follow-up, LLM responds with text (no tools → done)
  const agent = /* create with two-response VCR cassette */;
  const first = await agent.run("step one");
  expect(first.success).toBe(true);

  const second = await agent.continue("step two");
  expect(second.success).toBe(true);

  const history = agent.currentHistory();
  // Should contain: user("step one"), assistant(response1), user("step two"), assistant(response2)
  expect(history.length).toBeGreaterThanOrEqual(4);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/agent.test.ts`
Expected: FAIL — `agent.continue` is not a function

**Step 3: Implement**

Add `continue(message: string, signal?: AbortSignal): Promise<AgentResult>`:
1. Push `Msg.user(message)` onto `this.history`.
2. Emit `perceive` event.
3. Call `runLoop()` with the existing system prompt and state.
4. Return result.

The key difference from `run()`: no recall, no system prompt rebuild, no session_start event — those happened on the first `run()`.

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/agent.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: add Agent.continue() for multi-turn conversations"
```

---

### Task 7: Add blocking, shared params to delegate tool and wait_agent, message_agent tools

Update `buildDelegateTool()` to include `blocking` (default true) and `shared` (default false) parameters. Add `buildWaitAgentTool()` and `buildMessageAgentTool()` tool definitions.

**Files:**
- Modify: `src/agents/plan.ts`
- Modify: `test/agents/plan.test.ts`

**Step 1: Write the failing test**

```typescript
// In test/agents/plan.test.ts, add:
test("delegate tool includes blocking and shared params", () => {
  const tool = buildDelegateTool([{ name: "editor", /* ... */ }]);
  const props = tool.parameters.properties;
  expect(props.blocking).toBeDefined();
  expect(props.blocking.type).toBe("boolean");
  expect(props.shared).toBeDefined();
  expect(props.shared.type).toBe("boolean");
});

test("buildWaitAgentTool returns correct schema", () => {
  const tool = buildWaitAgentTool();
  expect(tool.name).toBe("wait_agent");
  expect(tool.parameters.properties.handle).toBeDefined();
  expect(tool.parameters.required).toEqual(["handle"]);
});

test("buildMessageAgentTool returns correct schema", () => {
  const tool = buildMessageAgentTool();
  expect(tool.name).toBe("message_agent");
  expect(tool.parameters.properties.handle).toBeDefined();
  expect(tool.parameters.properties.message).toBeDefined();
  expect(tool.parameters.properties.blocking).toBeDefined();
  expect(tool.parameters.required).toEqual(["handle", "message"]);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/plan.test.ts`
Expected: FAIL

**Step 3: Implement**

In `src/agents/plan.ts`:
1. Add `blocking` and `shared` properties to the delegate tool schema (both `type: "boolean"`, both optional, defaults described in description).
2. Export `WAIT_AGENT_TOOL_NAME = "wait_agent"` and `MESSAGE_AGENT_TOOL_NAME = "message_agent"`.
3. Add `buildWaitAgentTool()` — takes `handle` (string, required).
4. Add `buildMessageAgentTool()` — takes `handle` (string, required), `message` (string, required), `blocking` (boolean, optional, default true).
5. Update `parsePlanResponse()` to recognize the new tool names and classify them appropriately (new return fields or a broader classification).

**Step 4: Run tests to verify they pass**

Run: `bun test test/agents/plan.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/agents/plan.ts test/agents/plan.test.ts
git commit -m "feat: add blocking/shared to delegate, add wait_agent and message_agent tools"
```

---

## Phase 4: Agent Process Entry Point

### Task 8: Create the agent process entry point

A standalone Bun script that runs as a child process. It connects to the bus, subscribes to its inbox, waits for a `start` message, loads the agent spec from the genome, runs the agent loop, and publishes results.

**Files:**
- Create: `src/bus/agent-process.ts`
- Test: `test/bus/agent-process.test.ts`

**Step 1: Write the failing test**

This test spawns the agent process as a real subprocess, sends it a start message via the bus, and verifies it publishes a result.

```typescript
// test/bus/agent-process.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusClient } from "../../src/bus/client.ts";
import { BusServer } from "../../src/bus/server.ts";
import { agentInbox, agentResult } from "../../src/bus/topics.ts";

describe("agent-process", () => {
  let tempDir: string;
  let socketPath: string;
  let server: BusServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sprout-agent-proc-"));
    socketPath = join(tempDir, "bus.sock");
    server = new BusServer(socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("agent process connects, receives start, publishes result", async () => {
    // This test requires a genome with a simple agent that can run.
    // Set up a minimal genome in tempDir with a test agent spec.
    // Spawn the agent process, send it a start message, wait for result.
    //
    // The exact setup depends on how the agent process reads the genome
    // and LLM. Use environment variables or a VCR cassette for the LLM call.
    //
    // Skeleton:
    const handleId = "01TESTHANDLE";
    const sessionId = "01TESTSESSION";

    const client = new BusClient(socketPath);
    await client.connect();

    // Subscribe to result topic before spawning
    const resultPromise = client.waitForMessage(agentResult(sessionId, handleId));

    // Spawn agent process
    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "../../src/bus/agent-process.ts")],
      {
        env: {
          ...process.env,
          SPROUT_BUS_SOCKET: socketPath,
          SPROUT_HANDLE_ID: handleId,
          SPROUT_SESSION_ID: sessionId,
        },
      },
    );

    // Wait for process to connect, then send start
    await new Promise((r) => setTimeout(r, 200));
    await client.publish(agentInbox(sessionId, handleId), JSON.stringify({
      kind: "start",
      handle_id: handleId,
      agent_name: "test-agent",
      genome_path: tempDir, // needs genome setup
      session_id: sessionId,
      caller: { agent_name: "root", depth: 0 },
      goal: "Say hello",
      shared: false,
    }));

    const resultRaw = await resultPromise;
    const result = JSON.parse(resultRaw);
    expect(result.kind).toBe("result");
    expect(result.handle_id).toBe(handleId);

    proc.kill();
    await client.disconnect();
  });
});
```

Note: This test will need a minimal genome setup and a VCR cassette or mock for the LLM call. The exact wiring depends on whether we pass the LLM mock via environment variable or file path. Follow existing integration test patterns.

**Step 2: Run test to verify it fails**

Run: `bun test test/bus/agent-process.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

`src/bus/agent-process.ts` is a `Bun.main`-style entry point:

1. Read `SPROUT_BUS_SOCKET`, `SPROUT_HANDLE_ID`, `SPROUT_SESSION_ID` from env.
2. Connect a `BusClient` to the socket.
3. Subscribe to `agentInbox(sessionId, handleId)`.
4. Wait for a `start` message.
5. Load agent spec from genome at `start.genome_path`.
6. Create `Agent` instance (same as current `createAgent()` but parameterized).
7. Run the agent loop, publishing events to the agent's events topic.
8. On completion, publish `ResultMessage` to the agent's result topic.
9. Transition to idle — wait for `continue` or `steer` messages.
10. On `continue`: call `agent.continue(message)`, publish new result.
11. On shutdown signal: disconnect and exit.

**Step 4: Run test to verify it passes**

Run: `bun test test/bus/agent-process.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bus/agent-process.ts test/bus/agent-process.test.ts
git commit -m "feat: add agent process entry point (bus-connected subprocess)"
```

---

## Phase 5: Process Spawner and Tool Execution

### Task 9: Build the process spawner

Replace the in-process `executeDelegation()` with a process spawner that starts agent subprocesses. An orchestrator agent calls `delegate` → the spawner creates a new process, sends a `start` message, optionally waits for the result.

**Files:**
- Create: `src/bus/spawner.ts`
- Test: `test/bus/spawner.test.ts`

**Step 1: Write the failing test**

```typescript
// test/bus/spawner.test.ts
import { describe, expect, test } from "bun:test";
import { AgentSpawner } from "../../src/bus/spawner.ts";

describe("AgentSpawner", () => {
  test("spawnAgent assigns a ULID handle and returns it", () => {
    const spawner = new AgentSpawner(/* bus client, socket path, etc. */);
    const handle = spawner.spawnAgent({
      agentName: "code-editor",
      genomePath: "/tmp/genome",
      sessionId: "S1",
      caller: { agent_name: "root", depth: 0 },
      goal: "Fix the bug",
      blocking: false,
      shared: false,
    });
    expect(handle).toMatch(/^[0-9A-Z]{26}$/); // ULID format
  });

  test("waitAgent returns cached result if agent already completed", async () => {
    // Spawn a mock agent that completes immediately, then call waitAgent.
    // This needs the bus server/client infrastructure from Tasks 3-4.
  });
});
```

The full test will require the bus infrastructure. Implement incrementally — start with the handle assignment and message publishing, test the full flow with the bus.

**Step 2-5: Implement, test, commit**

`AgentSpawner` owns:
- A `BusClient` reference for publishing and subscribing.
- A `Map<handleId, { process, status, result? }>` for tracking child agents.
- `spawnAgent(opts)`: assigns ULID, spawns `Bun.spawn()`, publishes `StartMessage`.
- `waitAgent(handle)`: subscribes to result topic, returns when result arrives (or returns cached).
- `messageAgent(handle, message, blocking)`: publishes `ContinueMessage` or `SteerMessage` depending on agent state.

```bash
git add src/bus/spawner.ts test/bus/spawner.test.ts
git commit -m "feat: add AgentSpawner for bus-based subprocess delegation"
```

---

### Task 10: Wire new tools into Agent's execution loop

Replace the current `executeDelegation()` call path in `Agent.run()` with the bus-based spawner. When the LLM calls `delegate`, `wait_agent`, or `message_agent`, execute via the spawner.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

```typescript
test("delegate with blocking=false returns handle immediately", async () => {
  // Set up agent with VCR cassette where LLM calls delegate(blocking=false).
  // Verify the tool result contains a handle ID, not the agent's output.
});

test("wait_agent returns the result of a previously spawned agent", async () => {
  // Set up agent with VCR cassette: delegate(blocking=false) then wait_agent(handle).
  // Verify the wait_agent tool result contains the agent's output.
});

test("message_agent sends a continue message to a completed agent", async () => {
  // Set up agent with VCR cassette: delegate(blocking=true), then message_agent(handle, "new input").
  // Verify the message_agent tool result contains the second response.
});
```

**Step 2-5: Implement, test, commit**

Key changes to `Agent`:
1. Constructor accepts an optional `AgentSpawner` (or a `BusClient` from which to create one).
2. In the tool execution section of `runLoop()`, check for `delegate`, `wait_agent`, `message_agent` tool names.
3. For `delegate`: call `spawner.spawnAgent()`. If `blocking=true`, also call `spawner.waitAgent()` and return result as tool output. If `blocking=false`, return the handle ID as tool output.
4. For `wait_agent`: call `spawner.waitAgent(handle)`.
5. For `message_agent`: call `spawner.messageAgent(handle, message, blocking)`.
6. Remove `executeDelegation()` (or keep as fallback for tests running without bus).

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: wire delegate/wait_agent/message_agent tools to bus spawner"
```

---

## Phase 6: Caller Identity

### Task 11: Inject caller identity into sub-agent system prompt

When an agent process receives a `start` message, inject a `<caller>` block into its system prompt.

**Files:**
- Modify: `src/agents/plan.ts` (add `renderCallerIdentity()`)
- Modify: `src/bus/agent-process.ts` (pass caller info to prompt builder)
- Test: `test/agents/plan.test.ts`

**Step 1: Write the failing test**

```typescript
test("renderCallerIdentity produces XML block", () => {
  const result = renderCallerIdentity({ agent_name: "root", depth: 0 });
  expect(result).toContain("<caller>");
  expect(result).toContain("Agent: root");
  expect(result).toContain("Depth: 0");
  expect(result).toContain("</caller>");
});
```

**Step 2-5: Implement, test, commit**

```bash
git add src/agents/plan.ts src/bus/agent-process.ts test/agents/plan.test.ts
git commit -m "feat: inject <caller> identity block into sub-agent system prompt"
```

---

## Phase 7: Replace EventBus with Message Bus

### Task 12: Make SessionController a bus participant

Replace the in-process `EventBus` with the WebSocket bus. The `SessionController` connects as a bus client, subscribes to agent event topics and command topics. The TUI connects as another bus client.

**Files:**
- Modify: `src/host/session-controller.ts`
- Modify: `src/host/cli.ts`
- Modify: `test/host/session-controller.test.ts`
- Possibly deprecate: `src/host/event-bus.ts`

This is a large refactoring task. Key changes:

1. `SessionController` constructor takes a `BusClient` instead of `EventBus`.
2. On `submitGoal()`: instead of calling `createAgent()` and `agent.run()`, publish a `StartMessage` to the root agent's inbox via the spawner.
3. Subscribe to `session/{id}/agent/*/events` for all agent events.
4. Subscribe to `session/{id}/commands` for TUI commands.
5. The TUI (`App.tsx`) connects its own `BusClient` and publishes commands / subscribes to events.

**This task should be broken into sub-steps during implementation.** The implementer should:
1. First make `SessionController` work with the bus while keeping the existing EventBus as a local adapter (bridge pattern).
2. Then remove the EventBus entirely once the bus is proven.
3. Update all tests.

```bash
git commit -m "refactor: replace EventBus with WebSocket message bus in session controller"
```

---

## Phase 8: Per-Handle Event Logging and Resume

### Task 13: Per-handle event logging

Each agent process writes events to `{genome_path}/logs/{session_id}/{handle_id}.jsonl`. The existing `emitAndLog()` method in Agent already writes to a log file — update the path convention to use handle IDs.

**Files:**
- Modify: `src/bus/agent-process.ts`
- Modify: `src/agents/agent.ts` (log path convention)
- Test: `test/bus/agent-process.test.ts`

**Step 1-5: Implement, test, commit**

```bash
git commit -m "feat: per-handle event logging for agent processes"
```

---

### Task 14: Agent resume from event log

Add the ability to resume an agent process that died mid-run. Replay its event log to reconstruct conversation history, spawn a new process with the same handle ID, and continue from the last complete turn.

**Files:**
- Create: `src/bus/resume.ts`
- Test: `test/bus/resume.test.ts`

**Step 1: Write the failing test**

```typescript
test("replayAgentLog reconstructs history from events", async () => {
  // Write a JSONL log with perceive, plan_end, primitive_end events.
  // Call replayAgentLog(logPath).
  // Verify it returns the correct Message[] history.
});

test("resume spawns new process with reconstructed history", async () => {
  // Write a log that ends mid-run (no session_end).
  // Call resumeAgent(handleId, ...).
  // Verify a new process is spawned and continues.
});
```

**Step 2-5: Implement, test, commit**

Reuse the existing `replayEventLog()` pattern from `src/host/resume.ts` — it already reconstructs `Message[]` from event logs. The new version operates per-handle instead of per-session.

```bash
git add src/bus/resume.ts test/bus/resume.test.ts
git commit -m "feat: add agent resume from per-handle event logs"
```

---

## Phase 9: Genome Service

### Task 15: Extract genome mutation service

A bus-connected process that serializes genome mutations. Agents publish mutation requests to `session/{id}/genome/mutations`. The service processes them one at a time, commits to git, publishes confirmations.

**Files:**
- Create: `src/bus/genome-service.ts`
- Test: `test/bus/genome-service.test.ts`

**Step 1: Write the failing test**

```typescript
test("genome service processes mutation requests serially", async () => {
  // Start a genome service on the bus.
  // Publish two mutation requests concurrently.
  // Verify they're processed one at a time (sequential git commits).
});
```

**Step 2-5: Implement, test, commit**

This is essentially the existing `LearnProcess` promoted to a bus participant. It subscribes to `genomeMutations(sessionId)`, processes each mutation, and publishes confirmations to `genomeEvents(sessionId)`.

```bash
git add src/bus/genome-service.ts test/bus/genome-service.test.ts
git commit -m "feat: add bus-connected genome mutation service"
```

---

## Phase 10: Session Host Orchestration

### Task 16: Update the session host to start the bus and spawn the root agent

The CLI entry point (`runCli()`) starts the bus server, starts the genome service, spawns the root agent process, and connects the TUI as a bus client.

**Files:**
- Modify: `src/host/cli.ts`
- Modify: `test/host/cli.test.ts`

**Step 1-5: Implement, test, commit**

This wires everything together:
1. `runCli()` for interactive/oneshot modes: start `BusServer`, start `GenomeService`, create `AgentSpawner`, spawn root agent.
2. TUI subscribes to bus events instead of EventBus.
3. Session resume reconstructs root agent's handle and sub-agent handles from logs.

```bash
git commit -m "feat: wire session host to start bus, spawn root agent process"
```

---

### Task 17: Update session resume to use per-handle logs

Extend `--resume` to reconstruct the root agent's state from its per-handle log and resume sub-agents.

**Files:**
- Modify: `src/host/cli.ts`
- Modify: `src/bus/resume.ts`
- Test: `test/host/resume.integration.test.ts`

```bash
git commit -m "feat: extend session resume to handle per-process agent logs"
```

---

## Phase 11: Cleanup

### Task 18: Remove deprecated EventBus and in-process delegation code

Once all tests pass with the bus-based architecture:
1. Delete `src/host/event-bus.ts` and `test/host/event-bus.test.ts`.
2. Remove `executeDelegation()` from `Agent` if fully replaced.
3. Remove `AgentEventEmitter` if fully replaced by bus events.
4. Update imports across codebase.

```bash
git commit -m "chore: remove deprecated EventBus and in-process delegation code"
```

---

### Task 19: Full test suite verification

Run the entire test suite and fix any regressions.

```bash
bun test
```

All tests must pass. Any failures are blockers.

```bash
git commit -m "test: fix regressions from async agent messaging migration"
```

---

## Implementation Notes

### Bun WebSocket Unix Socket Support

Bun's `Bun.serve()` supports `unix:` option for Unix domain sockets. However, Bun's WebSocket *client* (`new WebSocket()`) may not support `ws+unix://` URLs. If not:
- **Fallback**: Use `localhost` with a random port. The bus server binds to `127.0.0.1:<port>` instead of a Unix socket. Port is written to a temp file and passed to child processes via env var.
- **The bus abstraction doesn't change** — only the connection URL differs.
- Revisit Unix domain sockets when targeting remote agents (swap to WSS over TCP).

### Testing Strategy

- **Unit tests** (Tasks 1-2, 7, 11): Pure functions, no I/O.
- **Integration tests** (Tasks 3-4): Real WebSocket connections over local sockets. Use temp directories.
- **Process tests** (Tasks 8-10): Spawn real subprocesses. Use VCR cassettes for LLM calls. These are slower — mark as integration tests if needed.
- **E2E tests** (Task 16-17): Full stack with bus + agents + genome. Reuse existing e2e test patterns with VCR.

### Migration Safety

Tasks 5-6 (history promotion, continue()) are safe refactors that don't change behavior — all existing tests must continue to pass. The bus infrastructure (Tasks 1-4) is additive — no existing code changes. The dangerous part is Task 12 (replacing EventBus) — use the bridge pattern to migrate incrementally.

### Dependency Order

```
Tasks 1-2 (types, topics) — no dependencies
Task 3 (bus server) — depends on 1-2
Task 4 (bus client) — depends on 3
Tasks 5-6 (Agent refactor) — independent of 1-4
Task 7 (new tools) — independent of 1-6
Task 8 (agent process) — depends on 3, 4, 5, 6
Task 9 (spawner) — depends on 4, 8
Task 10 (wire tools) — depends on 7, 9
Task 11 (caller identity) — depends on 8
Task 12 (replace EventBus) — depends on 9, 10
Task 13 (per-handle logging) — depends on 8
Task 14 (agent resume) — depends on 13
Task 15 (genome service) — depends on 4
Task 16 (session host) — depends on 12, 15
Task 17 (session resume) — depends on 14, 16
Task 18 (cleanup) — depends on all above
Task 19 (verification) — last
```

Parallelizable: Tasks 1-2 can run in parallel. Tasks 5-6 can run in parallel with 1-4. Task 7 can run in parallel with 1-6. Task 15 can run in parallel with 8-14.

# Bus Hardening Implementation Plan

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

**Goal:** Fix all reliability, correctness, and cleanup issues found during fresh-eyes review of the async agent messaging system.

**Architecture:** Three layers of fixes: (1) add subscribe acknowledgment to the bus protocol so timing is deterministic, (2) fix functional gaps in error reporting, learn signals, and tool descriptions, (3) clean up resource leaks and edge cases. Each task is independent after Task 1, which unblocks Tasks 2-3.

**Tech Stack:** Bun, TypeScript, WebSocket, bun:test

---

## Phase 1: Bus Protocol Reliability

### Task 1: Add subscribe acknowledgment to bus protocol

The server currently processes subscribe requests silently. The client's `subscribe()` returns before the server has registered the subscription. This causes a class of timing bugs: the spawner uses `await delay(50)` hoping the subprocess has subscribed, tests use `await delay()` after every subscribe, and `waitAgent` polls with `setTimeout(check, 20)`.

Fix: after the server processes a subscribe action, it sends `{ action: "subscribed", topic }` back to that client. `BusClient.subscribe()` waits for this ack before resolving.

**Files:**
- Modify: `src/bus/server.ts:115-131`
- Modify: `src/bus/client.ts:69-85`
- Test: `test/bus/server.test.ts`, `test/bus/client.test.ts`

**Step 1: Write the failing test for server ack**

Add to `test/bus/server.test.ts`:

```typescript
test("server sends subscribed ack after subscribe", async () => {
	const ws = await connect(server.url);
	const sub = JSON.stringify({ action: "subscribe", topic: "test/ack" });
	ws.send(sub);

	const ack = await nextMessage(ws);
	expect(ack).toEqual({ action: "subscribed", topic: "test/ack" });

	ws.close();
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/bus/server.test.ts`
Expected: FAIL — server does not send ack

**Step 3: Implement server-side ack**

In `src/bus/server.ts`, update `handleSubscribe` to send an ack back to the subscribing client:

```typescript
private handleSubscribe(ws: ServerWebSocket<WSData>, msg: { topic: string }): void {
	if (typeof msg.topic !== "string") return;

	let subs = this.subscriptions.get(msg.topic);
	if (!subs) {
		subs = new Set();
		this.subscriptions.set(msg.topic, subs);
	}
	subs.add(ws);

	let topics = this.clientTopics.get(ws);
	if (!topics) {
		topics = new Set();
		this.clientTopics.set(ws, topics);
	}
	topics.add(msg.topic);

	// Acknowledge the subscription back to the client
	ws.send(JSON.stringify({ action: "subscribed", topic: msg.topic }));
}
```

Also update the `DeliveryMessage` type to be a union:

```typescript
type ServerMessage =
	| { topic: string; payload: string }
	| { action: "subscribed"; topic: string };
```

**Step 4: Run test to verify it passes**

Run: `bun test test/bus/server.test.ts`
Expected: PASS

**Step 5: Write the failing test for client awaiting ack**

Add to `test/bus/client.test.ts`:

```typescript
test("subscribe resolves only after server ack", async () => {
	const client = new BusClient(server.url);
	await client.connect();

	// subscribe() should resolve (it will once the ack arrives)
	await client.subscribe("test/ack-topic", () => {});

	// If we got here, the subscribe promise resolved after server ack.
	// Publish from another client to verify the subscription is active.
	const pub = new BusClient(server.url);
	await pub.connect();

	const received: string[] = [];
	await client.subscribe("test/ack-verify", (p) => received.push(p));

	// No delay needed — subscribe is acked
	await pub.publish("test/ack-verify", "instant");
	// Small delay for message delivery (publish is still fire-and-forget)
	await new Promise((r) => setTimeout(r, 30));
	expect(received).toEqual(["instant"]);

	await client.disconnect();
	await pub.disconnect();
});
```

**Step 6: Implement client-side ack awaiting**

In `src/bus/client.ts`, update `subscribe()` to wait for the server's ack. Also update `handleMessage` to recognize ack messages:

```typescript
/** Pending subscribe ack resolvers, keyed by topic */
private pendingAcks = new Map<string, (() => void)[]>();

async subscribe(topic: string, callback: (payload: string) => void): Promise<void> {
	this.requireConnection();

	let cbs = this.callbacks.get(topic);
	if (!cbs) {
		cbs = new Set();
		this.callbacks.set(topic, cbs);
	}

	const isFirst = cbs.size === 0;
	cbs.add(callback);

	if (isFirst) {
		this.send({ action: "subscribe", topic });
		// Wait for the server to acknowledge
		await new Promise<void>((resolve) => {
			let acks = this.pendingAcks.get(topic);
			if (!acks) {
				acks = [];
				this.pendingAcks.set(topic, acks);
			}
			acks.push(resolve);
		});
	}
}
```

Update `handleMessage` to check for ack messages:

```typescript
private handleMessage(ev: MessageEvent): void {
	let msg: Record<string, unknown>;
	try {
		msg = JSON.parse(ev.data as string);
	} catch {
		return;
	}

	// Handle subscribe acknowledgment
	if (msg.action === "subscribed" && typeof msg.topic === "string") {
		const acks = this.pendingAcks.get(msg.topic);
		if (acks) {
			const resolve = acks.shift();
			if (resolve) resolve();
			if (acks.length === 0) this.pendingAcks.delete(msg.topic);
		}
		return;
	}

	// Handle normal delivery
	if (typeof msg.topic !== "string" || typeof msg.payload !== "string") return;

	const cbs = this.callbacks.get(msg.topic);
	if (!cbs) return;

	for (const cb of cbs) {
		try {
			cb(msg.payload as string);
		} catch {
			// Don't let one callback failure prevent others from firing
		}
	}
}
```

Also clear `pendingAcks` in `disconnect()`:

```typescript
disconnect(): Promise<void> {
	return new Promise((resolve) => {
		if (!this.ws) {
			resolve();
			return;
		}
		const ws = this.ws;
		this.ws = null;
		this.callbacks.clear();
		this.pendingAcks.clear();
		// ...rest unchanged
	});
}
```

And update `waitForMessage` since it directly subscribes — it also needs to wait for ack:

```typescript
async waitForMessage(topic: string, timeoutMs = 30_000): Promise<string> {
	this.requireConnection();

	return new Promise((resolve, reject) => {
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			this.removeCallback(topic, callback);
			reject(new Error(`waitForMessage timed out after ${timeoutMs}ms on topic "${topic}"`));
		}, timeoutMs);

		const callback = (payload: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.removeCallback(topic, callback);
			resolve(payload);
		};

		let cbs = this.callbacks.get(topic);
		const isFirst = !cbs || cbs.size === 0;
		if (!cbs) {
			cbs = new Set();
			this.callbacks.set(topic, cbs);
		}
		cbs.add(callback);

		if (isFirst) {
			this.send({ action: "subscribe", topic });
			// Register an ack resolver (no-op, just need it to clear the pending ack)
			let acks = this.pendingAcks.get(topic);
			if (!acks) {
				acks = [];
				this.pendingAcks.set(topic, acks);
			}
			acks.push(() => {}); // ack arrives, subscription is live
		}
	});
}
```

**Step 7: Run all tests to verify**

Run: `bun test test/bus/`
Expected: All pass

**Step 8: Remove `delay()` calls from client tests**

In `test/bus/client.test.ts`, remove or reduce the `delay()` calls after `subscribe`. The subscribe ack means these are no longer needed. Keep a small delay after `publish` since publish is still fire-and-forget (delivery is not acked — only subscribe is).

**Step 9: Run all tests, commit**

Run: `bun test`
Expected: All 1058+ tests pass

```bash
git add src/bus/server.ts src/bus/client.ts test/bus/server.test.ts test/bus/client.test.ts
git commit -m "feat: add subscribe acknowledgment to bus protocol"
```

---

### Task 2: Replace startup delay with ready handshake in spawner

The spawner uses `await delay(50)` hoping the subprocess has connected and subscribed. Replace with a ready handshake: the agent process publishes an `agent_ready` message after subscribing to its inbox, and the spawner waits for it before sending the start message.

**Depends on:** Task 1 (subscribe ack ensures the ready topic subscription is live before the agent publishes)

**Files:**
- Modify: `src/bus/spawner.ts:90-149`
- Modify: `src/bus/agent-process.ts:48-67`
- Modify: `src/bus/topics.ts` (add ready topic builder)
- Test: `test/bus/spawner.test.ts`, `test/bus/agent-process.test.ts`

**Step 1: Add the `agentReady` topic builder**

In `src/bus/topics.ts`, add:

```typescript
export function agentReady(sessionId: string, handleId: string): string {
	return `session/${sessionId}/agent/${handleId}/ready`;
}
```

Update the `AGENT_RE` regex to include `ready`:

```typescript
const AGENT_RE = /^session\/([^/]+)\/agent\/([^/]+)\/(inbox|events|result|ready)$/;
```

**Step 2: Write the failing test**

Add to `test/bus/topics.test.ts`:

```typescript
test("agentReady builds correct topic", () => {
	expect(agentReady("s1", "h1")).toBe("session/s1/agent/h1/ready");
});
```

And a parser test:

```typescript
test("parses agentReady topic", () => {
	const parsed = parseTopic("session/s1/agent/h1/ready");
	expect(parsed).toEqual({ session_id: "s1", handle_id: "h1", channel: "ready" });
});
```

**Step 3: Run, verify fail, implement, verify pass, commit topics change**

Run: `bun test test/bus/topics.test.ts`

```bash
git add src/bus/topics.ts test/bus/topics.test.ts
git commit -m "feat: add agentReady topic builder"
```

**Step 4: Update agent-process to publish ready signal**

In `src/bus/agent-process.ts`, after the bus connects and subscribes to the inbox, publish a ready message:

```typescript
export async function runAgentProcess(config: AgentProcessConfig): Promise<void> {
	const { busUrl, handleId, sessionId, genomePath, client, workDir, signal } = config;

	const bus = new BusClient(busUrl);
	await bus.connect();

	const inboxTopic = agentInbox(sessionId, handleId);
	const eventsTopic = agentEvents(sessionId, handleId);
	const resultTopic = agentResult(sessionId, handleId);
	const readyTopic = agentReady(sessionId, handleId);

	try {
		// Subscribe to inbox first, then signal ready
		// waitForStart registers the inbox callback
		const startPromise = waitForStart(bus, inboxTopic, signal);

		// Tell the spawner we're subscribed and ready
		await bus.publish(readyTopic, JSON.stringify({ kind: "ready", handle_id: handleId }));

		const startPayload = await startPromise;
		// ...rest unchanged
```

Import `agentReady` from topics.

**Step 5: Update spawner to wait for ready signal instead of delay**

In `src/bus/spawner.ts`, replace:

```typescript
// Wait for the subprocess to connect to the bus
await delay(50);
```

With:

```typescript
// Wait for the agent process to signal it's ready (subscribed to inbox)
const readyTopic = agentReady(this.sessionId, handleId);
await this.bus.waitForMessage(readyTopic, 10_000);
```

Import `agentReady` from topics. Remove the unused `delay` function at the bottom of the file.

**Step 6: Write a test for the ready handshake**

Add to `test/bus/spawner.test.ts`:

```typescript
test("spawner waits for agent ready signal before sending start", async () => {
	const requests: Request[] = [];
	const mockClient = {
		complete: async (request: Request): Promise<Response> => {
			requests.push(request);
			return {
				id: "mock-1",
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant("Done."),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
			};
		},
		stream: async function* () {},
		providers: () => ["anthropic"],
	} as unknown as Client;

	spawner = new AgentSpawner(bus, server.url, SESSION_ID, createInProcessSpawnFn(mockClient));

	const result = await spawner.spawnAgent({
		agentName: "test-leaf",
		genomePath: genomeDir,
		caller: { agent_name: "root", depth: 0 },
		goal: "Test ready handshake",
		blocking: true,
		shared: false,
		workDir: tempDir,
	});

	// If we got here, the handshake worked — agent received start and responded
	expect((result as ResultMessage).success).toBe(true);
}, 15_000);
```

**Step 7: Run all tests, commit**

Run: `bun test`

```bash
git add src/bus/spawner.ts src/bus/agent-process.ts src/bus/topics.ts test/bus/spawner.test.ts test/bus/agent-process.test.ts test/bus/topics.test.ts
git commit -m "feat: replace startup delay with ready handshake in spawner"
```

---

### Task 3: Replace polling with event-driven resolution in waitAgent

`waitAgent` polls every 20ms. Replace with a resolver stored on the handle.

**Files:**
- Modify: `src/bus/spawner.ts:156-182`
- Modify: `src/bus/spawner.ts:104-124` (result subscription)
- Test: `test/bus/spawner.test.ts`

**Step 1: Add a `resultResolvers` array to AgentHandle**

In `src/bus/spawner.ts`, add to the `AgentHandle` interface:

```typescript
export interface AgentHandle {
	handleId: string;
	process: { kill: () => void; exited: Promise<number> };
	status: "running" | "idle" | "completed";
	result?: ResultMessage;
	shared: boolean;
	/** Pending resolvers waiting for the next result */
	resultResolvers: Array<(result: ResultMessage) => void>;
}
```

**Step 2: Update result subscription to call resolvers**

In `spawnAgent`, when the result arrives, resolve all pending waiters:

```typescript
await this.bus.subscribe(resultTopic, (payload) => {
	try {
		const msg = parseBusMessage(payload);
		if (msg.kind === "result") {
			handle.result = msg;
			handle.status = opts.shared ? "idle" : "completed";
			// Resolve all pending waiters
			for (const resolve of handle.resultResolvers) {
				resolve(msg);
			}
			handle.resultResolvers = [];
		}
	} catch {
		// Ignore malformed messages
	}
});
```

And initialize `resultResolvers: []` in the handle creation.

**Step 3: Rewrite waitAgent to use resolver**

```typescript
waitAgent(handleId: string): Promise<ResultMessage> {
	const handle = this.handles.get(handleId);
	if (!handle) {
		throw new Error(`Unknown handle: ${handleId}`);
	}

	if (handle.result) {
		return Promise.resolve(handle.result);
	}

	return new Promise<ResultMessage>((resolve, reject) => {
		const timeout = setTimeout(() => {
			// Remove this resolver from the list
			const idx = handle.resultResolvers.indexOf(resolver);
			if (idx !== -1) handle.resultResolvers.splice(idx, 1);
			reject(new Error(`waitAgent timed out for handle ${handleId}`));
		}, 30_000);

		const resolver = (result: ResultMessage) => {
			clearTimeout(timeout);
			resolve(result);
		};
		handle.resultResolvers.push(resolver);
	});
}
```

**Step 4: Update messageAgent to clear cached result and reset resolvers**

In `messageAgent`, where it currently does `handle.result = undefined`, that stays. The resolver pattern handles the wait correctly since `waitAgent` checks `handle.result` first.

**Step 5: Run all tests, commit**

Run: `bun test`
Expected: All pass (existing spawner tests cover wait behavior)

```bash
git add src/bus/spawner.ts
git commit -m "refactor: replace polling with event-driven resolution in waitAgent"
```

---

## Phase 2: Functional Correctness

### Task 4: Add learn signals to spawner delegation path

The in-process `executeDelegation()` calls `verifyActResult()` and pushes learn signals. The spawner path does not, so nobody learns from bus-spawned delegations.

**Files:**
- Modify: `src/agents/agent.ts:379-449`
- Test: `test/agents/agent.test.ts`

**Step 1: Write the failing test**

Add to `test/agents/agent.test.ts`, in the spawner tests section:

```typescript
test("spawner delegation generates learn signal on failure", async () => {
	const learnSignals: any[] = [];
	const mockLearnProcess = {
		push: (signal: any) => learnSignals.push(signal),
		recordAction: () => {},
		startBackground: () => {},
		stopBackground: async () => {},
	};

	const mockSpawner = {
		spawnAgent: async () => ({
			kind: "result" as const,
			handle_id: "test-handle",
			output: "failed to complete task",
			success: false,
			stumbles: 2,
			turns: 5,
			timed_out: false,
		}),
	} as unknown as AgentSpawner;

	// Create agent with spawner and learnProcess, can_learn: true on spec
	const spec = {
		...rootSpec,
		constraints: { ...rootSpec.constraints, can_learn: true },
	};

	const agent = new Agent({
		spec,
		env,
		client: mockClient, // returns delegate tool call
		primitiveRegistry: registry,
		availableAgents: [leafSpec],
		spawner: mockSpawner,
		genomePath: "/tmp/test",
		learnProcess: mockLearnProcess as any,
		sessionId: "test-session",
	});

	await agent.run("delegate to leaf");

	expect(learnSignals.length).toBeGreaterThan(0);
	expect(learnSignals[0].kind).toBe("failure");
	expect(learnSignals[0].agent_name).toBe("leaf");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/agent.test.ts -t "spawner delegation generates learn signal"`
Expected: FAIL — `learnSignals` is empty

**Step 3: Add verifyActResult to executeSpawnerDelegation**

In `src/agents/agent.ts`, after the blocking result is received in `executeSpawnerDelegation`, add verify and learn signal logic (mirroring the in-process path):

```typescript
// Blocking: result is a ResultMessage
const resultMsg = result as ResultMessage;

// Verify and generate learn signals (parity with in-process delegation)
const actResult: ActResult = {
	agent_name: delegation.agent_name,
	goal: delegation.goal,
	output: resultMsg.output,
	success: resultMsg.success,
	stumbles: resultMsg.stumbles,
	turns: resultMsg.turns,
	timed_out: resultMsg.timed_out,
};

const { verify, learnSignal } = verifyActResult(actResult, this.sessionId);

this.emitAndLog("verify", agentId, this.depth, {
	agent_name: delegation.agent_name,
	success: verify.success,
	stumbled: verify.stumbled,
});

if (learnSignal) {
	this.emitAndLog("learn_signal", agentId, this.depth, {
		signal: learnSignal,
	});
	if (this.learnProcess && this.spec.constraints.can_learn) {
		this.learnProcess.push(learnSignal);
	}
}

if (this.learnProcess) {
	this.learnProcess.recordAction(agentId);
}

const content = truncateToolOutput(resultMsg.output, delegation.agent_name);
// ...rest unchanged
```

Import `ActResult` from `../kernel/types.ts` if not already imported. `verifyActResult` is already imported.

Update the JSDoc comment to reflect the change:

```typescript
/**
 * Execute a delegation via the bus-based spawner. Returns the tool result message and stumble count.
 *
 * For blocking spawns, calls verifyActResult() and pushes learn signals
 * just like the in-process executeDelegation() path.
 * For non-blocking spawns, learn signals are deferred until waitAgent returns the result.
 */
```

**Step 4: Run tests, commit**

Run: `bun test`

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: add learn signals to spawner delegation path"
```

---

### Task 5: Fix `shared` tool description

The delegate tool says shared means "reuse an existing agent instance." It actually means "keep alive after completion for follow-up messages."

**Files:**
- Modify: `src/agents/plan.ts:46-50`
- Test: `test/agents/plan.test.ts`

**Step 1: Write the failing test**

Add to `test/agents/plan.test.ts`:

```typescript
test("delegate tool shared parameter describes keep-alive behavior", () => {
	const tool = buildDelegateTool(["leaf"]);
	const sharedDesc = (tool.parameters as any).properties.shared.description;
	expect(sharedDesc).toContain("stays alive");
	expect(sharedDesc).not.toContain("reuse");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/plan.test.ts -t "shared parameter"`
Expected: FAIL — current description contains "reuse"

**Step 3: Fix the description**

In `src/agents/plan.ts`:

```typescript
shared: {
	type: "boolean",
	description:
		"If true, the agent stays alive after completion and can receive follow-up messages via message_agent. Default: false",
},
```

**Step 4: Run tests, commit**

Run: `bun test`

```bash
git add src/agents/plan.ts test/agents/plan.test.ts
git commit -m "fix: correct shared parameter description in delegate tool"
```

---

### Task 6: Publish error results from idleLoop catch block

When `agent.continue()` throws in the idle loop, the error is silently swallowed. The parent's `waitAgent` times out with no useful information.

**Files:**
- Modify: `src/bus/agent-process.ts:229-259`
- Test: `test/bus/agent-process.test.ts`

**Step 1: Write the failing test**

Add to `test/bus/agent-process.test.ts`:

```typescript
test("continue failure publishes error result", async () => {
	let callCount = 0;
	const mockClient = {
		complete: async (): Promise<Response> => {
			callCount++;
			if (callCount === 1) {
				// First call succeeds (initial run)
				return {
					id: "mock-1",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("First done."),
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
				};
			}
			// Second call (continue) throws
			throw new Error("LLM exploded");
		},
		stream: async function* () {},
		providers: () => ["anthropic"],
	} as unknown as Client;

	// Start the agent process with shared=true
	// Send a continue message after initial completion
	// Verify that an error result is published (not silently swallowed)

	// ...setup bus, genome, run agent process, subscribe to result topic
	// ...send start with shared=true, wait for first result
	// ...send continue, wait for error result
	// ...assert result.success === false and result.output contains "LLM exploded"
}, 15_000);
```

(The test needs full bus/genome setup similar to existing agent-process tests. Use the existing test patterns in that file.)

**Step 2: Fix the idleLoop catch block**

In `src/bus/agent-process.ts`, replace:

```typescript
} catch {
	processing = false;
}
```

With:

```typescript
} catch (err) {
	const errorResult: ResultMessage = {
		kind: "result",
		handle_id: handleId,
		output: `Continue failed: ${err instanceof Error ? err.message : String(err)}`,
		success: false,
		stumbles: 0,
		turns: 0,
		timed_out: false,
	};
	await bus.publish(resultTopic, JSON.stringify(errorResult));
	processing = false;
}
```

**Step 3: Run tests, commit**

Run: `bun test`

```bash
git add src/bus/agent-process.ts test/bus/agent-process.test.ts
git commit -m "fix: publish error result when continue fails in idle loop"
```

---

### Task 7: Clean up waitForStart subscription after start received

The `waitForStart` function subscribes to the inbox but never unsubscribes. After start is received, the callback remains registered, firing on every subsequent inbox message.

**Files:**
- Modify: `src/bus/agent-process.ts:166-200`
- Test: `test/bus/agent-process.test.ts`

**Step 1: Fix waitForStart to unsubscribe after receiving start**

Refactor `waitForStart` to track the callback and unsubscribe when done:

```typescript
function waitForStart(
	bus: BusClient,
	inboxTopic: string,
	signal?: AbortSignal,
): Promise<string | null> {
	if (signal?.aborted) return Promise.resolve(null);

	return new Promise((resolve) => {
		let settled = false;

		const onAbort = () => {
			if (settled) return;
			settled = true;
			bus.unsubscribe(inboxTopic);
			resolve(null);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		bus.subscribe(inboxTopic, (payload) => {
			if (settled) return;
			try {
				const msg = parseBusMessage(payload);
				if (msg.kind === "start") {
					settled = true;
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve(payload);
				}
			} catch {
				// Ignore malformed messages
			}
		});
	});
}
```

Wait — `bus.unsubscribe()` removes ALL callbacks for the topic, and the `idleLoop` also subscribes to the same inbox topic. We need to be more careful.

Better approach: don't unsubscribe from the topic (since `idleLoop` needs it). Instead, use a flag so the `waitForStart` callback becomes a no-op after start is received. The current code already does this with the `settled` flag. The callback stays registered but short-circuits via `if (settled) return`.

The real cleanup issue is actually minor — the callback is a closure that returns early after `settled = true`. The cost is one extra JSON.parse per inbox message. This is acceptable. Document why with a comment:

```typescript
// Note: The callback remains registered on the inbox topic but short-circuits
// via the `settled` flag. We don't unsubscribe because the idleLoop (for shared
// agents) will subscribe to the same topic and we'd remove its callback too.
```

This is a documentation-only fix. No code change needed beyond the comment.

**Step 2: Run tests, commit**

Run: `bun test`

```bash
git add src/bus/agent-process.ts
git commit -m "docs: document waitForStart callback lifecycle in agent-process"
```

---

### Task 8: Add timeout to GenomeMutationService stop() drain loop

The drain loop in `stop()` spins forever if `processing` gets stuck true.

**Files:**
- Modify: `src/bus/genome-service.ts:101-111`
- Test: `test/bus/genome-service.test.ts`

**Step 1: Write the failing test**

Add to `test/bus/genome-service.test.ts`:

```typescript
test("stop resolves within timeout even if processing is stuck", async () => {
	// Create a service, start it, then call stop — should not hang
	// This is a safety test: stop() must return within 5 seconds
	const service = new GenomeMutationService({ bus, genome, sessionId: SESSION_ID });
	await service.start();

	const stopPromise = service.stop();
	const timeout = new Promise<string>((resolve) =>
		setTimeout(() => resolve("timed_out"), 6_000),
	);

	const winner = await Promise.race([
		stopPromise.then(() => "stopped"),
		timeout,
	]);
	expect(winner).toBe("stopped");
}, 10_000);
```

**Step 2: Add timeout to the drain loop**

In `src/bus/genome-service.ts`:

```typescript
async stop(): Promise<void> {
	if (!this.started) return;
	this.started = false;

	await this.bus.unsubscribe(genomeMutations(this.sessionId));

	// Drain remaining items with a safety timeout
	const deadline = Date.now() + 5_000;
	while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
```

**Step 3: Run tests, commit**

Run: `bun test`

```bash
git add src/bus/genome-service.ts test/bus/genome-service.test.ts
git commit -m "fix: add timeout to GenomeMutationService stop() drain loop"
```

---

## Phase 3: Resource and State Fixes

### Task 9: Pass genome instance through to avoid dual-Genome

`startBusInfrastructure` creates a `Genome` for the `GenomeMutationService`, then `createAgent` creates another. Mutations to one are invisible to the other.

Fix: accept an optional `Genome` instance in `startBusInfrastructure`. If not provided, create one. Return it so the caller can pass it to `createAgent`. Update `createAgent` to accept an optional pre-loaded `Genome`.

**Files:**
- Modify: `src/host/cli.ts:20-68`
- Modify: `src/agents/factory.ts`
- Test: `test/host/cli.test.ts`

**Step 1: Update startBusInfrastructure to return genome**

In `src/host/cli.ts`, change `BusInfrastructure` to include the genome:

```typescript
interface BusInfrastructure {
	server: import("../bus/server.ts").BusServer;
	bus: import("../bus/client.ts").BusClient;
	spawner: import("../bus/spawner.ts").AgentSpawner;
	genome: import("../genome/genome.ts").Genome;
	cleanup: () => Promise<void>;
}
```

Return the genome from `startBusInfrastructure`.

**Step 2: Update createAgent to accept optional genome**

In `src/agents/factory.ts`, add `genome?: Genome` to `CreateAgentOptions`. If provided, skip the `new Genome()` + `loadFromDisk()`:

```typescript
const genome = options.genome ?? new Genome(options.genomePath);
if (!options.genome) {
	try {
		await genome.loadFromDisk();
	} catch {
		await genome.init();
	}
}
```

**Step 3: Thread the genome through CLI → SessionController → factory**

In `cli.ts`, pass `infra.genome` through the session controller options. Add `genome?` to `SessionControllerOptions` and `AgentFactoryOptions`. Thread it down to `createAgent`.

**Step 4: Write a test**

Add to `test/host/cli.test.ts`:

```typescript
test("startBusInfrastructure returns a genome instance", async () => {
	const infra = await startBusInfrastructure({
		genomePath: genomeDir,
		sessionId: "test-genome-passthrough",
	});
	expect(infra.genome).toBeDefined();
	await infra.cleanup();
});
```

**Step 5: Run tests, commit**

Run: `bun test`

```bash
git add src/host/cli.ts src/agents/factory.ts src/host/session-controller.ts test/host/cli.test.ts
git commit -m "fix: share single Genome instance between mutation service and agent"
```

---

### Task 10: Guard BusClient.send() against closed WebSocket

There's a TOCTOU window between `requireConnection()` and `send()` where the WebSocket can close.

**Files:**
- Modify: `src/bus/client.ts:160-162`
- Test: `test/bus/client.test.ts`

**Step 1: Write the failing test**

```typescript
test("send after WebSocket closes throws a clear error", async () => {
	const client = new BusClient(server.url);
	await client.connect();

	// Force-close the underlying connection
	// @ts-expect-error -- accessing private field for test
	client.ws!.close();

	// Wait for the close to propagate
	await new Promise((r) => setTimeout(r, 50));

	expect(() => client.publish("test/topic", "hello")).toThrow(/not connected/i);
});
```

**Step 2: Update send() to check readyState**

```typescript
private send(msg: ClientAction): void {
	if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
		throw new Error("BusClient is not connected");
	}
	this.ws.send(JSON.stringify(msg));
}
```

**Step 3: Run tests, commit**

Run: `bun test`

```bash
git add src/bus/client.ts test/bus/client.test.ts
git commit -m "fix: guard BusClient.send() against closed WebSocket"
```

---

### Task 11: Remove delay-based synchronization from tests

After Task 1 (subscribe ack), most `delay()` calls in tests are unnecessary. Replace them with the ack-based flow. Keep small delays only after `publish()` (since publish delivery is not acked).

**Files:**
- Modify: `test/bus/client.test.ts`
- Modify: `test/bus/spawner.test.ts`

**Step 1: Audit and remove unnecessary delays**

In `test/bus/client.test.ts`: The `delay()` calls after `subscribe` can be removed. The `delay()` calls after `publish` should use a smaller value or be replaced with `waitForMessage` where possible.

In `test/bus/spawner.test.ts`: The `delay(50)` and `delay(100)` and `delay(200)` calls for waiting on agent startup are no longer needed — the spawner now waits for the ready handshake. Remove where possible, reduce where timing is for other reasons (e.g., waiting for agent to enter "running" state).

**Step 2: Run tests repeatedly to check for flakiness**

Run: `for i in $(seq 1 5); do bun test test/bus/ 2>&1 | tail -3; done`

**Step 3: Commit**

```bash
git add test/bus/client.test.ts test/bus/spawner.test.ts
git commit -m "test: remove delay-based synchronization, use subscribe ack"
```

---

## Dependency Order

```
Task 1 (subscribe ack) — no dependencies
Task 2 (ready handshake) — depends on Task 1
Task 3 (event-driven waitAgent) — independent of Tasks 1-2
Task 4 (learn signals) — independent
Task 5 (shared description) — independent
Task 6 (idleLoop error publishing) — independent
Task 7 (waitForStart docs) — independent
Task 8 (stop timeout) — independent
Task 9 (genome passthrough) — independent
Task 10 (send guard) — independent
Task 11 (remove delays) — depends on Task 1
```

Parallelizable: Tasks 3-10 can all run in parallel. Task 11 runs after Task 1.

---

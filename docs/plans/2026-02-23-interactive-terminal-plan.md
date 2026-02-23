# Interactive Terminal Experience — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Sprout from a one-shot CLI into a full interactive terminal experience with resume, steering, interrupt, context-aware compaction, and a rich Ink-based TUI.

**Architecture:** Event bus (two channels: agent events up, commands down) with Session Controller managing agent lifecycle. Ink React components render the TUI. Both interactive and one-shot modes share the same Session Controller — only the subscriber differs.

**Tech Stack:** TypeScript on Bun, Ink (React for CLIs), ULID for session IDs

**Design doc:** `docs/plans/2026-02-23-interactive-terminal-design.md`

---

### Task 1: Project Setup — Dependencies and JSX Config

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `biome.json` (if exists, for JSX support)

**Step 1: Install dependencies**

Run:
```bash
cd /Users/jesse/prime-radiant/sprout
bun add ink react
bun add -d @types/react
```

**Step 2: Configure TSX support in tsconfig.json**

Add `"jsx": "react-jsx"` to compilerOptions in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ESNext"],
    ...
  }
}
```

**Step 3: Verify typecheck still passes**

Run: `bun run typecheck`
Expected: No errors

**Step 4: Verify all existing tests still pass**

Run: `bun test`
Expected: 362 tests pass

**Step 5: Commit**

```bash
git add package.json tsconfig.json bun.lockb
git commit -m "chore: add ink, react dependencies and JSX config"
```

---

### Task 2: ULID Utility

**Files:**
- Create: `src/util/ulid.ts`
- Create: `test/util/ulid.test.ts`

ULIDs are time-sortable unique IDs. We hand-roll a minimal implementation (~30 lines) to avoid a dependency.

**Step 1: Write the failing test**

Create `test/util/ulid.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { ulid } from "../../src/util/ulid.ts";

describe("ulid", () => {
	test("returns a 26-character string", () => {
		const id = ulid();
		expect(id).toHaveLength(26);
	});

	test("uses only Crockford Base32 characters", () => {
		const id = ulid();
		expect(id).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
	});

	test("is monotonically increasing", () => {
		const ids = Array.from({ length: 100 }, () => ulid());
		const sorted = [...ids].sort();
		expect(ids).toEqual(sorted);
	});

	test("two ULIDs generated at the same ms are different", () => {
		const a = ulid();
		const b = ulid();
		expect(a).not.toBe(b);
	});

	test("encodes timestamp in first 10 characters", () => {
		const before = Date.now();
		const id = ulid();
		const after = Date.now();

		// Decode first 10 chars as timestamp
		const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
		let ts = 0;
		for (let i = 0; i < 10; i++) {
			ts = ts * 32 + ENCODING.indexOf(id[i]!);
		}
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/util/ulid.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ULID**

Create `src/util/ulid.ts`:

```typescript
/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 * 26 characters: 10 for timestamp (ms), 16 random. Crockford Base32.
 * Monotonic within the same millisecond (increments random component).
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: number[] = [];

function encodeTime(now: number, len: number): string {
	let str = "";
	let t = now;
	for (let i = len; i > 0; i--) {
		str = ENCODING[t % 32]! + str;
		t = Math.floor(t / 32);
	}
	return str;
}

function randomChars(len: number): number[] {
	const chars: number[] = [];
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	for (let i = 0; i < len; i++) {
		chars.push(bytes[i]! % 32);
	}
	return chars;
}

export function ulid(): string {
	const now = Date.now();

	if (now === lastTime) {
		// Increment random component for monotonicity
		let i = lastRandom.length - 1;
		while (i >= 0 && lastRandom[i] === 31) {
			lastRandom[i] = 0;
			i--;
		}
		if (i >= 0) {
			lastRandom[i]!++;
		}
	} else {
		lastTime = now;
		lastRandom = randomChars(16);
	}

	return encodeTime(now, 10) + lastRandom.map((c) => ENCODING[c]!).join("");
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/util/ulid.test.ts`
Expected: 5 tests pass

**Step 5: Commit**

```bash
git add src/util/ulid.ts test/util/ulid.test.ts
git commit -m "feat: add ULID utility for time-sortable session IDs"
```

---

### Task 3: Event Bus

**Files:**
- Create: `src/host/event-bus.ts`
- Create: `test/host/event-bus.test.ts`
- Modify: `src/kernel/types.ts` (add new event kinds and Command type)

The event bus has two channels: agent events (up) and commands (down). It wraps `AgentEventEmitter`'s interface so Agent doesn't need to change.

**Step 1: Add new types to `src/kernel/types.ts`**

Add these new event kinds to the `EventKind` union (at the end, before the semicolon):

```typescript
| "session_resume"
| "context_update"
| "compaction"
| "interrupted"
```

Add the `Command` type after `SessionEvent`:

```typescript
/** Command kinds that flow down from frontends to the session controller */
export type CommandKind =
	| "submit_goal"
	| "steer"
	| "interrupt"
	| "compact"
	| "clear"
	| "switch_model"
	| "quit";

/** A command published by a frontend (TUI, API, test harness) */
export interface Command {
	kind: CommandKind;
	data: Record<string, unknown>;
}
```

**Step 2: Write the failing test**

Create `test/host/event-bus.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { EventBus } from "../../src/host/event-bus.ts";
import type { Command, SessionEvent } from "../../src/kernel/types.ts";

describe("EventBus", () => {
	describe("agent events (up channel)", () => {
		test("emits events to subscribers", () => {
			const bus = new EventBus();
			const received: SessionEvent[] = [];
			bus.onEvent((e) => received.push(e));

			bus.emitEvent("session_start", "root", 0, { goal: "test" });

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("session_start");
			expect(received[0]!.data.goal).toBe("test");
		});

		test("supports multiple subscribers", () => {
			const bus = new EventBus();
			let count1 = 0;
			let count2 = 0;
			bus.onEvent(() => count1++);
			bus.onEvent(() => count2++);

			bus.emitEvent("session_start", "root", 0);

			expect(count1).toBe(1);
			expect(count2).toBe(1);
		});

		test("unsubscribe stops delivery", () => {
			const bus = new EventBus();
			let count = 0;
			const unsub = bus.onEvent(() => count++);

			bus.emitEvent("session_start", "root", 0);
			unsub();
			bus.emitEvent("session_end", "root", 0);

			expect(count).toBe(1);
		});

		test("collected() returns all emitted events", () => {
			const bus = new EventBus();
			bus.emitEvent("session_start", "root", 0);
			bus.emitEvent("plan_start", "root", 0, { turn: 1 });

			const events = bus.collected();
			expect(events).toHaveLength(2);
			expect(events[0]!.kind).toBe("session_start");
			expect(events[1]!.kind).toBe("plan_start");
		});
	});

	describe("commands (down channel)", () => {
		test("delivers commands to subscribers", () => {
			const bus = new EventBus();
			const received: Command[] = [];
			bus.onCommand((c) => received.push(c));

			bus.emitCommand({ kind: "steer", data: { text: "try a different approach" } });

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("steer");
			expect(received[0]!.data.text).toBe("try a different approach");
		});

		test("supports multiple command subscribers", () => {
			const bus = new EventBus();
			let count1 = 0;
			let count2 = 0;
			bus.onCommand(() => count1++);
			bus.onCommand(() => count2++);

			bus.emitCommand({ kind: "interrupt", data: {} });

			expect(count1).toBe(1);
			expect(count2).toBe(1);
		});

		test("unsubscribe stops command delivery", () => {
			const bus = new EventBus();
			let count = 0;
			const unsub = bus.onCommand(() => count++);

			bus.emitCommand({ kind: "interrupt", data: {} });
			unsub();
			bus.emitCommand({ kind: "quit", data: {} });

			expect(count).toBe(1);
		});
	});

	describe("compatibility with AgentEventEmitter interface", () => {
		test("emit() method matches AgentEventEmitter signature", () => {
			const bus = new EventBus();
			const received: SessionEvent[] = [];
			bus.on((e) => received.push(e));

			// Agent calls: this.events.emit(kind, agentId, depth, data)
			bus.emit("plan_end", "root", 0, { turn: 1, text: "hello" });

			expect(received).toHaveLength(1);
			expect(received[0]!.kind).toBe("plan_end");
		});

		test("on() returns unsubscribe function", () => {
			const bus = new EventBus();
			let count = 0;
			const unsub = bus.on(() => count++);

			bus.emit("session_start", "root", 0);
			unsub();
			bus.emit("session_end", "root", 0);

			expect(count).toBe(1);
		});
	});
});
```

**Step 3: Run test to verify it fails**

Run: `bun test test/host/event-bus.test.ts`
Expected: FAIL — module not found

**Step 4: Implement EventBus**

Create `src/host/event-bus.ts`:

```typescript
import type { Command, EventKind, SessionEvent } from "../kernel/types.ts";

export type EventListener = (event: SessionEvent) => void;
export type CommandListener = (command: Command) => void;

/**
 * Two-channel event bus.
 *
 * Agent events (up): emitted by agents, consumed by TUI/logger/web bridge.
 * Commands (down): emitted by frontends, consumed by session controller.
 *
 * Compatible with AgentEventEmitter interface so Agent doesn't need to change.
 */
export class EventBus {
	private eventListeners: EventListener[] = [];
	private commandListeners: CommandListener[] = [];
	private events: SessionEvent[] = [];

	// --- Agent events (up channel) ---

	/** Subscribe to agent events. Returns unsubscribe function. */
	onEvent(listener: EventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	/** Emit an agent event to all subscribers. */
	emitEvent(kind: EventKind, agentId: string, depth: number, data: Record<string, unknown> = {}): void {
		const event: SessionEvent = {
			kind,
			timestamp: Date.now(),
			agent_id: agentId,
			depth,
			data,
		};
		this.events.push(event);
		for (const listener of this.eventListeners) {
			listener(event);
		}
	}

	// --- Commands (down channel) ---

	/** Subscribe to commands. Returns unsubscribe function. */
	onCommand(listener: CommandListener): () => void {
		this.commandListeners.push(listener);
		return () => {
			const idx = this.commandListeners.indexOf(listener);
			if (idx >= 0) this.commandListeners.splice(idx, 1);
		};
	}

	/** Emit a command to all subscribers. */
	emitCommand(command: Command): void {
		for (const listener of this.commandListeners) {
			listener(command);
		}
	}

	// --- AgentEventEmitter compatibility ---
	// Agent calls: this.events.emit(kind, agentId, depth, data)
	// Agent calls: this.events.on(listener)

	/** Alias for onEvent — matches AgentEventEmitter.on() signature. */
	on(listener: EventListener): () => void {
		return this.onEvent(listener);
	}

	/** Alias for emitEvent — matches AgentEventEmitter.emit() signature. */
	emit(kind: EventKind, agentId: string, depth: number, data: Record<string, unknown> = {}): void {
		this.emitEvent(kind, agentId, depth, data);
	}

	/** Return all collected events. */
	collected(): SessionEvent[] {
		return [...this.events];
	}
}
```

**Step 5: Run test to verify it passes**

Run: `bun test test/host/event-bus.test.ts`
Expected: All tests pass

**Step 6: Run full test suite**

Run: `bun test`
Expected: All tests pass (existing tests use `AgentEventEmitter` — both can coexist)

**Step 7: Commit**

```bash
git add src/kernel/types.ts src/host/event-bus.ts test/host/event-bus.test.ts
git commit -m "feat: add two-channel EventBus for agent events and commands"
```

---

### Task 4: Agent — Steering Queue and AbortSignal

**Files:**
- Modify: `src/agents/agent.ts`
- Create: `test/agents/steering.test.ts`

Add `steer()` method for live input injection and `AbortSignal` support for interrupt.

**Step 1: Write the failing tests**

Create `test/agents/steering.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { tmpdir } from "node:os";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";
import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

// Minimal leaf agent spec for testing
const leafSpec: AgentSpec = {
	name: "test-leaf",
	description: "Test agent",
	system_prompt: "You are a test agent. Reply with exactly 'DONE' and nothing else.",
	model: "best",
	capabilities: ["exec"],
	constraints: {
		max_turns: 5,
		max_depth: 0,
		timeout_ms: 30000,
		can_spawn: false,
		can_learn: false,
	},
	tags: [],
	version: 1,
};

describe("Agent steering", () => {
	test("steer() queues messages that are drained before next plan", async () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const events = new AgentEventEmitter();

		const agent = new Agent({
			spec: {
				...leafSpec,
				system_prompt:
					"You are a test agent. When you receive a steering message, acknowledge it and say DONE. Do not use any tools.",
			},
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
			events,
		});

		// Steer before run — should be picked up on first iteration
		agent.steer("Please acknowledge: STEERING_TEST_123");

		const result = await agent.run("Say hello");
		expect(result.output).toContain("STEERING_TEST_123");
	}, 30000);

	test("drainSteering returns empty array when no messages queued", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);

		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
		});

		// Access via type assertion since drainSteering is private
		// We test indirectly: steer nothing, run should work normally
		expect(agent.steer).toBeFunction();
	});
});

describe("Agent abort signal", () => {
	test("run() accepts AbortSignal and stops when aborted", async () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const events = new AgentEventEmitter();

		const agent = new Agent({
			spec: {
				...leafSpec,
				system_prompt:
					"You are a test agent. Use the exec tool to run 'echo step1', then 'echo step2', then 'echo step3'. Do all three steps.",
				constraints: { ...leafSpec.constraints, max_turns: 20 },
			},
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [],
			events,
		});

		const controller = new AbortController();

		// Abort after first event
		let eventCount = 0;
		events.on(() => {
			eventCount++;
			if (eventCount >= 3) {
				controller.abort();
			}
		});

		const result = await agent.run("Do all steps", controller.signal);
		// Should have been interrupted, not completed all steps
		expect(result.timed_out || result.turns < 20).toBe(true);

		// Should have an interrupted event
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "interrupted")).toBe(true);
	}, 30000);
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/steering.test.ts`
Expected: FAIL — `agent.steer is not a function` and `agent.run` doesn't accept AbortSignal

**Step 3: Implement steering and abort on Agent**

Modify `src/agents/agent.ts`:

1. Add a `steeringQueue` field and `steer()` method:

```typescript
// In the Agent class, add after the existing fields:
private steeringQueue: string[] = [];

/** Queue a steering message to be injected before the next plan phase. */
steer(text: string): void {
    this.steeringQueue.push(text);
}

/** Drain all queued steering messages. Returns empty array if none. */
private drainSteering(): string[] {
    if (this.steeringQueue.length === 0) return [];
    const messages = [...this.steeringQueue];
    this.steeringQueue.length = 0;
    return messages;
}
```

2. Modify `run()` signature to accept optional `AbortSignal`:

```typescript
async run(goal: string, signal?: AbortSignal): Promise<AgentResult> {
```

3. Inside the agent loop, at the start of each iteration (after `turns++` and before timeout check), drain steering messages:

```typescript
// Drain steering messages
const steered = this.drainSteering();
for (const text of steered) {
    history.push(Msg.user(text));
    this.emitAndLog("steering", agentId, this.depth, { text });
}
```

4. After the timeout check, add abort check:

```typescript
// Check abort signal
if (signal?.aborted) {
    this.emitAndLog("interrupted", agentId, this.depth, {
        message: "Agent interrupted by abort signal",
        turns,
    });
    break;
}
```

5. Thread the signal to `this.client.complete(request)` — check if the client supports it. If not, wrap the call:

```typescript
const response = signal
    ? await Promise.race([
        this.client.complete(request),
        new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
    ])
    : await this.client.complete(request);
```

Wrap the entire loop body in a try/catch for AbortError:

```typescript
try {
    // ... existing loop body ...
} catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
        this.emitAndLog("interrupted", agentId, this.depth, {
            message: "Agent interrupted during LLM call",
            turns,
        });
        break;
    }
    throw err;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/agents/steering.test.ts`
Expected: All tests pass

**Step 5: Run full test suite**

Run: `bun test`
Expected: All existing tests pass (new parameter is optional)

**Step 6: Commit**

```bash
git add src/agents/agent.ts test/agents/steering.test.ts
git commit -m "feat: add steering queue and AbortSignal support to Agent"
```

---

### Task 5: Session Metadata Persistence

**Files:**
- Create: `src/host/session-metadata.ts`
- Create: `test/host/session-metadata.test.ts`

Lightweight metadata file per session, updated after each turn.

**Step 1: Write the failing test**

Create `test/host/session-metadata.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMetadata, loadSessionMetadata, listSessions } from "../../src/host/session-metadata.ts";

describe("SessionMetadata", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-"));
	});

	afterAll(async () => {
		// Cleanup handled by OS for temp dirs
	});

	test("save creates a JSON file", async () => {
		const meta = new SessionMetadata({
			sessionId: "01ABCDEF12345678901234",
			agentSpec: "root",
			model: "claude-sonnet-4-6",
			sessionsDir: tempDir,
		});

		await meta.save();

		const raw = await readFile(join(tempDir, "01ABCDEF12345678901234.meta.json"), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.sessionId).toBe("01ABCDEF12345678901234");
		expect(parsed.agentSpec).toBe("root");
		expect(parsed.model).toBe("claude-sonnet-4-6");
		expect(parsed.status).toBe("idle");
		expect(parsed.turns).toBe(0);
	});

	test("updateTurn increments turns and saves", async () => {
		const meta = new SessionMetadata({
			sessionId: "01ABCDEF12345678901234",
			agentSpec: "root",
			model: "claude-sonnet-4-6",
			sessionsDir: tempDir,
		});

		meta.updateTurn(1, 5000, 200000);
		await meta.save();

		const raw = await readFile(join(tempDir, "01ABCDEF12345678901234.meta.json"), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.turns).toBe(1);
		expect(parsed.contextTokens).toBe(5000);
		expect(parsed.contextWindowSize).toBe(200000);
	});

	test("setStatus changes status", async () => {
		const meta = new SessionMetadata({
			sessionId: "01TEST",
			agentSpec: "root",
			model: "test",
			sessionsDir: tempDir,
		});

		meta.setStatus("running");
		await meta.save();

		const loaded = await loadSessionMetadata(join(tempDir, "01TEST.meta.json"));
		expect(loaded.status).toBe("running");
	});
});

describe("loadSessionMetadata", () => {
	test("loads a saved metadata file", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-load-"));
		const meta = new SessionMetadata({
			sessionId: "01LOAD",
			agentSpec: "root",
			model: "claude-sonnet-4-6",
			sessionsDir: tempDir,
		});
		meta.updateTurn(3, 15000, 200000);
		await meta.save();

		const loaded = await loadSessionMetadata(join(tempDir, "01LOAD.meta.json"));
		expect(loaded.sessionId).toBe("01LOAD");
		expect(loaded.turns).toBe(3);
		expect(loaded.contextTokens).toBe(15000);
	});
});

describe("listSessions", () => {
	test("lists sessions sorted by ULID (chronological)", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-meta-list-"));

		// Create sessions with ULIDs that sort chronologically
		for (const id of ["01AAA", "01CCC", "01BBB"]) {
			const meta = new SessionMetadata({
				sessionId: id,
				agentSpec: "root",
				model: "test",
				sessionsDir: tempDir,
			});
			await meta.save();
		}

		const sessions = await listSessions(tempDir);
		expect(sessions).toHaveLength(3);
		// Sorted by ULID (lexicographic = chronological)
		expect(sessions[0]!.sessionId).toBe("01AAA");
		expect(sessions[1]!.sessionId).toBe("01BBB");
		expect(sessions[2]!.sessionId).toBe("01CCC");
	});

	test("returns empty array for missing directory", async () => {
		const sessions = await listSessions("/nonexistent");
		expect(sessions).toEqual([]);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test test/host/session-metadata.test.ts`
Expected: FAIL — module not found

**Step 3: Implement SessionMetadata**

Create `src/host/session-metadata.ts`:

```typescript
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionMetadataSnapshot {
	sessionId: string;
	agentSpec: string;
	model: string;
	status: "idle" | "running" | "interrupted";
	turns: number;
	contextTokens: number;
	contextWindowSize: number;
	createdAt: string;
	updatedAt: string;
}

export class SessionMetadata {
	readonly sessionId: string;
	readonly agentSpec: string;
	model: string;
	status: "idle" | "running" | "interrupted" = "idle";
	turns = 0;
	contextTokens = 0;
	contextWindowSize = 0;
	readonly createdAt: string;
	updatedAt: string;
	private readonly sessionsDir: string;

	constructor(opts: {
		sessionId: string;
		agentSpec: string;
		model: string;
		sessionsDir: string;
	}) {
		this.sessionId = opts.sessionId;
		this.agentSpec = opts.agentSpec;
		this.model = opts.model;
		this.sessionsDir = opts.sessionsDir;
		const now = new Date().toISOString();
		this.createdAt = now;
		this.updatedAt = now;
	}

	updateTurn(turns: number, contextTokens: number, contextWindowSize: number): void {
		this.turns = turns;
		this.contextTokens = contextTokens;
		this.contextWindowSize = contextWindowSize;
		this.updatedAt = new Date().toISOString();
	}

	setStatus(status: "idle" | "running" | "interrupted"): void {
		this.status = status;
		this.updatedAt = new Date().toISOString();
	}

	async save(): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });
		const snapshot: SessionMetadataSnapshot = {
			sessionId: this.sessionId,
			agentSpec: this.agentSpec,
			model: this.model,
			status: this.status,
			turns: this.turns,
			contextTokens: this.contextTokens,
			contextWindowSize: this.contextWindowSize,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
		};
		await writeFile(
			join(this.sessionsDir, `${this.sessionId}.meta.json`),
			JSON.stringify(snapshot, null, 2) + "\n",
		);
	}
}

export async function loadSessionMetadata(path: string): Promise<SessionMetadataSnapshot> {
	const raw = await readFile(path, "utf-8");
	return JSON.parse(raw) as SessionMetadataSnapshot;
}

export async function listSessions(sessionsDir: string): Promise<SessionMetadataSnapshot[]> {
	let files: string[];
	try {
		files = await readdir(sessionsDir);
	} catch {
		return [];
	}

	const metaFiles = files.filter((f) => f.endsWith(".meta.json")).sort();
	const sessions: SessionMetadataSnapshot[] = [];

	for (const file of metaFiles) {
		try {
			const snapshot = await loadSessionMetadata(join(sessionsDir, file));
			sessions.push(snapshot);
		} catch {
			// Skip corrupted files
		}
	}

	return sessions;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/host/session-metadata.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/host/session-metadata.ts test/host/session-metadata.test.ts
git commit -m "feat: add session metadata persistence"
```

---

### Task 6: Session Controller

**Files:**
- Create: `src/host/session-controller.ts`
- Create: `test/host/session-controller.test.ts`
- Modify: `src/host/session.ts` (may be replaced or significantly revised)

The Session Controller is the stateful core. It owns the agent lifecycle, routes commands, and coordinates persistence.

**Step 1: Write the failing tests**

Create `test/host/session-controller.test.ts`. Key test cases:

- `constructor creates a session with ULID`
- `submitGoal starts agent and emits events on bus`
- `steer command routes to agent.steer()`
- `interrupt command aborts the agent`
- `events are written to log file`
- `metadata is saved after each turn`
- `session status transitions: idle → running → idle`

This test will be larger. Focus on:
1. Constructor creates session, assigns ULID
2. Command routing (steer, interrupt)
3. Event log writing
4. Metadata updates

**Important:** The Session Controller subscribes to the bus's command channel and routes to the agent. It also subscribes to the agent events channel to update metadata and write logs.

**Step 2: Implement SessionController**

Create `src/host/session-controller.ts`. Key structure:

```typescript
import type { EventBus } from "./event-bus.ts";
import type { SessionMetadata } from "./session-metadata.ts";
import type { Agent } from "../agents/agent.ts";
import { ulid } from "../util/ulid.ts";

export class SessionController {
    readonly sessionId: string;
    private agent: Agent | null = null;
    private abortController = new AbortController();
    private metadata: SessionMetadata;
    private readonly bus: EventBus;
    private readonly logPath: string;

    constructor(opts: {
        bus: EventBus;
        genomePath: string;
        model?: string;
    }) {
        this.sessionId = ulid();
        this.bus = opts.bus;
        // ... setup metadata, subscribe to commands
        this.bus.onCommand((cmd) => this.handleCommand(cmd));
    }

    private handleCommand(cmd: Command): void {
        switch (cmd.kind) {
            case "submit_goal":
                this.submitGoal(cmd.data.goal as string);
                break;
            case "steer":
                this.agent?.steer(cmd.data.text as string);
                break;
            case "interrupt":
                this.abortController.abort();
                this.abortController = new AbortController();
                break;
            case "compact":
                this.triggerCompaction();
                break;
            // ... etc
        }
    }

    private async submitGoal(goal: string): Promise<void> {
        // Create agent, start run with abort signal
        // Agent events flow through the shared bus
        // Update metadata after each plan_end event
    }
}
```

The exact implementation will depend on how `createAgent` works with the bus. The agent's `events` parameter should be the bus (since EventBus is compatible with AgentEventEmitter).

**Step 3: Run tests, iterate until passing**

**Step 4: Run full test suite**

Run: `bun test`

**Step 5: Commit**

```bash
git add src/host/session-controller.ts test/host/session-controller.test.ts
git commit -m "feat: add SessionController for agent lifecycle and command routing"
```

---

### Task 7: Resume — Event Log Replay

**Files:**
- Create: `src/host/resume.ts`
- Create: `test/host/resume.test.ts`

Replay a JSONL event log to reconstruct the agent's conversation history (Message array).

**Step 1: Write the failing tests**

Create `test/host/resume.test.ts`. Key test cases:

- `replayEventLog reconstructs user message from initial goal`
- `replayEventLog reconstructs assistant messages from plan_end events`
- `replayEventLog reconstructs tool results from primitive_end events`
- `replayEventLog reconstructs delegation results from act_end events`
- `replayEventLog handles compaction events by replacing prior history`
- `replayEventLog handles steering events as user messages`
- `replayEventLog returns empty history for empty log`

The replay function reads a JSONL file and returns a `Message[]` suitable for passing to a new Agent.

**Step 2: Implement replay**

Create `src/host/resume.ts`:

```typescript
import { readFile } from "node:fs/promises";
import type { Message } from "../llm/types.ts";
import { Msg } from "../llm/types.ts";
import type { SessionEvent } from "../kernel/types.ts";

/**
 * Replay a JSONL event log to reconstruct the conversation history.
 * Only processes root-depth events (depth === 0) since subagent events
 * don't go into the root's LLM context.
 */
export async function replayEventLog(logPath: string): Promise<Message[]> {
    const raw = await readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const events: SessionEvent[] = lines.map((line) => JSON.parse(line));

    const history: Message[] = [];

    for (const event of events) {
        // Only root-depth events contribute to root's history
        if (event.depth !== 0) continue;

        switch (event.kind) {
            case "perceive":
                // Initial goal becomes first user message
                if (event.data.goal) {
                    history.push(Msg.user(event.data.goal as string));
                }
                break;

            case "steering":
                // Steering messages become user messages
                history.push(Msg.user(event.data.text as string));
                break;

            case "plan_end":
                // Assistant response — reconstruct from text + tool calls
                // This needs the full assistant message structure
                // stored in event data
                if (event.data.assistant_message) {
                    history.push(event.data.assistant_message as Message);
                }
                break;

            case "primitive_end":
            case "act_end":
                // Tool results — reconstruct from event data
                if (event.data.tool_result_message) {
                    history.push(event.data.tool_result_message as Message);
                }
                break;

            case "compaction":
                // Replace all prior history with the summary
                history.length = 0;
                if (event.data.summary) {
                    history.push(Msg.user(event.data.summary as string));
                }
                break;
        }
    }

    return history;
}
```

**Important note:** The current event logging (`emitAndLog`) stores event data but NOT the full Message objects needed for replay. The implementation will need to either:
1. Store the full Message in the event data (preferred — add `assistant_message` and `tool_result_message` to the event data in the agent loop), OR
2. Reconstruct Messages from the event data fields

Option 1 is cleaner. This means Task 4 or a follow-up needs to modify the agent loop to include full messages in event data.

**Step 3: Run tests, iterate**

**Step 4: Commit**

```bash
git add src/host/resume.ts test/host/resume.test.ts
git commit -m "feat: add event log replay for session resume"
```

---

### Task 8: Compaction

**Files:**
- Create: `src/host/compaction.ts`
- Create: `test/host/compaction.test.ts`

Single-threshold compaction at 80% context usage. Summarizes older turns, preserves recent 6.

**Step 1: Write the failing tests**

Key test cases:

- `shouldCompact returns false below threshold`
- `shouldCompact returns true at or above threshold`
- `compactHistory preserves last 6 messages`
- `compactHistory replaces older messages with summary`
- `compaction summary includes log file path`
- `compaction summary prefix matches expected format`
- `buildCompactionPrompt includes older turns content`

**Step 2: Implement compaction**

Create `src/host/compaction.ts`:

```typescript
import type { Client } from "../llm/client.ts";
import type { Message } from "../llm/types.ts";
import { Msg, messageText } from "../llm/types.ts";

const COMPACTION_THRESHOLD = 0.80;
const PRESERVE_RECENT_TURNS = 6;

export function shouldCompact(contextTokens: number, contextWindowSize: number): boolean {
    if (contextWindowSize <= 0) return false;
    return contextTokens / contextWindowSize >= COMPACTION_THRESHOLD;
}

const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

function summaryPrefix(logPath: string): string {
    return `Another language model started this task and produced a summary of its work.
Full conversation log available at: ${logPath} (grep for details if needed).
Use this summary to continue the work without duplicating effort:`;
}

export async function compactHistory(opts: {
    history: Message[];
    client: Client;
    model: string;
    provider: string;
    logPath: string;
}): Promise<{ summary: string; beforeCount: number; afterCount: number }> {
    const { history, client, model, provider, logPath } = opts;
    const beforeCount = history.length;

    if (history.length <= PRESERVE_RECENT_TURNS) {
        return { summary: "", beforeCount, afterCount: beforeCount };
    }

    // Split: older turns to summarize, recent turns to keep
    const olderTurns = history.slice(0, -PRESERVE_RECENT_TURNS);
    const recentTurns = history.slice(-PRESERVE_RECENT_TURNS);

    // Build summarization request
    const summarizeHistory: Message[] = [
        ...olderTurns,
        Msg.user(COMPACTION_PROMPT),
    ];

    const response = await client.complete({
        model,
        provider,
        messages: summarizeHistory,
        tools: [],
        system: "",
    });

    const summaryText = messageText(response.message);
    const fullSummary = `${summaryPrefix(logPath)}\n\n${summaryText}`;

    // Replace history: summary + recent turns
    history.length = 0;
    history.push(Msg.user(fullSummary));
    history.push(...recentTurns);

    return { summary: fullSummary, beforeCount, afterCount: history.length };
}
```

**Step 3: Run tests, iterate**

**Step 4: Commit**

```bash
git add src/host/compaction.ts test/host/compaction.test.ts
git commit -m "feat: add context-aware compaction with handoff summary"
```

---

### Task 9: CLI Arg Parsing — New Modes

**Files:**
- Modify: `src/host/cli.ts`
- Modify: `test/host/cli.test.ts`

Update CLI to support: interactive default, `--prompt`, `--resume`, `--resume-last`, `--list`.

**Step 1: Write the failing tests**

Add to `test/host/cli.test.ts`:

```typescript
describe("parseArgs — new modes", () => {
    test("no args returns interactive mode", () => {
        const cmd = parseArgs([]);
        expect(cmd.kind).toBe("interactive");
    });

    test("--prompt returns oneshot mode", () => {
        const cmd = parseArgs(["--prompt", "Fix the bug"]);
        expect(cmd.kind).toBe("oneshot");
        expect(cmd.goal).toBe("Fix the bug");
    });

    test("--resume returns resume mode", () => {
        const cmd = parseArgs(["--resume", "01ABC123"]);
        expect(cmd.kind).toBe("resume");
        expect(cmd.sessionId).toBe("01ABC123");
    });

    test("--resume-last returns resume-last mode", () => {
        const cmd = parseArgs(["--resume-last"]);
        expect(cmd.kind).toBe("resume-last");
    });

    test("--list returns list mode", () => {
        const cmd = parseArgs(["--list"]);
        expect(cmd.kind).toBe("list");
    });

    // Backward compat: bare goal still works as oneshot
    test("bare goal returns oneshot mode", () => {
        const cmd = parseArgs(["Fix the bug"]);
        expect(cmd.kind).toBe("oneshot");
        expect(cmd.goal).toBe("Fix the bug");
    });
});
```

**Step 2: Run tests to verify they fail**

**Step 3: Update CliCommand type and parseArgs**

Update `CliCommand` union:
```typescript
export type CliCommand =
    | { kind: "interactive"; genomePath: string }
    | { kind: "oneshot"; goal: string; genomePath: string }
    | { kind: "resume"; sessionId: string; genomePath: string }
    | { kind: "resume-last"; genomePath: string }
    | { kind: "list"; genomePath: string }
    | { kind: "genome-list"; genomePath: string }
    | { kind: "genome-log"; genomePath: string }
    | { kind: "genome-rollback"; genomePath: string; commit: string }
    | { kind: "help" };
```

Update parseArgs to handle new flags. Key change: `rest.length === 0` now returns `interactive` instead of `help`. Bare positional args become `oneshot`.

**Step 4: Run tests, iterate until passing**

**Step 5: Run full test suite** (existing renderEvent tests should still pass)

**Step 6: Commit**

```bash
git add src/host/cli.ts test/host/cli.test.ts
git commit -m "feat: update CLI for interactive default, --prompt, --resume, --list"
```

---

### Task 10: Ink TUI — App Shell and ConversationView

**Files:**
- Create: `src/tui/app.tsx`
- Create: `src/tui/conversation.tsx`
- Create: `src/tui/render-event.ts` (extract from cli.ts)
- Create: `test/tui/render-event.test.ts`

**Step 1: Extract renderEvent from cli.ts**

Move `renderEvent`, `truncateLines`, and `primitiveKeyArg` from `src/host/cli.ts` to `src/tui/render-event.ts`. Update imports in cli.ts. This is a refactor — existing tests should be updated to import from the new location.

**Step 2: Write tests for extracted render-event**

Move/update the existing renderEvent tests from `test/host/cli.test.ts` to `test/tui/render-event.test.ts`. Add new test cases for the new event kinds:

```typescript
test("renders session_resume event", () => {
    const result = renderEvent(makeEvent("session_resume", { turns: 5 }));
    expect(result).toContain("Resumed session");
});

test("renders interrupted event", () => {
    const result = renderEvent(makeEvent("interrupted", { message: "User interrupted" }));
    expect(result).toContain("Interrupted");
});

test("renders context_update event as null (not displayed as text)", () => {
    const result = renderEvent(makeEvent("context_update", { pressure: 0.45 }));
    expect(result).toBeNull();
});
```

**Step 3: Create the Ink app shell**

Create `src/tui/app.tsx`:

```tsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { EventBus } from "../host/event-bus.ts";
import type { SessionEvent } from "../kernel/types.ts";
import { renderEvent } from "./render-event.ts";

interface AppProps {
    bus: EventBus;
    sessionId: string;
}

export function App({ bus, sessionId }: AppProps) {
    const [lines, setLines] = useState<string[]>([]);

    useEffect(() => {
        return bus.onEvent((event: SessionEvent) => {
            const line = renderEvent(event);
            if (line !== null) {
                setLines((prev) => [...prev, line]);
            }
        });
    }, [bus]);

    return (
        <Box flexDirection="column">
            <Box flexDirection="column" flexGrow={1}>
                {lines.map((line, i) => (
                    <Text key={i}>{line}</Text>
                ))}
            </Box>
            {/* StatusBar and InputArea will be added in subsequent tasks */}
        </Box>
    );
}
```

**Step 4: Verify typecheck passes**

Run: `bun run typecheck`

**Step 5: Commit**

```bash
git add src/tui/ test/tui/
git commit -m "feat: add Ink app shell and extract renderEvent"
```

---

### Task 11: Ink TUI — StatusBar

**Files:**
- Create: `src/tui/status-bar.tsx`

**Step 1: Implement StatusBar component**

```tsx
import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
    contextTokens: number;
    contextWindowSize: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    model: string;
    sessionId: string;
    status: "idle" | "running" | "interrupted";
}

export function StatusBar(props: StatusBarProps) {
    const { contextTokens, contextWindowSize, turns, inputTokens, outputTokens, model, sessionId, status } = props;
    const pressure = contextWindowSize > 0 ? contextTokens / contextWindowSize : 0;
    const percentStr = `${Math.round(pressure * 100)}%`;
    const compactDistance = contextWindowSize > 0
        ? Math.max(0, Math.round(contextWindowSize * 0.80 - contextTokens))
        : 0;

    const formatTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

    return (
        <Box borderStyle="single" paddingX={1} justifyContent="space-between">
            <Text>
                ctx: {formatTokens(contextTokens)}/{formatTokens(contextWindowSize)} ({percentStr}, {formatTokens(compactDistance)} to compact)
                {" | "}turn {turns}
                {status === "running" && ` | ↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`}
            </Text>
            <Text dimColor>
                {model} | {sessionId.slice(0, 8)}...
            </Text>
        </Box>
    );
}
```

**Step 2: Wire into App component**

Update `src/tui/app.tsx` to include `<StatusBar>`, driven by `context_update` and `plan_end` events.

**Step 3: Verify typecheck**

**Step 4: Commit**

```bash
git add src/tui/status-bar.tsx src/tui/app.tsx
git commit -m "feat: add StatusBar component with context pressure display"
```

---

### Task 12: Ink TUI — InputArea, Slash Commands, and Input History

**Files:**
- Create: `src/tui/input-area.tsx`
- Create: `src/tui/slash-commands.ts`
- Create: `src/tui/history.ts`
- Create: `test/tui/slash-commands.test.ts`
- Create: `test/tui/history.test.ts`

**Step 1: Write slash command parser tests**

```typescript
import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "../../src/tui/slash-commands.ts";

describe("parseSlashCommand", () => {
    test("returns null for non-slash input", () => {
        expect(parseSlashCommand("hello")).toBeNull();
    });

    test("parses /help", () => {
        expect(parseSlashCommand("/help")).toEqual({ kind: "help" });
    });

    test("parses /quit", () => {
        expect(parseSlashCommand("/quit")).toEqual({ kind: "quit" });
    });

    test("parses /model with argument", () => {
        expect(parseSlashCommand("/model claude-sonnet-4-6")).toEqual({
            kind: "switch_model",
            model: "claude-sonnet-4-6",
        });
    });

    test("parses /model without argument", () => {
        expect(parseSlashCommand("/model")).toEqual({ kind: "switch_model", model: undefined });
    });

    test("parses /compact", () => {
        expect(parseSlashCommand("/compact")).toEqual({ kind: "compact" });
    });

    test("parses /clear", () => {
        expect(parseSlashCommand("/clear")).toEqual({ kind: "clear" });
    });

    test("parses /status", () => {
        expect(parseSlashCommand("/status")).toEqual({ kind: "status" });
    });
});
```

**Step 2: Write input history tests**

```typescript
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputHistory } from "../../src/tui/history.ts";

describe("InputHistory", () => {
    test("stores and retrieves entries", async () => {
        const dir = await mkdtemp(join(tmpdir(), "sprout-hist-"));
        const history = new InputHistory(join(dir, "history.txt"));

        history.add("first command");
        history.add("second command");

        expect(history.previous()).toBe("second command");
        expect(history.previous()).toBe("first command");
        expect(history.previous()).toBe("first command"); // stays at oldest
    });

    test("navigates forward with next()", async () => {
        const dir = await mkdtemp(join(tmpdir(), "sprout-hist-"));
        const history = new InputHistory(join(dir, "history.txt"));

        history.add("a");
        history.add("b");
        history.add("c");

        history.previous(); // c
        history.previous(); // b
        expect(history.next()).toBe("c");
        expect(history.next()).toBe(""); // back to empty input
    });

    test("persists to file and reloads", async () => {
        const dir = await mkdtemp(join(tmpdir(), "sprout-hist-"));
        const path = join(dir, "history.txt");

        const h1 = new InputHistory(path);
        h1.add("saved command");
        await h1.save();

        const h2 = new InputHistory(path);
        await h2.load();
        expect(h2.previous()).toBe("saved command");
    });

    test("handles multiline entries by escaping newlines", async () => {
        const dir = await mkdtemp(join(tmpdir(), "sprout-hist-"));
        const path = join(dir, "history.txt");

        const h1 = new InputHistory(path);
        h1.add("line1\nline2\nline3");
        await h1.save();

        const h2 = new InputHistory(path);
        await h2.load();
        expect(h2.previous()).toBe("line1\nline2\nline3");
    });
});
```

**Step 3: Implement slash commands and history**

**Step 4: Create InputArea component**

The InputArea should:
- Use Ink's `TextInput` or a custom input component
- Enter submits, Alt+Enter for newline
- Up/Down arrows navigate history
- Parse slash commands before dispatching to bus
- When agent status is "running", auto-route input as steer command

**Step 5: Wire into App component**

**Step 6: Run tests**

**Step 7: Commit**

```bash
git add src/tui/ test/tui/
git commit -m "feat: add InputArea with slash commands and persistent history"
```

---

### Task 13: Integration — Wire CLI Modes to Session Controller + TUI

**Files:**
- Modify: `src/host/cli.ts` (runCli function)
- Create: `test/integration/interactive.test.ts`

This is the final wiring task. Connect all the pieces:

**Interactive mode (`sprout`):**
1. Create EventBus
2. Create SessionController with bus
3. Render Ink `<App>` with bus
4. Wait for user input via TUI

**One-shot mode (`sprout --prompt "goal"`):**
1. Create EventBus
2. Create SessionController with bus
3. Subscribe console renderer to bus events (no Ink)
4. Submit goal via bus command
5. Wait for completion, exit

**Resume mode (`sprout --resume {ulid}`):**
1. Create EventBus
2. Create SessionController with bus
3. Resume session from logs + metadata
4. Render Ink `<App>` with bus (pre-populated with history)
5. Wait for user input

**List mode (`sprout --list`):**
1. Load and display session list
2. Let user pick a session
3. Resume picked session (same as resume mode)

**Step 1: Write integration test**

Test that one-shot mode works end-to-end (creates session, runs agent, writes logs):

```typescript
test("one-shot mode runs agent and persists session", async () => {
    // Create temp genome dir
    // Run CLI in oneshot mode
    // Verify session metadata was created
    // Verify event log was written
});
```

**Step 2: Implement runCli for each mode**

**Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 4: Manual smoke test**

```bash
# Interactive mode
bun run src/host/cli.ts

# One-shot mode
bun run src/host/cli.ts --prompt "What is 2 + 2?"

# List sessions
bun run src/host/cli.ts --list
```

**Step 5: Commit**

```bash
git add src/host/cli.ts test/integration/
git commit -m "feat: wire CLI modes to SessionController and Ink TUI"
```

---

### Task 14: Replace UUID with ULID Throughout

**Files:**
- Modify: `src/agents/agent.ts` (sessionId generation)
- Modify: `src/agents/agent.ts` (subagent log path)
- Modify: Any other files using `crypto.randomUUID()` for session/log IDs
- Modify: relevant tests

**Step 1: Search for all UUID usage**

Run: `grep -r "randomUUID\|crypto.randomUUID" src/`

**Step 2: Replace with ULID**

In `src/agents/agent.ts`:
- Line 86: `this.sessionId = options.sessionId ?? crypto.randomUUID();` → `this.sessionId = options.sessionId ?? ulid();`
- Line 211: `${this.logBasePath}/subagents/${crypto.randomUUID()}` → `${this.logBasePath}/subagents/${ulid()}`

**Step 3: Update tests that check UUID format**

**Step 4: Run full test suite**

**Step 5: Commit**

```bash
git add src/ test/
git commit -m "refactor: replace UUID with ULID for session and log IDs"
```

---

## Task Dependency Graph

```
Task 1 (setup)
  └─→ Task 2 (ULID)
       └─→ Task 3 (EventBus)
            ├─→ Task 4 (Agent steer + abort)
            ├─→ Task 5 (Session metadata)
            │    └─→ Task 6 (Session Controller) ←── Task 4
            │         ├─→ Task 7 (Resume)
            │         ├─→ Task 8 (Compaction)
            │         └─→ Task 9 (CLI args)
            │              └─→ Task 13 (Integration wiring) ←── Tasks 10,11,12
            ├─→ Task 10 (TUI App + ConversationView)
            ├─→ Task 11 (TUI StatusBar)
            └─→ Task 12 (TUI InputArea + slash + history)
  Task 14 (ULID replacement) — independent, can run anytime after Task 2
```

## Notes for Implementer

1. **Bun + Ink compatibility:** Ink should work with Bun, but if you hit issues with React JSX compilation, check that `tsconfig.json` has `"jsx": "react-jsx"` and that `@types/react` is installed.

2. **Event data for resume:** The current `emitAndLog` in `agent.ts` stores event data but NOT full `Message` objects. For resume to work, you'll need to include serialized messages in event data. Add `assistant_message` to `plan_end` events and `tool_result_message` to primitive/act result events.

3. **Testing TUI components:** Ink provides `render()` from `ink-testing-library` for testing. Install it as a dev dependency if needed. Alternatively, test the non-UI logic (slash commands, history, render-event) with unit tests and verify the TUI manually.

4. **AbortSignal threading:** The LLM client SDKs (Anthropic, OpenAI, Gemini) have varying support for AbortSignal. You may need to check each provider's `complete()` implementation and add signal support there.

5. **Context window sizes:** You'll need a lookup table mapping model names to context window sizes. Start simple: `{ "claude-sonnet-4-6": 200000, "claude-haiku-4-5": 200000, "gpt-4o": 128000, ... }`.

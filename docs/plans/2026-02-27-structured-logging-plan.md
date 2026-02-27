# Structured Logging System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a structured Logger service that writes JSON-L to disk, optionally forwards to the event bus, and logs every LLM call via Client middleware.

**Architecture:** A `SessionLogger` class writes `LogEntry` records to `{genomePath}/logs/{sessionId}/session.log.jsonl`. Child loggers inherit context (component, agentId, sessionId, depth). A `loggingMiddleware` wraps `Client.complete()` to log every LLM call. Components receive logger instances via constructor injection.

**Tech Stack:** TypeScript, Bun test runner, existing EventBus

**Design doc:** `docs/plans/2026-02-27-structured-logging-design.md`

---

### Task 1: Logger types and core class

**Files:**
- Create: `src/host/logger.ts`
- Test: `test/host/logger.test.ts`

**Step 1: Write the failing tests**

Create `test/host/logger.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLogger, type LogEntry } from "../../src/host/logger.ts";

async function readLogEntries(path: string): Promise<LogEntry[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("SessionLogger", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("writes log entries as JSON-L to disk", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "test" });

		logger.info("system", "hello world", { key: "value" });
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.level).toBe("info");
		expect(entries[0]!.category).toBe("system");
		expect(entries[0]!.message).toBe("hello world");
		expect(entries[0]!.component).toBe("test");
		expect(entries[0]!.data).toEqual({ key: "value" });
		expect(entries[0]!.timestamp).toBeGreaterThan(0);
	});

	test("child logger inherits and merges parent context", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const parent = new SessionLogger({
			logPath,
			component: "parent",
			sessionId: "sess-1",
		});
		const child = parent.child({ component: "child", agentId: "agent-1", depth: 2 });

		child.info("agent", "child log");
		await parent.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.component).toBe("child");
		expect(entries[0]!.sessionId).toBe("sess-1");
		expect(entries[0]!.agentId).toBe("agent-1");
		expect(entries[0]!.depth).toBe(2);
	});

	test("writes all log levels to disk", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "test" });

		logger.debug("llm", "debug msg");
		logger.info("llm", "info msg");
		logger.warn("llm", "warn msg");
		logger.error("llm", "error msg");
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
	});

	test("creates log directory lazily", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "nested", "deep", "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "test" });

		logger.info("system", "first write");
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);
	});

	test("never throws on write failure", async () => {
		const logger = new SessionLogger({
			logPath: "/dev/null/impossible/path/log.jsonl",
			component: "test",
		});

		// Should not throw
		logger.error("system", "this will fail to write");
		await logger.flush();
	});

	test("forwards info+ entries to bus when configured", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "logger-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];
		const fakeBus = {
			emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>) {
				emitted.push({ kind, data });
			},
		};

		const logger = new SessionLogger({
			logPath,
			component: "test",
			bus: fakeBus as any,
		});

		logger.debug("llm", "should not forward");
		logger.info("llm", "should forward");
		logger.warn("llm", "should also forward");
		await logger.flush();

		expect(emitted).toHaveLength(2);
		expect(emitted[0]!.kind).toBe("log");
		expect((emitted[0]!.data as any).level).toBe("info");
		expect((emitted[1]!.data as any).level).toBe("warn");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/host/logger.test.ts`
Expected: FAIL — `SessionLogger` does not exist yet.

**Step 3: Implement the SessionLogger**

Create `src/host/logger.ts`:

```typescript
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionBus } from "./event-bus.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory =
	| "llm"
	| "agent"
	| "primitive"
	| "learn"
	| "compaction"
	| "session"
	| "system";

export interface LogEntry {
	timestamp: number;
	level: LogLevel;
	category: LogCategory;
	message: string;
	component?: string;
	agentId?: string;
	sessionId?: string;
	depth?: number;
	data?: Record<string, unknown>;
}

export interface LogContext {
	component: string;
	agentId?: string;
	sessionId?: string;
	depth?: number;
}

export interface Logger {
	debug(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	info(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	warn(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	error(category: LogCategory, message: string, data?: Record<string, unknown>): void;
	child(context: Partial<LogContext>): Logger;
	flush(): Promise<void>;
}

export interface SessionLoggerOptions {
	logPath: string;
	component: string;
	sessionId?: string;
	bus?: SessionBus;
}

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Structured logger that writes JSON-L to disk and optionally forwards to the event bus.
 *
 * All levels written to disk. Bus receives info and above.
 * Child loggers share the parent's write chain and output targets.
 */
export class SessionLogger implements Logger {
	private readonly logPath: string;
	private readonly bus?: SessionBus;
	private readonly context: LogContext;
	private writeChain: Promise<void> = Promise.resolve();
	private dirCreated = false;

	constructor(options: SessionLoggerOptions) {
		this.logPath = options.logPath;
		this.bus = options.bus;
		this.context = {
			component: options.component,
			sessionId: options.sessionId,
		};
	}

	/** Internal constructor for child loggers that share write infrastructure. */
	private static createChild(parent: SessionLogger, context: LogContext): SessionLogger {
		const child = Object.create(SessionLogger.prototype) as SessionLogger;
		Object.defineProperty(child, "logPath", { value: parent.logPath });
		Object.defineProperty(child, "bus", { value: parent.bus });
		Object.defineProperty(child, "context", { value: context });
		Object.defineProperty(child, "dirCreated", { value: parent.dirCreated, writable: true });
		// Share the write chain via getter/setter that delegates to parent
		Object.defineProperty(child, "_parent", { value: parent });
		return child;
	}

	private get _writeChain(): Promise<void> {
		const parent = (this as any)._parent as SessionLogger | undefined;
		return parent ? parent._writeChain : this.writeChain;
	}

	private set _writeChain(val: Promise<void>) {
		const parent = (this as any)._parent as SessionLogger | undefined;
		if (parent) {
			parent._writeChain = val;
		} else {
			this.writeChain = val;
		}
	}

	debug(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("debug", category, message, data);
	}

	info(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("info", category, message, data);
	}

	warn(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("warn", category, message, data);
	}

	error(category: LogCategory, message: string, data?: Record<string, unknown>): void {
		this.log("error", category, message, data);
	}

	child(context: Partial<LogContext>): Logger {
		const merged: LogContext = {
			component: context.component ?? this.context.component,
			agentId: context.agentId ?? this.context.agentId,
			sessionId: context.sessionId ?? this.context.sessionId,
			depth: context.depth ?? this.context.depth,
		};
		const root = (this as any)._parent ?? this;
		return SessionLogger.createChild(root, merged);
	}

	async flush(): Promise<void> {
		await this._writeChain;
	}

	private log(
		level: LogLevel,
		category: LogCategory,
		message: string,
		data?: Record<string, unknown>,
	): void {
		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			category,
			message,
			component: this.context.component,
			agentId: this.context.agentId,
			sessionId: this.context.sessionId,
			depth: this.context.depth,
			data,
		};

		// Write to disk (all levels)
		const line = `${JSON.stringify(entry)}\n`;
		this._writeChain = this._writeChain
			.then(async () => {
				if (!this.dirCreated) {
					await mkdir(dirname(this.logPath), { recursive: true });
					this.dirCreated = true;
					// Also mark parent if we're a child
					const parent = (this as any)._parent as SessionLogger | undefined;
					if (parent) parent.dirCreated = true;
				}
				await appendFile(this.logPath, line);
			})
			.catch(() => {});

		// Forward to bus (info and above)
		if (this.bus && LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK.info) {
			try {
				this.bus.emitEvent(
					"log" as any,
					this.context.agentId ?? "",
					this.context.depth ?? 0,
					entry as unknown as Record<string, unknown>,
				);
			} catch {
				// Swallow bus errors
			}
		}
	}
}

/** No-op logger for components that don't need logging (tests, etc.). */
export class NullLogger implements Logger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
	child(): Logger {
		return this;
	}
	async flush(): Promise<void> {}
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/host/logger.test.ts`
Expected: All 6 tests PASS.

**Step 5: Commit**

```bash
git add src/host/logger.ts test/host/logger.test.ts
git commit -m "feat: add SessionLogger with JSON-L output and bus forwarding"
```

---

### Task 2: Logging middleware for Client

**Files:**
- Create: `src/llm/logging-middleware.ts`
- Test: `test/llm/logging-middleware.test.ts`

**Step 1: Write the failing tests**

Create `test/llm/logging-middleware.test.ts`:

```typescript
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLogger, type LogEntry } from "../../src/host/logger.ts";
import { loggingMiddleware } from "../../src/llm/logging-middleware.ts";
import type { Request, Response, Usage } from "../../src/llm/types.ts";
import { ContentKind } from "../../src/llm/types.ts";

async function readLogEntries(path: string): Promise<LogEntry[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function makeRequest(overrides: Partial<Request> = {}): Request {
	return {
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		messages: [
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hello" }] },
		],
		tools: [
			{ name: "read_file", description: "Read a file", parameters: {} },
			{ name: "exec", description: "Execute command", parameters: {} },
		],
		...overrides,
	};
}

function makeResponse(overrides: Partial<Response> = {}): Response {
	return {
		id: "msg_123",
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		message: { role: "assistant", content: [{ kind: ContentKind.TEXT, text: "hi" }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
		...overrides,
	};
}

describe("loggingMiddleware", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("logs provider, model, latency, and token counts", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mw-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "llm-client" });
		const mw = loggingMiddleware(logger);

		const response = makeResponse();
		const next = async (_req: Request) => response;

		const result = await mw(makeRequest(), next);
		await logger.flush();

		expect(result).toBe(response);

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);

		const entry = entries[0]!;
		expect(entry.level).toBe("info");
		expect(entry.category).toBe("llm");
		expect(entry.message).toBe("LLM call completed");
		expect(entry.data!.provider).toBe("anthropic");
		expect(entry.data!.model).toBe("claude-sonnet-4-6");
		expect(entry.data!.inputTokens).toBe(100);
		expect(entry.data!.outputTokens).toBe(50);
		expect(entry.data!.finishReason).toBe("stop");
		expect(entry.data!.messageCount).toBe(1);
		expect(entry.data!.toolCount).toBe(2);
		expect(typeof entry.data!.latencyMs).toBe("number");
	});

	test("logs error when adapter throws", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mw-"));
		const logPath = join(tempDir, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "llm-client" });
		const mw = loggingMiddleware(logger);

		const next = async (_req: Request): Promise<Response> => {
			throw new Error("API rate limit");
		};

		await expect(mw(makeRequest(), next)).rejects.toThrow("API rate limit");
		await logger.flush();

		const entries = await readLogEntries(logPath);
		expect(entries).toHaveLength(1);

		const entry = entries[0]!;
		expect(entry.level).toBe("error");
		expect(entry.category).toBe("llm");
		expect(entry.message).toBe("LLM call failed");
		expect(entry.data!.error).toBe("API rate limit");
		expect(typeof entry.data!.latencyMs).toBe("number");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test test/llm/logging-middleware.test.ts`
Expected: FAIL — `loggingMiddleware` does not exist yet.

**Step 3: Implement the logging middleware**

Create `src/llm/logging-middleware.ts`:

```typescript
import type { Logger } from "../host/logger.ts";
import type { Middleware } from "./client.ts";

/**
 * Client middleware that logs every LLM call with provider, model, latency, and token counts.
 *
 * Logs at info level on success, error level on failure.
 * Does not log request/response bodies (that's done at debug level by the caller).
 */
export function loggingMiddleware(logger: Logger): Middleware {
	return async (request, next) => {
		const start = performance.now();
		try {
			const response = await next(request);
			const latencyMs = Math.round(performance.now() - start);
			logger.info("llm", "LLM call completed", {
				provider: request.provider,
				model: request.model,
				latencyMs,
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
				cacheReadTokens: response.usage.cache_read_tokens,
				cacheWriteTokens: response.usage.cache_write_tokens,
				finishReason: response.finish_reason.reason,
				messageCount: request.messages.length,
				toolCount: request.tools?.length ?? 0,
			});
			return response;
		} catch (err) {
			const latencyMs = Math.round(performance.now() - start);
			logger.error("llm", "LLM call failed", {
				provider: request.provider,
				model: request.model,
				latencyMs,
				error: err instanceof Error ? err.message : String(err),
				messageCount: request.messages.length,
				toolCount: request.tools?.length ?? 0,
			});
			throw err;
		}
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test test/llm/logging-middleware.test.ts`
Expected: All 2 tests PASS.

**Step 5: Commit**

```bash
git add src/llm/logging-middleware.ts test/llm/logging-middleware.test.ts
git commit -m "feat: add LLM logging middleware for Client"
```

---

### Task 3: Add "log" event kind to kernel types

**Files:**
- Modify: `src/kernel/types.ts` (add `"log"` to `EventKind` union)

The Logger already emits `"log"` events to the bus, but `EventKind` doesn't include it yet. The `as any` cast in Task 1 needs to be cleaned up.

**Step 1: Write the failing test**

Add to an existing test file or create a simple assertion. Actually, this is a type-level change — verify via TypeScript:

Run: `npx tsc --noEmit`
Expected: PASS (the `as any` cast currently hides the error, but we want a clean type).

**Step 2: Add "log" to EventKind**

In `src/kernel/types.ts`, add `"log"` to the `EventKind` union (line ~170, after `"exit_hint"`):

```typescript
export type EventKind =
	| "session_start"
	| "session_end"
	// ... existing kinds ...
	| "exit_hint"
	| "log";
```

**Step 3: Remove `as any` cast from SessionLogger**

In `src/host/logger.ts`, change:
```typescript
this.bus.emitEvent(
	"log" as any,
```
to:
```typescript
this.bus.emitEvent(
	"log",
```

**Step 4: Run tests**

Run: `npx tsc --noEmit && bun test test/host/logger.test.ts`
Expected: Both pass.

**Step 5: Commit**

```bash
git add src/kernel/types.ts src/host/logger.ts
git commit -m "feat: add 'log' event kind to EventKind union"
```

---

### Task 4: Wire logger to CLI and SessionController

**Files:**
- Modify: `src/host/cli.ts` — create root logger, pass to WebServer and SessionController
- Modify: `src/host/session-controller.ts` — accept optional logger, pass to factory
- Modify: `src/agents/factory.ts` — accept optional logger, pass to Agent and LearnProcess
- Modify: `src/web/server.ts` — accept optional logger

This task wires the logger through the system without adding any log calls yet (except those already handled by middleware). Each component accepts an optional `Logger` to avoid breaking existing tests.

**Step 1: Write the failing test**

Add a test to `test/host/session-controller.test.ts` that verifies the logger option is accepted:

```typescript
test("accepts optional logger", () => {
	const { NullLogger } = require("../../src/host/logger.ts");
	const ctrl = new SessionController({
		bus,
		genomePath: "/tmp/test-genome",
		logger: new NullLogger(),
	});
	expect(ctrl).toBeDefined();
});
```

(Note: find the existing test file's pattern for `SessionController` construction and match it.)

**Step 2: Run test to verify it fails**

Run: `bun test test/host/session-controller.test.ts`
Expected: FAIL — `logger` not in `SessionControllerOptions`.

**Step 3: Add logger option to each component**

In `src/host/session-controller.ts`:
- Add `logger?: Logger` to `SessionControllerOptions` (import from `../host/logger.ts`)
- Add `logger?: Logger` to `AgentFactoryOptions`
- Store `this.logger` in `SessionController`
- Pass `logger` through to `defaultFactory` and into `createAgent` call

In `src/agents/factory.ts`:
- Add `logger?: Logger` to `CreateAgentOptions` (import from `../host/logger.ts`)
- Pass `logger` to `Agent` constructor and `LearnProcess` constructor

In `src/web/server.ts`:
- Add `logger?: Logger` to `WebServerOptions` (import from `../host/logger.ts`)
- Store `this.logger` in `WebServer`

In `src/host/cli.ts` (inside the `runInteractive` / `runSession` function — find where `WebServer` and `SessionController` are constructed):
- Create root logger: `const logger = new SessionLogger({ logPath: join(genomePath, "logs", sessionId, "session.log.jsonl"), component: "cli", sessionId, bus })`
- Create logging middleware: `const client = Client.fromEnv({ middleware: [loggingMiddleware(logger)] })`
- Pass `logger` to `new WebServer({ ..., logger })`
- Pass `logger` to `new SessionController({ ..., logger })`

**Important:** `AgentOptions` in `src/agents/agent.ts` also needs `logger?: Logger`. Add it but don't add any log calls yet — that's Task 5.

**Step 4: Run tests**

Run: `bun test && npx tsc --noEmit`
Expected: All tests pass, TypeScript clean.

**Step 5: Commit**

```bash
git add src/host/cli.ts src/host/session-controller.ts src/agents/factory.ts src/agents/agent.ts src/web/server.ts test/host/session-controller.test.ts
git commit -m "feat: wire logger through CLI, SessionController, factory, and WebServer"
```

---

### Task 5: Add LLM call logging to Agent

**Files:**
- Modify: `src/agents/agent.ts` — log LLM calls at debug level with full context

This adds agent-level logging alongside the existing `emitAndLog` calls. The middleware already logs at info level; Agent adds debug-level entries with agentId, request/response details.

**Step 1: Write the failing test**

Add to `test/agents/agent.test.ts`. Find the existing test setup pattern (VCR client, AgentEventEmitter, etc.) and add:

```typescript
test("logs LLM calls at debug level when logger is provided", async () => {
	const { mkdtemp, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { SessionLogger } = await import("../../src/host/logger.ts");

	const tempDir = await mkdtemp(join(tmpdir(), "agent-log-"));
	const logPath = join(tempDir, "session.log.jsonl");
	const logger = new SessionLogger({ logPath, component: "agent" });

	// ... set up agent with logger option, run a simple goal ...
	// ... after agent.run(), flush logger, read log file ...
	// ... assert at least one entry with level "debug" and category "llm" ...

	await rm(tempDir, { recursive: true, force: true });
});
```

The exact test setup depends on the existing test patterns in `test/agents/agent.test.ts`. Match those patterns. The key assertion: after an agent run, the log file contains a debug-level `llm` entry with `agentId` and `model` in the data.

**Step 2: Run test to verify it fails**

Run: `bun test test/agents/agent.test.ts -t "logs LLM calls"`
Expected: FAIL — Agent doesn't create a child logger or write LLM debug entries.

**Step 3: Add logging to Agent**

In `src/agents/agent.ts`:
- Import `Logger` and `NullLogger` from `../host/logger.ts`
- Add `logger?: Logger` to `AgentOptions` (if not already done in Task 4)
- In the constructor, create a child logger:
  ```typescript
  private readonly logger: Logger;
  // In constructor:
  this.logger = (options.logger ?? new NullLogger()).child({
  	component: "agent",
  	agentId: this.agentId ?? this.spec.name,
  	sessionId: this.sessionId,
  	depth: this.depth,
  });
  ```
- In `runLoop()`, after `client.complete()` returns successfully (around line 755-770), add:
  ```typescript
  this.logger.debug("llm", "Plan response received", {
  	model: this.resolved.model,
  	provider: this.resolved.provider,
  	turn: turns,
  	inputTokens: response.usage.input_tokens,
  	outputTokens: response.usage.output_tokens,
  	finishReason: response.finish_reason.reason,
  	messageCount: this.history.length,
  	toolCount: this.agentTools.length + this.primitiveTools.length,
  });
  ```

**Step 4: Run tests**

Run: `bun test test/agents/agent.test.ts`
Expected: All tests pass (existing + new).

**Step 5: Commit**

```bash
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: add debug-level LLM call logging to Agent"
```

---

### Task 6: Verify end-to-end and run full suite

**Step 1: Run the full test suite**

Run: `bun test`
Expected: All tests pass (1543+).

**Step 2: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: Clean, no errors.

**Step 3: Verify log file creation**

Write a quick manual check or add an integration-style test that:
1. Creates a SessionLogger
2. Creates a Client with loggingMiddleware
3. Verifies the log file contains the expected entries after a client.complete() call

This can be a test in `test/host/logger.test.ts` or `test/llm/logging-middleware.test.ts`.

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test: verify end-to-end logging pipeline"
```

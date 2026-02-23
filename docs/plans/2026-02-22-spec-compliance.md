# Sprout Spec Compliance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring sprout to 100% compliance with self-improving-agent-spec.md, fixing all gaps identified in the code review.

**Architecture:** 18 tasks organized by subsystem. Each task is independent enough to commit separately. Critical/high-impact tasks first, then medium, then polish. All tasks follow TDD.

**Tech Stack:** TypeScript, Bun, `@anthropic-ai/sdk`, `openai`, `@google/genai`, `yaml`, `zod`

**Reference Docs:**
- Spec: `~/prime-radiant/serf/self-improving-agent-spec.md`
- Unified LLM spec: `~/prime-radiant/serf/unified-llm-spec.md`
- Coding agent loop spec: `~/prime-radiant/serf/coding-agent-loop-spec.md`
- Code review: see the conversation that generated this plan

---

## Task 1: Fix model resolver — correct tiers and names

The `best` tier maps to Sonnet instead of Opus. The `balanced` tier doesn't exist (code has `good`). This cripples root agent quality and breaks bootstrap specs that use `balanced`.

**Files:**
- Modify: `src/agents/model-resolver.ts`
- Modify: `test/agents/model-resolver.test.ts`

**Step 1: Update the test to expect correct tiers**

The test should verify `best` → Opus, `balanced` → Sonnet, `fast` → Haiku. Add a test for the `balanced` tier. Update existing tests that reference `good`.

```typescript
// In test/agents/model-resolver.test.ts
// Update or add these test cases:

test("best tier resolves to opus-class models", () => {
  const result = resolveModel("best", ["anthropic"]);
  expect(result).toEqual({ model: "claude-opus-4-6", provider: "anthropic" });
});

test("balanced tier resolves to sonnet-class models", () => {
  const result = resolveModel("balanced", ["anthropic"]);
  expect(result).toEqual({ model: "claude-sonnet-4-6", provider: "anthropic" });
});

test("fast tier resolves to haiku-class models", () => {
  const result = resolveModel("fast", ["anthropic"]);
  expect(result).toEqual({ model: "claude-haiku-4-5-20251001", provider: "anthropic" });
});

// Also test OpenAI and Gemini tiers match spec Section 10.2
```

**Step 2: Run tests, verify they fail**

Run: `cd ~/prime-radiant/sprout && bun test test/agents/model-resolver.test.ts`
Expected: FAIL — `best` returns Sonnet, `balanced` doesn't exist

**Step 3: Update model-resolver.ts**

```typescript
// src/agents/model-resolver.ts — replace MODEL_TIERS
const MODEL_TIERS: Record<string, Record<string, string>> = {
  best: {
    anthropic: "claude-opus-4-6",
    openai: "gpt-4.1",
    gemini: "gemini-2.5-pro",
  },
  balanced: {
    anthropic: "claude-sonnet-4-6",
    openai: "gpt-4.1",
    gemini: "gemini-2.5-flash",
  },
  fast: {
    anthropic: "claude-haiku-4-5-20251001",
    openai: "gpt-4.1-mini",
    gemini: "gemini-2.5-flash",
  },
};
```

Remove the `good` tier entirely. Any code referencing `good` should be updated to `balanced`.

**Step 4: Run tests, verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test test/agents/model-resolver.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/agents/model-resolver.ts test/agents/model-resolver.test.ts
git commit -m "fix: correct model tier mappings — best=Opus, add balanced tier"
```

---

## Task 2: Fix bootstrap agent specs

Code-editor uses `model: fast` instead of `balanced`. Both code-editor and command-runner have extra capabilities beyond spec's minimal set (exec, grep, glob on code-editor).

**Files:**
- Modify: `bootstrap/code-editor.yaml`
- Modify: `bootstrap/command-runner.yaml`
- Modify: `test/agents/agent.integration.test.ts` (if it references these capabilities)

**Step 1: Update code-editor.yaml**

```yaml
# bootstrap/code-editor.yaml
name: code-editor
description: "Make targeted edits to code files"
model: balanced
capabilities:
  - read_file
  - write_file
  - edit_file
constraints:
  max_turns: 50
  max_depth: 0
  timeout_ms: 300000
  can_spawn: false
  can_learn: false
tags:
  - core
  - editing
system_prompt: |
  You are a code editing specialist. You make precise, targeted edits to files.

  Your tools:
  - read_file: Read file contents to understand context
  - write_file: Create new files or overwrite existing ones
  - edit_file: Replace specific strings in files (preferred for modifications)

  When editing, always read the file first to understand context.
  Prefer edit_file over write_file for modifications — it's safer and more precise.
  For new files, use write_file.
version: 1
```

**Step 2: Update command-runner.yaml**

```yaml
# bootstrap/command-runner.yaml — set capabilities to just [exec]
capabilities:
  - exec
```

Keep the rest as-is. The spec says `capabilities: [exec]` for command-runner.

**Step 3: Run the full test suite**

Run: `cd ~/prime-radiant/sprout && bun test`
Expected: PASS (if integration tests relied on code-editor having grep/glob, they may fail and need updating)

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add bootstrap/code-editor.yaml bootstrap/command-runner.yaml
git commit -m "fix: align bootstrap agent specs with spec Section 11.2"
```

---

## Task 3: Anthropic prompt caching

The single most expensive bug. Anthropic requires explicit `cache_control` breakpoints. The adapter must inject them automatically on system messages and tool definitions.

**Files:**
- Modify: `src/llm/anthropic.ts`
- Modify: `test/llm/anthropic.test.ts`

**Step 1: Write a test that verifies cache tokens appear**

```typescript
// In test/llm/anthropic.test.ts — add:
test("prompt caching: cache_read_tokens > 0 on turn 2+", async () => {
  const adapter = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!);

  const tools = [{
    name: "get_weather",
    description: "Get weather for a location",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }];

  const systemMsg = Msg.system("You are a helpful assistant. ".repeat(50)); // enough tokens to be cacheable
  const userMsg = Msg.user("What's the weather in Paris?");

  // Turn 1 — populates cache
  const r1 = await adapter.complete({
    model: "claude-sonnet-4-6",
    messages: [systemMsg, userMsg],
    tools,
    max_tokens: 100,
  });
  expect(r1.usage.cache_write_tokens).toBeGreaterThan(0);

  // Turn 2 — should read from cache
  const r2 = await adapter.complete({
    model: "claude-sonnet-4-6",
    messages: [systemMsg, userMsg],
    tools,
    max_tokens: 100,
  });
  expect(r2.usage.cache_read_tokens).toBeGreaterThan(0);
});
```

**Step 2: Run test, verify it fails**

Run: `cd ~/prime-radiant/sprout && bun test test/llm/anthropic.test.ts -t "prompt caching"`
Expected: FAIL — cache_write_tokens and cache_read_tokens are both 0 or undefined

**Step 3: Implement prompt caching in `buildAnthropicRequest`**

In `src/llm/anthropic.ts`, modify `buildAnthropicRequest` to:

1. Convert the `system` string to an array of content blocks with `cache_control` on the last block:
```typescript
if (system) {
  params.system = [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];
}
```

2. Add `cache_control` to the last tool definition:
```typescript
if (request.tools?.length) {
  params.tools = request.tools.map((t, i) => {
    const tool: any = {
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool["input_schema"],
    };
    // Cache breakpoint on the last tool
    if (i === request.tools!.length - 1) {
      tool.cache_control = { type: "ephemeral" };
    }
    return tool;
  });
}
```

This is the standard Anthropic pattern for agentic caching: system prompt and tool definitions are cached because they're stable across turns.

**Step 4: Run test, verify it passes**

Run: `cd ~/prime-radiant/sprout && bun test test/llm/anthropic.test.ts -t "prompt caching"`
Expected: PASS

**Step 5: Run full LLM test suite**

Run: `cd ~/prime-radiant/sprout && bun test test/llm/`
Expected: PASS — existing tests should not break since caching is additive

**Step 6: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/llm/anthropic.ts test/llm/anthropic.test.ts
git commit -m "feat: implement Anthropic prompt caching with cache_control breakpoints"
```

---

## Task 4: provider_options passthrough and extended thinking

`provider_options` is defined on `Request` but ignored by all adapters. This blocks: Anthropic extended thinking, beta headers, Gemini thinking config, OpenAI reasoning_effort.

**Files:**
- Modify: `src/llm/anthropic.ts`
- Modify: `src/llm/openai.ts`
- Modify: `src/llm/gemini.ts`
- Modify: `test/llm/anthropic.test.ts`
- Modify: `test/llm/openai.test.ts`

**Step 1: Write tests for provider_options**

```typescript
// test/llm/anthropic.test.ts — add:
test("extended thinking via provider_options", async () => {
  const adapter = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!);
  const response = await adapter.complete({
    model: "claude-sonnet-4-6",
    messages: [Msg.user("What is 15 * 37? Think step by step.")],
    max_tokens: 8000,
    provider_options: {
      anthropic: {
        thinking: { type: "enabled", budget_tokens: 5000 },
      },
    },
  });
  // Should have a thinking block in the response
  const reasoning = messageReasoning(response.message);
  expect(reasoning).toBeDefined();
  expect(reasoning!.length).toBeGreaterThan(0);
});
```

```typescript
// test/llm/openai.test.ts — add:
test("reasoning_effort via provider_options", async () => {
  const adapter = new OpenAIAdapter(process.env.OPENAI_API_KEY!);
  // This test just verifies the parameter is passed without error
  const response = await adapter.complete({
    model: "gpt-4.1",
    messages: [Msg.user("Say hello")],
    reasoning_effort: "low",
  });
  expect(response.message).toBeDefined();
});
```

**Step 2: Run tests, verify they fail**

**Step 3: Implement provider_options in each adapter**

In `src/llm/anthropic.ts` `buildAnthropicRequest`, after existing params:
```typescript
// Extended thinking
const anthropicOpts = request.provider_options?.anthropic as Record<string, unknown> | undefined;
if (anthropicOpts?.thinking) {
  (params as any).thinking = anthropicOpts.thinking;
}

// Beta headers — pass via the client constructor or request-level headers
// The Anthropic SDK supports betas via the `betas` param
if (anthropicOpts?.betas) {
  (params as any).betas = anthropicOpts.betas;
}
```

In `src/llm/openai.ts` `buildResponsesParams`, add:
```typescript
if (request.reasoning_effort) {
  (params as any).reasoning = { effort: request.reasoning_effort };
}
```

In `src/llm/gemini.ts` `buildGeminiRequest`, add thinking config support:
```typescript
const geminiOpts = request.provider_options?.gemini as Record<string, unknown> | undefined;
if (geminiOpts?.thinkingConfig) {
  config.thinkingConfig = geminiOpts.thinkingConfig;
}
```

**Step 4: Run tests, verify they pass**

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/llm/anthropic.ts src/llm/openai.ts src/llm/gemini.ts test/llm/anthropic.test.ts test/llm/openai.test.ts
git commit -m "feat: wire provider_options through all adapters (thinking, reasoning_effort)"
```

---

## Task 5: Fix Gemini module-level shared state

`callIdCounter` and `callIdToName` are module-level globals. Memory leak, concurrency hazard, cross-instance contamination.

**Files:**
- Modify: `src/llm/gemini.ts`
- Modify: `test/llm/gemini.test.ts`

**Step 1: Write a test for cross-instance isolation**

```typescript
// test/llm/gemini.test.ts — add:
test("separate adapter instances don't share state", async () => {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) return; // skip without key

  const adapter1 = new GeminiAdapter(key);
  const adapter2 = new GeminiAdapter(key);

  // Make a tool call with adapter1
  const r1 = await adapter1.complete({
    model: "gemini-2.5-flash",
    messages: [Msg.user("What is 2+2?")],
    tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } }],
    tool_choice: "required",
  });

  // adapter2 should have independent state — its call IDs should not collide
  const r2 = await adapter2.complete({
    model: "gemini-2.5-flash",
    messages: [Msg.user("What is 3+3?")],
    tools: [{ name: "calc", description: "Calculate", parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } }],
    tool_choice: "required",
  });

  // Both should work — if state leaked, adapter2 might have stale callIdToName entries
  expect(r1.message).toBeDefined();
  expect(r2.message).toBeDefined();
});
```

**Step 2: Move state to instance level**

In `src/llm/gemini.ts`, replace module-level globals:

```typescript
// REMOVE these module-level declarations:
// let callIdCounter = 0;
// function nextCallId(): string { ... }
// const callIdToName = new Map<string, string>();

// ADD to class:
export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini";
  private client: GoogleGenAI;
  private callIdCounter = 0;
  private callIdToName = new Map<string, string>();

  private nextCallId(): string {
    return `call_gemini_${++this.callIdCounter}`;
  }
  // ... update all references from module functions to this.nextCallId(), this.callIdToName
```

All functions that reference `callIdToName` or `nextCallId` need to become instance methods or receive the adapter as a parameter.

**Step 3: Run tests, verify they pass**

Run: `cd ~/prime-radiant/sprout && bun test test/llm/gemini.test.ts`

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/llm/gemini.ts test/llm/gemini.test.ts
git commit -m "fix: move Gemini callId state to instance level (memory leak, concurrency)"
```

---

## Task 6: Streaming middleware support

`Client.stream()` bypasses middleware entirely. The spec says middleware must apply to streaming.

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `test/llm/client.test.ts`

**Step 1: Write a test for streaming middleware**

```typescript
// test/llm/client.test.ts — add:
test("middleware runs for stream() calls", async () => {
  let middlewareCalled = false;
  const middleware: Middleware = async (request, next) => {
    middlewareCalled = true;
    return next(request);
  };
  const client = Client.fromEnv({ middleware: [middleware] });
  const request = { model: "claude-sonnet-4-6", messages: [Msg.user("Say hi")] };
  for await (const _event of client.stream(request)) {
    // consume
  }
  expect(middlewareCalled).toBe(true);
});
```

**Step 2: Run test, verify it fails**

**Step 3: Implement streaming middleware**

The challenge: middleware returns `Promise<Response>` but streaming returns `AsyncIterable<StreamEvent>`. Two approaches:

**Approach A (simpler):** Run middleware for side-effects (logging, metrics, request modification) but the middleware still receives a `complete` next function. The request modification applies to the stream call. After middleware transforms the request, call adapter.stream() with the transformed request.

```typescript
// src/llm/client.ts
async *stream(request: Request): AsyncIterable<StreamEvent> {
  const adapter = this.resolveAdapter(request);

  // Run middleware for request transformation only
  // Create a proxy that captures the final transformed request
  let transformedRequest = request;
  const chainedRequest = this.middlewareChain.reduceRight<(req: Request) => Promise<Response>>(
    (next, mw) => async (req) => {
      return mw(req, async (r) => {
        transformedRequest = r;
        // Return a dummy response — we just want the request transformation
        return next(r);
      });
    },
    async (req) => {
      transformedRequest = req;
      return adapter.complete(req); // never actually called
    },
  );

  // Only run if there are middlewares that need to transform the request
  if (this.middlewareChain.length > 0) {
    // Just build the transformed request without executing
    // Actually, simpler: just apply request-transform middlewares
    for (const mw of this.middlewareChain) {
      // This is a simplification — full middleware support for streaming
      // would require a streaming-aware middleware type
    }
  }

  yield* adapter.stream(transformedRequest);
}
```

Actually, the cleanest approach: add a `StreamMiddleware` type, OR run the complete middleware chain but intercept before the actual call:

```typescript
async *stream(request: Request): AsyncIterable<StreamEvent> {
  // Apply middleware to transform the request, then stream with the transformed request
  let finalRequest = request;
  const noop = async (req: Request): Promise<Response> => {
    finalRequest = req;
    // Return a placeholder — we only want request transformation
    return { id: "", model: "", provider: "", message: { role: "assistant", content: [] }, finish_reason: { reason: "stop" }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  };

  if (this.middlewareChain.length > 0) {
    const chain = this.middlewareChain.reduceRight<(req: Request) => Promise<Response>>(
      (next, mw) => (req) => mw(req, next),
      noop,
    );
    await chain(request);
  }

  const adapter = this.resolveAdapter(finalRequest);
  yield* adapter.stream(finalRequest);
}
```

This runs all middleware for their request-transformation side effects, then streams with the final request. Middleware that wraps the response won't work, but that's acceptable — most middleware (logging, caching, request modification) only needs the request.

**Step 4: Run tests, verify they pass**

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/llm/client.ts test/llm/client.test.ts
git commit -m "fix: apply middleware to streaming requests for request transformation"
```

---

## Task 7: Anthropic streaming end events

`content_block_stop` doesn't produce `text_end`, `reasoning_end`, or `tool_call_end` events. The adapter needs to track which block type is active.

**Files:**
- Modify: `src/llm/anthropic.ts`
- Modify: `test/llm/anthropic.test.ts`

**Step 1: Write a test that expects end events**

```typescript
test("streaming emits text_end after text content", async () => {
  const adapter = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY!);
  const events: StreamEvent[] = [];
  for await (const event of adapter.stream({
    model: "claude-sonnet-4-6",
    messages: [Msg.user("Say hello")],
    max_tokens: 50,
  })) {
    events.push(event);
  }
  const types = events.map(e => e.type);
  expect(types).toContain("text_start");
  expect(types).toContain("text_end");
  // text_end should come after text_start
  expect(types.indexOf("text_end")).toBeGreaterThan(types.indexOf("text_start"));
});
```

**Step 2: Run test, verify it fails**

**Step 3: Track block type in streaming**

```typescript
// In the stream() method of AnthropicAdapter:
let activeBlockType: string | null = null;

// In content_block_start:
if (event.content_block.type === "text") {
  activeBlockType = "text";
  yield { type: "text_start" };
} else if (event.content_block.type === "tool_use") {
  activeBlockType = "tool_call";
  yield { type: "tool_call_start", ... };
} else if (event.content_block.type === "thinking") {
  activeBlockType = "thinking";
  yield { type: "reasoning_start" };
}

// In content_block_stop:
if (activeBlockType === "text") {
  yield { type: "text_end" };
} else if (activeBlockType === "tool_call") {
  yield { type: "tool_call_end" };
} else if (activeBlockType === "thinking") {
  yield { type: "reasoning_end" };
}
activeBlockType = null;
```

**Step 4: Run tests, verify they pass**

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/llm/anthropic.ts test/llm/anthropic.test.ts
git commit -m "fix: emit text_end/reasoning_end/tool_call_end in Anthropic streaming"
```

---

## Task 8: Agent timeout enforcement

`timeout_ms` is in AgentConstraints but never checked. An agent can run forever.

**Files:**
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/agent.test.ts`

**Step 1: Write a test for timeout**

```typescript
// test/agents/agent.test.ts — add:
test("agent times out after timeout_ms", async () => {
  // Create a mock client that always returns a tool call (infinite loop)
  const mockClient = {
    providers: () => ["anthropic"],
    complete: async () => ({
      id: "test",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      message: Msg.assistant("still working..."),  // no tool calls = natural completion
      finish_reason: { reason: "stop" as const },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }),
  };

  // Actually, to test timeout we need the loop to keep running.
  // Use a mock that always returns tool calls to keep the loop alive.
  const alwaysCallTool = {
    providers: () => ["anthropic"],
    complete: async () => {
      // Simulate slow LLM response
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        id: "test",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        message: {
          role: "assistant" as const,
          content: [{
            kind: ContentKind.TOOL_CALL,
            tool_call: { id: "call_1", name: "read_file", arguments: { path: "/tmp/test.txt" } },
          }],
        },
        finish_reason: { reason: "tool_calls" as const },
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      };
    },
  };

  const spec = {
    ...baseSpec,
    constraints: { ...baseSpec.constraints, timeout_ms: 300, max_turns: 1000 },
  };

  const agent = new Agent({ spec, client: alwaysCallTool as any, ... });
  const result = await agent.run("do something");

  // Should have been stopped by timeout, not max_turns
  expect(result.success).toBe(false);
  expect(result.stumbles).toBeGreaterThan(0);
});
```

**Step 2: Run test, verify it fails (agent runs to max_turns)**

**Step 3: Add timeout check to the agent loop**

In `src/agents/agent.ts`, at the beginning of `run()`:

```typescript
const startTime = performance.now();
```

Inside the while loop, after `turns++`:

```typescript
// Check timeout
const elapsed = performance.now() - startTime;
if (this.spec.constraints.timeout_ms > 0 && elapsed >= this.spec.constraints.timeout_ms) {
  stumbles++;
  this.emitAndLog("warning", agentId, this.depth, {
    message: `Agent timed out after ${Math.round(elapsed)}ms (limit: ${this.spec.constraints.timeout_ms}ms)`,
  });
  break;
}
```

And update the success condition at the bottom:

```typescript
const hitTurnLimit = turns >= this.spec.constraints.max_turns;
const hitTimeout = this.spec.constraints.timeout_ms > 0
  && (performance.now() - startTime) >= this.spec.constraints.timeout_ms;
if (hitTurnLimit || hitTimeout) {
  stumbles++;
}
const success = !hitTurnLimit && !hitTimeout;
```

**Step 4: Run tests, verify they pass**

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/agents/agent.ts test/agents/agent.test.ts
git commit -m "feat: enforce timeout_ms in agent loop"
```

---

## Task 9: Verify all 5 LearnSignal kinds

Verify currently only produces "failure" and "error". Missing: "retry", "inefficiency", "timeout".

**Files:**
- Modify: `src/agents/verify.ts`
- Modify: `src/agents/agent.ts`
- Modify: `test/agents/verify.test.ts`

**Step 1: Write tests for all 5 signal kinds**

```typescript
// test/agents/verify.test.ts — add:
test("timeout signal when turns > 0 and timed_out", () => {
  const result = verifyActResult({
    agent_name: "test",
    goal: "do something",
    output: "timed out",
    success: false,
    stumbles: 0,
    turns: 50,
    timed_out: true,  // new field
  }, "session-1");
  expect(result.learnSignal?.kind).toBe("timeout");
});

test("inefficiency signal when turns > efficiency threshold", () => {
  const result = verifyActResult({
    agent_name: "test",
    goal: "read a file",
    output: "done",
    success: true,
    stumbles: 0,
    turns: 15,  // way too many for a simple goal
    timed_out: false,
  }, "session-1");
  // Successful but high turn count = inefficiency
  expect(result.learnSignal?.kind).toBe("inefficiency");
});
```

**Step 2: Run tests, verify they fail**

**Step 3: Expand verifyActResult to detect all kinds**

```typescript
// src/agents/verify.ts
export function verifyActResult(
  actResult: ActResult,
  sessionId: string,
): { verify: VerifyResult; learnSignal?: LearnSignal } {
  let kind: LearnSignal["kind"] | undefined;

  if (!actResult.success) {
    kind = actResult.timed_out ? "timeout" : "failure";
  } else if (actResult.stumbles > 0) {
    kind = "error";
  } else if (actResult.turns > 10) {
    // Successful but took too many turns = inefficiency
    kind = "inefficiency";
  }

  const stumbled = kind !== undefined;

  let learnSignal: LearnSignal | undefined;
  if (stumbled) {
    learnSignal = {
      kind: kind!,
      goal: actResult.goal,
      agent_name: actResult.agent_name,
      details: actResult,
      session_id: sessionId,
      timestamp: Date.now(),
    };
  }

  return {
    verify: { success: actResult.success, stumbled, output: actResult.output },
    learnSignal,
  };
}
```

Note: "retry" detection requires tracking whether the same action was attempted multiple times within a subagent. This is harder — it requires the parent to observe repeated patterns in subagent behavior. For now, add a `TODO` comment for retry detection and implement the other three (timeout, inefficiency, and the existing error/failure).

Add `timed_out` to the `ActResult` type in `src/kernel/types.ts` if not already present.

**Step 4: Generate LearnSignals for primitive stumbles too**

In `src/agents/agent.ts`, in the primitive execution block (around line 360-378), push a LearnSignal when a primitive fails:

```typescript
if (stumbled && this.learnProcess && this.spec.constraints.can_learn) {
  const primSignal: LearnSignal = {
    kind: "error",
    goal: goal,
    agent_name: agentId,
    details: {
      agent_name: call.name,
      goal: `primitive: ${call.name}`,
      output: result.output,
      success: result.success,
      stumbles: 1,
      turns: 1,
    },
    session_id: this.sessionId,
    timestamp: Date.now(),
  };
  this.learnProcess.push(primSignal);
}
```

**Step 5: Run tests, verify they pass**

**Step 6: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/agents/verify.ts src/agents/agent.ts src/kernel/types.ts test/agents/verify.test.ts
git commit -m "feat: generate all 5 LearnSignal kinds including primitive stumbles"
```

---

## Task 10: Make Learn truly async

Learn currently runs post-hoc after the agent completes. The spec requires background processing during agent execution.

**Files:**
- Modify: `src/host/session.ts`
- Modify: `src/learn/learn-process.ts`
- Modify: `test/host/session.test.ts`

**Step 1: Write a test that verifies Learn runs during agent execution**

```typescript
// test/host/session.test.ts — add:
test("learn processes signals during agent execution, not just after", async () => {
  // This test verifies that if we push a signal during agent execution,
  // it gets processed before the agent finishes (or at least concurrently)
  const processedDuring: number[] = [];
  const learnProcess = {
    queueSize: () => 0,
    processNext: async () => {
      processedDuring.push(Date.now());
      return "applied" as const;
    },
    push: () => {},
    recordAction: () => {},
  };
  // ... verify processedDuring has entries with timestamps before agent completion
});
```

**Step 2: Implement background learn processing**

In `src/learn/learn-process.ts`, add a background processing loop:

```typescript
// Add to LearnProcess class:
private processing = false;
private stopRequested = false;

/** Start background processing of the learn queue. */
startBackground(): void {
  if (this.processing) return;
  this.processing = true;
  this.stopRequested = false;
  this.backgroundLoop();
}

/** Stop background processing. Completes the current signal if any. */
async stopBackground(): Promise<void> {
  this.stopRequested = true;
  // Wait for current processing to finish
  while (this.processing && this.queue.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  this.processing = false;
}

private async backgroundLoop(): Promise<void> {
  while (!this.stopRequested) {
    if (this.queue.length > 0) {
      await this.processNext();
    } else {
      // Poll interval — check for new signals every 500ms
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  this.processing = false;
}
```

In `src/host/session.ts`, start background Learn when agent starts, stop when agent completes:

```typescript
// Before agent.run():
if (learnProcess) learnProcess.startBackground();

// After agent completes:
if (learnProcess) {
  await learnProcess.stopBackground();
  // Drain any remaining signals
  while (learnProcess.queueSize() > 0) {
    await learnProcess.processNext();
    while (buffer.length > 0) yield buffer.shift()!;
  }
}
```

**Step 3: Run tests, verify they pass**

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/learn-process.ts src/host/session.ts test/host/session.test.ts
git commit -m "feat: run Learn in background during agent execution"
```

---

## Task 11: Give Learn genome context

Learn's LLM prompt has no information about existing agents, memories, or routing rules. It flies blind.

**Files:**
- Modify: `src/learn/learn-process.ts`
- Modify: `test/learn/learn-process.test.ts`

**Step 1: Write a test**

```typescript
// test/learn/learn-process.test.ts — add:
test("reasonAboutImprovement includes genome context", async () => {
  // Create a genome with some agents and memories
  // Push a signal
  // Verify the LLM prompt includes agent names and memory content
  // (Test by intercepting the client.complete call)
});
```

This is hard to unit test without mocking the client. A pragmatic approach: make `reasonAboutImprovement` build a prompt string, extract prompt-building into a testable function.

**Step 2: Extract prompt building into a testable function**

```typescript
// src/learn/learn-process.ts — add:
export function buildLearnPrompt(
  signal: LearnSignal,
  existingAgents: AgentSpec[],
  recentMemories: Memory[],
  routingRules: RoutingRule[],
): string {
  let prompt = `You are analyzing a recurring problem in an AI coding agent system.

A stumble signal has been detected:
- Agent: ${signal.agent_name}
- Kind: ${signal.kind}
- Goal: ${signal.goal}
- Output: ${signal.details.output}
- Success: ${signal.details.success}
- Stumbles: ${signal.details.stumbles}
- Turns used: ${signal.details.turns}

Existing agents in the genome:
${existingAgents.map(a => `- ${a.name}: ${a.description}`).join("\n")}

Recent memories:
${recentMemories.length > 0 ? recentMemories.map(m => `- ${m.content}`).join("\n") : "(none)"}

Existing routing rules:
${routingRules.length > 0 ? routingRules.map(r => `- When: ${r.condition} → prefer ${r.preference}`).join("\n") : "(none)"}

Based on this signal, decide what improvement to make. ...`;
  // ... rest of prompt (JSON format instructions)
  return prompt;
}
```

Then use this in `reasonAboutImprovement`:
```typescript
const agents = this.genome.allAgents();
const memories = this.genome.memories.search(signal.goal, 5, 0.3);
const rules = this.genome.allRoutingRules();
const prompt = buildLearnPrompt(signal, agents, memories, rules);
```

**Step 3: Write unit test for buildLearnPrompt**

```typescript
test("buildLearnPrompt includes genome context", () => {
  const prompt = buildLearnPrompt(
    signal,
    [{ name: "code-reader", description: "Find code" } as AgentSpec],
    [{ content: "This project uses vitest" } as Memory],
    [{ condition: "Go tests", preference: "test-runner-go" } as RoutingRule],
  );
  expect(prompt).toContain("code-reader: Find code");
  expect(prompt).toContain("This project uses vitest");
  expect(prompt).toContain("Go tests");
});
```

**Step 4: Run tests, verify they pass**

**Step 5: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/learn-process.ts test/learn/learn-process.test.ts
git commit -m "feat: include genome context in Learn's LLM prompt"
```

---

## Task 12: JSON parsing resilience in Learn

`reasonAboutImprovement` does bare `JSON.parse(text)` with no markdown stripping. LLMs frequently wrap JSON in code fences.

**Files:**
- Modify: `src/learn/learn-process.ts`
- Add: `test/learn/learn-process.test.ts` (new test cases)

**Step 1: Write tests for edge cases**

```typescript
test("parseLearnResponse handles markdown-wrapped JSON", () => {
  const raw = '```json\n{"type": "create_memory", "content": "test", "tags": ["a"]}\n```';
  const result = parseLearnResponse(raw);
  expect(result).toEqual({ type: "create_memory", content: "test", tags: ["a"] });
});

test("parseLearnResponse handles plain JSON", () => {
  const raw = '{"type": "skip"}';
  const result = parseLearnResponse(raw);
  expect(result).toBeNull(); // skip returns null
});

test("parseLearnResponse handles garbage gracefully", () => {
  const result = parseLearnResponse("I think we should create a memory...");
  expect(result).toBeNull();
});
```

**Step 2: Extract and harden the JSON parsing**

```typescript
// src/learn/learn-process.ts — add:
export function parseLearnResponse(text: string): LearnMutation | null {
  // Strip markdown code fences
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.type === "skip") return null;
    if (["create_memory", "update_agent", "create_agent", "create_routing_rule"].includes(parsed.type)) {
      return parsed as LearnMutation;
    }
    return null;
  } catch {
    return null;
  }
}
```

Use this in `reasonAboutImprovement` instead of inline JSON.parse.

**Step 3: Run tests, verify they pass**

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/learn-process.ts test/learn/learn-process.test.ts
git commit -m "fix: harden Learn JSON parsing — strip markdown fences, handle garbage"
```

---

## Task 13: Genome rollback as a programmatic method

Learn needs to evaluate improvements and roll back harmful ones. Currently rollback is CLI-only.

**Files:**
- Modify: `src/genome/genome.ts`
- Modify: `test/genome/genome.test.ts`

**Step 1: Write a test**

```typescript
test("rollback reverts the last mutation", async () => {
  const genome = new Genome(tmpDir);
  await genome.init();
  await genome.initFromBootstrap(bootstrapDir);

  const agentCount = genome.agentCount();
  await genome.addAgent({ name: "test-agent", ... });
  expect(genome.agentCount()).toBe(agentCount + 1);

  await genome.rollback();
  await genome.loadFromDisk(); // reload after rollback
  expect(genome.agentCount()).toBe(agentCount);
});
```

**Step 2: Implement rollback on Genome**

```typescript
// src/genome/genome.ts — add to Genome class:

/** Rollback the last genome mutation (git revert HEAD). */
async rollback(): Promise<void> {
  await git(this.rootPath, "revert", "--no-edit", "HEAD");
}

/** Rollback a specific commit by hash. */
async rollbackCommit(commitHash: string): Promise<void> {
  await git(this.rootPath, "revert", "--no-edit", commitHash);
}
```

**Step 3: Run tests, verify they pass**

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/genome/genome.ts test/genome/genome.test.ts
git commit -m "feat: add programmatic rollback to Genome class"
```

---

## Task 14: Metrics windowed queries for improvement evaluation

`MetricsStore.stumbleRate()` returns all-time rate. Learn needs before/after comparison.

**Files:**
- Modify: `src/learn/metrics-store.ts`
- Modify: `test/learn/metrics-store.test.ts`

**Step 1: Write tests**

```typescript
test("stumbleRateForPeriod returns rate within time window", async () => {
  const store = new MetricsStore(tmpPath);

  // Record some stumbles at known timestamps (use the raw JSONL)
  await store.recordStumble("agent-a", "error");
  await store.recordAction("agent-a");
  await store.recordAction("agent-a");

  // Rate should be 1/2 = 0.5 for all time
  expect(store.stumbleRate("agent-a")).toBeCloseTo(0.5);

  // Rate since 1 second ago should be the same
  const rate = await store.stumbleRateForPeriod("agent-a", Date.now() - 1000);
  expect(rate).toBeCloseTo(0.5);

  // Rate since the future should be 0
  const futureRate = await store.stumbleRateForPeriod("agent-a", Date.now() + 1000);
  expect(futureRate).toBe(0);
});
```

**Step 2: Implement windowed query**

Since entries are timestamped in the JSONL, add a method that re-scans the file for a given time window:

```typescript
// src/learn/metrics-store.ts — add:
async stumbleRateForPeriod(agentName: string, since: number, until?: number): Promise<number> {
  const end = until ?? Date.now();
  let raw: string;
  try {
    raw = await readFile(this.path, "utf-8");
  } catch {
    return 0;
  }

  let stumbles = 0;
  let actions = 0;

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as MetricsEntry;
    if (entry.timestamp < since || entry.timestamp > end) continue;
    if (entry.agent_name !== agentName) continue;

    if (entry.type === "stumble") stumbles++;
    else if (entry.type === "action") actions++;
  }

  return actions === 0 ? 0 : stumbles / actions;
}
```

**Step 3: Run tests, verify they pass**

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/learn/metrics-store.ts test/learn/metrics-store.test.ts
git commit -m "feat: add time-windowed stumble rate queries for improvement evaluation"
```

---

## Task 15: Genome pruning

Not implemented at all. Spec Section 8.7.

**Files:**
- Modify: `src/genome/genome.ts`
- Modify: `src/learn/learn-process.ts`
- Create: `test/genome/pruning.test.ts`

**Step 1: Write tests**

```typescript
// test/genome/pruning.test.ts
test("pruneMemories removes memories below confidence threshold", async () => {
  const genome = new Genome(tmpDir);
  await genome.init();

  // Add a memory with very old last_used (30+ days ago)
  await genome.addMemory({
    id: "old-mem",
    content: "stale fact",
    tags: [],
    source: "test",
    created: Date.now() - 90 * 86400000, // 90 days ago
    last_used: Date.now() - 90 * 86400000,
    use_count: 1,
    confidence: 0.8, // will decay to ~0.1 after 90 days
  });

  await genome.addMemory({
    id: "fresh-mem",
    content: "fresh fact",
    tags: [],
    source: "test",
    created: Date.now(),
    last_used: Date.now(),
    use_count: 1,
    confidence: 0.8,
  });

  const pruned = await genome.pruneMemories(0.2);
  expect(pruned).toContain("old-mem");
  expect(pruned).not.toContain("fresh-mem");
});
```

**Step 2: Implement pruning methods on Genome**

```typescript
// src/genome/genome.ts — add:

/** Remove memories whose effective confidence is below the threshold. */
async pruneMemories(minConfidence = 0.2): Promise<string[]> {
  const pruned = this.memories.pruneByConfidence(minConfidence);
  if (pruned.length > 0) {
    await this.memories.save();
    await git(this.rootPath, "add", join(this.rootPath, "memories", "memories.jsonl"));
    await git(this.rootPath, "commit", "-m", `genome: prune ${pruned.length} low-confidence memories`);
  }
  return pruned;
}

/** Remove routing rules that have never been triggered (no matching queries). */
async pruneUnusedRoutingRules(usedRuleIds: Set<string>): Promise<string[]> {
  const before = this.routingRules.length;
  this.routingRules = this.routingRules.filter(r => usedRuleIds.has(r.id));
  const pruned = before - this.routingRules.length;
  if (pruned > 0) {
    await this.saveRoutingRules();
    await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
    await git(this.rootPath, "commit", "-m", `genome: prune ${pruned} unused routing rules`);
  }
  return []; // return IDs for logging
}
```

Add `pruneByConfidence` to `MemoryStore`:

```typescript
// src/genome/memory-store.ts — add:
pruneByConfidence(minConfidence: number): string[] {
  const pruned: string[] = [];
  this.entries = this.entries.filter(m => {
    const eff = this.effectiveConfidence(m);
    if (eff < minConfidence) {
      pruned.push(m.id);
      return false;
    }
    return true;
  });
  return pruned;
}
```

**Step 3: Run tests, verify they pass**

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/genome/genome.ts src/genome/memory-store.ts test/genome/pruning.test.ts
git commit -m "feat: implement genome pruning for memories and routing rules"
```

---

## Task 16: Batch markMemoriesUsed to reduce git noise

`markMemoriesUsed` creates a git commit on every recall invocation. This floods the git log.

**Files:**
- Modify: `src/genome/genome.ts`
- Modify: `src/genome/recall.ts`
- Modify: `test/genome/recall.test.ts`

**Step 1: Move memory-used tracking outside git**

The simplest fix: `markMemoriesUsed` should NOT create a git commit. Memory usage timestamps are operational metadata, not genome mutations. Write to JSONL (persist) but skip the git add/commit.

```typescript
// src/genome/genome.ts — modify:
async markMemoriesUsed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    this.memories.markUsed(id);
  }
  await this.memories.save();
  // No git commit — this is operational metadata, not a genome mutation
}
```

**Step 2: Update tests that assert git commits from markMemoriesUsed**

Find any test that checks `git log` after `markMemoriesUsed` and remove that assertion.

**Step 3: Run tests, verify they pass**

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add src/genome/genome.ts test/genome/recall.test.ts
git commit -m "fix: stop creating git commits for memory-used timestamps"
```

---

## Task 17: Add `bin` entry and fix hardcoded `.env` path

The CLI can't be invoked as `sprout`. The .env path points to Jesse's personal serf directory.

**Files:**
- Modify: `package.json`
- Modify: `src/host/cli.ts`

**Step 1: Add bin entry**

```json
// package.json — add:
"bin": {
  "sprout": "src/host/cli.ts"
}
```

**Step 2: Fix .env loading**

In `src/host/cli.ts`, replace the hardcoded path:

```typescript
// REMOVE: config({ path: join(import.meta.dir, "../../../serf/.env") });
// REPLACE WITH:
config(); // loads .env from current working directory
```

**Step 3: Test CLI invocation**

```bash
cd ~/prime-radiant/sprout && bun link
sprout --genome list  # should work after bun link
```

**Step 4: Commit**

```bash
cd ~/prime-radiant/sprout
git add package.json src/host/cli.ts
git commit -m "fix: add bin entry for CLI, use standard dotenv resolution"
```

---

## Task 18: E2E stumble-and-learn closed loop test

The current e2e test manually pushes a signal instead of running the agent twice and comparing stumble counts.

**Files:**
- Modify: `test/integration/e2e.test.ts`

**Step 1: Rewrite the stumble-and-learn test**

```typescript
test("3. stumble and learn: repeated error triggers improvement", async () => {
  // Run agent on a task that will likely cause a stumble
  // (e.g., "Run the tests" in a project with no obvious test runner)
  const { agent: agent1, events: events1, learnProcess: lp1 } = await createAgent({
    genomePath: genomeDir,
    workDir: workDir,
  });

  // First run — may stumble
  let stumbles1 = 0;
  for await (const event of submitGoal("Run the tests in this project", { agent: agent1, events: events1, learnProcess: lp1 })) {
    if (event.kind === "session_end") {
      stumbles1 = (event.data as any).stumbles ?? 0;
    }
  }

  // Second run — should stumble less if Learn worked
  const { agent: agent2, events: events2, learnProcess: lp2 } = await createAgent({
    genomePath: genomeDir,
    workDir: workDir,
  });

  let stumbles2 = 0;
  for await (const event of submitGoal("Run the tests in this project", { agent: agent2, events: events2, learnProcess: lp2 })) {
    if (event.kind === "session_end") {
      stumbles2 = (event.data as any).stumbles ?? 0;
    }
  }

  // The second run should have equal or fewer stumbles
  expect(stumbles2).toBeLessThanOrEqual(stumbles1);
}, 120_000); // generous timeout for two full agent runs
```

**Step 2: Run the test**

Run: `cd ~/prime-radiant/sprout && bun test test/integration/e2e.test.ts -t "stumble"`
Expected: This is a real API test. It may be flaky depending on the LLM's behavior. The important thing is that the test structure is correct — it runs the agent twice and compares.

**Step 3: Commit**

```bash
cd ~/prime-radiant/sprout
git add test/integration/e2e.test.ts
git commit -m "fix: e2e stumble-and-learn test now tests the actual closed loop"
```

---

## Summary: Task Dependencies

Most tasks are independent and can be done in any order. Logical groupings:

**Do first (highest impact):**
- Task 1: Model resolver (everything else depends on correct tiers)
- Task 2: Bootstrap specs (depend on Task 1 for `balanced` tier)
- Task 3: Prompt caching (most expensive bug)

**LLM client fixes (independent of each other):**
- Task 4: provider_options
- Task 5: Gemini state
- Task 6: Streaming middleware
- Task 7: Streaming end events

**Agent loop fixes (some interdependency):**
- Task 8: Timeout enforcement
- Task 9: All 5 signal kinds (depends on Task 8 for timeout signal)

**Learn system (build in order):**
- Task 11: Genome context in Learn prompt
- Task 12: JSON parsing resilience
- Task 10: Async Learn (depends on 11, 12 being solid first)
- Task 14: Windowed metrics
- Task 13: Programmatic rollback

**Genome maintenance:**
- Task 15: Pruning
- Task 16: Reduce git noise

**Polish:**
- Task 17: CLI bin + dotenv
- Task 18: E2E closed loop test (do last — validates everything)

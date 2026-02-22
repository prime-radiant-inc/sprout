# Phase 3: Core Loop + Bootstrap Agents — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the core agent loop (Perceive -> Plan -> Act -> Verify) with bootstrap agents that can decompose and execute coding tasks via real LLM calls.

**Architecture:** Single `Agent` class runs the recursive loop. Plan maps agents-as-tools + primitives-as-tools, calls LLM, dispatches results. Subagents are new Agent instances with shared ExecutionEnvironment. Verify detects stumbles and queues LearnSignals (logged only, not processed until Phase 6).

**Tech Stack:** TypeScript on Bun, existing LLM Client + primitives from Phases 1-2, `yaml` npm package for AgentSpec loading.

---

### Task 1: EventEmitter

Typed event emitter for SessionEvents. Callback-based, simple.

**Files:**
- Create: `src/agents/events.ts`
- Test: `test/agents/events.test.ts`

**Step 1: Write failing test**

```typescript
// test/agents/events.test.ts
import { describe, expect, test } from "bun:test";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";

describe("AgentEventEmitter", () => {
	test("emit delivers events to listeners", () => {
		const emitter = new AgentEventEmitter();
		const received: SessionEvent[] = [];
		emitter.on((e) => received.push(e));

		emitter.emit("session_start", "agent-1", 0, { goal: "test" });

		expect(received).toHaveLength(1);
		expect(received[0]!.kind).toBe("session_start");
		expect(received[0]!.agent_id).toBe("agent-1");
		expect(received[0]!.depth).toBe(0);
		expect(received[0]!.data.goal).toBe("test");
	});

	test("unsubscribe removes listener", () => {
		const emitter = new AgentEventEmitter();
		const received: SessionEvent[] = [];
		const unsub = emitter.on((e) => received.push(e));

		emitter.emit("plan_start", "a", 0);
		unsub();
		emitter.emit("plan_end", "a", 0);

		expect(received).toHaveLength(1);
	});

	test("multiple listeners all receive events", () => {
		const emitter = new AgentEventEmitter();
		let count1 = 0;
		let count2 = 0;
		emitter.on(() => count1++);
		emitter.on(() => count2++);

		emitter.emit("perceive", "a", 0);

		expect(count1).toBe(1);
		expect(count2).toBe(1);
	});

	test("collected() returns all emitted events", () => {
		const emitter = new AgentEventEmitter();
		emitter.emit("session_start", "a", 0);
		emitter.emit("plan_start", "a", 0);
		emitter.emit("session_end", "a", 0);

		expect(emitter.collected()).toHaveLength(3);
		expect(emitter.collected()[0]!.kind).toBe("session_start");
	});
});
```

**Step 2: Run test, verify it fails**

Run: `bun test test/agents/events.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

```typescript
// src/agents/events.ts
import type { EventKind, SessionEvent } from "../kernel/types.ts";

export type EventListener = (event: SessionEvent) => void;

export class AgentEventEmitter {
	private listeners: EventListener[] = [];
	private events: SessionEvent[] = [];

	on(listener: EventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const idx = this.listeners.indexOf(listener);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	emit(kind: EventKind, agentId: string, depth: number, data: Record<string, unknown> = {}): void {
		const event: SessionEvent = {
			kind,
			timestamp: Date.now(),
			agent_id: agentId,
			depth,
			data,
		};
		this.events.push(event);
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	collected(): SessionEvent[] {
		return [...this.events];
	}
}
```

**Step 4: Run test, verify it passes**

Run: `bun test test/agents/events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/events.ts test/agents/events.test.ts
git commit -m "Add AgentEventEmitter for typed session events"
```

---

### Task 2: Model Resolver

Maps symbolic model names ("best", "fast") to concrete model IDs. Detects provider from model ID.

**Files:**
- Create: `src/agents/model-resolver.ts`
- Test: `test/agents/model-resolver.test.ts`

**Step 1: Write failing test**

```typescript
// test/agents/model-resolver.test.ts
import { describe, expect, test } from "bun:test";
import { detectProvider, resolveModel } from "../../src/agents/model-resolver.ts";

describe("detectProvider", () => {
	test("detects anthropic from claude model", () => {
		expect(detectProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
		expect(detectProvider("claude-opus-4-6")).toBe("anthropic");
	});

	test("detects openai from gpt/o-series models", () => {
		expect(detectProvider("gpt-4.1-mini")).toBe("openai");
		expect(detectProvider("gpt-4.1")).toBe("openai");
		expect(detectProvider("o3-pro")).toBe("openai");
	});

	test("detects gemini", () => {
		expect(detectProvider("gemini-2.5-flash")).toBe("gemini");
		expect(detectProvider("gemini-2.5-pro")).toBe("gemini");
	});

	test("returns undefined for unknown model", () => {
		expect(detectProvider("llama-3")).toBeUndefined();
	});
});

describe("resolveModel", () => {
	test("resolves 'fast' to first available provider", () => {
		const result = resolveModel("fast", ["anthropic", "openai", "gemini"]);
		expect(result.provider).toBe("anthropic");
		expect(result.model).toContain("claude");
	});

	test("resolves 'fast' skips unavailable providers", () => {
		const result = resolveModel("fast", ["openai"]);
		expect(result.provider).toBe("openai");
		expect(result.model).toContain("gpt");
	});

	test("resolves 'best' to best available", () => {
		const result = resolveModel("best", ["anthropic"]);
		expect(result.provider).toBe("anthropic");
	});

	test("passes through concrete model IDs unchanged", () => {
		const result = resolveModel("claude-haiku-4-5-20251001", ["anthropic"]);
		expect(result.model).toBe("claude-haiku-4-5-20251001");
		expect(result.provider).toBe("anthropic");
	});

	test("throws if no provider available for symbolic name", () => {
		expect(() => resolveModel("fast", [])).toThrow();
	});

	test("throws if concrete model's provider not available", () => {
		expect(() => resolveModel("claude-opus-4-6", ["openai"])).toThrow();
	});
});
```

**Step 2: Run test, verify it fails**

**Step 3: Implement**

```typescript
// src/agents/model-resolver.ts
export interface ResolvedModel {
	model: string;
	provider: string;
}

const MODEL_TIERS: Record<string, Record<string, string>> = {
	best: {
		anthropic: "claude-sonnet-4-5-20250514",
		openai: "gpt-4.1",
		gemini: "gemini-2.5-pro",
	},
	good: {
		anthropic: "claude-sonnet-4-5-20250514",
		openai: "gpt-4.1",
		gemini: "gemini-2.5-flash",
	},
	fast: {
		anthropic: "claude-haiku-4-5-20251001",
		openai: "gpt-4.1-mini",
		gemini: "gemini-2.5-flash",
	},
};

const PROVIDER_PRIORITY = ["anthropic", "openai", "gemini"];

export function detectProvider(model: string): string | undefined {
	if (model.startsWith("claude-")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-")) return "openai";
	if (model.startsWith("gemini-")) return "gemini";
	return undefined;
}

export function resolveModel(model: string, availableProviders: string[]): ResolvedModel {
	const tier = MODEL_TIERS[model];
	if (tier) {
		// Symbolic name — pick first available provider by priority
		for (const provider of PROVIDER_PRIORITY) {
			if (availableProviders.includes(provider) && tier[provider]) {
				return { model: tier[provider], provider };
			}
		}
		throw new Error(`No provider available for model tier '${model}'. Available: ${availableProviders.join(", ")}`);
	}

	// Concrete model ID — detect provider
	const provider = detectProvider(model);
	if (!provider) {
		throw new Error(`Cannot detect provider for model '${model}'`);
	}
	if (!availableProviders.includes(provider)) {
		throw new Error(`Provider '${provider}' for model '${model}' is not available. Available: ${availableProviders.join(", ")}`);
	}
	return { model, provider };
}
```

**Step 4: Run test, verify passes**

**Step 5: Commit**

```bash
git add src/agents/model-resolver.ts test/agents/model-resolver.test.ts
git commit -m "Add model resolver: symbolic names to concrete model IDs"
```

---

### Task 3: Plan Module

Agent-as-tool mapping, primitive tool filtering by capabilities + provider, system prompt construction, LLM request building.

**Files:**
- Create: `src/agents/plan.ts`
- Test: `test/agents/plan.test.ts`
- Reference: `src/llm/types.ts` (ToolDefinition, Request, Message, Msg, ContentKind)
- Reference: `src/kernel/primitives.ts` (Primitive, PrimitiveRegistry)
- Reference: `src/kernel/types.ts` (AgentSpec, Delegation)

**Step 1: Write failing tests**

```typescript
// test/agents/plan.test.ts
import { describe, expect, test } from "bun:test";
import {
	agentAsTool,
	buildPlanRequest,
	buildSystemPrompt,
	parsePlanResponse,
	primitivesForAgent,
} from "../../src/agents/plan.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";

const testAgent: AgentSpec = {
	name: "code-reader",
	description: "Find and return relevant code",
	system_prompt: "You help find code.",
	model: "fast",
	capabilities: ["read_file", "grep", "glob"],
	constraints: { max_turns: 50, max_depth: 3, timeout_ms: 300000, can_spawn: true, can_learn: false },
	tags: ["core"],
	version: 1,
};

describe("agentAsTool", () => {
	test("converts AgentSpec to ToolDefinition with goal/hints params", () => {
		const tool = agentAsTool(testAgent);
		expect(tool.name).toBe("code-reader");
		expect(tool.description).toBe("Find and return relevant code");
		const props = (tool.parameters as any).properties;
		expect(props.goal).toBeDefined();
		expect(props.goal.type).toBe("string");
		expect(props.hints).toBeDefined();
		expect(props.hints.type).toBe("array");
		expect((tool.parameters as any).required).toEqual(["goal"]);
	});
});

describe("primitivesForAgent", () => {
	test("filters primitives by capabilities", () => {
		// Create a mock-like registry that has all primitives
		const allNames = ["read_file", "write_file", "edit_file", "apply_patch", "exec", "grep", "glob", "fetch"];
		const tools = primitivesForAgent(["read_file", "grep"], allNames, "anthropic");
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("grep");
		expect(names).not.toContain("write_file");
		expect(names).not.toContain("exec");
	});

	test("swaps edit_file for apply_patch on OpenAI", () => {
		const allNames = ["read_file", "write_file", "edit_file", "apply_patch", "exec", "grep", "glob", "fetch"];
		const tools = primitivesForAgent(["read_file", "edit_file"], allNames, "openai");
		const names = tools.map((t) => t.name);
		expect(names).toContain("apply_patch");
		expect(names).not.toContain("edit_file");
	});

	test("keeps edit_file for Anthropic", () => {
		const allNames = ["read_file", "write_file", "edit_file", "apply_patch", "exec", "grep", "glob", "fetch"];
		const tools = primitivesForAgent(["read_file", "edit_file"], allNames, "anthropic");
		const names = tools.map((t) => t.name);
		expect(names).toContain("edit_file");
		expect(names).not.toContain("apply_patch");
	});
});

describe("buildSystemPrompt", () => {
	test("includes agent system prompt and environment context", () => {
		const prompt = buildSystemPrompt(testAgent, "/tmp/test", "darwin", "Darwin 25.0");
		expect(prompt).toContain("You help find code.");
		expect(prompt).toContain("/tmp/test");
		expect(prompt).toContain("darwin");
	});
});

describe("buildPlanRequest", () => {
	test("builds a valid LLM Request", () => {
		const req = buildPlanRequest({
			systemPrompt: "You are a test agent.",
			history: [],
			agentTools: [agentAsTool(testAgent)],
			primitiveTools: [],
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
		});
		expect(req.model).toBe("claude-haiku-4-5-20251001");
		expect(req.provider).toBe("anthropic");
		expect(req.messages[0]!.role).toBe("system");
		expect(req.tools).toHaveLength(1);
		expect(req.tools![0]!.name).toBe("code-reader");
	});
});

describe("parsePlanResponse", () => {
	test("identifies agent delegations vs primitive calls", () => {
		// Simulate tool calls in an assistant message
		const agentNames = new Set(["code-reader", "code-editor"]);
		const toolCalls = [
			{ id: "call_1", name: "code-reader", arguments: { goal: "find auth code" } },
			{ id: "call_2", name: "exec", arguments: { command: "ls" } },
		];
		const result = parsePlanResponse(toolCalls, agentNames);
		expect(result.delegations).toHaveLength(1);
		expect(result.delegations[0]!.agent_name).toBe("code-reader");
		expect(result.delegations[0]!.goal).toBe("find auth code");
		expect(result.primitiveCalls).toHaveLength(1);
		expect(result.primitiveCalls[0]!.name).toBe("exec");
	});
});
```

**Step 2: Run test, verify it fails**

**Step 3: Implement plan.ts**

Key exports:
- `agentAsTool(spec: AgentSpec) -> ToolDefinition` — maps agent to tool with goal/hints params
- `primitivesForAgent(capabilities: string[], allPrimitiveNames: string[], provider: string) -> string[]` — returns the primitive names this agent should see, with provider alignment (edit_file <-> apply_patch swap)
- `buildSystemPrompt(spec: AgentSpec, workDir: string, platform: string, osVersion: string) -> string` — agent prompt + environment context block
- `buildPlanRequest({systemPrompt, history, agentTools, primitiveTools, model, provider}) -> Request`
- `parsePlanResponse(toolCalls: ToolCall[], agentNames: Set<string>) -> { delegations: Delegation[], primitiveCalls: ToolCall[] }`

Note: `primitivesForAgent` returns **names** only. The caller gets the actual `ToolDefinition` from the `PrimitiveRegistry` by name. This keeps the plan module decoupled from the registry. Update the test accordingly — the function takes capabilities and all available primitive names, returns filtered names.

Wait, we need the actual ToolDefinition objects (name + description + parameters) for the LLM request. The Primitive interface has all of those. So the function should accept the registry (or a list of Primitives) and return ToolDefinitions. Let me adjust: `primitivesForAgent` takes capabilities, available Primitive objects, and provider. Returns ToolDefinition[].

Revised signature:
```typescript
function primitivesForAgent(
	capabilities: string[],
	allPrimitiveNames: string[],
	provider: string,
): string[]
// Returns filtered+swapped primitive names. The Agent class maps names to ToolDefinitions from the registry.
```

Actually, keeping it as names is cleaner. The Agent class has the registry and can look up each Primitive to get its ToolDefinition. Plan module stays decoupled.

**Step 4: Run test, verify passes**

**Step 5: Commit**

```bash
git add src/agents/plan.ts test/agents/plan.test.ts
git commit -m "Add plan module: agent-as-tool mapping and request building"
```

---

### Task 4: Verify Module

Stumble detection and LearnSignal creation.

**Files:**
- Create: `src/agents/verify.ts`
- Test: `test/agents/verify.test.ts`
- Reference: `src/kernel/types.ts` (ActResult, VerifyResult, LearnSignal, PrimitiveResult)

**Step 1: Write failing test**

```typescript
// test/agents/verify.test.ts
import { describe, expect, test } from "bun:test";
import { verifyActResult, verifyPrimitiveResult } from "../../src/agents/verify.ts";
import type { ActResult } from "../../src/kernel/types.ts";

describe("verifyActResult", () => {
	test("success with no stumbles returns clean result", () => {
		const actResult: ActResult = {
			agent_name: "code-editor",
			goal: "create file",
			output: "Done",
			success: true,
			stumbles: 0,
			turns: 3,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.success).toBe(true);
		expect(result.verify.stumbled).toBe(false);
		expect(result.learnSignal).toBeUndefined();
	});

	test("failure generates learn signal", () => {
		const actResult: ActResult = {
			agent_name: "code-editor",
			goal: "fix bug",
			output: "Could not fix",
			success: false,
			stumbles: 0,
			turns: 10,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.success).toBe(false);
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("failure");
		expect(result.learnSignal!.agent_name).toBe("code-editor");
	});

	test("success with stumbles still generates learn signal", () => {
		const actResult: ActResult = {
			agent_name: "command-runner",
			goal: "run tests",
			output: "Tests pass",
			success: true,
			stumbles: 3,
			turns: 8,
		};
		const result = verifyActResult(actResult, "session-1");
		expect(result.verify.success).toBe(true);
		expect(result.verify.stumbled).toBe(true);
		expect(result.learnSignal).toBeDefined();
		expect(result.learnSignal!.kind).toBe("error");
	});
});

describe("verifyPrimitiveResult", () => {
	test("success returns no stumble", () => {
		const result = verifyPrimitiveResult({ output: "ok", success: true }, "exec", "run ls");
		expect(result.stumbled).toBe(false);
	});

	test("failure returns stumble", () => {
		const result = verifyPrimitiveResult(
			{ output: "", success: false, error: "File not found" },
			"read_file",
			"read config",
		);
		expect(result.stumbled).toBe(true);
	});
});
```

**Step 2: Run test, verify it fails**

**Step 3: Implement verify.ts**

Key exports:
- `verifyActResult(actResult, sessionId) -> { verify: VerifyResult, learnSignal?: LearnSignal }`
- `verifyPrimitiveResult(primitiveResult, toolName, goal) -> { stumbled: boolean }`

Logic: stumbled = !success OR stumbles > 0. If stumbled, create LearnSignal with appropriate kind.

**Step 4: Run test, verify passes**

**Step 5: Commit**

```bash
git add src/agents/verify.ts test/agents/verify.test.ts
git commit -m "Add verify module: stumble detection and LearnSignal creation"
```

---

### Task 5: YAML Loader + Bootstrap Specs

Install `yaml` dependency. Create YAML loader. Create 4 bootstrap agent specs.

**Files:**
- Create: `src/agents/loader.ts`
- Create: `bootstrap/root.yaml`
- Create: `bootstrap/code-reader.yaml`
- Create: `bootstrap/code-editor.yaml`
- Create: `bootstrap/command-runner.yaml`
- Test: `test/agents/loader.test.ts`

**Step 1: Install yaml dependency**

```bash
bun add yaml
```

**Step 2: Write failing test**

```typescript
// test/agents/loader.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgentSpec, loadBootstrapAgents } from "../../src/agents/loader.ts";

describe("loadAgentSpec", () => {
	test("loads a valid YAML agent spec", async () => {
		const spec = await loadAgentSpec(join(import.meta.dir, "../../bootstrap/root.yaml"));
		expect(spec.name).toBe("root");
		expect(spec.description).toBeTruthy();
		expect(spec.system_prompt).toBeTruthy();
		expect(spec.model).toBe("best");
		expect(spec.capabilities).toContain("code-reader");
		expect(spec.capabilities).toContain("code-editor");
		expect(spec.capabilities).toContain("command-runner");
		expect(spec.constraints.max_turns).toBeGreaterThan(0);
		expect(spec.tags).toBeInstanceOf(Array);
		expect(spec.version).toBe(1);
	});

	test("throws on missing file", async () => {
		expect(loadAgentSpec("/nonexistent.yaml")).rejects.toThrow();
	});
});

describe("loadBootstrapAgents", () => {
	test("loads all 4 bootstrap agents", async () => {
		const agents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
		expect(agents).toHaveLength(4);
		const names = agents.map((a) => a.name);
		expect(names).toContain("root");
		expect(names).toContain("code-reader");
		expect(names).toContain("code-editor");
		expect(names).toContain("command-runner");
	});

	test("all agents have valid constraints", async () => {
		const agents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
		for (const agent of agents) {
			expect(agent.constraints.max_turns).toBeGreaterThan(0);
			expect(agent.constraints.max_depth).toBeGreaterThan(0);
			expect(agent.capabilities.length).toBeGreaterThan(0);
		}
	});
});
```

**Step 3: Create bootstrap YAML specs**

Create all 4 files in `bootstrap/`. Key content:

- **root.yaml**: model=best, capabilities=[code-reader, code-editor, command-runner], system prompt about decomposing tasks and delegating
- **code-reader.yaml**: model=fast, capabilities=[read_file, grep, glob], system prompt about finding relevant code
- **code-editor.yaml**: model=fast, capabilities=[read_file, write_file, edit_file, exec, grep, glob], system prompt about editing code carefully
- **command-runner.yaml**: model=fast, capabilities=[exec, read_file, grep, glob], system prompt about running commands and interpreting output

Each spec needs: name, description, system_prompt, model, capabilities, constraints (with defaults), tags, version: 1.

**Step 4: Implement loader.ts**

```typescript
// src/agents/loader.ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_CONSTRAINTS, type AgentSpec } from "../kernel/types.ts";

export async function loadAgentSpec(path: string): Promise<AgentSpec> {
	const content = await readFile(path, "utf-8");
	const raw = parse(content);
	return {
		name: raw.name,
		description: raw.description,
		system_prompt: raw.system_prompt,
		model: raw.model,
		capabilities: raw.capabilities ?? [],
		constraints: { ...DEFAULT_CONSTRAINTS, ...raw.constraints },
		tags: raw.tags ?? [],
		version: raw.version ?? 1,
	};
}

export async function loadBootstrapAgents(dir: string): Promise<AgentSpec[]> {
	const files = await readdir(dir);
	const yamlFiles = files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	return Promise.all(yamlFiles.map((f) => loadAgentSpec(join(dir, f))));
}
```

**Step 5: Run tests, verify passes**

**Step 6: Commit**

```bash
git add bootstrap/ src/agents/loader.ts test/agents/loader.test.ts package.json bun.lock
git commit -m "Add YAML loader and 4 bootstrap agent specs"
```

---

### Task 6: Agent Class

The core loop. Wires together events, model resolver, plan, verify, primitives.

**Files:**
- Create: `src/agents/agent.ts`
- Create: `src/agents/index.ts`
- Modify: `src/index.ts` (add agents export)
- Test: `test/agents/agent.test.ts` (unit tests — constructor, tool resolution)

**Step 1: Write failing unit tests**

```typescript
// test/agents/agent.test.ts
import { describe, expect, test } from "bun:test";
import { Agent, type AgentOptions } from "../../src/agents/agent.ts";
import { DEFAULT_CONSTRAINTS, type AgentSpec } from "../../src/kernel/types.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { Client } from "../../src/llm/client.ts";
import { config } from "dotenv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

config();

describe("Agent", () => {
	const rootSpec: AgentSpec = {
		name: "root",
		description: "Test root",
		system_prompt: "You decompose tasks.",
		model: "fast",
		capabilities: ["leaf"],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 10 },
		tags: [],
		version: 1,
	};

	const leafSpec: AgentSpec = {
		name: "leaf",
		description: "Test leaf",
		system_prompt: "You do things.",
		model: "fast",
		capabilities: ["read_file", "write_file", "exec"],
		constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
		tags: [],
		version: 1,
	};

	test("constructor validates max_depth", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		expect(
			() =>
				new Agent({
					spec: rootSpec,
					env,
					client,
					primitiveRegistry: registry,
					availableAgents: [],
					depth: 5,
				}),
		).toThrow(/depth/i);
	});

	test("resolves agent tools from capabilities", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 0,
		});
		// Root's capabilities include "leaf", which is an agent name
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("leaf");
		// Should NOT include root itself
		expect(names).not.toContain("root");
	});

	test("resolves primitive tools from capabilities", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const client = Client.fromEnv();
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: [rootSpec, leafSpec],
			depth: 1,
		});
		const tools = agent.resolvedTools();
		const names = tools.map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
		expect(names).toContain("exec");
		// Should not include agent tools (leaf has no agent capabilities)
		expect(names).not.toContain("root");
		expect(names).not.toContain("leaf");
	});
});
```

**Step 2: Run test, verify it fails**

**Step 3: Implement Agent class**

```typescript
// src/agents/agent.ts
export interface AgentOptions {
	spec: AgentSpec;
	env: ExecutionEnvironment;
	client: Client;
	primitiveRegistry: PrimitiveRegistry;
	availableAgents: AgentSpec[];
	depth?: number;
	events?: AgentEventEmitter;
}

export interface AgentResult {
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
}

export class Agent {
	readonly spec: AgentSpec;
	// ... private fields

	constructor(options: AgentOptions) { /* validate depth, resolve model/provider, build tool lists */ }

	resolvedTools(): ToolDefinition[] { /* returns all tools this agent can use */ }

	async run(goal: string): Promise<AgentResult> {
		// 1. Emit session_start
		// 2. Add goal as user message to history
		// 3. Loop:
		//    a. Check turn limit
		//    b. Build LLM request via plan module
		//    c. Call client.complete()
		//    d. Add assistant message to history
		//    e. If no tool calls -> natural completion, break
		//    f. For each tool call:
		//       - If agent name -> spawn subagent, run its loop, get result
		//       - If primitive name -> execute via registry
		//       - Verify result, track stumbles
		//       - Add tool result to history
		// 4. Emit session_end
		// 5. Return AgentResult
	}
}
```

Key implementation details:
- Model resolution happens in constructor via `resolveModel(spec.model, client.providers())`
- Provider detection via `detectProvider(resolvedModel)`
- Tool list built once in constructor: agent tools (from capabilities matching available agent names) + primitive tools (from capabilities matching primitive names, provider-aligned)
- Subagent spawning: `new Agent({...options, spec: subagentSpec, depth: this.depth + 1, availableAgents: this.availableAgents})`
- The subagent's goal is formatted as: the goal string, with hints (if any) appended

**Step 4: Run test, verify passes**

**Step 5: Create barrel export and update top-level index**

```typescript
// src/agents/index.ts
export { Agent, type AgentOptions, type AgentResult } from "./agent.ts";
export { AgentEventEmitter, type EventListener } from "./events.ts";
export { loadAgentSpec, loadBootstrapAgents } from "./loader.ts";
export { detectProvider, resolveModel, type ResolvedModel } from "./model-resolver.ts";
export { agentAsTool, buildPlanRequest, buildSystemPrompt, parsePlanResponse, primitivesForAgent } from "./plan.ts";
export { verifyActResult, verifyPrimitiveResult } from "./verify.ts";
```

Update `src/index.ts` to add `export * from "./agents/index.ts"`.

**Step 6: Commit**

```bash
git add src/agents/ test/agents/agent.test.ts src/index.ts
git commit -m "Add Agent class with core loop structure and tool resolution"
```

---

### Task 7: Integration Tests

Real API calls proving the loop works end-to-end. Uses bootstrap agents.

**Files:**
- Create: `test/agents/agent.integration.test.ts`

**Step 1: Write integration test — single leaf agent with primitives**

```typescript
// test/agents/agent.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "dotenv";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/agents/agent.ts";
import { loadBootstrapAgents } from "../../src/agents/loader.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { Client } from "../../src/llm/client.ts";
import type { AgentSpec, SessionEvent } from "../../src/kernel/types.ts";

config();

describe("Agent Integration", () => {
	let tempDir: string;
	let env: LocalExecutionEnvironment;
	let client: Client;
	let registry: ReturnType<typeof createPrimitiveRegistry>;
	let bootstrapAgents: AgentSpec[];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-test-"));
		env = new LocalExecutionEnvironment(tempDir);
		client = Client.fromEnv();
		registry = createPrimitiveRegistry(env);
		bootstrapAgents = await loadBootstrapAgents(join(import.meta.dir, "../../bootstrap"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("leaf agent creates a file using primitives", async () => {
		const codeEditor = bootstrapAgents.find((a) => a.name === "code-editor")!;
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: codeEditor,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: bootstrapAgents,
			depth: 1,
			events,
		});

		const result = await agent.run(
			`Create a file called hello.py in ${tempDir} that prints "Hello World". Use the write_file tool with the absolute path.`,
		);

		// The file should exist
		const content = await readFile(join(tempDir, "hello.py"), "utf-8");
		expect(content).toContain("Hello");
		expect(result.turns).toBeGreaterThan(0);

		// Should have emitted events
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "session_start")).toBe(true);
		expect(collected.some((e) => e.kind === "session_end")).toBe(true);
	}, 30_000);

	test("root agent delegates to code-editor to create a file", async () => {
		const rootSpec = bootstrapAgents.find((a) => a.name === "root")!;
		const events = new AgentEventEmitter();
		const agent = new Agent({
			spec: rootSpec,
			env,
			client,
			primitiveRegistry: registry,
			availableAgents: bootstrapAgents,
			depth: 0,
			events,
		});

		const result = await agent.run(
			`Create a file called greet.py in ${tempDir} that prints "Hello from Sprout". The file must exist when you're done.`,
		);

		const content = await readFile(join(tempDir, "greet.py"), "utf-8");
		expect(content).toContain("Sprout");

		// Should have act_start/act_end events (delegation happened)
		const collected = events.collected();
		expect(collected.some((e) => e.kind === "act_start")).toBe(true);
		expect(collected.some((e) => e.kind === "act_end")).toBe(true);
	}, 60_000);
});
```

**Step 2: Run test, verify it fails** (Agent.run not implemented yet, or loop logic incomplete)

**Step 3: Iterate on Agent.run() implementation until tests pass**

This is where the loop gets wired up. The Agent class calls:
- `buildSystemPrompt()` and `buildPlanRequest()` from plan.ts
- `client.complete()` from LLM client
- `messageToolCalls()` and `messageText()` from LLM types
- `parsePlanResponse()` to classify tool calls
- `primitiveRegistry.execute()` for primitive calls
- Spawns new `Agent` instances for delegation calls
- `verifyActResult()` and `verifyPrimitiveResult()` from verify.ts
- Emits events via `AgentEventEmitter`

**Step 4: Run full test suite**

```bash
bun test
```

All tests (Phase 1 + 2 + 3) must pass.

**Step 5: Commit**

```bash
git add test/agents/agent.integration.test.ts
git commit -m "Add integration tests: leaf agent + root delegation"
```

---

## Verification

After all tasks complete:

1. `bun test` — all tests pass (Phase 1 + 2 + 3)
2. `bun run check` — biome check passes
3. `bun run typecheck` — TypeScript compiles
4. Integration test proves: root agent receives goal -> delegates to code-editor -> file gets created on disk
5. Events emitted throughout (session_start, perceive, plan_start/end, act_start/end, primitive_start/end, session_end)

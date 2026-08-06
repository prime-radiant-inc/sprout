import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { type AgentOptions, Agent as RawAgent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import type { AgentSpawner } from "../../src/bus/spawner.ts";
import type { CellRunner } from "../../src/kernel/cell-primitive.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS, type SessionEvent } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Response } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";
import { leafSpec, makeMockClient, withDefaultResolverContext } from "./fixtures.ts";
import "../helpers/test-env.ts";

class Agent extends RawAgent {
	constructor(options: AgentOptions) {
		super(withDefaultResolverContext(options));
	}
}

/** A store stub — construction never touches its methods; names() is only hit
 * by the runtime splice path, which the flag-off gate short-circuits. */
function stubStore() {
	return { names: async () => [] } as unknown;
}

function stubSpawner(): AgentSpawner {
	return { storeAccess: stubStore() } as unknown as AgentSpawner;
}

function stubCellHost(): CellRunner {
	return {
		run: async () => ({ output: "", success: true }),
	} as unknown as CellRunner;
}

function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Response {
	return {
		id: `resp-${id}`,
		model: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		message: {
			role: "assistant",
			content: [{ kind: ContentKind.TOOL_CALL, tool_call: { id, name, arguments: args } }],
		},
		finish_reason: { reason: "tool_calls" },
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	};
}

const STOP_RESPONSE: Response = {
	id: "stop",
	model: "claude-haiku-4-5-20251001",
	provider: "anthropic",
	message: Msg.assistant("Done."),
	finish_reason: { reason: "stop" },
	usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
};

/** A client that replays a scripted sequence of responses, one per turn. */
function scriptedClient(responses: Response[]): Client {
	let i = 0;
	return {
		providers: () => ["anthropic"],
		listModelsByProvider: async () => new Map(),
		complete: async () => responses[Math.min(i++, responses.length - 1)]!,
		stream: async function* () {},
	} as unknown as Client;
}

function codeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: "coder",
		description: "code-mode agent",
		system_prompt: "You write cells.",
		model: "fast",
		act: "code",
		tools: [],
		agents: ["leaf"],
		constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: true },
		tags: [],
		version: 1,
		...overrides,
	};
}

describe("act mode — code-mode tool surface (sap §6)", () => {
	test("code-mode agent offers exactly the cell tool", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: codeSpec(),
			env,
			client: makeMockClient(),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [codeSpec(), leafSpec],
			spawner: stubSpawner(),
			cellHost: stubCellHost(),
		});
		const names = agent.resolvedTools().map((t) => t.name);
		expect(names).toEqual(["cell"]);
		expect(names).not.toContain("delegate");
		expect(names).not.toContain("value_grep");
	});

	test("flag-off degrades a code-mode spec to a delegating tool-mode agent", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: codeSpec(),
			env,
			client: makeMockClient(),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [codeSpec(), leafSpec],
			spawner: stubSpawner(),
			cellHost: stubCellHost(),
			dataPlaneEnabled: false,
		});
		const names = agent.resolvedTools().map((t) => t.name);
		expect(names).toContain("delegate");
		expect(names).not.toContain("cell");
		expect(names).not.toContain("value_grep");
	});
});

describe("act mode — data-plane flag filters value_*/cell (sap §6)", () => {
	test("flag-on offers granted value_* reads", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: {
				...leafSpec,
				tools: ["value_grep", "read_file"],
				constraints: { ...leafSpec.constraints, can_spawn: false },
			},
			env,
			client: makeMockClient(),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [],
			spawner: stubSpawner(),
		});
		const names = agent.resolvedTools().map((t) => t.name);
		expect(names).toContain("value_grep");
		expect(names).toContain("read_file");
	});

	test("flag-off filters value_* out and keeps real tools", () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: {
				...leafSpec,
				tools: ["value_grep", "read_file"],
				constraints: { ...leafSpec.constraints, can_spawn: false },
			},
			env,
			client: makeMockClient(),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [],
			spawner: stubSpawner(),
			dataPlaneEnabled: false,
		});
		const names = agent.resolvedTools().map((t) => t.name);
		expect(names).not.toContain("value_grep");
		expect(names).not.toContain("cell");
		expect(names).toContain("read_file");
	});
});

describe("act mode — flag-off data-plane field gates (sap §6)", () => {
	function collectEvents(): { events: AgentEventEmitter; log: SessionEvent[] } {
		const events = new AgentEventEmitter();
		const log: SessionEvent[] = [];
		events.on((e) => log.push(e));
		return { events, log };
	}

	test("a whole-arg ⟦name⟧ under flag-off is rejected naming the flag", async () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const { events, log } = collectEvents();
		const agent = new Agent({
			spec: { ...leafSpec, tools: ["write_file"] },
			env,
			client: scriptedClient([
				toolCallResponse("c1", "write_file", { path: "out.txt", content: "⟦x⟧" }),
				STOP_RESPONSE,
			]),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [],
			events,
			dataPlaneEnabled: false,
		});
		await agent.run("write it");
		const end = log.find((e) => e.kind === "primitive_end");
		expect(String(end?.data.error)).toContain("the data plane is disabled for this session");
		expect(String(end?.data.error)).toContain("⟦name⟧");
	});

	test("a bind: arg under flag-off is rejected naming the flag", async () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const { events, log } = collectEvents();
		const agent = new Agent({
			spec: { ...leafSpec, tools: ["read_file"] },
			env,
			client: scriptedClient([
				toolCallResponse("c1", "read_file", { path: "out.txt", bind: "cap" }),
				STOP_RESPONSE,
			]),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [],
			events,
			dataPlaneEnabled: false,
		});
		await agent.run("read it");
		const end = log.find((e) => e.kind === "primitive_end");
		expect(String(end?.data.error)).toContain("the data plane is disabled for this session");
		expect(String(end?.data.error)).toContain("bind:");
	});

	test("env on delegate under flag-off is rejected naming the flag", async () => {
		const env = new LocalExecutionEnvironment(tmpdir());
		const { events, log } = collectEvents();
		const agent = new Agent({
			spec: {
				...leafSpec,
				name: "orchestrator",
				tools: [],
				agents: ["leaf"],
				constraints: { ...leafSpec.constraints, can_spawn: true },
			},
			env,
			client: scriptedClient([
				toolCallResponse("c1", "delegate", {
					agent_name: "leaf",
					goal: "do it",
					env: { a: "b" },
				}),
				STOP_RESPONSE,
			]),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [leafSpec],
			events,
			dataPlaneEnabled: false,
		});
		await agent.run("delegate it");
		const end = log.find((e) => e.kind === "act_end" && e.data.error);
		expect(String(end?.data.error)).toContain("the data plane is disabled for this session");
		expect(String(end?.data.error)).toContain("env");
	});
});

describe("act mode — agent-tool dispatch honors the granted surface (Phase 7)", () => {
	function recordingSpawner(): { spawner: AgentSpawner; calls: string[] } {
		const calls: string[] = [];
		const spawner = {
			storeAccess: stubStore(),
			spawnAgent: async (...args: unknown[]) => {
				calls.push("spawnAgent");
				throw new Error(`unexpected spawn: ${JSON.stringify(args[0])}`);
			},
			waitAgent: async () => {
				calls.push("waitAgent");
				throw new Error("unexpected wait");
			},
			messageAgent: async () => {
				calls.push("messageAgent");
				throw new Error("unexpected message");
			},
		} as unknown as AgentSpawner;
		return { spawner, calls };
	}

	test("a code-mode agent cannot delegate via an explicit delegate tool call", async () => {
		const { spawner, calls } = recordingSpawner();
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: codeSpec(),
			env,
			client: scriptedClient([
				toolCallResponse("call-gate-1", "delegate", { agent_name: "leaf", goal: "do it" }),
				STOP_RESPONSE,
			]),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [codeSpec(), leafSpec],
			spawner,
			cellHost: stubCellHost(),
			events,
		});
		await agent.run("try to delegate");
		expect(calls).toEqual([]);
		const denial = events.collected().find((e) => e.kind === "act_end" && e.data.success === false);
		expect(denial).toBeDefined();
		expect(String(denial!.data.error)).toContain("not in this agent's granted tool surface");
	});

	test("a code-mode agent cannot delegate via a bare agent-name tool call", async () => {
		const { spawner, calls } = recordingSpawner();
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: codeSpec(),
			env,
			client: scriptedClient([
				toolCallResponse("call-gate-2", "leaf", { goal: "do it" }),
				STOP_RESPONSE,
			]),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [codeSpec(), leafSpec],
			spawner,
			cellHost: stubCellHost(),
			events,
		});
		await agent.run("try the legacy path");
		expect(calls).toEqual([]);
		const denial = events.collected().find((e) => e.kind === "act_end" && e.data.success === false);
		expect(denial).toBeDefined();
		expect(String(denial!.data.error)).toContain("not in this agent's granted tool surface");
	});

	test("a code-mode agent cannot dispatch wait_agent or message_agent", async () => {
		const { spawner, calls } = recordingSpawner();
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const agent = new Agent({
			spec: codeSpec(),
			env,
			client: scriptedClient([
				toolCallResponse("call-gate-3", "wait_agent", { handle: "h1" }),
				toolCallResponse("call-gate-4", "message_agent", { handle: "h1", message: "hi" }),
				STOP_RESPONSE,
			]),
			primitiveRegistry: createPrimitiveRegistry(env),
			availableAgents: [codeSpec(), leafSpec],
			spawner,
			cellHost: stubCellHost(),
			events,
		});
		await agent.run("try the command tools");
		expect(calls).toEqual([]);
		const denials = events
			.collected()
			.filter(
				(e) =>
					e.kind === "act_end" &&
					String(e.data.error ?? "").includes("not in this agent's granted tool surface"),
			);
		expect(denials.length).toBeGreaterThanOrEqual(2);
	});
});

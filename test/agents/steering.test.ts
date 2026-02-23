import { describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Response } from "../../src/llm/types.ts";
import { ContentKind, Msg } from "../../src/llm/types.ts";

config({ path: join(homedir(), "prime-radiant/serf/.env") });

const leafSpec: AgentSpec = {
	name: "test-leaf",
	description: "Test agent",
	system_prompt:
		"You are a test agent. Reply with exactly 'DONE' and nothing else. Do not use any tools.",
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

function makeAgent(opts?: {
	events?: AgentEventEmitter;
	client?: Client;
	spec?: AgentSpec;
}): Agent {
	const env = new LocalExecutionEnvironment(tmpdir());
	const client =
		opts?.client ??
		({
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => ({
				id: "mock-1",
				model: "claude-haiku-4-5-20251001",
				provider: "anthropic",
				message: Msg.assistant("DONE"),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			}),
			stream: async function* () {},
		} as unknown as Client);
	const registry = createPrimitiveRegistry(env);
	return new Agent({
		spec: opts?.spec ?? leafSpec,
		env,
		client,
		primitiveRegistry: registry,
		availableAgents: [],
		depth: 0,
		events: opts?.events,
	});
}

describe("Steering queue", () => {
	test("steer() is a function on Agent", () => {
		const agent = makeAgent();
		expect(typeof agent.steer).toBe("function");
	});

	test("steering event is emitted when messages are queued before run", async () => {
		const events = new AgentEventEmitter();
		const agent = makeAgent({ events });

		// Queue a steering message before calling run
		agent.steer("change direction please");

		await agent.run("test goal");

		const collected = events.collected();
		const steeringEvents = collected.filter((e) => e.kind === "steering");
		expect(steeringEvents.length).toBe(1);
		expect(steeringEvents[0]!.data.text).toBe("change direction please");
	});

	test("multiple steering messages each produce a steering event", async () => {
		const events = new AgentEventEmitter();
		const agent = makeAgent({ events });

		agent.steer("first correction");
		agent.steer("second correction");

		await agent.run("test goal");

		const collected = events.collected();
		const steeringEvents = collected.filter((e) => e.kind === "steering");
		expect(steeringEvents.length).toBe(2);
		expect(steeringEvents[0]!.data.text).toBe("first correction");
		expect(steeringEvents[1]!.data.text).toBe("second correction");
	});

	test("steering queue is drained after processing", async () => {
		const events = new AgentEventEmitter();

		// Mock client that does two turns: first returns a tool call, second completes.
		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					return {
						id: "mock-tc-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: {
							role: "assistant" as const,
							content: [
								{
									kind: ContentKind.TOOL_CALL,
									tool_call: {
										id: "call-1",
										name: "exec",
										arguments: JSON.stringify({ command: "echo hi" }),
									},
								},
							],
						},
						finish_reason: { reason: "tool_calls" as const },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
				}
				return {
					id: "mock-tc-2",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("DONE"),
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const agent = makeAgent({ events, client: mockClient });

		// Queue before run - should drain on first iteration
		agent.steer("only once");

		await agent.run("test goal");

		const collected = events.collected();
		const steeringEvents = collected.filter((e) => e.kind === "steering");
		// Should be exactly 1 steering event, not repeated on second turn
		expect(steeringEvents.length).toBe(1);
	});
});

describe("AbortSignal", () => {
	test("run() accepts optional AbortSignal parameter", async () => {
		const agent = makeAgent();
		const controller = new AbortController();
		// Should not throw - signal is optional
		const result = await agent.run("test goal", controller.signal);
		expect(result.success).toBe(true);
	});

	test("pre-aborted signal stops agent immediately", async () => {
		const events = new AgentEventEmitter();
		const agent = makeAgent({ events });

		const controller = new AbortController();
		controller.abort();

		await agent.run("test goal", controller.signal);

		const collected = events.collected();
		const interrupted = collected.filter((e) => e.kind === "interrupted");
		expect(interrupted.length).toBe(1);
		expect(interrupted[0]!.data.message).toContain("abort signal");
	});

	test("abort during LLM call emits interrupted and terminates", async () => {
		const events = new AgentEventEmitter();
		const controller = new AbortController();

		// Mock client that hangs long enough for us to abort
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				// Simulate a slow LLM call - abort will fire during this
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return {
					id: "mock-slow",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("DONE"),
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const agent = makeAgent({ events, client: mockClient });

		// Abort after a short delay
		setTimeout(() => controller.abort(), 50);

		await agent.run("test goal", controller.signal);

		const collected = events.collected();
		const interrupted = collected.filter((e) => e.kind === "interrupted");
		expect(interrupted.length).toBe(1);
		expect(interrupted[0]!.data.message).toContain("interrupted");
	});

	test("abort between turns emits interrupted with turn count", async () => {
		const events = new AgentEventEmitter();
		const controller = new AbortController();

		// Mock client: first call returns a tool call, then we abort before second iteration
		let callCount = 0;
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				if (callCount === 1) {
					// After first response, abort so the check at top of next iteration fires
					setTimeout(() => controller.abort(), 0);
					return {
						id: "mock-abort-between-1",
						model: "claude-haiku-4-5-20251001",
						provider: "anthropic",
						message: {
							role: "assistant" as const,
							content: [
								{
									kind: ContentKind.TOOL_CALL,
									tool_call: {
										id: "call-1",
										name: "exec",
										arguments: JSON.stringify({ command: "echo test" }),
									},
								},
							],
						},
						finish_reason: { reason: "tool_calls" as const },
						usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
					};
				}
				return {
					id: "mock-abort-between-2",
					model: "claude-haiku-4-5-20251001",
					provider: "anthropic",
					message: Msg.assistant("DONE"),
					finish_reason: { reason: "stop" as const },
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				};
			},
			stream: async function* () {},
		} as unknown as Client;

		const agent = makeAgent({ events, client: mockClient });

		await agent.run("test goal", controller.signal);

		const collected = events.collected();
		const interrupted = collected.filter((e) => e.kind === "interrupted");
		expect(interrupted.length).toBeGreaterThanOrEqual(1);
		// Should have turns recorded in the event data
		const interruptedEvent = interrupted[0]!;
		expect(interruptedEvent.data.turns).toBeDefined();
	});
});

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Agent } from "../../src/agents/agent.ts";
import { AgentEventEmitter } from "../../src/agents/events.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry } from "../../src/kernel/primitives.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS, type SessionEvent } from "../../src/kernel/types.ts";
import { Client } from "../../src/llm/client.ts";
import type { Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";

const leafSpec: AgentSpec = {
	name: "leaf",
	description: "Test leaf",
	system_prompt: "You do things.",
	model: "fast",
	tools: ["read_file", "write_file", "exec"],
	agents: [],
	constraints: { ...DEFAULT_CONSTRAINTS, max_turns: 5 },
	tags: [],
	version: 1,
};

function makeMockClient(response: Response) {
	return {
		providers: () => ["anthropic"],
		complete: async () => response,
		stream: async function* () {
			yield { type: "stream_start" as const };
			yield { type: "text_start" as const };
			yield { type: "text_delta" as const, delta: "Task " };
			yield { type: "text_delta" as const, delta: "complete." };
			yield { type: "text_end" as const };
			yield {
				type: "finish" as const,
				finish_reason: response.finish_reason,
				usage: response.usage,
				response,
			};
		},
	} as unknown as Client;
}

describe("LLM progress events", () => {
	const simpleResponse: Response = {
		id: "mock-1",
		model: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		message: Msg.assistant("Task complete."),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
	};

	test("emits llm_start before the LLM call", async () => {
		const mockClient = makeMockClient(simpleResponse);
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("test goal");

		const collected = events.collected();
		const llmStart = collected.find((e) => e.kind === "llm_start");
		expect(llmStart).toBeDefined();
		expect(llmStart!.data.model).toBe("claude-haiku-4-5-20251001");
		expect(llmStart!.data.provider).toBe("anthropic");
		expect(llmStart!.data.turn).toBe(1);
		expect(typeof llmStart!.data.message_count).toBe("number");
	});

	test("emits llm_end after the LLM call completes", async () => {
		const mockClient = makeMockClient(simpleResponse);
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("test goal");

		const collected = events.collected();
		const llmEnd = collected.find((e) => e.kind === "llm_end");
		expect(llmEnd).toBeDefined();
		expect(llmEnd!.data.model).toBe("claude-haiku-4-5-20251001");
		expect(llmEnd!.data.provider).toBe("anthropic");
		expect(llmEnd!.data.input_tokens).toBe(100);
		expect(llmEnd!.data.output_tokens).toBe(50);
		expect(typeof llmEnd!.data.latency_ms).toBe("number");
		expect(llmEnd!.data.latency_ms).toBeGreaterThanOrEqual(0);
		expect(llmEnd!.data.finish_reason).toBe("stop");
	});

	test("llm_start is emitted after plan_start and before llm_end", async () => {
		const mockClient = makeMockClient(simpleResponse);
		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("test goal");

		const collected = events.collected();
		const kinds = collected.map((e) => e.kind);
		const planStartIdx = kinds.indexOf("plan_start");
		const llmStartIdx = kinds.indexOf("llm_start");
		const llmEndIdx = kinds.indexOf("llm_end");
		const planEndIdx = kinds.indexOf("plan_end");

		expect(planStartIdx).toBeLessThan(llmStartIdx);
		expect(llmStartIdx).toBeLessThan(llmEndIdx);
		expect(llmEndIdx).toBeLessThan(planEndIdx);
	});

	test("llm_start/llm_end are emitted for each turn", async () => {
		// Mock client that returns a tool call on turn 1, then completes on turn 2
		let callCount = 0;
		const toolCallResponse: Response = {
			id: "mock-tc",
			model: "claude-haiku-4-5-20251001",
			provider: "anthropic",
			message: {
				role: "assistant",
				content: [
					{
						kind: "tool_call",
						tool_call: {
							id: "call-1",
							name: "read_file",
							arguments: { path: "/tmp/test.txt" },
						},
					},
				],
			},
			finish_reason: { reason: "tool_calls" },
			usage: { input_tokens: 80, output_tokens: 30, total_tokens: 110 },
		};
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				callCount++;
				return callCount === 1 ? toolCallResponse : simpleResponse;
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("multi-turn test");

		const collected = events.collected();
		const llmStarts = collected.filter((e) => e.kind === "llm_start");
		const llmEnds = collected.filter((e) => e.kind === "llm_end");

		expect(llmStarts).toHaveLength(2);
		expect(llmEnds).toHaveLength(2);

		// Turn numbers should be 1 and 2
		expect(llmStarts[0]!.data.turn).toBe(1);
		expect(llmStarts[1]!.data.turn).toBe(2);
	});

	test("emits throttled llm_chunk events during streaming", async () => {
		// Mock client with streaming that yields multiple deltas
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => simpleResponse,
			stream: async function* () {
				yield { type: "stream_start" as const };
				yield { type: "text_start" as const };
				// Yield several deltas
				for (let i = 0; i < 10; i++) {
					yield { type: "text_delta" as const, delta: `token${i} ` };
				}
				yield { type: "text_end" as const };
				yield {
					type: "finish" as const,
					finish_reason: simpleResponse.finish_reason,
					usage: simpleResponse.usage,
					response: simpleResponse,
				};
			},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			enableStreaming: true,
		});

		await agent.run("streaming test");

		const collected = events.collected();
		const chunks = collected.filter((e) => e.kind === "llm_chunk");

		// Should have at least one chunk event
		expect(chunks.length).toBeGreaterThanOrEqual(1);
		// Each chunk should have tokens_so_far and elapsed_ms
		for (const chunk of chunks) {
			expect(typeof chunk.data.tokens_so_far).toBe("number");
			expect(typeof chunk.data.elapsed_ms).toBe("number");
			expect(chunk.data.tokens_so_far).toBeGreaterThan(0);
		}
	});

	test("llm_chunk throttling limits emission rate", async () => {
		// Mock client with streaming that yields deltas with time control
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => simpleResponse,
			stream: async function* () {
				yield { type: "stream_start" as const };
				yield { type: "text_start" as const };
				// Yield many deltas rapidly — should be throttled
				for (let i = 0; i < 50; i++) {
					yield { type: "text_delta" as const, delta: "x" };
				}
				yield { type: "text_end" as const };
				yield {
					type: "finish" as const,
					finish_reason: simpleResponse.finish_reason,
					usage: simpleResponse.usage,
					response: simpleResponse,
				};
			},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			enableStreaming: true,
		});

		await agent.run("throttle test");

		const collected = events.collected();
		const chunks = collected.filter((e) => e.kind === "llm_chunk");

		// 50 tokens arriving instantly — throttle should limit chunk count
		// The first chunk is emitted immediately, then throttled at 500ms intervals.
		// Since all tokens arrive instantly, we expect very few chunks (1-2).
		expect(chunks.length).toBeLessThanOrEqual(3);
	});

	test("streaming mode still emits llm_start and llm_end", async () => {
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async () => simpleResponse,
			stream: async function* () {
				yield { type: "stream_start" as const };
				yield { type: "text_start" as const };
				yield { type: "text_delta" as const, delta: "done" };
				yield { type: "text_end" as const };
				yield {
					type: "finish" as const,
					finish_reason: simpleResponse.finish_reason,
					usage: simpleResponse.usage,
					response: simpleResponse,
				};
			},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
			enableStreaming: true,
		});

		await agent.run("stream with bookends");

		const collected = events.collected();
		const llmStart = collected.find((e) => e.kind === "llm_start");
		const llmEnd = collected.find((e) => e.kind === "llm_end");
		expect(llmStart).toBeDefined();
		expect(llmEnd).toBeDefined();
		expect(llmEnd!.data.input_tokens).toBe(100);
		expect(llmEnd!.data.output_tokens).toBe(50);
	});

	test("llm_end includes correct latency_ms", async () => {
		// Add a small delay to the mock to ensure latency > 0
		const mockClient = {
			providers: () => ["anthropic"],
			complete: async (): Promise<Response> => {
				await new Promise((r) => setTimeout(r, 10));
				return simpleResponse;
			},
			stream: async function* () {},
		} as unknown as Client;

		const events = new AgentEventEmitter();
		const env = new LocalExecutionEnvironment(tmpdir());
		const registry = createPrimitiveRegistry(env);
		const agent = new Agent({
			spec: leafSpec,
			env,
			client: mockClient,
			primitiveRegistry: registry,
			availableAgents: [],
			depth: 0,
			events,
		});

		await agent.run("latency test");

		const collected = events.collected();
		const llmEnd = collected.find((e) => e.kind === "llm_end");
		expect(llmEnd).toBeDefined();
		expect(llmEnd!.data.latency_ms).toBeGreaterThanOrEqual(5);
	});
});

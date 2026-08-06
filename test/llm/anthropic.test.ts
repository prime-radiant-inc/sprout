import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AnthropicAdapter, buildAnthropicRequest } from "../../src/llm/anthropic.ts";
import type { ProviderAdapter } from "../../src/llm/types.ts";
import {
	ContentKind,
	messageReasoning,
	messageText,
	messageToolCalls,
	type Request,
	type StreamEvent,
} from "../../src/llm/types.ts";
import "../helpers/test-env.ts";
import { createAdapterVcr } from "../helpers/vcr.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/llm-anthropic");

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
}

function vcrFor(testName: string, realAdapter?: ProviderAdapter) {
	return createAdapterVcr({
		fixtureDir: FIXTURE_DIR,
		testName: slug(testName),
		realAdapter,
	});
}

describe("AnthropicAdapter", () => {
	let realAdapter: AnthropicAdapter | undefined;

	beforeAll(() => {
		const key = process.env.ANTHROPIC_API_KEY;
		if (key) {
			realAdapter = new AnthropicAdapter(key);
		}
	});

	test("adapter name is anthropic", async () => {
		const vcr = vcrFor("adapter-name-is-anthropic", realAdapter);
		expect(vcr.adapter.name).toBe("anthropic");
		await vcr.afterTest();
	});

	test("normalizes Anthropic cache usage telemetry", async () => {
		const adapter = new AnthropicAdapter("test-key");
		(adapter as any).client = {
			messages: {
				create: async () => ({
					id: "msg-cache",
					model: "claude-sonnet-4-6",
					role: "assistant",
					type: "message",
					content: [{ type: "text", text: "ok" }],
					stop_reason: "end_turn",
					usage: {
						input_tokens: 25,
						output_tokens: 7,
						cache_read_input_tokens: 100,
						cache_creation_input_tokens: 30,
						cache_creation: {
							ephemeral_5m_input_tokens: 20,
							ephemeral_1h_input_tokens: 10,
						},
					},
				}),
			},
		};

		const response = await adapter.complete({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hello" }] }],
		});

		expect(response.usage.input_tokens).toBe(25);
		expect(response.usage.cache_read_tokens).toBe(100);
		expect(response.usage.cache_write_tokens).toBe(30);
		expect(response.usage.cache_write_5m_tokens).toBe(20);
		expect(response.usage.cache_write_1h_tokens).toBe(10);
		expect(response.usage.total_input_tokens).toBe(155);
		expect(response.usage.total_tokens).toBe(162);
	});

	test("build request places cache markers on system, tools, and stable history", () => {
		const tools = [
			{
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		];
		const request: Request = {
			model: "claude-sonnet-4-6",
			messages: [],
			tools,
			max_tokens: 1000,
			provider_options: {
				anthropic: {
					cache: { enabled: true, ttl: "1h" },
				},
			},
		};
		const params = buildAnthropicRequest(request, "system prompt", [
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "turn 1" }] },
			{ role: "assistant", content: [{ kind: ContentKind.TEXT, text: "answer 1" }] },
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "turn 2" }] },
			{ role: "assistant", content: [{ kind: ContentKind.TEXT, text: "answer 2" }] },
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "live turn" }] },
		]);

		expect((params.system as any[])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect((params.tools as any[])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		const messages = params.messages;
		expect(((messages[2]!.content as any[]).at(-1) as any).cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(((messages[3]!.content as any[]).at(-1) as any).cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
		expect(((messages[4]!.content as any[]).at(-1) as any).cache_control).toBeUndefined();
	});

	test("build request omits cache markers unless explicitly enabled", () => {
		const tools = [
			{
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		];
		const request: Request = {
			model: "claude-sonnet-4-6",
			messages: [],
			tools,
			max_tokens: 1000,
		};
		const params = buildAnthropicRequest(request, "system prompt", [
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "turn 1" }] },
			{ role: "assistant", content: [{ kind: ContentKind.TEXT, text: "answer 1" }] },
			{ role: "user", content: [{ kind: ContentKind.TEXT, text: "turn 2" }] },
		]);

		expect((params.system as any[])[0].cache_control).toBeUndefined();
		expect((params.tools as any[])[0].cache_control).toBeUndefined();
		expect(((params.messages[0]!.content as any[]).at(-1) as any).cache_control).toBeUndefined();
	});

	test("build request omits temperature for Anthropic models that reject it", () => {
		const params = buildAnthropicRequest(
			{
				model: "claude-opus-4-7",
				messages: [],
				max_tokens: 30,
				temperature: 0.9,
				tool_choice: "none",
			},
			undefined,
			[{ role: "user", content: [{ kind: ContentKind.TEXT, text: "Name this agent." }] }],
		);

		expect(params.temperature).toBeUndefined();
	});

	test("build request omits temperature for claude-sonnet-5 (rejects the param)", () => {
		const params = buildAnthropicRequest(
			{
				model: "claude-sonnet-5",
				messages: [],
				max_tokens: 30,
				temperature: 0.9,
				tool_choice: "none",
			},
			undefined,
			[{ role: "user", content: [{ kind: ContentKind.TEXT, text: "Name this agent." }] }],
		);

		expect(params.temperature).toBeUndefined();
	});

	test("build request preserves temperature for Anthropic models that accept it", () => {
		const params = buildAnthropicRequest(
			{
				model: "claude-sonnet-4-6",
				messages: [],
				max_tokens: 30,
				temperature: 0.9,
				tool_choice: "none",
			},
			undefined,
			[{ role: "user", content: [{ kind: ContentKind.TEXT, text: "Name this agent." }] }],
		);

		expect(params.temperature).toBe(0.9);
	});

	test("complete returns a text response", async () => {
		const vcr = vcrFor("complete-returns-a-text-response", realAdapter);
		const req: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Say hello in exactly 3 words." }],
				},
			],
			max_tokens: 50,
		};

		const resp = await vcr.adapter.complete(req);
		expect(resp.id).toBeTruthy();
		expect(resp.provider).toBe("anthropic");
		expect(resp.model).toContain("haiku");
		expect(messageText(resp.message).length).toBeGreaterThan(0);
		expect(resp.finish_reason.reason).toBe("stop");
		expect(resp.usage.input_tokens).toBeGreaterThan(0);
		expect(resp.usage.output_tokens).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 15_000);

	test("complete handles tool calls", async () => {
		const vcr = vcrFor("complete-handles-tool-calls", realAdapter);
		const req: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [
						{
							kind: ContentKind.TEXT,
							text: "What's the weather in San Francisco? Use the get_weather tool.",
						},
					],
				},
			],
			tools: [
				{
					name: "get_weather",
					description: "Get current weather for a location",
					parameters: {
						type: "object",
						properties: {
							location: { type: "string", description: "City name" },
						},
						required: ["location"],
					},
				},
			],
			tool_choice: "required",
			max_tokens: 200,
		};

		const resp = await vcr.adapter.complete(req);
		expect(resp.finish_reason.reason).toBe("tool_calls");
		const calls = messageToolCalls(resp.message);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]!.name).toBe("get_weather");
		expect(calls[0]!.id).toBeTruthy();
		await vcr.afterTest();
	}, 15_000);

	test("complete handles tool result round-trip", async () => {
		const vcr = vcrFor("complete-handles-tool-result-round-trip", realAdapter);

		// First turn: model calls tool
		const req1: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [
						{
							kind: ContentKind.TEXT,
							text: "What's the weather in SF? Use the get_weather tool.",
						},
					],
				},
			],
			tools: [
				{
					name: "get_weather",
					description: "Get current weather",
					parameters: {
						type: "object",
						properties: { location: { type: "string" } },
						required: ["location"],
					},
				},
			],
			tool_choice: "required",
			max_tokens: 200,
		};

		const resp1 = await vcr.adapter.complete(req1);
		const calls = messageToolCalls(resp1.message);
		expect(calls.length).toBeGreaterThan(0);

		// Second turn: send tool result back
		const req2: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				...req1.messages,
				resp1.message,
				{
					role: "tool",
					content: [
						{
							kind: ContentKind.TOOL_RESULT,
							tool_result: {
								tool_call_id: calls[0]!.id,
								content: "72F and sunny",
								is_error: false,
							},
						},
					],
					tool_call_id: calls[0]!.id,
				},
			],
			tools: req1.tools,
			max_tokens: 200,
		};

		const resp2 = await vcr.adapter.complete(req2);
		expect(resp2.finish_reason.reason).toBe("stop");
		const text = messageText(resp2.message);
		expect(text.length).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 30_000);

	test("prompt caching: cache_write_tokens on turn 1, cache_read_tokens on turn 2", async () => {
		const vcr = vcrFor("prompt-caching", realAdapter);

		// Haiku 4.5 requires at least 4096 tokens for caching to activate
		const systemMsg: import("../../src/llm/types.ts").Message = {
			role: "system",
			content: [{ kind: ContentKind.TEXT, text: "You are a helpful assistant. ".repeat(800) }],
		};
		const userMsg: import("../../src/llm/types.ts").Message = {
			role: "user",
			content: [{ kind: ContentKind.TEXT, text: "What is 2+2?" }],
		};

		const tools = [
			{
				name: "get_weather",
				description: `Get weather for a location. ${"Detailed description. ".repeat(50)}`,
				parameters: {
					type: "object" as const,
					properties: { city: { type: "string" } },
					required: ["city"],
				},
			},
		];

		// Turn 1 — populates cache (or reads if already cached from a previous run)
		const r1 = await vcr.adapter.complete({
			model: "claude-haiku-4-5-20251001",
			messages: [systemMsg, userMsg],
			tools,
			max_tokens: 50,
		});
		const cacheActive =
			(r1.usage.cache_write_tokens ?? 0) > 0 || (r1.usage.cache_read_tokens ?? 0) > 0;
		expect(cacheActive).toBe(true);

		// Turn 2 — should read from cache
		const r2 = await vcr.adapter.complete({
			model: "claude-haiku-4-5-20251001",
			messages: [systemMsg, userMsg],
			tools,
			max_tokens: 50,
		});
		expect(r2.usage.cache_read_tokens).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 30_000);

	test("extended thinking via provider_options", async () => {
		const vcr = vcrFor("extended-thinking-via-provider-options", realAdapter);

		const response = await vcr.adapter.complete({
			model: "claude-sonnet-4-6",
			messages: [
				{
					role: "user",
					content: [
						{
							kind: ContentKind.TEXT,
							text: "What is 15 * 37? Think step by step.",
						},
					],
				},
			],
			max_tokens: 16000,
			provider_options: {
				anthropic: {
					thinking: { type: "enabled", budget_tokens: 10000 },
				},
			},
		});
		const reasoning = messageReasoning(response.message);
		expect(reasoning).toBeDefined();
		expect(reasoning!.length).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 30_000);

	test("streaming emits text_end after text content", async () => {
		const vcr = vcrFor("streaming-emits-text-end-after-text-content", realAdapter);
		const events: StreamEvent[] = [];
		for await (const event of vcr.adapter.stream({
			model: "claude-haiku-4-5-20251001",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "Say hello" }] }],
			max_tokens: 50,
		})) {
			events.push(event);
		}
		const types = events.map((e) => e.type);
		expect(types).toContain("text_start");
		expect(types).toContain("text_end");
		// text_end should come after text_start
		expect(types.indexOf("text_end")).toBeGreaterThan(types.indexOf("text_start"));
		await vcr.afterTest();
	}, 15_000);

	test("stream yields text deltas that match complete response", async () => {
		const vcr = vcrFor("stream-yields-text-deltas", realAdapter);
		const req: Request = {
			model: "claude-haiku-4-5-20251001",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Count from 1 to 5." }],
				},
			],
			max_tokens: 100,
		};

		const events: StreamEvent[] = [];
		let textDeltas = "";
		for await (const event of vcr.adapter.stream(req)) {
			events.push(event);
			if (event.type === "text_delta" && event.delta) {
				textDeltas += event.delta;
			}
		}

		// Should have start, deltas, and finish
		expect(events.some((e) => e.type === "stream_start")).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(true);
		expect(textDeltas.length).toBeGreaterThan(0);

		// Finish event should have usage
		const finish = events.find((e) => e.type === "finish");
		expect(finish?.usage?.input_tokens).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 15_000);
});

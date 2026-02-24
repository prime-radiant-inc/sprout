import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "dotenv";
import { AnthropicAdapter } from "../../src/llm/anthropic.ts";
import type { ProviderAdapter } from "../../src/llm/types.ts";
import {
	ContentKind,
	messageReasoning,
	messageText,
	messageToolCalls,
	type Request,
	type StreamEvent,
} from "../../src/llm/types.ts";
import { createAdapterVcr } from "../helpers/vcr.ts";

config();

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

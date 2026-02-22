import { beforeAll, describe, expect, test } from "bun:test";
import { config } from "dotenv";
import { GeminiAdapter } from "../../src/llm/gemini.ts";
import { ContentKind, messageText, messageToolCalls, type Request } from "../../src/llm/types.ts";

config();

describe("GeminiAdapter", () => {
	let adapter: GeminiAdapter;

	beforeAll(() => {
		const key = process.env.GEMINI_API_KEY;
		if (!key) throw new Error("GEMINI_API_KEY not set");
		adapter = new GeminiAdapter(key);
	});

	test("adapter name is gemini", () => {
		expect(adapter.name).toBe("gemini");
	});

	test("complete returns a text response", async () => {
		const req: Request = {
			model: "gemini-2.5-flash",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Say hello in exactly 3 words." }],
				},
			],
			max_tokens: 500,
		};

		const resp = await adapter.complete(req);
		expect(resp.provider).toBe("gemini");
		expect(messageText(resp.message).length).toBeGreaterThan(0);
		expect(["stop", "length"]).toContain(resp.finish_reason.reason);
		expect(resp.usage.input_tokens).toBeGreaterThan(0);
		expect(resp.usage.output_tokens).toBeGreaterThan(0);
	}, 15_000);

	test("complete handles tool calls", async () => {
		const req: Request = {
			model: "gemini-2.5-flash",
			messages: [
				{
					role: "user",
					content: [
						{
							kind: ContentKind.TEXT,
							text: "What's the weather in San Francisco? You must use the get_weather tool.",
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
			max_tokens: 200,
		};

		const resp = await adapter.complete(req);
		expect(resp.finish_reason.reason).toBe("tool_calls");
		const calls = messageToolCalls(resp.message);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]!.name).toBe("get_weather");
	}, 15_000);

	test("complete handles tool result round-trip", async () => {
		const req1: Request = {
			model: "gemini-2.5-flash",
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
			max_tokens: 200,
		};

		const resp1 = await adapter.complete(req1);
		const calls = messageToolCalls(resp1.message);
		expect(calls.length).toBeGreaterThan(0);

		const req2: Request = {
			model: "gemini-2.5-flash",
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

		const resp2 = await adapter.complete(req2);
		expect(resp2.finish_reason.reason).toBe("stop");
		expect(messageText(resp2.message).length).toBeGreaterThan(0);
	}, 30_000);

	test("stream yields text deltas", async () => {
		const req: Request = {
			model: "gemini-2.5-flash",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Count from 1 to 5." }],
				},
			],
			max_tokens: 100,
		};

		const events = [];
		let textDeltas = "";
		for await (const event of adapter.stream(req)) {
			events.push(event);
			if (event.type === "text_delta" && event.delta) {
				textDeltas += event.delta;
			}
		}

		expect(events.some((e) => e.type === "stream_start")).toBe(true);
		expect(events.some((e) => e.type === "text_delta")).toBe(true);
		expect(events.some((e) => e.type === "finish")).toBe(true);
		expect(textDeltas.length).toBeGreaterThan(0);

		const finish = events.find((e) => e.type === "finish");
		expect(finish?.usage).toBeDefined();
	}, 15_000);
});

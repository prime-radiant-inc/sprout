import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "dotenv";
import { GeminiAdapter } from "../../src/llm/gemini.ts";
import type { ProviderAdapter } from "../../src/llm/types.ts";
import { ContentKind, messageText, messageToolCalls, type Request } from "../../src/llm/types.ts";
import { createAdapterVcr } from "../helpers/vcr.ts";

config();

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/llm-gemini");

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

describe("GeminiAdapter", () => {
	let realAdapter: GeminiAdapter | undefined;

	beforeAll(() => {
		const key = process.env.GEMINI_API_KEY;
		if (key) {
			realAdapter = new GeminiAdapter(key);
		}
	});

	test("adapter name is gemini", async () => {
		const vcr = vcrFor("adapter-name-is-gemini", realAdapter);
		expect(vcr.adapter.name).toBe("gemini");
		await vcr.afterTest();
	});

	test("complete returns a text response", async () => {
		const vcr = vcrFor("complete-returns-a-text-response", realAdapter);
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

		const resp = await vcr.adapter.complete(req);
		expect(resp.provider).toBe("gemini");
		expect(messageText(resp.message).length).toBeGreaterThan(0);
		expect(["stop", "length"]).toContain(resp.finish_reason.reason);
		expect(resp.usage.input_tokens).toBeGreaterThan(0);
		expect(resp.usage.output_tokens).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 15_000);

	test("complete handles tool calls", async () => {
		const vcr = vcrFor("complete-handles-tool-calls", realAdapter);
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

		const resp = await vcr.adapter.complete(req);
		expect(resp.finish_reason.reason).toBe("tool_calls");
		const calls = messageToolCalls(resp.message);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]!.name).toBe("get_weather");
		await vcr.afterTest();
	}, 15_000);

	test("complete handles tool result round-trip", async () => {
		const vcr = vcrFor("complete-handles-tool-result-round-trip", realAdapter);
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

		const resp1 = await vcr.adapter.complete(req1);
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

		const resp2 = await vcr.adapter.complete(req2);
		expect(resp2.finish_reason.reason).toBe("stop");
		expect(messageText(resp2.message).length).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 30_000);

	test("separate adapter instances don't share call ID state", async () => {
		// This test needs two separate adapters, but VCR records sequentially.
		// We use two VCR instances to record each adapter's calls separately.
		const vcr1 = vcrFor(
			"separate-adapters-instance-1",
			realAdapter ? new GeminiAdapter(process.env.GEMINI_API_KEY!) : undefined,
		);
		const vcr2 = vcrFor(
			"separate-adapters-instance-2",
			realAdapter ? new GeminiAdapter(process.env.GEMINI_API_KEY!) : undefined,
		);

		const toolReq: Request = {
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
					description: "Get weather for a city",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			],
			max_tokens: 200,
		};

		const resp1 = await vcr1.adapter.complete(toolReq);
		const calls1 = messageToolCalls(resp1.message);
		expect(calls1.length).toBeGreaterThan(0);
		await vcr1.afterTest();

		const resp2 = await vcr2.adapter.complete(toolReq);
		const calls2 = messageToolCalls(resp2.message);
		expect(calls2.length).toBeGreaterThan(0);
		await vcr2.afterTest();

		// Both should produce call_gemini_1 as first ID — independent counters
		expect(calls1[0]!.id).toBe("call_gemini_1");
		expect(calls2[0]!.id).toBe("call_gemini_1");
	}, 30_000);

	test("stream yields text deltas", async () => {
		const vcr = vcrFor("stream-yields-text-deltas", realAdapter);
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
		for await (const event of vcr.adapter.stream(req)) {
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
		await vcr.afterTest();
	}, 15_000);
});

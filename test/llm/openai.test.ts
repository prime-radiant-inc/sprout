import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildResponsesInput, buildResponsesParams, OpenAIAdapter } from "../../src/llm/openai.ts";
import type { ProviderAdapter } from "../../src/llm/types.ts";
import { ContentKind, messageText, messageToolCalls, type Request } from "../../src/llm/types.ts";
import "../helpers/test-env.ts";
import { createAdapterVcr } from "../helpers/vcr.ts";

const FIXTURE_DIR = join(import.meta.dir, "../fixtures/vcr/llm-openai");

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

describe("OpenAIAdapter", () => {
	let realAdapter: OpenAIAdapter | undefined;

	beforeAll(() => {
		const key = process.env.OPENAI_API_KEY;
		if (key) {
			realAdapter = new OpenAIAdapter(key);
		}
	});

	test("adapter name is openai", async () => {
		const vcr = vcrFor("adapter-name-is-openai", realAdapter);
		expect(vcr.adapter.name).toBe("openai");
		await vcr.afterTest();
	});

	test("build request passes prompt cache key", () => {
		const request: Request = {
			model: "gpt-4.1-mini",
			messages: [
				{
					role: "system",
					content: [{ kind: ContentKind.TEXT, text: "system prompt" }],
				},
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "hello" }],
				},
			],
			provider_options: {
				openai: {
					prompt_cache_key: "01SESSION:engineer",
					prompt_cache_retention: "in_memory",
				},
			},
		};

		const params = buildResponsesParams(request, buildResponsesInput(request));
		expect((params as any).prompt_cache_key).toBe("01SESSION:engineer");
		expect((params as any).prompt_cache_retention).toBe("in_memory");
	});

	test("reads Responses API cached input token telemetry", async () => {
		const rawResponse = {
			id: "resp-cache",
			model: "gpt-4.1-mini",
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: "cached" }],
				},
			],
			usage: {
				input_tokens: 100,
				output_tokens: 5,
				input_tokens_details: { cached_tokens: 42 },
				prompt_tokens_details: { cached_tokens: 7 },
			},
		};
		async function* streamResponse() {
			yield { type: "response.output_text.delta", delta: "cached" };
			yield { type: "response.output_item.done", item: { type: "message" } };
			yield { type: "response.completed", response: rawResponse };
		}
		const adapter = new OpenAIAdapter("test-key");
		(adapter as any).client = {
			responses: {
				create: async (params: { stream?: boolean }) =>
					params.stream ? streamResponse() : rawResponse,
			},
		};
		const request: Request = {
			model: "gpt-4.1-mini",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hello" }] }],
		};

		const complete = await adapter.complete(request);
		const streamEvents = [];
		for await (const event of adapter.stream(request)) {
			streamEvents.push(event);
		}
		const finish = streamEvents.find((event) => event.type === "finish");

		expect(complete.usage.cache_read_tokens).toBe(42);
		expect(finish?.usage?.cache_read_tokens).toBe(42);
	});

	test("complete returns a text response", async () => {
		const vcr = vcrFor("complete-returns-a-text-response", realAdapter);
		const req: Request = {
			model: "gpt-4.1-mini",
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
		expect(resp.provider).toBe("openai");
		expect(messageText(resp.message).length).toBeGreaterThan(0);
		expect(resp.finish_reason.reason).toBe("stop");
		expect(resp.usage.input_tokens).toBeGreaterThan(0);
		expect(resp.usage.output_tokens).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 15_000);

	test("complete handles tool calls", async () => {
		const vcr = vcrFor("complete-handles-tool-calls", realAdapter);
		const req: Request = {
			model: "gpt-4.1-mini",
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
			tool_choice: "required",
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
			model: "gpt-4.1-mini",
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

		const req2: Request = {
			model: "gpt-4.1-mini",
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

	test("reasoning_effort passthrough does not error", async () => {
		const vcr = vcrFor("reasoning-effort-passthrough", realAdapter);
		const response = await vcr.adapter.complete({
			model: "o4-mini",
			messages: [
				{
					role: "user",
					content: [{ kind: ContentKind.TEXT, text: "Say hello" }],
				},
			],
			reasoning_effort: "low",
			max_tokens: 1000,
		});
		expect(response.message).toBeDefined();
		await vcr.afterTest();
	}, 15_000);

	test("stream yields text deltas", async () => {
		const vcr = vcrFor("stream-yields-text-deltas", realAdapter);
		const req: Request = {
			model: "gpt-4.1-mini",
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
		expect(finish?.usage?.input_tokens).toBeGreaterThan(0);
		await vcr.afterTest();
	}, 15_000);
});

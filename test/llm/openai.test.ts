import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	buildChatCompletionsParams,
	buildResponsesInput,
	buildResponsesParams,
	OpenAIAdapter,
	safeParseJSON,
} from "../../src/llm/openai.ts";
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

	test("builds chat completions requests for openai-compatible providers", () => {
		const request: Request = {
			model: "qwen",
			messages: [
				{ role: "system", content: [{ kind: ContentKind.TEXT, text: "system prompt" }] },
				{ role: "user", content: [{ kind: ContentKind.TEXT, text: "read a file" }] },
			],
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
			tool_choice: "required",
			max_tokens: 200,
			provider_options: {
				openai: {
					extra_body: { seed: 123 },
				},
			},
		};

		const params = buildChatCompletionsParams(request);

		expect(params.messages).toEqual([
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "read a file" },
		]);
		expect(params.tools[0].function.name).toBe("read_file");
		expect(params.tool_choice).toBe("required");
		expect(params.max_tokens).toBe(200);
		expect(params.seed).toBe(123);
	});

	test("safeParseJSON preserves valid JSON values", () => {
		expect(safeParseJSON('{"ok":true}')).toEqual({ ok: true });
		expect(safeParseJSON("[1,2]") as unknown).toEqual([1, 2]);
		expect(safeParseJSON('"hello"') as unknown).toBe("hello");
		expect(safeParseJSON("null") as unknown).toBeNull();
		expect(safeParseJSON("not json")).toEqual({ raw: "not json" });
		expect(safeParseJSON(undefined)).toEqual({ raw: undefined });
	});

	test("openai-compatible complete uses chat completions and parses tool calls", async () => {
		const adapter = new OpenAIAdapter("unused", {
			providerId: "lmstudio",
			kind: "openai-compatible",
			baseUrl: "http://127.0.0.1:1234/v1",
		});
		let chatCalled = false;
		let responsesCalled = false;
		(adapter as any).client = {
			responses: {
				create: async () => {
					responsesCalled = true;
					throw new Error("responses should not be used");
				},
			},
			chat: {
				completions: {
					create: async (params: any) => {
						chatCalled = true;
						expect(params.think).toBe(false);
						return {
							id: "chatcmpl-local",
							model: "qwen",
							choices: [
								{
									message: {
										role: "assistant",
										content: null,
										tool_calls: [
											{
												id: "call_1",
												type: "function",
												function: {
													name: "read_file",
													arguments: '{"path":"README.md"}',
												},
											},
										],
									},
									finish_reason: "tool_calls",
								},
							],
							usage: {
								prompt_tokens: 11,
								completion_tokens: 4,
								total_tokens: 15,
							},
						};
					},
				},
			},
		};

		const response = await adapter.complete({
			model: "qwen",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "read" }] }],
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "required",
		});

		expect(chatCalled).toBe(true);
		expect(responsesCalled).toBe(false);
		expect(response.provider).toBe("openai-compatible");
		expect(response.finish_reason.reason).toBe("tool_calls");
		const calls = messageToolCalls(response.message);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("read_file");
		expect(calls[0]!.arguments).toEqual({ path: "README.md" });
		expect(response.usage.input_tokens).toBe(11);
		expect(response.usage.output_tokens).toBe(4);
	});

	test("openai-compatible stream uses chat completions", async () => {
		const adapter = new OpenAIAdapter("unused", {
			providerId: "ollama",
			kind: "openai-compatible",
			baseUrl: "http://127.0.0.1:11434/v1",
		});
		let chatCalled = false;
		(adapter as any).client = {
			chat: {
				completions: {
					create: async function* () {
						chatCalled = true;
						yield {
							choices: [{ delta: { content: "hello" }, finish_reason: null }],
						};
						yield {
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
						};
					},
				},
			},
		};

		const events = [];
		for await (const event of adapter.stream({
			model: "qwen",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hi" }] }],
		})) {
			events.push(event);
		}

		expect(chatCalled).toBe(true);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		const finish = events.find((event) => event.type === "finish");
		expect(finish?.usage?.input_tokens).toBe(3);
		expect(finish?.usage?.output_tokens).toBe(1);
	});

	test("openai-compatible extra_body can override chat defaults", async () => {
		const adapter = new OpenAIAdapter("unused", {
			providerId: "ollama",
			kind: "openai-compatible",
			baseUrl: "http://127.0.0.1:11434/v1",
		});
		let capturedThink: unknown;
		(adapter as any).client = {
			chat: {
				completions: {
					create: async (params: any) => {
						capturedThink = params.think;
						return {
							id: "chatcmpl-local",
							model: "qwen",
							choices: [
								{
									message: { role: "assistant", content: "ok" },
									finish_reason: "stop",
								},
							],
							usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
						};
					},
				},
			},
		};

		await adapter.complete({
			model: "qwen",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hi" }] }],
			provider_options: { openai: { extra_body: { think: true } } },
		});

		expect(capturedThink).toBe(true);
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
		expect(complete.usage.input_tokens).toBe(58);
		expect(complete.usage.total_input_tokens).toBe(100);
		expect(complete.usage.total_tokens).toBe(105);
		expect(finish?.usage?.cache_read_tokens).toBe(42);
		expect(finish?.usage?.input_tokens).toBe(58);
		expect(finish?.usage?.total_input_tokens).toBe(100);
		expect(finish?.usage?.total_tokens).toBe(105);
	});

	test("responses stream orders function call argument events before output item completion", async () => {
		const rawResponse = {
			id: "resp-stream-tools",
			model: "gpt-4.1-mini",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_weather",
					call_id: "call_weather",
					name: "get_weather",
					arguments: '{"location":"San Francisco"}',
				},
			],
			usage: {
				input_tokens: 12,
				output_tokens: 6,
			},
		};
		async function* streamResponse() {
			yield {
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_weather",
					call_id: "call_weather",
					name: "get_weather",
				},
			};
			yield {
				type: "response.function_call_arguments.delta",
				item_id: "fc_weather",
				delta: '{"location":',
			};
			yield {
				type: "response.function_call_arguments.delta",
				item_id: "fc_weather",
				delta: '"San Francisco"}',
			};
			yield {
				type: "response.function_call_arguments.done",
				item_id: "fc_weather",
				arguments: '{"location":"San Francisco"}',
			};
			yield {
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_weather",
					call_id: "call_weather",
					name: "get_weather",
				},
			};
			yield { type: "response.completed", response: rawResponse };
		}
		const adapter = new OpenAIAdapter("test-key");
		(adapter as any).client.responses.create = async () => streamResponse();

		const events = [];
		for await (const event of adapter.stream({
			model: "gpt-4.1-mini",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather" }] }],
			tools: [
				{
					name: "get_weather",
					description: "Get weather",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "required",
		})) {
			events.push(event);
		}

		expect(events.map((event) => event.type)).toEqual([
			"stream_start",
			"tool_call_delta",
			"tool_call_delta",
			"tool_call_end",
			"finish",
		]);
		expect(events[1]?.delta).toBe('{"location":');
		expect(events[2]?.delta).toBe('"San Francisco"}');
		expect(events[3]?.tool_call).toEqual({
			id: "call_weather",
			name: "get_weather",
			arguments: { location: "San Francisco" },
		});
		const finish = events[4];
		expect(finish?.usage?.input_tokens).toBe(12);
		expect(finish?.usage?.output_tokens).toBe(6);
		expect(finish?.response ? messageToolCalls(finish.response.message) : []).toEqual([
			{
				id: "call_weather",
				name: "get_weather",
				arguments: { location: "San Francisco" },
			},
		]);
	});

	test("responses stream merges output-indexed function call events without duplicates", async () => {
		const rawResponse = {
			id: "resp-stream-output-index",
			model: "gpt-4.1-mini",
			status: "completed",
			output: [
				{
					type: "function_call",
					call_id: "call_weather",
					name: "get_weather",
					arguments: '{"location":"San Francisco"}',
				},
			],
			usage: {
				input_tokens: 12,
				output_tokens: 6,
			},
		};
		async function* streamResponse() {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					call_id: "call_weather",
					name: "get_weather",
				},
			};
			yield {
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_weather",
				delta: '{"location":',
			};
			yield {
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_weather",
				delta: '"San Francisco"}',
			};
			yield {
				type: "response.function_call_arguments.done",
				output_index: 0,
				item_id: "fc_weather",
				arguments: '{"location":"San Francisco"}',
			};
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					call_id: "call_weather",
					name: "get_weather",
				},
			};
			yield { type: "response.completed", response: rawResponse };
		}
		const adapter = new OpenAIAdapter("test-key");
		(adapter as any).client.responses.create = async () => streamResponse();

		const events = [];
		for await (const event of adapter.stream({
			model: "gpt-4.1-mini",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather" }] }],
			tools: [
				{
					name: "get_weather",
					description: "Get weather",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "required",
		})) {
			events.push(event);
		}

		const toolCallEnds = events.filter((event) => event.type === "tool_call_end");
		expect(toolCallEnds).toHaveLength(1);
		expect(toolCallEnds[0]?.tool_call).toEqual({
			id: "call_weather",
			name: "get_weather",
			arguments: { location: "San Francisco" },
		});

		const finish = events.find((event) => event.type === "finish");
		const toolCalls = finish?.response ? messageToolCalls(finish.response.message) : [];
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toEqual({
			id: "call_weather",
			name: "get_weather",
			arguments: { location: "San Francisco" },
		});
	});

	test("responses stream uses incomplete and failed terminal responses for finish state", async () => {
		const cases = [
			{
				eventType: "response.incomplete",
				status: "incomplete",
				expectedReason: "length",
				inputTokens: 21,
				outputTokens: 5,
			},
			{
				eventType: "response.failed",
				status: "failed",
				expectedReason: "error",
				inputTokens: 13,
				outputTokens: 2,
			},
		] as const;

		for (const streamCase of cases) {
			const rawResponse = {
				id: `resp-${streamCase.status}`,
				model: "gpt-4.1-mini",
				status: streamCase.status,
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text: streamCase.status }],
					},
				],
				usage: {
					input_tokens: streamCase.inputTokens,
					output_tokens: streamCase.outputTokens,
				},
			};
			async function* streamResponse() {
				yield { type: "response.output_text.delta", delta: streamCase.status };
				yield { type: "response.output_item.done", item: { type: "message" } };
				yield { type: streamCase.eventType, response: rawResponse };
			}
			const adapter = new OpenAIAdapter("test-key");
			(adapter as any).client.responses.create = async () => streamResponse();

			const events = [];
			for await (const event of adapter.stream({
				model: "gpt-4.1-mini",
				messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "status" }] }],
			})) {
				events.push(event);
			}

			const finish = events.find((event) => event.type === "finish");
			expect(finish?.finish_reason?.reason).toBe(streamCase.expectedReason);
			expect(finish?.finish_reason?.raw).toBe(streamCase.status);
			expect(finish?.usage?.input_tokens).toBe(streamCase.inputTokens);
			expect(finish?.usage?.output_tokens).toBe(streamCase.outputTokens);
			expect(finish?.usage?.total_tokens).toBe(streamCase.inputTokens + streamCase.outputTokens);
		}
	});

	test("responses stream does not finish partial tool calls on incomplete or failed terminal responses", async () => {
		const cases = [
			{
				eventType: "response.incomplete",
				status: "incomplete",
				expectedReason: "length",
				inputTokens: 34,
				outputTokens: 7,
			},
			{
				eventType: "response.failed",
				status: "failed",
				expectedReason: "error",
				inputTokens: 19,
				outputTokens: 3,
			},
		] as const;

		for (const streamCase of cases) {
			const rawResponse = {
				id: `resp-partial-${streamCase.status}`,
				model: "gpt-4.1-mini",
				status: streamCase.status,
				output: [],
				usage: {
					input_tokens: streamCase.inputTokens,
					output_tokens: streamCase.outputTokens,
				},
			};
			async function* streamResponse() {
				yield {
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_weather",
						call_id: "call_weather",
						name: "get_weather",
					},
				};
				yield {
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_weather",
					delta: '{"location":',
				};
				yield { type: streamCase.eventType, response: rawResponse };
			}
			const adapter = new OpenAIAdapter("test-key");
			(adapter as any).client.responses.create = async () => streamResponse();

			const events = [];
			for await (const event of adapter.stream({
				model: "gpt-4.1-mini",
				messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather" }] }],
				tools: [
					{
						name: "get_weather",
						description: "Get weather",
						parameters: { type: "object", properties: {} },
					},
				],
				tool_choice: "required",
			})) {
				events.push(event);
			}

			expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
			const finish = events.find((event) => event.type === "finish");
			expect(finish?.finish_reason?.reason).toBe(streamCase.expectedReason);
			expect(finish?.finish_reason?.raw).toBe(streamCase.status);
			expect(finish?.usage?.input_tokens).toBe(streamCase.inputTokens);
			expect(finish?.usage?.output_tokens).toBe(streamCase.outputTokens);
			expect(finish?.response ? messageToolCalls(finish.response.message) : []).toEqual([]);
		}
	});

	test("responses stream does not finish function call done items with incomplete or failed status", async () => {
		const cases = [
			{
				itemStatus: "incomplete",
				eventType: "response.incomplete",
				terminalStatus: "incomplete",
				expectedReason: "length",
				inputTokens: 41,
				outputTokens: 8,
			},
			{
				itemStatus: "failed",
				eventType: "response.failed",
				terminalStatus: "failed",
				expectedReason: "error",
				inputTokens: 23,
				outputTokens: 4,
			},
		] as const;

		for (const streamCase of cases) {
			const rawResponse = {
				id: `resp-done-item-${streamCase.terminalStatus}`,
				model: "gpt-4.1-mini",
				status: streamCase.terminalStatus,
				output: [],
				usage: {
					input_tokens: streamCase.inputTokens,
					output_tokens: streamCase.outputTokens,
				},
			};
			async function* streamResponse() {
				yield {
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: "fc_weather",
					arguments: '{"location":"San Francisco"}',
				};
				yield {
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_weather",
						call_id: "call_weather",
						name: "get_weather",
						status: streamCase.itemStatus,
						arguments: '{"location":',
					},
				};
				yield { type: streamCase.eventType, response: rawResponse };
			}
			const adapter = new OpenAIAdapter("test-key");
			(adapter as any).client.responses.create = async () => streamResponse();

			const events = [];
			for await (const event of adapter.stream({
				model: "gpt-4.1-mini",
				messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather" }] }],
				tools: [
					{
						name: "get_weather",
						description: "Get weather",
						parameters: { type: "object", properties: {} },
					},
				],
				tool_choice: "required",
			})) {
				events.push(event);
			}

			expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
			const finish = events.find((event) => event.type === "finish");
			expect(finish?.finish_reason?.reason).toBe(streamCase.expectedReason);
			expect(finish?.finish_reason?.raw).toBe(streamCase.terminalStatus);
			expect(finish?.usage?.input_tokens).toBe(streamCase.inputTokens);
			expect(finish?.usage?.output_tokens).toBe(streamCase.outputTokens);
			expect(finish?.response ? messageToolCalls(finish.response.message) : []).toEqual([]);
		}
	});

	test("responses stream treats completed function call done item arguments as complete", async () => {
		const rawResponse = {
			id: "resp-completed-done-item",
			model: "gpt-4.1-mini",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_weather",
					call_id: "call_weather",
					name: "get_weather",
					arguments: '{"location":"San Francisco"}',
				},
			],
			usage: {
				input_tokens: 12,
				output_tokens: 6,
			},
		};
		async function* streamResponse() {
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_weather",
					call_id: "call_weather",
					name: "get_weather",
					status: "completed",
					arguments: '{"location":"San Francisco"}',
				},
			};
			yield { type: "response.completed", response: rawResponse };
		}
		const adapter = new OpenAIAdapter("test-key");
		(adapter as any).client.responses.create = async () => streamResponse();

		const events = [];
		for await (const event of adapter.stream({
			model: "gpt-4.1-mini",
			messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "weather" }] }],
			tools: [
				{
					name: "get_weather",
					description: "Get weather",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "required",
		})) {
			events.push(event);
		}

		const toolCallEnds = events.filter((event) => event.type === "tool_call_end");
		expect(toolCallEnds).toHaveLength(1);
		expect(toolCallEnds[0]?.tool_call).toEqual({
			id: "call_weather",
			name: "get_weather",
			arguments: { location: "San Francisco" },
		});
		const finish = events.find((event) => event.type === "finish");
		expect(finish?.finish_reason?.reason).toBe("tool_calls");
		expect(finish?.response ? messageToolCalls(finish.response.message) : []).toEqual([
			{
				id: "call_weather",
				name: "get_weather",
				arguments: { location: "San Francisco" },
			},
		]);
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

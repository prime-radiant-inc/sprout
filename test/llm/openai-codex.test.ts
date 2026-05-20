import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAICodexRuntimeCredentials } from "../../src/host/openai-codex-oauth/service.ts";
import { OpenAICodexAdapter } from "../../src/llm/openai-codex.ts";
import { ContentKind, messageText, messageToolCalls, type Request } from "../../src/llm/types.ts";

interface CapturedRequest {
	method: string;
	pathname: string;
	search: string;
	headers: Headers;
	body: unknown;
}

const baseRequest: Request = {
	model: "gpt-5.4",
	messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text: "hello" }] }],
};

const systemRequest: Request = {
	...baseRequest,
	messages: [
		{ role: "system", content: [{ kind: ContentKind.TEXT, text: "Be concise." }] },
		...baseRequest.messages,
	],
};

let servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
	for (const server of servers) {
		server.stop(true);
	}
	servers = [];
});

describe("OpenAICodexAdapter", () => {
	test("listModels sends Codex OAuth headers and parses remote models", async () => {
		const requests: CapturedRequest[] = [];
		const server = startCodexServer(async (request) => {
			requests.push(await captureRequest(request));
			return Response.json({
				models: [{ slug: "gpt-5.4", display_name: "GPT-5.4" }],
			});
		});
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		const models = await adapter.listModels();

		expect(models).toEqual([{ id: "gpt-5.4", label: "GPT-5.4", source: "remote" }]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.pathname).toBe("/backend-api/codex/models");
		expect(requests[0]?.search).toBe("?client_version=0.0.0");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer access");
		expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct");
	});

	test("listModels parses model and id fields from Codex models payloads", async () => {
		const server = startCodexServer(async () =>
			Response.json({
				models: [
					{ model: "gpt-model-field" },
					{ id: "gpt-id-field" },
					{
						slug: "gpt-slug-wins",
						model: "gpt-model-loses",
						id: "gpt-id-loses",
						display_name: "Slug Wins",
					},
					{
						slug: "",
						model: "gpt-model-fallback",
						id: "gpt-id-fallback",
					},
				],
			}),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		const models = await adapter.listModels();

		expect(models).toEqual([
			{ id: "gpt-model-field", label: "gpt-model-field", source: "remote" },
			{ id: "gpt-id-field", label: "gpt-id-field", source: "remote" },
			{ id: "gpt-slug-wins", label: "Slug Wins", source: "remote" },
			{ id: "gpt-model-fallback", label: "gpt-model-fallback", source: "remote" },
		]);
	});

	test("listModels parses OpenAI-style data payloads", async () => {
		const server = startCodexServer(async () =>
			Response.json({
				data: [{ id: "gpt-data-field" }],
			}),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		const models = await adapter.listModels();

		expect(models).toEqual([{ id: "gpt-data-field", label: "gpt-data-field", source: "remote" }]);
	});

	test("listModels rejects malformed model payloads with a clear error", async () => {
		const server = startCodexServer(async () =>
			Response.json({
				models: {},
			}),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		await expect(adapter.listModels()).rejects.toThrow(
			"OpenAI Codex models response was malformed",
		);
	});

	test("listModels rejects payloads without a usable model array", async () => {
		const server = startCodexServer(async () => Response.json({}));
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		await expect(adapter.listModels()).rejects.toThrow(
			"OpenAI Codex models response was malformed",
		);
	});

	test("listModels rejects malformed data payloads with a clear error", async () => {
		const server = startCodexServer(async () =>
			Response.json({
				data: {},
			}),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		await expect(adapter.listModels()).rejects.toThrow(
			"OpenAI Codex models response was malformed",
		);
	});

	test("complete sends the Codex-compatible responses request shape", async () => {
		const requests: CapturedRequest[] = [];
		const server = startCodexServer(async (request) => {
			requests.push(await captureRequest(request));
			return sseResponse([
				{ type: "response.output_text.delta", delta: "ready" },
				{ type: "response.output_text.done" },
				{
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc_read",
						call_id: "call_read",
						name: "read_file",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 1,
					item_id: "fc_read",
					delta: '{"path":"README.md"}',
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 1,
					item_id: "fc_read",
					arguments: '{"path":"README.md"}',
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: {
						type: "function_call",
						id: "fc_read",
						call_id: "call_read",
						name: "read_file",
						arguments: '{"path":"README.md"}',
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_codex",
						model: "gpt-5.4",
						status: "completed",
						output: [],
						usage: { input_tokens: 7, output_tokens: 3 },
					},
				},
			]);
		});
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		const response = await adapter.complete({
			...systemRequest,
			max_tokens: 16,
			temperature: 0,
			top_p: 1,
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "required",
			provider_options: {
				openai: {
					prompt_cache_key: "01SESSION:root",
					prompt_cache_retention: "in_memory",
				},
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.pathname).toBe("/backend-api/codex/responses");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer access");
		expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct");
		expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
		const body = requests[0]?.body as Record<string, unknown>;
		expect(body).toMatchObject({
			model: "gpt-5.4",
			instructions: "Be concise.",
			stream: true,
			store: false,
			parallel_tool_calls: true,
			tool_choice: "required",
			include: [],
			prompt_cache_key: "01SESSION:root",
		});
		expect(body.tools).toMatchObject([{ type: "function", name: "read_file" }]);
		expect(body).not.toHaveProperty("max_output_tokens");
		expect(body).not.toHaveProperty("prompt_cache_retention");
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("top_p");
		expect(messageText(response.message)).toBe("ready");
		expect(messageToolCalls(response.message)).toEqual([
			{ id: "call_read", name: "read_file", arguments: { path: "README.md" } },
		]);
		expect(response.finish_reason.reason).toBe("tool_calls");
		expect(response.usage.input_tokens).toBe(7);
		expect(response.usage.output_tokens).toBe(3);
	});

	test("stream surfaces Codex detail errors from non-OpenAI error payloads", async () => {
		const server = startCodexServer(async () =>
			Response.json({ detail: "Store must be set to false" }, { status: 400 }),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		await expect(Array.fromAsync(adapter.stream(baseRequest))).rejects.toThrow(
			"OpenAI Codex responses request failed: 400 Store must be set to false",
		);
	});

	test("complete rejects streams that end without a terminal Responses event", async () => {
		const server = startCodexServer(async () =>
			sseResponse([{ type: "response.output_text.delta", delta: "partial" }]),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		await expect(adapter.complete(baseRequest)).rejects.toThrow(
			"OpenAI Codex response stream ended without terminal response",
		);
	});

	test("stream rejects streams that end without a terminal Responses event", async () => {
		const server = startCodexServer(async () =>
			sseResponse([{ type: "response.output_text.delta", delta: "partial" }]),
		);
		const adapter = createAdapter(server.url.toString(), async () => credentials("access", "acct"));

		await expect(Array.fromAsync(adapter.stream(baseRequest))).rejects.toThrow(
			"OpenAI Codex response stream ended without terminal response",
		);
	});

	test("stream resolves fresh credentials per request and forwards accumulator events", async () => {
		const requests: CapturedRequest[] = [];
		const server = startCodexServer(async (request) => {
			requests.push(await captureRequest(request));
			return sseResponse([
				{ type: "response.output_text.delta", delta: `chunk-${requests.length}` },
				{ type: "response.output_text.done" },
				{
					type: "response.completed",
					response: {
						id: `resp_${requests.length}`,
						model: "gpt-5.4",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			]);
		});
		let credentialIndex = 0;
		const adapter = createAdapter(server.url.toString(), async () => {
			credentialIndex += 1;
			return credentials(`access-${credentialIndex}`, `acct-${credentialIndex}`);
		});

		const first = await Array.fromAsync(adapter.stream(baseRequest));
		const second = await Array.fromAsync(adapter.stream(baseRequest));

		expect(first.find((event) => event.type === "text_delta")?.delta).toBe("chunk-1");
		expect(second.find((event) => event.type === "text_delta")?.delta).toBe("chunk-2");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer access-1");
		expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct-1");
		expect(requests[1]?.headers.get("authorization")).toBe("Bearer access-2");
		expect(requests[1]?.headers.get("chatgpt-account-id")).toBe("acct-2");
	});
});

function createAdapter(
	serverUrl: string,
	resolveCredentials: (providerId: string) => Promise<OpenAICodexRuntimeCredentials>,
): OpenAICodexAdapter {
	return new OpenAICodexAdapter({
		providerId: "codex-test",
		baseURL: `${serverUrl}backend-api/codex`,
		resolveCredentials,
	});
}

function credentials(accessToken: string, accountId: string): OpenAICodexRuntimeCredentials {
	return {
		accessToken,
		accountId,
		expiresAt: "2026-05-20T12:00:00.000Z",
	};
}

function startCodexServer(
	handler: (request: globalThis.Request) => Promise<Response>,
): ReturnType<typeof Bun.serve> {
	const server = Bun.serve({
		port: 0,
		fetch: handler,
	});
	servers.push(server);
	return server;
}

async function captureRequest(request: globalThis.Request): Promise<CapturedRequest> {
	const url = new URL(request.url);
	const bodyText = await request.text();
	return {
		method: request.method,
		pathname: url.pathname,
		search: url.search,
		headers: request.headers,
		body: bodyText ? JSON.parse(bodyText) : undefined,
	};
}

function sseResponse(events: unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		headers: {
			"content-type": "text/event-stream",
		},
	});
}

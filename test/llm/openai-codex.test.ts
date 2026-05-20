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

	test("complete consumes the streaming Codex responses endpoint and returns the final response", async () => {
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
			...baseRequest,
			tools: [
				{
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: {} },
				},
			],
			tool_choice: "required",
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.pathname).toBe("/backend-api/codex/responses");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer access");
		expect(requests[0]?.headers.get("chatgpt-account-id")).toBe("acct");
		expect((requests[0]?.body as { stream?: boolean } | undefined)?.stream).toBe(true);
		expect(messageText(response.message)).toBe("ready");
		expect(messageToolCalls(response.message)).toEqual([
			{ id: "call_read", name: "read_file", arguments: { path: "README.md" } },
		]);
		expect(response.finish_reason.reason).toBe("tool_calls");
		expect(response.usage.input_tokens).toBe(7);
		expect(response.usage.output_tokens).toBe(3);
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

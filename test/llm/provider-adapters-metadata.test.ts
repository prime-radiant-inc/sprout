import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicAdapter } from "../../src/llm/anthropic.ts";
import { GeminiAdapter } from "../../src/llm/gemini.ts";
import { OpenAIAdapter } from "../../src/llm/openai.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("provider adapter metadata", () => {
	test("OpenAIAdapter exposes provider identity, model metadata, and connectivity helpers", async () => {
		const requests: Array<{ url: string; headers: Headers }> = [];
		globalThis.fetch = (async (input, init) => {
			requests.push({
				url:
					typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
				headers: new Headers(init?.headers),
			});
			return new Response(
				JSON.stringify({
					data: [{ id: "gpt-4.1-mini" }],
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		}) as typeof fetch;

		const adapter = new OpenAIAdapter("test-key", {
			providerId: "lmstudio",
			kind: "openai-compatible",
			baseUrl: "http://127.0.0.1:1234/v1",
			headers: { "X-Test-Header": "sprout" },
		});

		expect(adapter.providerId).toBe("lmstudio");
		expect(adapter.kind).toBe("openai-compatible");
		expect(await adapter.listModels()).toEqual([
			{ id: "gpt-4.1-mini", label: "gpt-4.1-mini", source: "remote" },
		]);
		expect(await adapter.checkConnection()).toEqual({ ok: true });
		expect(requests[0]?.url).toBe("http://127.0.0.1:1234/v1/models");
		expect(requests[0]?.headers.get("x-test-header")).toBe("sprout");
	});

	test("AnthropicAdapter exposes provider metadata and provider models", async () => {
		const adapter = new AnthropicAdapter("test-key", {
			providerId: "anthropic-main",
			headers: { "X-Test-Header": "sprout" },
		});
		(adapter as any).client = {
			models: {
				list: async function* () {
					yield { id: "claude-sonnet-4-6" };
				},
			},
		};

		expect(adapter.providerId).toBe("anthropic-main");
		expect(adapter.kind).toBe("anthropic");
		expect(await adapter.listModels()).toEqual([
			{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", source: "remote" },
		]);
		expect(await adapter.checkConnection()).toEqual({ ok: true });
	});

	test("GeminiAdapter exposes provider metadata and provider models", async () => {
		const adapter = new GeminiAdapter("test-key", {
			providerId: "gemini-main",
		});
		(adapter as any).client = {
			models: {
				list: async () =>
					({
						async *[Symbol.asyncIterator]() {
							yield { name: "models/gemini-2.5-flash" };
						},
					}) as AsyncIterable<{ name: string }>,
			},
		};

		expect(adapter.providerId).toBe("gemini-main");
		expect(adapter.kind).toBe("gemini");
		expect(await adapter.listModels()).toEqual([
			{ id: "gemini-2.5-flash", label: "gemini-2.5-flash", source: "remote" },
		]);
		expect(await adapter.checkConnection()).toEqual({ ok: true });
	});
});

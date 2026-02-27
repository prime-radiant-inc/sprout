import { describe, expect, test } from "bun:test";
import { Client } from "../../src/llm/client.ts";
import type { ProviderAdapter, Request, Response, StreamEvent } from "../../src/llm/types.ts";

/** Minimal fake adapter that returns a fixed model list. */
function fakeAdapter(name: string, models: string[]): ProviderAdapter {
	return {
		name,
		async complete(_request: Request): Promise<Response> {
			throw new Error("not implemented");
		},
		stream(_request: Request): AsyncIterable<StreamEvent> {
			throw new Error("not implemented");
		},
		async listModels(): Promise<string[]> {
			return models;
		},
	};
}

describe("ProviderAdapter.listModels", () => {
	test("fake adapter returns its model list", async () => {
		const adapter = fakeAdapter("test", ["model-a", "model-b"]);
		const models = await adapter.listModels();
		expect(models).toEqual(["model-a", "model-b"]);
	});
});

describe("Client.listModelsByProvider", () => {
	test("aggregates models from all providers", async () => {
		const client = new Client({
			providers: {
				anthropic: fakeAdapter("anthropic", ["claude-opus-4-6", "claude-sonnet-4-6"]),
				openai: fakeAdapter("openai", ["gpt-4.1", "o4-mini"]),
			},
		});

		const result = await client.listModelsByProvider();
		expect(result.get("anthropic")).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"]);
		expect(result.get("openai")).toEqual(["gpt-4.1", "o4-mini"]);
	});

	test("returns empty map when no providers registered", async () => {
		const client = new Client();
		const result = await client.listModelsByProvider();
		expect(result.size).toBe(0);
	});

	test("returns empty array for provider whose listModels fails", async () => {
		const failingAdapter: ProviderAdapter = {
			name: "broken",
			async complete() {
				throw new Error("not implemented");
			},
			stream() {
				throw new Error("not implemented");
			},
			async listModels() {
				throw new Error("API unavailable");
			},
		};

		const client = new Client({
			providers: {
				broken: failingAdapter,
				working: fakeAdapter("working", ["model-a"]),
			},
		});

		const result = await client.listModelsByProvider();
		expect(result.get("broken")).toEqual([]);
		expect(result.get("working")).toEqual(["model-a"]);
	});
});

import { describe, expect, test } from "bun:test";
import { Client } from "../../src/llm/client.ts";
import type {
	ProviderAdapter,
	ProviderModel,
	Request,
	Response,
	StreamEvent,
} from "../../src/llm/types.ts";

/** Minimal fake adapter that returns a fixed model list. */
function fakeAdapter(name: string, models: string[]): ProviderAdapter {
	return {
		name,
		providerId: name,
		kind: name as ProviderAdapter["kind"],
		async complete(_request: Request): Promise<Response> {
			throw new Error("not implemented");
		},
		stream(_request: Request): AsyncIterable<StreamEvent> {
			throw new Error("not implemented");
		},
		async listModels(): Promise<ProviderModel[]> {
			return models.map((id) => ({ id, label: id, source: "remote" }));
		},
		async checkConnection() {
			return { ok: true as const };
		},
	};
}

describe("ProviderAdapter.listModels", () => {
	test("fake adapter returns its model list", async () => {
		const adapter = fakeAdapter("test", ["model-a", "model-b"]);
		const models = await adapter.listModels();
		expect(models).toEqual([
			{ id: "model-a", label: "model-a", source: "remote" },
			{ id: "model-b", label: "model-b", source: "remote" },
		]);
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
		expect(result.get("anthropic")).toEqual([
			{ id: "claude-opus-4-6", label: "claude-opus-4-6", source: "remote" },
			{ id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", source: "remote" },
		]);
		expect(result.get("openai")).toEqual([
			{ id: "gpt-4.1", label: "gpt-4.1", source: "remote" },
			{ id: "o4-mini", label: "o4-mini", source: "remote" },
		]);
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
			providerId: "broken",
			kind: "openai",
			stream() {
				throw new Error("not implemented");
			},
			async listModels() {
				throw new Error("API unavailable");
			},
			async checkConnection() {
				return { ok: false as const, message: "API unavailable" };
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
		expect(result.get("working")).toEqual([{ id: "model-a", label: "model-a", source: "remote" }]);
	});
});

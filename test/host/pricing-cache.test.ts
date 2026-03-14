import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPricingSnapshot } from "../../src/host/pricing-cache.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const LLM_PRICES_URL = "https://www.llm-prices.com/current-v1.json";

/** Minimal OpenRouter response with one model */
const openRouterPayload = {
	data: [
		{
			id: "anthropic/claude-sonnet-4-6",
			pricing: { prompt: "0.000003", completion: "0.000015" },
		},
	],
};

/** Minimal llm-prices.com response with one model */
const llmPricesPayload = {
	updated_at: "2025-01-01T00:00:00Z",
	prices: [{ id: "gpt-4o", vendor: "openai", name: "GPT-4o", input: 2.5, output: 10 }],
};

describe("loadPricingSnapshot", () => {
	let tempDir: string;
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pricing-cache-"));
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await rm(tempDir, { recursive: true, force: true });
	});

	function mockFetch(
		handler: (url: string) => { ok: boolean; json: () => Promise<unknown> } | null,
	) {
		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const result = handler(url);
			if (!result) throw new Error(`Network error for ${url}`);
			return result as Response;
		}) as typeof fetch;
	}

	test("both sources succeed → merged table with OpenRouter entries first", async () => {
		mockFetch((url) => {
			if (url === OPENROUTER_URL) {
				return { ok: true, json: async () => openRouterPayload };
			}
			if (url === LLM_PRICES_URL) {
				return { ok: true, json: async () => llmPricesPayload };
			}
			return null;
		});

		const snapshot = await loadPricingSnapshot(tempDir);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.source).toBe("live");
		expect(snapshot?.upstreams).toEqual(["openrouter", "llm-prices"]);
		// OpenRouter produces 2 entries (full + stripped), llm-prices produces 1
		expect(snapshot!.table.length).toBeGreaterThanOrEqual(3);
		// OpenRouter entries come first
		expect(snapshot!.table[0]![0]).toBe("anthropic/claude-sonnet-4-6");
		expect(snapshot!.table[1]![0]).toBe("claude-sonnet-4-6");
		// llm-prices entry after
		expect(snapshot!.table[2]![0]).toBe("gpt-4o");
	});

	test("OpenRouter fails → llm-prices data returned", async () => {
		mockFetch((url) => {
			if (url === OPENROUTER_URL) return null; // network error
			if (url === LLM_PRICES_URL) {
				return { ok: true, json: async () => llmPricesPayload };
			}
			return null;
		});

		const snapshot = await loadPricingSnapshot(tempDir);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.source).toBe("live");
		expect(snapshot?.upstreams).toEqual(["llm-prices"]);
		expect(snapshot!.table.length).toBeGreaterThanOrEqual(1);
		expect(snapshot!.table[0]![0]).toBe("gpt-4o");
	});

	test("llm-prices fails → OpenRouter data returned", async () => {
		mockFetch((url) => {
			if (url === OPENROUTER_URL) {
				return { ok: true, json: async () => openRouterPayload };
			}
			if (url === LLM_PRICES_URL) return null; // network error
			return null;
		});

		const snapshot = await loadPricingSnapshot(tempDir);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.source).toBe("live");
		expect(snapshot?.upstreams).toEqual(["openrouter"]);
		expect(snapshot!.table.length).toBeGreaterThanOrEqual(2);
		expect(snapshot!.table[0]![0]).toBe("anthropic/claude-sonnet-4-6");
		expect(snapshot!.table[1]![0]).toBe("claude-sonnet-4-6");
	});

	test("both sources fail → disk cache returned", async () => {
		// Pre-populate disk cache
		const cacheDir = join(tempDir, "cache");
		await mkdir(cacheDir, { recursive: true });
		const cached = {
			source: "live",
			fetchedAt: "2025-01-01T00:00:00Z",
			upstreams: ["openrouter"],
			table: [["cached-model", { input: 1, output: 2 }]] as [
				string,
				{ input: number; output: number },
			][],
		};
		await writeFile(join(cacheDir, "pricing-cache.json"), JSON.stringify(cached));

		mockFetch(() => null); // all fetches fail

		const snapshot = await loadPricingSnapshot(tempDir);
		expect(snapshot).not.toBeNull();
		expect(snapshot?.source).toBe("cache");
		expect(snapshot?.upstreams).toEqual(["openrouter"]);
		expect(snapshot?.table).toHaveLength(1);
		expect(snapshot?.table[0]).toEqual(["cached-model", { input: 1, output: 2 }]);
	});

	test("both sources fail + no cache → null returned", async () => {
		mockFetch(() => null); // all fetches fail, no cache file exists

		const snapshot = await loadPricingSnapshot(tempDir);
		expect(snapshot).toBeNull();
	});
});

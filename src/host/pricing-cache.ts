import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmPricesResponse, OpenRouterResponse, PricingTable } from "../kernel/pricing.ts";
import { transformOpenRouterPrices, transformPrices } from "../kernel/pricing.ts";

const LLM_PRICES_URL = "https://www.llm-prices.com/current-v1.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const CACHE_FILENAME = "pricing-cache.json";

export interface PricingSnapshot {
	source: "live" | "cache";
	fetchedAt: string;
	upstreams: string[];
	table: PricingTable;
}

export async function loadPricingSnapshot(cacheDir: string): Promise<PricingSnapshot | null> {
	// Fetch both sources in parallel (each has 5s timeout)
	const [openRouter, llmPrices] = await Promise.all([fetchOpenRouter(), fetchLlmPrices()]);

	// Merge: OpenRouter entries first (primary), llm-prices.com supplements
	const table: PricingTable = [];
	const upstreams: string[] = [];
	if (openRouter) {
		table.push(...openRouter);
		upstreams.push("openrouter");
	}
	if (llmPrices) {
		table.push(...llmPrices);
		upstreams.push("llm-prices");
	}

	if (table.length > 0) {
		const snapshot: PricingSnapshot = {
			source: "live",
			fetchedAt: new Date().toISOString(),
			upstreams,
			table,
		};
		// Cache the merged result to disk (fire and forget)
		cacheToDisk(cacheDir, snapshot).catch(() => {});
		return snapshot;
	}

	// Both failed — try disk cache
	const cached = await readFromDisk(cacheDir);
	if (!cached) return null;
	return { ...cached, source: "cache" };
}

async function fetchOpenRouter(): Promise<PricingTable | null> {
	try {
		const resp = await fetch(OPENROUTER_URL, { signal: AbortSignal.timeout(5_000) });
		if (!resp.ok) return null;
		const data = (await resp.json()) as OpenRouterResponse;
		if (!Array.isArray(data.data)) return null;
		return transformOpenRouterPrices(data.data);
	} catch {
		return null;
	}
}

async function fetchLlmPrices(): Promise<PricingTable | null> {
	try {
		const resp = await fetch(LLM_PRICES_URL, { signal: AbortSignal.timeout(5_000) });
		if (!resp.ok) return null;
		const data = (await resp.json()) as LlmPricesResponse;
		return transformPrices(data.prices);
	} catch {
		return null;
	}
}

async function cacheToDisk(cacheDir: string, data: PricingSnapshot): Promise<void> {
	const dir = join(cacheDir, "cache");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, CACHE_FILENAME), JSON.stringify(data));
}

async function readFromDisk(cacheDir: string): Promise<PricingSnapshot | null> {
	try {
		const raw = await readFile(join(cacheDir, "cache", CACHE_FILENAME), "utf-8");
		const cached = JSON.parse(raw) as PricingSnapshot;
		return Array.isArray(cached.table) &&
			typeof cached.fetchedAt === "string" &&
			Array.isArray(cached.upstreams) &&
			(cached.source === "live" || cached.source === "cache")
			? cached
			: null;
	} catch {
		return null;
	}
}

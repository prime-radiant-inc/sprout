import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	LlmPricesResponse,
	OpenRouterResponse,
	PricingTable,
} from "../kernel/pricing.ts";
import { transformOpenRouterPrices, transformPrices } from "../kernel/pricing.ts";

const LLM_PRICES_URL = "https://www.llm-prices.com/current-v1.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const CACHE_FILENAME = "pricing-cache.json";

interface CachedPricing {
	fetchedAt: string;
	table: PricingTable;
}

export async function loadPricingTable(cacheDir: string): Promise<PricingTable | null> {
	// Fetch both sources in parallel (each has 5s timeout)
	const [openRouter, llmPrices] = await Promise.all([
		fetchOpenRouter(),
		fetchLlmPrices(),
	]);

	// Merge: OpenRouter entries first (primary), llm-prices.com supplements
	const table: PricingTable = [];
	if (openRouter) table.push(...openRouter);
	if (llmPrices) table.push(...llmPrices);

	if (table.length > 0) {
		// Cache the merged result to disk (fire and forget)
		cacheToDisk(cacheDir, { fetchedAt: new Date().toISOString(), table }).catch(() => {});
		return table;
	}

	// Both failed — try disk cache
	const cached = await readFromDisk(cacheDir);
	return cached;
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

async function cacheToDisk(cacheDir: string, data: CachedPricing): Promise<void> {
	const dir = join(cacheDir, "cache");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, CACHE_FILENAME), JSON.stringify(data));
}

async function readFromDisk(cacheDir: string): Promise<PricingTable | null> {
	try {
		const raw = await readFile(join(cacheDir, "cache", CACHE_FILENAME), "utf-8");
		const cached = JSON.parse(raw) as CachedPricing;
		return Array.isArray(cached.table) ? cached.table : null;
	} catch {
		return null;
	}
}

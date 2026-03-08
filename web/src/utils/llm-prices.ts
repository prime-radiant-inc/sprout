import type { ModelPricing } from "./pricing.ts";

interface LlmPriceEntry {
	id: string;
	vendor: string;
	name: string;
	input: number;
	output: number;
	input_cached?: number | null;
}

interface LlmPricesResponse {
	updated_at: string;
	prices: LlmPriceEntry[];
}

const LLM_PRICES_URL = "https://www.llm-prices.com/current-v1.json";

/**
 * Transform raw API price entries into the [prefix, ModelPricing][] format.
 * For entries with dots in the ID (e.g. "claude-sonnet-4.5"), also registers
 * the prefix up to the last dot ("claude-sonnet-4") to handle naming mismatches
 * between llm-prices.com IDs and Sprout API model names.
 */
export function transformPrices(prices: LlmPriceEntry[]): [string, ModelPricing][] {
	const table: [string, ModelPricing][] = [];
	for (const entry of prices) {
		const pricing: ModelPricing = { input: entry.input, output: entry.output };
		table.push([entry.id, pricing]);

		// For IDs with dots, add the prefix up to the last dot as a fallback.
		// "claude-sonnet-4.5" → also register "claude-sonnet-4"
		// Longest prefix match ensures the exact ID takes priority.
		const dotIdx = entry.id.lastIndexOf(".");
		if (dotIdx > 0) {
			table.push([entry.id.slice(0, dotIdx), pricing]);
		}
	}
	return table;
}

let fetchedTable: [string, ModelPricing][] | null = null;

async function fetchPrices(): Promise<void> {
	try {
		const resp = await fetch(LLM_PRICES_URL);
		if (!resp.ok) return;
		const data: LlmPricesResponse = await resp.json();
		fetchedTable = transformPrices(data.prices);
	} catch {
		// Silent fail — hardcoded fallback table will be used
	}
}

// Fire on module load
fetchPrices();

/** Returns the fetched pricing table, or null if fetch hasn't completed or failed. */
export function getFetchedPricingTable(): [string, ModelPricing][] | null {
	return fetchedTable;
}

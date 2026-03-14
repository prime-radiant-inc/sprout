export interface ModelPricing {
	input: number;
	output: number;
	cached_input?: number;
}

export type PricingTable = [string, ModelPricing][];

/** Mirrors the llm-prices.com API response shape. */
export interface LlmPriceEntry {
	id: string;
	vendor: string;
	name: string;
	input: number;
	output: number;
	input_cached?: number | null;
}

export interface LlmPricesResponse {
	updated_at: string;
	prices: LlmPriceEntry[];
}

export interface OpenRouterModel {
	id: string;
	pricing: {
		prompt: string;
		completion: string;
	};
}

export interface OpenRouterResponse {
	data: OpenRouterModel[];
}

export function transformPrices(prices: LlmPriceEntry[]): PricingTable {
	const table: PricingTable = [];
	for (const entry of prices) {
		const pricing: ModelPricing = {
			input: entry.input,
			output: entry.output,
			cached_input: entry.input_cached ?? undefined,
		};
		table.push([entry.id, pricing]);
		const dotIdx = entry.id.lastIndexOf(".");
		if (dotIdx > 0) {
			table.push([entry.id.slice(0, dotIdx), pricing]);
		}
	}
	return table;
}

/**
 * Transform OpenRouter model entries into PricingTable format.
 * Strips provider prefix from IDs and converts per-token pricing to per-million.
 */
export function transformOpenRouterPrices(models: OpenRouterModel[]): PricingTable {
	const table: PricingTable = [];
	for (const model of models) {
		const inputPerToken = Number.parseFloat(model.pricing.prompt);
		const outputPerToken = Number.parseFloat(model.pricing.completion);
		if (Number.isNaN(inputPerToken) || Number.isNaN(outputPerToken)) continue;
		if (inputPerToken === 0 && outputPerToken === 0) continue;

		const pricing: ModelPricing = {
			input: inputPerToken * 1_000_000,
			output: outputPerToken * 1_000_000,
		};

		// Register with full ID (e.g., "anthropic/claude-sonnet-4-6")
		table.push([model.id, pricing]);

		// Register with provider prefix stripped (e.g., "claude-sonnet-4-6")
		const slashIdx = model.id.indexOf("/");
		if (slashIdx >= 0) {
			table.push([model.id.slice(slashIdx + 1), pricing]);
		}
	}
	return table;
}

export const FALLBACK_PRICING_TABLE: PricingTable = [
	["claude-opus-4", { input: 15, output: 75 }],
	["claude-sonnet-4", { input: 3, output: 15 }],
	["claude-haiku-4", { input: 0.8, output: 4 }],
	["o3-pro", { input: 20, output: 80 }],
	["o4-mini", { input: 1.1, output: 4.4 }],
	["gemini-2.5-pro", { input: 1.25, output: 10 }],
	["gemini-2.5-flash", { input: 0.3, output: 2.5 }],
];

export function longestPrefixMatch(model: string, table: PricingTable): ModelPricing | null {
	let best: ModelPricing | null = null;
	let bestLen = 0;
	for (const [prefix, pricing] of table) {
		if (model.startsWith(prefix) && prefix.length > bestLen) {
			best = pricing;
			bestLen = prefix.length;
		}
	}
	return best;
}

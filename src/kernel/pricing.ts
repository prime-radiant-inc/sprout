import { LITELLM_PRICING_TABLE } from "../generated/litellm-pricing.ts";

export interface ModelPricing {
	input: number;
	output: number;
	cached_input?: number;
	cache_write_5m?: number;
	cache_write_1h?: number;
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

/** Mirrors one entry in LiteLLM's model_prices_and_context_window.json. All costs are per-token. */
export interface LiteLLMEntry {
	input_cost_per_token?: number;
	output_cost_per_token?: number;
	cache_read_input_token_cost?: number;
	cache_creation_input_token_cost?: number;
	cache_creation_input_token_cost_above_1hr?: number;
	litellm_provider?: string;
	mode?: string;
	max_input_tokens?: number;
}

export function transformPrices(prices: LlmPriceEntry[]): PricingTable {
	const table: PricingTable = [];
	for (const entry of prices) {
		const pricing = withAnthropicCachePricing(entry.vendor, entry.id, {
			input: entry.input,
			output: entry.output,
			cached_input: entry.input_cached ?? undefined,
		});
		addPricingEntries(table, entry.id, pricing);
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

		const pricing = withAnthropicCachePricing(undefined, model.id, {
			input: inputPerToken * 1_000_000,
			output: outputPerToken * 1_000_000,
		});

		addPricingEntries(table, model.id, pricing);
		const slashIdx = model.id.indexOf("/");
		if (slashIdx >= 0) {
			addPricingEntries(table, model.id.slice(slashIdx + 1), pricing);
		}
	}
	return table;
}

/**
 * Transform LiteLLM's model_prices_and_context_window.json into PricingTable format.
 * Converts per-token pricing to per-million and canonicalizes provider-prefixed ids
 * (e.g. "anthropic.claude-sonnet-5", "azure_ai/claude-sonnet-5") down to a bare id
 * alongside the original, so longestPrefixMatch resolves either form.
 *
 * Dedup strategy: when multiple raw keys canonicalize to the same table id (e.g. a
 * bare id and a provider-prefixed alias for the same model), keep the first entry
 * that is fully priced (input > 0 and output > 0); if every colliding entry is only
 * partially priced, keep whichever was encountered first.
 */
export function transformLiteLLMPrices(raw: Record<string, LiteLLMEntry>): PricingTable {
	const byId = new Map<string, ModelPricing>();
	for (const [rawId, entry] of Object.entries(raw)) {
		if (entry.mode !== undefined && entry.mode !== "chat") continue;
		if (!entry.input_cost_per_token && !entry.output_cost_per_token) continue;

		const pricing: ModelPricing = {
			input: perMillion(entry.input_cost_per_token ?? 0),
			output: perMillion(entry.output_cost_per_token ?? 0),
		};
		if (entry.cache_read_input_token_cost !== undefined) {
			pricing.cached_input = perMillion(entry.cache_read_input_token_cost);
		}
		if (entry.cache_creation_input_token_cost !== undefined) {
			pricing.cache_write_5m = perMillion(entry.cache_creation_input_token_cost);
		}
		if (entry.cache_creation_input_token_cost_above_1hr !== undefined) {
			pricing.cache_write_1h = perMillion(entry.cache_creation_input_token_cost_above_1hr);
		}

		for (const id of canonicalizeLiteLLMId(rawId)) {
			const existing = byId.get(id);
			if (existing === undefined || (!isFullyPriced(existing) && isFullyPriced(pricing))) {
				byId.set(id, pricing);
			}
		}
	}
	return [...byId.entries()];
}

function isFullyPriced(pricing: ModelPricing): boolean {
	return pricing.input > 0 && pricing.output > 0;
}

/** Converts a per-token rate to per-million, rounded to avoid float noise (e.g. 0.4969999...). */
function perMillion(perTokenRate: number): number {
	return Number((perTokenRate * 1_000_000).toFixed(6));
}

/** Ids to register for one LiteLLM key: its canonical form, plus the canonicalized
 * bare id with any provider prefix stripped (when that differs from the raw key). */
function canonicalizeLiteLLMId(rawId: string): string[] {
	const ids = new Set<string>([canonicalPricingModelId(rawId)]);
	const bare = stripLiteLLMProviderPrefix(rawId);
	if (bare !== rawId) ids.add(canonicalPricingModelId(bare));
	return [...ids];
}

function stripLiteLLMProviderPrefix(id: string): string {
	const dotMatch = id.match(/^anthropic\.(claude-.+)$/i);
	if (dotMatch) return dotMatch[1] as string;
	const slashIdx = id.indexOf("/");
	if (slashIdx >= 0) return id.slice(slashIdx + 1);
	return id;
}

export const FALLBACK_PRICING_TABLE: PricingTable = [
	[
		"claude-opus-4.7",
		{ input: 5, output: 25, cached_input: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
	],
	[
		"claude-opus-4.6",
		{ input: 5, output: 25, cached_input: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
	],
	[
		"claude-opus-4.5",
		{ input: 5, output: 25, cached_input: 0.5, cache_write_5m: 6.25, cache_write_1h: 10 },
	],
	[
		"claude-opus-4.1",
		{ input: 15, output: 75, cached_input: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 },
	],
	[
		"claude-opus-4",
		{ input: 15, output: 75, cached_input: 1.5, cache_write_5m: 18.75, cache_write_1h: 30 },
	],
	[
		"claude-sonnet-4.6",
		{ input: 3, output: 15, cached_input: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
	],
	[
		"claude-sonnet-4.5",
		{ input: 3, output: 15, cached_input: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
	],
	[
		"claude-sonnet-4",
		{ input: 3, output: 15, cached_input: 0.3, cache_write_5m: 3.75, cache_write_1h: 6 },
	],
	[
		"claude-haiku-4.5",
		{ input: 1, output: 5, cached_input: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 },
	],
	[
		"claude-haiku-4",
		{ input: 1, output: 5, cached_input: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 },
	],
	[
		"claude-haiku-3.5",
		{ input: 0.8, output: 4, cached_input: 0.08, cache_write_5m: 1, cache_write_1h: 1.6 },
	],
	["o3-pro", { input: 20, output: 80 }],
	["o4-mini", { input: 1.1, output: 4.4 }],
	["gemini-2.5-pro", { input: 1.25, output: 10 }],
	["gemini-2.5-flash", { input: 0.3, output: 2.5 }],
];

/**
 * The offline pricing table actually consulted when no live snapshot has a match.
 * LITELLM_PRICING_TABLE is regenerated periodically (bun scripts/update-pricing.ts)
 * and is comprehensive, so it goes first; FALLBACK_PRICING_TABLE remains a backstop
 * for any custom/local ids LiteLLM doesn't carry.
 */
export const EFFECTIVE_FALLBACK_PRICING_TABLE: PricingTable = [
	...LITELLM_PRICING_TABLE,
	...FALLBACK_PRICING_TABLE,
];

export function withAnthropicCachePricing(
	vendor: string | undefined,
	modelId: string,
	pricing: ModelPricing,
): ModelPricing {
	if (!isAnthropicModel(vendor, modelId)) return pricing;
	return {
		...pricing,
		cached_input: pricing.cached_input ?? derivedRate(pricing.input, 0.1),
		cache_write_5m: pricing.cache_write_5m ?? derivedRate(pricing.input, 1.25),
		cache_write_1h: pricing.cache_write_1h ?? derivedRate(pricing.input, 2),
	};
}

function derivedRate(inputRate: number, multiplier: number): number {
	return Number((inputRate * multiplier).toFixed(12));
}

function isAnthropicModel(vendor: string | undefined, modelId: string): boolean {
	const normalizedVendor = vendor?.toLowerCase();
	const normalizedModel = modelId.toLowerCase();
	return (
		normalizedVendor === "anthropic" ||
		normalizedModel.startsWith("claude-") ||
		normalizedModel.startsWith("anthropic/claude-")
	);
}

function addPricingEntries(table: PricingTable, modelId: string, pricing: ModelPricing): void {
	const seen = new Set(table.map(([id]) => id));
	for (const alias of pricingAliases(modelId)) {
		if (seen.has(alias)) continue;
		table.push([alias, pricing]);
		seen.add(alias);
	}
}

function pricingAliases(modelId: string): string[] {
	const aliases = [modelId];
	const canonical = canonicalPricingModelId(modelId);
	if (canonical !== modelId) aliases.push(canonical);

	const hyphenated = hyphenateClaudeSemanticVersion(canonical);
	if (hyphenated !== canonical && hyphenated !== modelId) aliases.push(hyphenated);

	return aliases;
}

export function canonicalPricingModelId(modelId: string): string {
	return modelId
		.toLowerCase()
		.replace(
			/^(anthropic\/)?claude-(opus|sonnet|haiku)-(\d+)-(\d{1,2})(?=$|-)/,
			"$1claude-$2-$3.$4",
		);
}

function hyphenateClaudeSemanticVersion(modelId: string): string {
	return modelId.replace(
		/^(anthropic\/)?claude-(opus|sonnet|haiku)-(\d+)\.(\d{1,2})(?=$|-)/,
		"$1claude-$2-$3-$4",
	);
}

export function longestPrefixMatch(model: string, table: PricingTable): ModelPricing | null {
	let best: ModelPricing | null = null;
	let bestLen = 0;
	const canonicalModel = canonicalPricingModelId(model);
	for (const [prefix, pricing] of table) {
		const canonicalPrefix = canonicalPricingModelId(prefix);
		const matches = model.startsWith(prefix) || canonicalModel.startsWith(canonicalPrefix);
		if (
			matches &&
			!isUnsafeClaudeBareMajorMatch(canonicalModel, canonicalPrefix) &&
			canonicalPrefix.length > bestLen
		) {
			best = pricing;
			bestLen = canonicalPrefix.length;
		}
	}
	return best;
}

function isUnsafeClaudeBareMajorMatch(canonicalModel: string, canonicalPrefix: string): boolean {
	const modelMatch = canonicalModel.match(
		/^(?:anthropic\/)?claude-(opus|sonnet|haiku)-(\d+)\.(\d{1,2})(?:$|-)/,
	);
	const prefixMatch = canonicalPrefix.match(/^(?:anthropic\/)?claude-(opus|sonnet|haiku)-(\d+)$/);
	return (
		modelMatch !== null &&
		prefixMatch !== null &&
		modelMatch[1] === prefixMatch[1] &&
		modelMatch[2] === prefixMatch[2]
	);
}

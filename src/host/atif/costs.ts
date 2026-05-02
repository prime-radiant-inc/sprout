import type { ModelPricing } from "../../kernel/pricing.ts";
import {
	FALLBACK_PRICING_TABLE,
	longestPrefixMatch,
	withAnthropicCachePricing,
} from "../../kernel/pricing.ts";
import type { Usage } from "../../llm/types.ts";
import type { PricingSnapshot } from "../pricing-cache.ts";
import type { AtifMetrics } from "./types.ts";

const STANDARD_USAGE_FIELDS = new Set([
	"input_tokens",
	"output_tokens",
	"total_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"cache_write_5m_tokens",
	"cache_write_1h_tokens",
	"total_input_tokens",
]);

const UNPRICED_LOCAL_PROVIDER_PREFIXES = ["lmstudio", "ollama", "llamacpp"];

export interface BuildAtifMetricsOptions {
	providerId: string;
	modelId: string;
	usage: Usage & Record<string, unknown>;
	pricingSnapshot?: PricingSnapshot | null;
}

export function buildAtifMetrics(options: BuildAtifMetricsOptions): AtifMetrics | undefined {
	const promptTokens = options.usage.input_tokens;
	const completionTokens = options.usage.output_tokens;
	const cachedTokens = options.usage.cache_read_tokens ?? 0;
	const cacheWrite5mTokens = options.usage.cache_write_5m_tokens ?? 0;
	const cacheWrite1hTokens = options.usage.cache_write_1h_tokens ?? 0;
	const cacheWriteTokens =
		options.usage.cache_write_tokens ?? cacheWrite5mTokens + cacheWrite1hTokens;
	const knownCacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;
	const unknownCacheWriteTokens = Math.max(0, cacheWriteTokens - knownCacheWriteTokens);
	const totalInputTokens =
		options.usage.total_input_tokens ?? promptTokens + cachedTokens + cacheWriteTokens;

	if (
		promptTokens === 0 &&
		completionTokens === 0 &&
		cachedTokens === 0 &&
		cacheWriteTokens === 0
	) {
		return undefined;
	}

	const metrics: AtifMetrics = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		cached_tokens: cachedTokens,
		total_input_tokens: totalInputTokens,
	};
	if (cacheWriteTokens > 0) {
		metrics.cache_write_tokens = cacheWriteTokens;
	}

	const extra = buildMetricsExtra(options);
	if (extra) {
		metrics.extra = extra;
	}

	const resolvedPricing = resolvePricing(
		options.providerId,
		options.modelId,
		options.pricingSnapshot,
	);
	if (resolvedPricing) {
		const cost = calculateCost({
			pricing: resolvedPricing.pricing,
			promptTokens,
			completionTokens,
			cachedTokens,
			cacheWrite5mTokens,
			cacheWrite1hTokens,
			unknownCacheWriteTokens,
		});
		metrics.cost_usd = cost.total;
		metrics.extra ??= {};
		metrics.extra.cost_pricing_source = resolvedPricing.source;
		metrics.extra.cost_breakdown_usd = cost.breakdown;
		if (cost.partialReasons.length > 0) {
			metrics.extra.cost_partial = true;
			metrics.extra.cost_partial_reasons = cost.partialReasons;
		}
		if (cachedTokens > 0 && resolvedPricing.pricing.cached_input === undefined) {
			metrics.extra.assumed_cached_input_rate = resolvedPricing.pricing.input;
		}
	}

	return metrics;
}

function resolvePricing(
	providerId: string,
	modelId: string,
	pricingSnapshot: PricingSnapshot | null | undefined,
): { pricing: ModelPricing; source: "snapshot" | "fallback" } | null {
	if (UNPRICED_LOCAL_PROVIDER_PREFIXES.some((prefix) => providerId.startsWith(prefix))) {
		return null;
	}

	const snapshotPricing =
		pricingSnapshot === null || pricingSnapshot === undefined
			? null
			: findPricing(providerId, modelId, pricingSnapshot.table);
	if (snapshotPricing) {
		return {
			pricing: withAnthropicCachePricing(providerId, modelId, snapshotPricing),
			source: "snapshot",
		};
	}

	const fallbackPricing = findPricing(providerId, modelId, FALLBACK_PRICING_TABLE);
	if (!fallbackPricing) return null;
	return {
		pricing: withAnthropicCachePricing(providerId, modelId, fallbackPricing),
		source: "fallback",
	};
}

function findPricing(providerId: string, modelId: string, table: Array<[string, ModelPricing]>) {
	return (
		longestPrefixMatch(modelId, table) ??
		(providerId === "openrouter" && modelId.includes("/")
			? longestPrefixMatch(modelId.slice(modelId.indexOf("/") + 1), table)
			: null)
	);
}

function calculateCost(options: {
	pricing: ModelPricing;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
	unknownCacheWriteTokens: number;
}): {
	total: number;
	breakdown: Record<string, number>;
	partialReasons: string[];
} {
	const inputCost = (options.promptTokens * options.pricing.input) / 1_000_000;
	const outputCost = (options.completionTokens * options.pricing.output) / 1_000_000;
	const cachedInputRate = options.pricing.cached_input ?? options.pricing.input;
	const cacheReadCost = (options.cachedTokens * cachedInputRate) / 1_000_000;
	const partialReasons: string[] = [];

	let cacheWrite5mCost = 0;
	if (options.cacheWrite5mTokens > 0) {
		if (options.pricing.cache_write_5m !== undefined) {
			cacheWrite5mCost = (options.cacheWrite5mTokens * options.pricing.cache_write_5m) / 1_000_000;
		} else {
			partialReasons.push("missing_cache_write_5m_rate");
		}
	}

	let cacheWrite1hCost = 0;
	if (options.cacheWrite1hTokens > 0) {
		if (options.pricing.cache_write_1h !== undefined) {
			cacheWrite1hCost = (options.cacheWrite1hTokens * options.pricing.cache_write_1h) / 1_000_000;
		} else {
			partialReasons.push("missing_cache_write_1h_rate");
		}
	}

	if (options.unknownCacheWriteTokens > 0) {
		partialReasons.push("cache_write_tokens_missing_ttl_bucket");
	}

	const breakdown = {
		regular_input_cost_usd: inputCost,
		cache_read_cost_usd: cacheReadCost,
		cache_write_5m_cost_usd: cacheWrite5mCost,
		cache_write_1h_cost_usd: cacheWrite1hCost,
		output_cost_usd: outputCost,
	};

	return {
		total: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
		breakdown,
		partialReasons,
	};
}

function buildMetricsExtra(options: BuildAtifMetricsOptions): Record<string, unknown> | undefined {
	const extra: Record<string, unknown> = {};

	if (options.pricingSnapshot) {
		extra.pricing_snapshot = {
			source: options.pricingSnapshot.source,
			fetched_at: options.pricingSnapshot.fetchedAt,
			upstreams: [...options.pricingSnapshot.upstreams],
		};
	}

	for (const [key, value] of Object.entries(options.usage)) {
		if (STANDARD_USAGE_FIELDS.has(key) || value === undefined) continue;
		extra[key] = value;
	}

	return Object.keys(extra).length > 0 ? extra : undefined;
}

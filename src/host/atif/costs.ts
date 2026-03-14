import { longestPrefixMatch } from "../../kernel/pricing.ts";
import type { Usage } from "../../llm/types.ts";
import type { PricingSnapshot } from "../pricing-cache.ts";
import type { AtifMetrics } from "./types.ts";

const STANDARD_USAGE_FIELDS = new Set([
	"input_tokens",
	"output_tokens",
	"total_tokens",
	"cache_read_tokens",
]);

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

	if (promptTokens === 0 && completionTokens === 0 && cachedTokens === 0) {
		return undefined;
	}

	const metrics: AtifMetrics = {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		cached_tokens: cachedTokens,
	};

	const extra = buildMetricsExtra(options);
	if (extra) {
		metrics.extra = extra;
	}

	const pricing = resolvePricing(options.providerId, options.modelId, options.pricingSnapshot);
	if (pricing) {
		const nonCachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
		const cachedInputRate = pricing.cached_input ?? pricing.input;
		metrics.cost_usd =
			(nonCachedPromptTokens * pricing.input +
				cachedTokens * cachedInputRate +
				completionTokens * pricing.output) /
			1_000_000;
		if (cachedTokens > 0 && pricing.cached_input === undefined) {
			metrics.extra ??= {};
			metrics.extra.assumed_cached_input_rate = pricing.input;
		}
	}

	return metrics;
}

function resolvePricing(
	providerId: string,
	modelId: string,
	pricingSnapshot: PricingSnapshot | null | undefined,
) {
	if (!pricingSnapshot) return null;
	return (
		longestPrefixMatch(modelId, pricingSnapshot.table) ??
		(providerId === "openrouter" && modelId.includes("/")
			? longestPrefixMatch(modelId.slice(modelId.indexOf("/") + 1), pricingSnapshot.table)
			: null)
	);
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

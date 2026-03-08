interface ModelPricing {
	input: number; // $/1M input tokens
	output: number; // $/1M output tokens
}

// Prefix-matched: longer prefixes win over shorter ones (ordering does not matter)
const PRICING_TABLE: [prefix: string, pricing: ModelPricing][] = [
	["claude-opus-4", { input: 15, output: 75 }],
	["claude-sonnet-4", { input: 3, output: 15 }],
	["claude-haiku-4", { input: 0.8, output: 4 }],
	["o3-pro", { input: 20, output: 80 }],
	["o4-mini", { input: 1.1, output: 4.4 }],
	["gemini-2.5-pro", { input: 1.25, output: 10 }],
	["gemini-2.5-flash", { input: 0.15, output: 0.6 }],
];

/** Find pricing for a model name by longest prefix match. Returns null if no match. */
export function getModelPricing(model: string): ModelPricing | null {
	let bestMatch: ModelPricing | null = null;
	let bestLen = 0;
	for (const [prefix, pricing] of PRICING_TABLE) {
		if (model.startsWith(prefix) && prefix.length > bestLen) {
			bestMatch = pricing;
			bestLen = prefix.length;
		}
	}
	return bestMatch;
}

/** Compute dollar cost from token counts and model name. Returns null if model unknown. */
export function computeCost(
	model: string,
	inputTokens: number,
	outputTokens: number,
): number | null {
	const pricing = getModelPricing(model);
	if (!pricing) return null;
	return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** Format a dollar amount for display: "$0.12", "$1.23", "$123" */
export function formatCost(dollars: number): string {
	if (dollars >= 100) return `$${Math.round(dollars)}`;
	return `$${dollars.toFixed(2)}`;
}

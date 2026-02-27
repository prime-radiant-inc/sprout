export interface ResolvedModel {
	model: string;
	provider: string;
}

export type Tier = "best" | "balanced" | "fast";

const TIER_NAMES: Tier[] = ["best", "balanced", "fast"];

const PROVIDER_PRIORITY = ["anthropic", "openai", "gemini"];

/** Classify a model into a tier based on its name, or null if unclassifiable. */
export function classifyTier(model: string): Tier | null {
	if (/opus|(?<![a-z])pro(?!cess)/i.test(model)) return "best";
	if (/sonnet/i.test(model)) return "balanced";
	if (/haiku|mini|flash|nano/i.test(model)) return "fast";
	return null;
}

/**
 * Build a minimal model map from provider names.
 * Each provider gets a single "fast" tier model as a fallback.
 * Used when no pre-fetched model map is available (e.g., in tests).
 */
export function defaultModelsByProvider(providers: string[]): Map<string, string[]> {
	const defaults: Record<string, string[]> = {
		anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
		openai: ["o3-pro", "o4-mini"],
		gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
	};
	const map = new Map<string, string[]>();
	for (const provider of providers) {
		map.set(provider, defaults[provider] ?? []);
	}
	return map;
}

export function detectProvider(model: string): string | undefined {
	if (model.startsWith("claude-")) return "anthropic";
	if (
		model.startsWith("gpt-") ||
		model.startsWith("o1-") ||
		model.startsWith("o3-") ||
		model.startsWith("o4-")
	)
		return "openai";
	if (model.startsWith("gemini-")) return "gemini";
	return undefined;
}

/**
 * Resolve a model string to a concrete model + provider.
 *
 * If `model` is a tier name ("best", "balanced", "fast"), searches the
 * model map for a matching model using classifyTier and provider priority.
 *
 * If `model` is a concrete ID, detects its provider and validates it's available.
 */
export function resolveModel(
	model: string,
	modelsByProvider: Map<string, string[]>,
): ResolvedModel {
	if (TIER_NAMES.includes(model as Tier)) {
		const tier = model as Tier;
		for (const provider of PROVIDER_PRIORITY) {
			const models = modelsByProvider.get(provider);
			if (!models) continue;
			const match = models.find((m) => classifyTier(m) === tier);
			if (match) return { model: match, provider };
		}
		// Also check providers not in the priority list
		for (const [provider, models] of modelsByProvider) {
			if (PROVIDER_PRIORITY.includes(provider)) continue;
			const match = models.find((m) => classifyTier(m) === tier);
			if (match) return { model: match, provider };
		}
		const available = [...modelsByProvider.keys()].join(", ");
		throw new Error(`No model matching tier '${tier}' found. Available providers: ${available}`);
	}

	const provider = detectProvider(model);
	if (!provider) {
		throw new Error(`Cannot detect provider for model '${model}'`);
	}
	if (!modelsByProvider.has(provider)) {
		const available = [...modelsByProvider.keys()].join(", ");
		throw new Error(
			`Provider '${provider}' for model '${model}' is not available. Available: ${available}`,
		);
	}
	return { model, provider };
}

/** Returns tier names plus all concrete model IDs from the map (deduped). */
export function getAvailableModels(modelsByProvider: Map<string, string[]>): string[] {
	const models = new Set<string>();
	for (const providerModels of modelsByProvider.values()) {
		for (const m of providerModels) {
			models.add(m);
		}
	}
	return [...TIER_NAMES, ...models];
}

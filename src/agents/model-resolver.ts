export interface ResolvedModel {
	model: string;
	provider: string;
}

const MODEL_TIERS: Record<string, Record<string, string>> = {
	best: {
		anthropic: "claude-opus-4-6",
		openai: "gpt-4.1",
		gemini: "gemini-2.5-pro",
	},
	balanced: {
		anthropic: "claude-sonnet-4-6",
		openai: "gpt-4.1",
		gemini: "gemini-2.5-flash",
	},
	fast: {
		anthropic: "claude-haiku-4-5-20251001",
		openai: "gpt-4.1-mini",
		gemini: "gemini-2.5-flash",
	},
};

const PROVIDER_PRIORITY = ["anthropic", "openai", "gemini"];

/** Returns tier names plus concrete model IDs available for the given providers (deduped). */
export function getAvailableModels(providers: string[]): string[] {
	const tiers = Object.keys(MODEL_TIERS);
	const models = new Set<string>();
	for (const tier of Object.values(MODEL_TIERS)) {
		for (const provider of providers) {
			const model = tier[provider];
			if (model) models.add(model);
		}
	}
	return [...tiers, ...models];
}

export function detectProvider(model: string): string | undefined {
	if (model.startsWith("claude-")) return "anthropic";
	if (model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-"))
		return "openai";
	if (model.startsWith("gemini-")) return "gemini";
	return undefined;
}

export function resolveModel(model: string, availableProviders: string[]): ResolvedModel {
	const tier = MODEL_TIERS[model];
	if (tier) {
		for (const provider of PROVIDER_PRIORITY) {
			if (availableProviders.includes(provider) && tier[provider]) {
				return { model: tier[provider], provider };
			}
		}
		throw new Error(
			`No provider available for model tier '${model}'. Available: ${availableProviders.join(", ")}`,
		);
	}

	const provider = detectProvider(model);
	if (!provider) {
		throw new Error(`Cannot detect provider for model '${model}'`);
	}
	if (!availableProviders.includes(provider)) {
		throw new Error(
			`Provider '${provider}' for model '${model}' is not available. Available: ${availableProviders.join(", ")}`,
		);
	}
	return { model, provider };
}

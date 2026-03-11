import type { ProviderCatalogEntry } from "../llm/model-catalog.ts";
import { classifyTier } from "../llm/model-catalog.ts";
import type { ProviderModel } from "../llm/types.ts";

export interface ResolvedModel {
	model: string;
	provider: string;
}

export type Tier = "best" | "balanced" | "fast";

export interface ModelRef {
	providerId: string;
	modelId: string;
}

export interface ResolverProvider {
	id: string;
	enabled: boolean;
}

export interface ResolverSettings {
	providers: ResolverProvider[];
	routing: {
		providerPriority: string[];
		tierOverrides: Partial<Record<Tier, string[]>>;
	};
}

const TIER_NAMES: Tier[] = ["best", "balanced", "fast"];

export function defaultModelsByProvider(providers: string[]): Map<string, ProviderModel[]> {
	const defaults: Record<string, string[]> = {
		anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
		openai: ["o3-pro", "gpt-4.1", "o4-mini"],
		gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
	};
	const map = new Map<string, ProviderModel[]>();
	for (const provider of providers) {
		map.set(
			provider,
			(defaults[provider] ?? []).map((id) => {
				const classified = classifyTier(id);
				return {
					id,
					label: id,
					tierHint: classified?.tierHint,
					rank: classified?.rank,
					source: "remote" as const,
				};
			}),
		);
	}
	return map;
}

export function createResolverSettings(providerIds: string[]): ResolverSettings {
	return {
		providers: providerIds.map((providerId) => ({
			id: providerId,
			enabled: true,
		})),
		routing: {
			providerPriority: [...providerIds],
			tierOverrides: {},
		},
	};
}

export function resolveModel(
	selection: string | ModelRef,
	settings: ResolverSettings,
	catalog: ProviderCatalogEntry[] | Map<string, ProviderModel[]>,
): ResolvedModel {
	const catalogMap = toCatalogMap(catalog);

	if (typeof selection !== "string") {
		return resolveExplicitModelRef(selection, settings, catalogMap);
	}

	if (TIER_NAMES.includes(selection as Tier)) {
		return resolveTier(selection as Tier, settings, catalogMap);
	}

	const matches = findExplicitModelMatches(selection, settings, catalogMap);
	if (matches.length === 1) {
		return { provider: matches[0]!.providerId, model: matches[0]!.model.id };
	}
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous model '${selection}' across providers: ${matches.map((m) => m.providerId).join(", ")}`,
		);
	}
	throw new Error(`Missing model '${selection}' in enabled providers`);
}

export function getAvailableModels(
	catalog: ProviderCatalogEntry[] | Map<string, ProviderModel[]>,
): string[] {
	const models = new Set<string>();
	for (const providerModels of toCatalogMap(catalog).values()) {
		for (const model of providerModels) {
			models.add(model.id);
		}
	}
	return [...TIER_NAMES, ...models];
}

function resolveExplicitModelRef(
	selection: ModelRef,
	settings: ResolverSettings,
	catalog: Map<string, ProviderModel[]>,
): ResolvedModel {
	const provider = settings.providers.find((candidate) => candidate.id === selection.providerId);
	if (!provider) {
		throw new Error(`Unknown provider '${selection.providerId}'`);
	}
	if (!provider.enabled) {
		throw new Error(`Provider '${selection.providerId}' is disabled`);
	}
	const providerModels = catalog.get(selection.providerId) ?? [];
	if (providerModels.length === 0) {
		return { provider: selection.providerId, model: selection.modelId };
	}
	if (!providerModels.some((model) => model.id === selection.modelId)) {
		throw new Error(`Missing model '${selection.modelId}' for provider '${selection.providerId}'`);
	}
	return { provider: selection.providerId, model: selection.modelId };
}

function resolveTier(
	tier: Tier,
	settings: ResolverSettings,
	catalog: Map<string, ProviderModel[]>,
): ResolvedModel {
	const providerOrder = resolveProviderOrder(settings, tier);
	for (const providerId of providerOrder) {
		const provider = settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider?.enabled) continue;
		const models = [...(catalog.get(providerId) ?? [])]
			.filter((model) => model.tierHint === tier)
			.sort(compareTierCandidates);
		if (models.length > 0) {
			return { provider: providerId, model: models[0]!.id };
		}
	}
	throw new Error(`No model matching tier '${tier}' found`);
}

function resolveProviderOrder(settings: ResolverSettings, tier: Tier): string[] {
	const tierOverride = settings.routing.tierOverrides[tier] ?? [];
	const global = settings.routing.providerPriority;
	return [...tierOverride, ...global.filter((providerId) => !tierOverride.includes(providerId))];
}

function compareTierCandidates(left: ProviderModel, right: ProviderModel): number {
	const rankDelta =
		(right.rank ?? Number.NEGATIVE_INFINITY) - (left.rank ?? Number.NEGATIVE_INFINITY);
	if (rankDelta !== 0) return rankDelta;
	return left.id.localeCompare(right.id);
}

function findExplicitModelMatches(
	modelId: string,
	settings: ResolverSettings,
	catalog: Map<string, ProviderModel[]>,
): Array<{ providerId: string; model: ProviderModel }> {
	const enabledProviderIds = new Set(
		settings.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
	);
	const matches: Array<{ providerId: string; model: ProviderModel }> = [];
	for (const [providerId, models] of catalog) {
		if (!enabledProviderIds.has(providerId)) continue;
		for (const model of models) {
			if (model.id === modelId) {
				matches.push({ providerId, model });
			}
		}
	}
	return matches;
}

function toCatalogMap(
	catalog: ProviderCatalogEntry[] | Map<string, ProviderModel[]>,
): Map<string, ProviderModel[]> {
	if (catalog instanceof Map) {
		return new Map(
			[...catalog.entries()].map(([providerId, models]) => [
				providerId,
				normalizeProviderModels(models),
			]),
		);
	}
	return new Map(catalog.map((entry) => [entry.providerId, normalizeProviderModels(entry.models)]));
}

function normalizeProviderModels(models: ProviderModel[]): ProviderModel[] {
	return models.map((model) => {
		const classified = classifyTier(model.id);
		return {
			...model,
			label: model.label ?? model.id,
			tierHint: model.tierHint ?? classified?.tierHint,
			rank: model.rank ?? classified?.rank,
		};
	});
}

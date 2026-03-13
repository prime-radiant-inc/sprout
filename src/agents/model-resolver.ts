import type { ProviderCatalogEntry } from "../llm/model-catalog.ts";
import type { ProviderModel } from "../llm/types.ts";
import type { ProviderConfig, TierModelDefaults } from "../shared/provider-settings.ts";

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
	defaults: {
		defaultProviderId?: string;
		tierDefaults?: TierModelDefaults;
	};
}
const TIER_NAMES: readonly Tier[] = ["best", "balanced", "fast"];

export function createResolverSettings(
	providers: Pick<ProviderConfig, "id" | "enabled">[],
	defaultProviderId?: string,
	tierDefaults?: TierModelDefaults,
): ResolverSettings {
	return {
		providers: providers.map((provider) => ({
			id: provider.id,
			enabled: provider.enabled,
		})),
		defaults: {
			...(defaultProviderId ? { defaultProviderId } : {}),
			...(tierDefaults ? { tierDefaults } : {}),
		},
	};
}

export interface ResolveModelOptions {
	providerId?: string;
}

export function resolveModel(
	selection: string | ModelRef,
	settings: ResolverSettings,
	catalog: ProviderCatalogEntry[] | Map<string, ProviderModel[]>,
	options: ResolveModelOptions = {},
): ResolvedModel {
	const catalogMap = toCatalogMap(catalog);

	if (typeof selection !== "string") {
		return resolveExplicitModelRef(selection, settings, catalogMap);
	}

	if (TIER_NAMES.includes(selection as Tier)) {
		return resolveTier(selection as Tier, settings, catalogMap);
	}
	return resolveProviderRelativeModel(selection, settings, catalogMap, options);
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
	const provider = getEnabledProvider(selection.providerId, settings);
	if (!provider) {
		if (settings.providers.some((candidate) => candidate.id === selection.providerId)) {
			throw new Error(`Provider '${selection.providerId}' is disabled`);
		}
		throw new Error(`Unknown provider '${selection.providerId}'`);
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
	const modelRef = settings.defaults.tierDefaults?.[tier];
	if (!modelRef) {
		throw new Error(`No global '${tier}' model is configured`);
	}
	const provider = getEnabledProvider(modelRef.providerId, settings);
	if (!provider) {
		if (settings.providers.some((candidate) => candidate.id === modelRef.providerId)) {
			throw new Error(
				`Global '${tier}' model references disabled provider '${modelRef.providerId}'`,
			);
		}
		throw new Error(`Global '${tier}' model references unknown provider '${modelRef.providerId}'`);
	}
	assertProviderModelAvailable(modelRef.providerId, modelRef.modelId, catalog);
	return { provider: modelRef.providerId, model: modelRef.modelId };
}

function resolveProviderRelativeModel(
	modelId: string,
	settings: ResolverSettings,
	catalog: Map<string, ProviderModel[]>,
	options: ResolveModelOptions,
): ResolvedModel {
	const providerId = options.providerId;
	if (!providerId) {
		throw new Error(`Exact model '${modelId}' requires an explicit provider`);
	}
	const provider = getEnabledProvider(providerId, settings);
	if (!provider) {
		if (settings.providers.some((candidate) => candidate.id === providerId)) {
			throw new Error(`Provider '${providerId}' is disabled`);
		}
		throw new Error(`Unknown provider '${providerId}'`);
	}
	assertProviderModelAvailable(provider.id, modelId, catalog);
	return {
		provider: provider.id,
		model: modelId,
	};
}

function getEnabledProvider(
	providerId: string,
	settings: ResolverSettings,
): ResolverProvider | undefined {
	const provider = settings.providers.find((candidate) => candidate.id === providerId);
	return provider?.enabled ? provider : undefined;
}

function assertProviderModelAvailable(
	providerId: string,
	modelId: string,
	catalog: Map<string, ProviderModel[]>,
): void {
	const providerModels = catalog.get(providerId) ?? [];
	if (providerModels.length === 0) {
		return;
	}
	if (!providerModels.some((model) => model.id === modelId)) {
		throw new Error(`Missing model '${modelId}' for provider '${providerId}'`);
	}
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
	return models.map((model) => ({
		...model,
		label: model.label ?? model.id,
	}));
}

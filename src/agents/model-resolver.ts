import type { ProviderCatalogEntry } from "../llm/model-catalog.ts";
import type { ProviderModel } from "../llm/types.ts";
import type { ProviderConfig, ProviderTierDefaults } from "../shared/provider-settings.ts";

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
	tierDefaults?: ProviderTierDefaults;
}

export interface ResolverSettings {
	providers: ResolverProvider[];
	defaults: {
		defaultProviderId?: string;
	};
}
const TIER_NAMES: readonly Tier[] = ["best", "balanced", "fast"];

export function createResolverSettings(
	providers: Pick<ProviderConfig, "id" | "enabled" | "tierDefaults">[],
	defaultProviderId?: string,
): ResolverSettings {
	return {
		providers: providers.map((provider) => ({
			id: provider.id,
			enabled: provider.enabled,
			tierDefaults: provider.tierDefaults,
		})),
		defaults: defaultProviderId ? { defaultProviderId } : {},
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
		return resolveTier(selection as Tier, settings, catalogMap, options);
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
	options: ResolveModelOptions,
): ResolvedModel {
	const provider = getSelectedProvider(settings, options);
	const modelId = provider.tierDefaults?.[tier];
	if (!modelId) {
		throw new Error(`Provider '${provider.id}' does not define a '${tier}' model`);
	}
	assertProviderModelAvailable(provider.id, modelId, catalog);
	return { provider: provider.id, model: modelId };
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

function getSelectedProvider(
	settings: ResolverSettings,
	options: ResolveModelOptions,
): ResolverProvider {
	const providerId = options.providerId ?? settings.defaults.defaultProviderId;
	if (!providerId) {
		throw new Error("No provider selected for model resolution");
	}
	const provider = getEnabledProvider(providerId, settings);
	if (!provider) {
		if (settings.providers.some((candidate) => candidate.id === providerId)) {
			throw new Error(`Provider '${providerId}' is disabled`);
		}
		throw new Error(`Unknown provider '${providerId}'`);
	}
	return provider;
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

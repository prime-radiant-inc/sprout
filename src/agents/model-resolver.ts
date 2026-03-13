import type { ProviderCatalogEntry } from "../llm/model-catalog.ts";
import type { ProviderModel } from "../llm/types.ts";
import type {
	DefaultsConfig,
	ModelRef,
	ProviderConfig,
	Tier,
} from "../shared/provider-settings.ts";

export interface ResolvedModel {
	model: string;
	provider: string;
}

export interface ResolverProvider {
	id: string;
	enabled: boolean;
}

export interface ResolverSettings {
	providers: ResolverProvider[];
	defaults: DefaultsConfig;
}
const TIER_NAMES: readonly Tier[] = ["best", "balanced", "fast"];

export function createResolverSettings(
	providers: Pick<ProviderConfig, "id" | "enabled">[],
	defaults: DefaultsConfig = {},
): ResolverSettings {
	return {
		providers: providers.map((provider) => ({
			id: provider.id,
			enabled: provider.enabled,
		})),
		defaults: { ...defaults },
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
	const explicitModel = parseModelRef(selection);
	if (explicitModel) {
		return resolveExplicitModelRef(explicitModel, settings, catalogMap);
	}
	throw new Error(`Exact model '${selection}' requires an explicit provider`);
}

export function getAvailableModels(
	catalog: ProviderCatalogEntry[] | Map<string, ProviderModel[]>,
): string[] {
	const models = new Set<string>();
	for (const [providerId, providerModels] of toCatalogMap(catalog).entries()) {
		for (const model of providerModels) {
			models.add(`${providerId}:${model.id}`);
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
	const modelRef = settings.defaults[tier];
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

function parseModelRef(selection: string): ModelRef | null {
	const separatorIndex = selection.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === selection.length - 1) {
		return null;
	}
	return {
		providerId: selection.slice(0, separatorIndex),
		modelId: selection.slice(separatorIndex + 1),
	};
}

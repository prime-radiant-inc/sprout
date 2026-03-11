import type { ProviderConfig, Tier } from "../host/settings/types.ts";
import type { ProviderModel } from "./types.ts";

export interface ProviderCatalogEntry {
	providerId: string;
	models: ProviderModel[];
	lastRefreshAt?: string;
}

export interface ClassifiedModel {
	tierHint: Tier;
	rank: number;
}

export interface BuildCatalogEntryOptions {
	remoteModels?: ProviderModel[];
	cachedModels?: ProviderModel[];
	validationErrors?: string[];
	lastRefreshAt?: string;
}

export class ModelCatalog {
	private readonly entries = new Map<string, ProviderCatalogEntry>();

	getEntry(providerId: string): ProviderCatalogEntry | undefined {
		return this.entries.get(providerId);
	}

	getEntries(): ProviderCatalogEntry[] {
		return [...this.entries.values()];
	}

	refreshProvider(
		provider: ProviderConfig,
		remoteModels: ProviderModel[],
		lastRefreshAt?: string,
	): ProviderCatalogEntry {
		const entry = buildCatalogEntry(provider, {
			remoteModels,
			cachedModels: this.entries.get(provider.id)?.models,
			lastRefreshAt,
		});
		this.entries.set(provider.id, entry);
		return entry;
	}
}

export function buildCatalogEntry(
	provider: ProviderConfig,
	options: BuildCatalogEntryOptions,
): ProviderCatalogEntry {
	const manualModels = normalizeManualModels(provider.manualModels);
	const cachedModels = normalizeRemoteModels(options.cachedModels ?? []);
	const remoteModels = normalizeRemoteModels(options.remoteModels ?? []);
	const validationErrors = options.validationErrors ?? [];

	let models: ProviderModel[];
	if (validationErrors.length > 0) {
		models = provider.discoveryStrategy === "remote-only" ? [] : manualModels;
	} else if (provider.discoveryStrategy === "manual-only") {
		models = manualModels;
	} else if (!provider.enabled) {
		models =
			provider.discoveryStrategy === "remote-with-manual"
				? mergeProviderModels(cachedModels, manualModels)
				: cachedModels;
	} else if (provider.discoveryStrategy === "remote-only") {
		models = remoteModels;
	} else {
		models = mergeProviderModels(remoteModels, manualModels);
	}

	return {
		providerId: provider.id,
		models,
		lastRefreshAt: options.lastRefreshAt,
	};
}

export function classifyTier(modelId: string): ClassifiedModel | null {
	if (/opus/i.test(modelId)) return { tierHint: "best", rank: 300 };
	if (/^gemini-.*-pro$/i.test(modelId)) return { tierHint: "best", rank: 290 };
	if (/^o(?:1|3|4)(?:[-_].*)?$/i.test(modelId)) return { tierHint: "best", rank: 280 };
	if (/haiku|mini|nano|flash/i.test(modelId)) return { tierHint: "fast", rank: 100 };
	if (/sonnet/i.test(modelId)) return { tierHint: "balanced", rank: 220 };
	if (/gpt-4\.1|gpt-4o/i.test(modelId)) return { tierHint: "balanced", rank: 210 };
	if (/-pro(?:$|-)|\bpro\b/i.test(modelId)) return { tierHint: "balanced", rank: 200 };
	return null;
}

function normalizeRemoteModels(models: ProviderModel[]): ProviderModel[] {
	return models.map((model) => {
		const classified = classifyTier(model.id);
		return {
			...model,
			label: model.label ?? model.id,
			tierHint: model.tierHint ?? classified?.tierHint,
			rank: model.rank ?? classified?.rank,
			source: model.source ?? "remote",
		};
	});
}

function normalizeManualModels(models: ProviderConfig["manualModels"]): ProviderModel[] {
	return (models ?? []).map((model) => ({
		id: model.id,
		label: model.label ?? model.id,
		tierHint: model.tierHint,
		rank: model.rank,
		source: "manual",
	}));
}

function mergeProviderModels(
	remoteModels: ProviderModel[],
	manualModels: ProviderModel[],
): ProviderModel[] {
	const merged = new Map<string, ProviderModel>();

	for (const model of remoteModels) {
		merged.set(model.id, model);
	}
	for (const manualModel of manualModels) {
		const remoteModel = merged.get(manualModel.id);
		if (!remoteModel) {
			merged.set(manualModel.id, manualModel);
			continue;
		}
		merged.set(manualModel.id, {
			...remoteModel,
			label: remoteModel.label ?? manualModel.label,
			tierHint: remoteModel.tierHint ?? manualModel.tierHint,
			rank: remoteModel.rank ?? manualModel.rank,
		});
	}

	return [...merged.values()];
}

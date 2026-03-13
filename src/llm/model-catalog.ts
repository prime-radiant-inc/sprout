import type { ProviderConfig } from "../shared/provider-settings.ts";
import type { ProviderModel } from "./types.ts";

export interface ProviderCatalogEntry {
	providerId: string;
	models: ProviderModel[];
	lastRefreshAt?: string;
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

function normalizeRemoteModels(models: ProviderModel[]): ProviderModel[] {
	return models.map((model) => ({
		...model,
		label: model.label ?? model.id,
		source: model.source ?? "remote",
	}));
}

function normalizeManualModels(models: ProviderConfig["manualModels"]): ProviderModel[] {
	return (models ?? []).map((model) => ({
		id: model.id,
		label: model.label ?? model.id,
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
		});
	}

	return [...merged.values()];
}

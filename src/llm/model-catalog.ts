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
	const cachedModels = normalizeRemoteModels(options.cachedModels ?? []);
	const remoteModels = normalizeRemoteModels(options.remoteModels ?? []);
	const validationErrors = options.validationErrors ?? [];

	const models =
		validationErrors.length > 0 || !provider.enabled
			? cachedModels
			: options.remoteModels
				? remoteModels
				: cachedModels;

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

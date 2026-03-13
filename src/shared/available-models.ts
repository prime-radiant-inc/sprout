export interface AvailableModelsCatalogEntry {
	providerId: string;
	models: Array<{ id: string }>;
}

const TIER_MODELS = ["best", "balanced", "fast"] as const;

export function deriveAvailableModels(
	catalog: AvailableModelsCatalogEntry[] | null | undefined,
): string[] {
	const models = new Set<string>(TIER_MODELS);
	for (const entry of catalog ?? []) {
		for (const model of entry.models) {
			models.add(`${entry.providerId}:${model.id}`);
		}
	}
	return [...models];
}

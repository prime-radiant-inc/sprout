export interface AvailableModelsCatalogEntry {
	models: Array<{ id: string }>;
}

const TIER_MODELS = ["best", "balanced", "fast"] as const;

export function deriveAvailableModels(
	catalog: AvailableModelsCatalogEntry[] | null | undefined,
): string[] {
	const models = new Set<string>(TIER_MODELS);
	for (const entry of catalog ?? []) {
		for (const model of entry.models) {
			models.add(model.id);
		}
	}
	return [...models];
}

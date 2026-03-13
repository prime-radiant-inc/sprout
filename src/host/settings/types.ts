import {
	SETTINGS_SCHEMA_VERSION,
	type SproutSettings,
	type Tier,
} from "../../shared/provider-settings.ts";

export * from "../../shared/provider-settings.ts";

export function createEmptySettings(): SproutSettings {
	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [],
		defaults: {},
	};
}

export function validateSproutSettings(settings: SproutSettings): void {
	const providerIds = new Set<string>();
	const enabledProviderIds = new Set<string>();

	for (const provider of settings.providers) {
		if (providerIds.has(provider.id)) {
			throw new Error(`Duplicate provider id: ${provider.id}`);
		}
		providerIds.add(provider.id);
		if (provider.enabled) enabledProviderIds.add(provider.id);
	}

	for (const tier of ["best", "balanced", "fast"] as const satisfies Tier[]) {
		const modelRef = settings.defaults[tier];
		if (!modelRef) continue;
		if (!enabledProviderIds.has(modelRef.providerId)) {
			throw new Error(
				`Default model '${tier}' must reference an enabled provider: ${modelRef.providerId}`,
			);
		}
	}
}

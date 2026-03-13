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

	if (
		settings.defaults.defaultProviderId !== undefined &&
		!enabledProviderIds.has(settings.defaults.defaultProviderId)
	) {
		throw new Error(
			`Default provider must reference an enabled provider: ${settings.defaults.defaultProviderId}`,
		);
	}

	const tierDefaults = settings.defaults.tierDefaults;
	if (!tierDefaults) return;

	for (const tier of ["best", "balanced", "fast"] as const satisfies Tier[]) {
		const modelRef = tierDefaults[tier];
		if (!modelRef) continue;
		if (!enabledProviderIds.has(modelRef.providerId)) {
			throw new Error(
				`Tier default '${tier}' must reference an enabled provider: ${modelRef.providerId}`,
			);
		}
	}
}

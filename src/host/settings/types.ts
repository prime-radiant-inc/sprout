export const SETTINGS_SCHEMA_VERSION = 1;

export type ProviderKind = "anthropic" | "openai" | "openai-compatible" | "openrouter" | "gemini";

export type Tier = "best" | "balanced" | "fast";

export type ProviderDiscoveryStrategy = "remote-only" | "manual-only" | "remote-with-manual";

export interface ManualModelConfig {
	id: string;
	label?: string;
	tierHint?: Tier;
	rank?: number;
}

export interface ProviderConfig {
	id: string;
	kind: ProviderKind;
	label: string;
	enabled: boolean;
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	discoveryStrategy: ProviderDiscoveryStrategy;
	manualModels?: ManualModelConfig[];
	createdAt: string;
	updatedAt: string;
}

export interface ModelRef {
	providerId: string;
	modelId: string;
}

export type DefaultSelection =
	| { kind: "none" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };

export type SessionModelSelection =
	| { kind: "inherit" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };

export interface DefaultsConfig {
	selection: DefaultSelection;
}

export interface RoutingConfig {
	providerPriority: string[];
	tierOverrides: Partial<Record<Tier, string[]>>;
}

export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
	routing: RoutingConfig;
}

export function createEmptySettings(): SproutSettings {
	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [],
		defaults: { selection: { kind: "none" } },
		routing: {
			providerPriority: [],
			tierOverrides: {},
		},
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

	const providerPriority = new Set<string>();
	for (const providerId of settings.routing.providerPriority) {
		if (providerPriority.has(providerId)) {
			throw new Error(`Duplicate provider priority entry: ${providerId}`);
		}
		providerPriority.add(providerId);
	}

	for (const providerId of enabledProviderIds) {
		if (!providerPriority.has(providerId)) {
			throw new Error(`Missing enabled provider in provider priority: ${providerId}`);
		}
	}
}

export const SETTINGS_SCHEMA_VERSION = 1;

export type ProviderKind = "anthropic" | "openai" | "openai-compatible" | "openrouter" | "gemini";

export type Tier = "best" | "balanced" | "fast";

export type ProviderDiscoveryStrategy = "remote-only" | "manual-only" | "remote-with-manual";

export interface ManualModelConfig {
	id: string;
	label?: string;
}

export interface ModelRef {
	providerId: string;
	modelId: string;
}

export interface TierModelDefaults {
	best?: ModelRef;
	balanced?: ModelRef;
	fast?: ModelRef;
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

export type SessionModelSelection =
	| { kind: "inherit" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };

export interface DefaultsConfig {
	defaultProviderId?: string;
	tierDefaults?: TierModelDefaults;
}

export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
}

export const SETTINGS_SCHEMA_VERSION = 1;

export type ProviderKind = "anthropic" | "openai" | "openai-compatible" | "openrouter" | "gemini";

export type Tier = "best" | "balanced" | "fast";

export type ProviderDiscoveryStrategy = "remote-only" | "manual-only" | "remote-with-manual";

export interface ManualModelConfig {
	id: string;
	label?: string;
}

export interface ProviderTierDefaults {
	best?: string;
	balanced?: string;
	fast?: string;
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
	tierDefaults?: ProviderTierDefaults;
	createdAt: string;
	updatedAt: string;
}

export interface ModelRef {
	providerId: string;
	modelId: string;
}

export type SessionModelSelection =
	| { kind: "inherit"; providerId?: string }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; providerId?: string; tier: Tier };

export interface DefaultsConfig {
	defaultProviderId?: string;
}

export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
}

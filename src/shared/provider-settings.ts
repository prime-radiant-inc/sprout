export const SETTINGS_SCHEMA_VERSION = 4;

export const PROVIDER_KINDS = [
	"anthropic",
	"openai",
	"openai-codex",
	"openai-compatible",
	"openrouter",
	"gemini",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_KIND_LABELS = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "OpenAI Codex",
	"openai-compatible": "OpenAI-compatible",
	openrouter: "OpenRouter",
	gemini: "Gemini",
} as const satisfies Record<ProviderKind, string>;

export type ProviderSecretKind = "api-key" | "oauth";

export const PROVIDER_CREDENTIAL_KINDS = {
	anthropic: ["api-key"],
	openai: ["api-key"],
	"openai-codex": ["oauth"],
	"openai-compatible": ["api-key"],
	openrouter: ["api-key"],
	gemini: ["api-key"],
} as const satisfies Record<ProviderKind, readonly ProviderSecretKind[]>;

export function getProviderCredentialKinds(kind: ProviderKind): readonly ProviderSecretKind[] {
	return PROVIDER_CREDENTIAL_KINDS[kind];
}

export function providerSupportsSecretKind(
	kind: ProviderKind,
	secretKind: ProviderSecretKind,
): boolean {
	return getProviderCredentialKinds(kind).includes(secretKind);
}

export type Tier = "best" | "balanced" | "fast";
export type MemoryModelPurpose =
	| "summary"
	| "extraction"
	| "relationship"
	| "consolidation"
	| "entityGc"
	| "subcortical";

export const MEMORY_MODEL_PURPOSES = [
	"summary",
	"extraction",
	"relationship",
	"consolidation",
	"entityGc",
	"subcortical",
] as const satisfies readonly MemoryModelPurpose[];

export const MEMORY_MODEL_LABELS: Record<MemoryModelPurpose, string> = {
	summary: "Segment summary",
	extraction: "Memory extraction",
	relationship: "Relationship classifier",
	consolidation: "Consolidation reviewer",
	entityGc: "Entity GC reviewer",
	subcortical: "Subcortical recall",
};

export const MEMORY_MODEL_DEFAULT_TIERS: Record<MemoryModelPurpose, Tier> = {
	summary: "best",
	extraction: "balanced",
	relationship: "fast",
	consolidation: "balanced",
	entityGc: "fast",
	subcortical: "fast",
};

export const MEMORY_MODEL_DESCRIPTIONS: Record<MemoryModelPurpose, string> = {
	summary:
		"Collapses completed sessions into durable segment summaries, titles, precis, and complexity scores.",
	extraction:
		"Extracts durable project memories from collapse, learn, and bus evidence before anything is written.",
	relationship:
		"Classifies candidate memory pairs as semantic links such as refines, supersedes, conflicts, or unrelated.",
	consolidation:
		"Reviews similar memory clusters and proposes conservative merges while preserving distinct facts.",
	entityGc:
		"Reviews entity alias groups and decides which duplicate names should merge or stay separate.",
	subcortical:
		"Runs the cheap pre-recall pass: expands the search query, extracts entity hints, and keeps pinned memories.",
};

export interface ModelRef {
	providerId: string;
	modelId: string;
}

export interface ProviderConfig {
	id: string;
	kind: ProviderKind;
	label: string;
	enabled: boolean;
	disabledReason?: "user" | "credential-cleanup-failed";
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export type SessionModelSelection =
	| { kind: "inherit" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };

export type AgentModelOverride = { kind: "model"; model: ModelRef } | { kind: "tier"; tier: Tier };

export interface DefaultsConfig {
	best?: ModelRef;
	balanced?: ModelRef;
	fast?: ModelRef;
}

export type MemoryModelsConfig = Partial<Record<MemoryModelPurpose, ModelRef>>;
export type AgentModelOverridesConfig = Record<string, AgentModelOverride>;

/** "auto" runs memory consolidation/entity-GC unattended after collapse
 *  (Jesse's ruling default); "manual" is the opt-out, leaving the CLI
 *  `--genome maintain` flow as the only way to apply decisions. */
export type MemoryMaintenanceMode = "manual" | "auto";

export interface AgentModelDescriptor {
	key: string;
	name: string;
	source: "root" | "tree" | "overlay";
	path?: string;
	description?: string;
	defaultModel: string;
	storedOverride?: AgentModelOverride;
	runtimeOverride?: {
		source: "env";
		envVar: string;
		selection: AgentModelOverride;
		displayLabel?: string;
		diagnostic?: string;
	};
	effective: {
		selection: "default" | "tier" | "model";
		label: string;
		model?: ModelRef;
		error?: string;
	};
}

export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
	memoryModels: MemoryModelsConfig;
	agentModelOverrides: AgentModelOverridesConfig;
	/** Optional so pre-existing settings literals stay valid; treat a missing
	 *  value as "auto" (see MemoryMaintenanceMode). */
	memoryMaintenance?: MemoryMaintenanceMode;
}

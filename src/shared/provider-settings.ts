export const SETTINGS_SCHEMA_VERSION = 4;

export type ProviderKind =
	| "anthropic"
	| "openai"
	| "openai-codex"
	| "openai-compatible"
	| "openrouter"
	| "gemini";

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
}

export const SETTINGS_SCHEMA_VERSION = 3;

export type ProviderKind = "anthropic" | "openai" | "openai-compatible" | "openrouter" | "gemini";

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
	baseUrl?: string;
	nonSecretHeaders?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export type SessionModelSelection =
	| { kind: "inherit" }
	| { kind: "model"; model: ModelRef }
	| { kind: "tier"; tier: Tier };

export interface DefaultsConfig {
	best?: ModelRef;
	balanced?: ModelRef;
	fast?: ModelRef;
}

export type MemoryModelsConfig = Partial<Record<MemoryModelPurpose, ModelRef>>;

export interface SproutSettings {
	version: typeof SETTINGS_SCHEMA_VERSION;
	providers: ProviderConfig[];
	defaults: DefaultsConfig;
	memoryModels: MemoryModelsConfig;
}

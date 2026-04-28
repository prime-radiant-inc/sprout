import {
	type AgentModelOverride,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelPurpose,
	type ModelRef,
	SETTINGS_SCHEMA_VERSION,
	type SproutSettings,
	type Tier,
} from "../../shared/provider-settings.ts";

export * from "../../shared/provider-settings.ts";

const RESERVED_PROVIDER_IDS = new Set(["memory"]);

export function createEmptySettings(): SproutSettings {
	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [],
		defaults: {},
		memoryModels: {},
		agentModelOverrides: {},
	};
}

export function validateSproutSettings(settings: SproutSettings): void {
	const providerIds = new Set<string>();
	const enabledProviderIds = new Set<string>();

	for (const provider of settings.providers) {
		if (RESERVED_PROVIDER_IDS.has(provider.id)) {
			throw new Error(`Provider id is reserved: ${provider.id}`);
		}
		if (providerIds.has(provider.id)) {
			throw new Error(`Duplicate provider id: ${provider.id}`);
		}
		providerIds.add(provider.id);
		if (provider.enabled) enabledProviderIds.add(provider.id);
	}

	for (const tier of ["best", "balanced", "fast"] as const satisfies Tier[]) {
		const modelRef = settings.defaults[tier];
		if (!modelRef) continue;
		validateModelRef(modelRef, `Default model '${tier}'`);
		if (!enabledProviderIds.has(modelRef.providerId)) {
			throw new Error(
				`Default model '${tier}' must reference an enabled provider: ${modelRef.providerId}`,
			);
		}
	}

	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const modelRef = settings.memoryModels[purpose];
		if (!modelRef) continue;
		validateModelRef(modelRef, `Memory model '${purpose}'`);
		if (!enabledProviderIds.has(modelRef.providerId)) {
			throw new Error(
				`Memory model '${purpose}' must reference an enabled provider: ${modelRef.providerId}`,
			);
		}
	}

	for (const [agentKey, override] of Object.entries(settings.agentModelOverrides)) {
		validateAgentModelOverrideKey(agentKey);
		const label = `Agent model override '${agentKey}'`;
		validateAgentModelOverride(override, label);
		if (override.kind === "tier") continue;
		if (!enabledProviderIds.has(override.model.providerId)) {
			throw new Error(
				`Agent model override '${agentKey}' must reference an enabled provider: ${override.model.providerId}`,
			);
		}
	}
}

function validateAgentModelOverrideKey(agentKey: string): void {
	if (!isNonEmptyString(agentKey)) {
		throw new Error("Agent model override keys must be non-empty strings");
	}
}

export function validateAgentModelOverride(override: AgentModelOverride, label: string): void {
	if (override.kind === "tier") {
		if (!["best", "balanced", "fast"].includes(override.tier)) {
			throw new Error(`${label} must reference best, balanced, or fast`);
		}
		return;
	}
	validateModelRef(override.model, label);
}

function validateModelRef(modelRef: ModelRef, label: string): void {
	if (!isNonEmptyString(modelRef.providerId)) {
		throw new Error(`${label} must include a non-empty providerId`);
	}
	if (!isNonEmptyString(modelRef.modelId)) {
		throw new Error(`${label} must include a non-empty modelId`);
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export type { MemoryModelPurpose };

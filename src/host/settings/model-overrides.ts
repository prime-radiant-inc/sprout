import type { ProviderCatalogEntry } from "../../llm/model-catalog.ts";
import type { ProviderModel } from "../../llm/types.ts";
import {
	type AgentModelOverride,
	MEMORY_MODEL_PURPOSES,
	type MemoryModelPurpose,
	type ModelRef,
	type SproutSettings,
	type Tier,
} from "./types.ts";

export interface ModelConfigOverride {
	source: "env";
	envVar: string;
	model: ModelRef;
	catalogStatus: "not_loaded" | "matched" | "missing";
	displayLabel?: string;
	diagnostic?: string;
}

export interface AgentModelConfigOverride {
	source: "env";
	envVar: string;
	selection: AgentModelOverride;
	displayLabel?: string;
	diagnostic?: string;
}

export interface ModelConfigOverrides {
	defaults: Partial<Record<Tier, ModelConfigOverride>>;
	memoryModels: Partial<Record<MemoryModelPurpose, ModelConfigOverride>>;
	agentModelOverrides: Record<string, AgentModelConfigOverride>;
}

const DEFAULT_MODEL_ENV_VARS: Record<Tier, string> = {
	best: "SPROUT_DEFAULT_BEST_MODEL",
	balanced: "SPROUT_DEFAULT_BALANCED_MODEL",
	fast: "SPROUT_DEFAULT_FAST_MODEL",
};

const MEMORY_MODEL_ENV_VARS: Record<MemoryModelPurpose, string> = {
	summary: "SPROUT_MEMORY_SUMMARY_MODEL",
	extraction: "SPROUT_MEMORY_EXTRACTION_MODEL",
	relationship: "SPROUT_MEMORY_RELATIONSHIP_MODEL",
	consolidation: "SPROUT_MEMORY_CONSOLIDATION_MODEL",
	entityGc: "SPROUT_MEMORY_ENTITY_GC_MODEL",
	subcortical: "SPROUT_MEMORY_SUBCORTICAL_MODEL",
};

const AGENT_MODEL_OVERRIDES_ENV_VAR = "SPROUT_AGENT_MODEL_OVERRIDES";

const TIERS = ["best", "balanced", "fast"] as const satisfies readonly Tier[];

export function createEmptyModelConfigOverrides(): ModelConfigOverrides {
	return {
		defaults: {},
		memoryModels: {},
		agentModelOverrides: {},
	};
}

export function parseModelConfigOverrides(
	env: Record<string, string | undefined> = process.env,
): ModelConfigOverrides {
	const overrides = createEmptyModelConfigOverrides();
	for (const tier of TIERS) {
		const envVar = DEFAULT_MODEL_ENV_VARS[tier];
		const model = parseModelRef(env[envVar], envVar);
		if (model) overrides.defaults[tier] = createEnvOverride(envVar, model);
	}
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const envVar = MEMORY_MODEL_ENV_VARS[purpose];
		const model = parseModelRef(env[envVar], envVar);
		if (model) overrides.memoryModels[purpose] = createEnvOverride(envVar, model);
	}
	overrides.agentModelOverrides = parseAgentModelOverridesEnv(env[AGENT_MODEL_OVERRIDES_ENV_VAR]);
	return overrides;
}

export function validateModelConfigOverrides(
	overrides: ModelConfigOverrides,
	settings: Pick<SproutSettings, "providers" | "defaults">,
	options: { agentKeys?: Iterable<string> } = {},
): void {
	for (const override of enumerateOverrides(overrides)) {
		const provider = settings.providers.find(
			(candidate) => candidate.id === override.model.providerId,
		);
		if (!provider) {
			throw new Error(
				`${override.envVar} references unknown provider '${override.model.providerId}'`,
			);
		}
		if (!provider.enabled) {
			throw new Error(
				`${override.envVar} references disabled provider '${override.model.providerId}'`,
			);
		}
	}

	const agentKeys = options.agentKeys ? new Set(options.agentKeys) : undefined;
	const effectiveDefaults = {
		...settings.defaults,
		...Object.fromEntries(
			Object.entries(overrides.defaults).map(([tier, override]) => [tier, override.model]),
		),
	};
	for (const [agentKey, override] of Object.entries(overrides.agentModelOverrides)) {
		if (agentKeys && !agentKeys.has(agentKey)) {
			throw new Error(
				`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey} references unknown agent key '${agentKey}'`,
			);
		}
		if (override.selection.kind !== "tier") continue;
		const modelRef = effectiveDefaults[override.selection.tier];
		if (!modelRef) {
			throw new Error(
				`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey} references unconfigured global '${override.selection.tier}' model`,
			);
		}
		const provider = settings.providers.find((candidate) => candidate.id === modelRef.providerId);
		if (!provider) {
			throw new Error(
				`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey} references global '${override.selection.tier}' model with unknown provider '${modelRef.providerId}'`,
			);
		}
		if (!provider.enabled) {
			throw new Error(
				`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey} references global '${override.selection.tier}' model with disabled provider '${modelRef.providerId}'`,
			);
		}
	}
}

export function applyModelConfigOverrides(
	settings: Pick<SproutSettings, "providers" | "defaults" | "memoryModels" | "agentModelOverrides">,
	overrides: ModelConfigOverrides,
): Pick<SproutSettings, "providers" | "defaults" | "memoryModels" | "agentModelOverrides"> {
	const defaults = structuredClone(settings.defaults);
	const memoryModels = structuredClone(settings.memoryModels);
	const agentModelOverrides = structuredClone(settings.agentModelOverrides ?? {});

	for (const tier of TIERS) {
		const override = overrides.defaults[tier];
		if (override) defaults[tier] = override.model;
	}
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const override = overrides.memoryModels[purpose];
		if (override) memoryModels[purpose] = override.model;
	}
	for (const [agentKey, override] of Object.entries(overrides.agentModelOverrides)) {
		agentModelOverrides[agentKey] = override.selection;
	}

	return {
		providers: structuredClone(settings.providers),
		defaults,
		memoryModels,
		agentModelOverrides,
	};
}

export function buildModelConfigOverrideSnapshot(
	overrides: ModelConfigOverrides,
	catalog: ProviderCatalogEntry[],
): ModelConfigOverrides {
	const catalogMap = new Map(catalog.map((entry) => [entry.providerId, entry.models]));
	const defaults: ModelConfigOverrides["defaults"] = {};
	const memoryModels: ModelConfigOverrides["memoryModels"] = {};
	const agentModelOverrides: ModelConfigOverrides["agentModelOverrides"] = {};

	for (const tier of TIERS) {
		const override = overrides.defaults[tier];
		if (override) defaults[tier] = annotateOverride(override, catalogMap);
	}
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const override = overrides.memoryModels[purpose];
		if (override) memoryModels[purpose] = annotateOverride(override, catalogMap);
	}
	for (const [agentKey, override] of Object.entries(overrides.agentModelOverrides)) {
		agentModelOverrides[agentKey] = annotateAgentOverride(override, catalogMap);
	}

	return { defaults, memoryModels, agentModelOverrides };
}

export function findModelConfigOverridesForProvider(
	overrides: ModelConfigOverrides,
	providerId: string,
): ModelConfigOverride[] {
	return enumerateOverrides(overrides).filter(
		(override) => override.model.providerId === providerId,
	);
}

function createEnvOverride(envVar: string, model: ModelRef): ModelConfigOverride {
	return {
		source: "env",
		envVar,
		model,
		catalogStatus: "not_loaded",
	};
}

function parseModelRef(value: string | undefined, envVar: string): ModelRef | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const separatorIndex = trimmed.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
		throw new Error(`${envVar} must be a provider-qualified model reference`);
	}
	return {
		providerId: trimmed.slice(0, separatorIndex),
		modelId: trimmed.slice(separatorIndex + 1),
	};
}

function parseAgentModelOverridesEnv(
	value: string | undefined,
): Record<string, AgentModelConfigOverride> {
	const trimmed = value?.trim();
	if (!trimmed) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new Error(
			`${AGENT_MODEL_OVERRIDES_ENV_VAR} must be a JSON object: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${AGENT_MODEL_OVERRIDES_ENV_VAR} must be a JSON object`);
	}
	const overrides: Record<string, AgentModelConfigOverride> = {};
	for (const [agentKey, rawSelection] of Object.entries(parsed as Record<string, unknown>)) {
		if (agentKey.trim().length === 0) {
			throw new Error(`${AGENT_MODEL_OVERRIDES_ENV_VAR} contains an empty agent key`);
		}
		if (agentKey !== agentKey.trim()) {
			throw new Error(`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey} key cannot contain padding`);
		}
		if (typeof rawSelection !== "string") {
			throw new Error(`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey} must be a string`);
		}
		overrides[agentKey] = {
			source: "env",
			envVar: AGENT_MODEL_OVERRIDES_ENV_VAR,
			selection: parseAgentModelOverrideString(
				rawSelection,
				`${AGENT_MODEL_OVERRIDES_ENV_VAR}.${agentKey}`,
			),
		};
	}
	return overrides;
}

function parseAgentModelOverrideString(value: string, label: string): AgentModelOverride {
	const trimmed = value.trim();
	if (trimmed === "best" || trimmed === "balanced" || trimmed === "fast") {
		return { kind: "tier", tier: trimmed };
	}
	const model = parseModelRef(trimmed, label);
	if (!model) {
		throw new Error(
			`${label} must be best, balanced, fast, or a provider-qualified model reference`,
		);
	}
	return { kind: "model", model };
}

function enumerateOverrides(overrides: ModelConfigOverrides): ModelConfigOverride[] {
	const values: ModelConfigOverride[] = [];
	for (const tier of TIERS) {
		const override = overrides.defaults[tier];
		if (override) values.push(override);
	}
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const override = overrides.memoryModels[purpose];
		if (override) values.push(override);
	}
	for (const override of Object.values(overrides.agentModelOverrides)) {
		if (override.selection.kind === "model") {
			values.push(createEnvOverride(override.envVar, override.selection.model));
		}
	}
	return values;
}

function annotateOverride(
	override: ModelConfigOverride,
	catalogMap: Map<string, ProviderModel[]>,
): ModelConfigOverride {
	const providerModels = catalogMap.get(override.model.providerId) ?? [];
	if (providerModels.length === 0) {
		return {
			source: override.source,
			envVar: override.envVar,
			model: structuredClone(override.model),
			catalogStatus: "not_loaded",
		};
	}

	const catalogModel = providerModels.find((model) => model.id === override.model.modelId);
	if (catalogModel) {
		return {
			source: override.source,
			envVar: override.envVar,
			model: structuredClone(override.model),
			catalogStatus: "matched",
			displayLabel: catalogModel.label,
		};
	}

	return {
		source: override.source,
		envVar: override.envVar,
		model: structuredClone(override.model),
		catalogStatus: "missing",
		diagnostic: `Model '${override.model.modelId}' is not in the loaded catalog for provider '${override.model.providerId}'`,
	};
}

function annotateAgentOverride(
	override: AgentModelConfigOverride,
	catalogMap: Map<string, ProviderModel[]>,
): AgentModelConfigOverride {
	if (override.selection.kind === "tier") {
		return structuredClone(override);
	}
	const annotated = annotateOverride(
		createEnvOverride(override.envVar, override.selection.model),
		catalogMap,
	);
	return {
		source: override.source,
		envVar: override.envVar,
		selection: structuredClone(override.selection),
		displayLabel: annotated.displayLabel,
		diagnostic: annotated.diagnostic,
	};
}

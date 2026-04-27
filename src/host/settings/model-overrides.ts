import type { ProviderCatalogEntry } from "../../llm/model-catalog.ts";
import type { ProviderModel } from "../../llm/types.ts";
import {
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

export interface ModelConfigOverrides {
	defaults: Partial<Record<Tier, ModelConfigOverride>>;
	memoryModels: Partial<Record<MemoryModelPurpose, ModelConfigOverride>>;
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

const TIERS = ["best", "balanced", "fast"] as const satisfies readonly Tier[];

export function createEmptyModelConfigOverrides(): ModelConfigOverrides {
	return {
		defaults: {},
		memoryModels: {},
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
	return overrides;
}

export function validateModelConfigOverrides(
	overrides: ModelConfigOverrides,
	settings: Pick<SproutSettings, "providers">,
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
}

export function applyModelConfigOverrides(
	settings: Pick<SproutSettings, "providers" | "defaults" | "memoryModels">,
	overrides: ModelConfigOverrides,
): Pick<SproutSettings, "providers" | "defaults" | "memoryModels"> {
	const defaults = structuredClone(settings.defaults);
	const memoryModels = structuredClone(settings.memoryModels);

	for (const tier of TIERS) {
		const override = overrides.defaults[tier];
		if (override) defaults[tier] = override.model;
	}
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const override = overrides.memoryModels[purpose];
		if (override) memoryModels[purpose] = override.model;
	}

	return {
		providers: structuredClone(settings.providers),
		defaults,
		memoryModels,
	};
}

export function buildModelConfigOverrideSnapshot(
	overrides: ModelConfigOverrides,
	catalog: ProviderCatalogEntry[],
): ModelConfigOverrides {
	const catalogMap = new Map(catalog.map((entry) => [entry.providerId, entry.models]));
	const defaults: ModelConfigOverrides["defaults"] = {};
	const memoryModels: ModelConfigOverrides["memoryModels"] = {};

	for (const tier of TIERS) {
		const override = overrides.defaults[tier];
		if (override) defaults[tier] = annotateOverride(override, catalogMap);
	}
	for (const purpose of MEMORY_MODEL_PURPOSES) {
		const override = overrides.memoryModels[purpose];
		if (override) memoryModels[purpose] = annotateOverride(override, catalogMap);
	}

	return { defaults, memoryModels };
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

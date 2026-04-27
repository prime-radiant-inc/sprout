import type { DefaultsConfig, MemoryModelsConfig, ModelRef } from "./types.ts";

export function backfillRequiredMemoryModels(
	defaults: DefaultsConfig,
	memoryModels: MemoryModelsConfig,
): MemoryModelsConfig {
	const next: MemoryModelsConfig = { ...memoryModels };
	if (!next.subcortical) {
		const modelRef = firstDefaultModel(defaults);
		if (modelRef) next.subcortical = cloneModelRef(modelRef);
	}
	return next;
}

function firstDefaultModel(defaults: DefaultsConfig): ModelRef | undefined {
	return defaults.fast ?? defaults.balanced ?? defaults.best;
}

function cloneModelRef(modelRef: ModelRef): ModelRef {
	return {
		providerId: modelRef.providerId,
		modelId: modelRef.modelId,
	};
}

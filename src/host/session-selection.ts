import { resolveModel } from "../agents/model-resolver.ts";
import {
	formatSessionSelectionRequest,
	type ModelOverride,
	type SessionSelectionRequest,
	selectionRequestToModelOverride,
} from "../shared/session-selection.ts";
import type { ProviderCatalogEntry } from "./settings/control-plane.ts";
import type { ModelRef, SessionModelSelection, SproutSettings } from "./settings/types.ts";

export interface SessionSelectionContext {
	settings: Pick<SproutSettings, "providers" | "routing">;
	catalog: ProviderCatalogEntry[];
}

export interface SessionSelectionSnapshot {
	selection: SessionModelSelection;
	resolved?: ModelRef;
	source: "runtime-fallback" | "session";
}

export function createDefaultSessionSelectionSnapshot(): SessionSelectionSnapshot {
	return {
		selection: { kind: "inherit" },
		source: "runtime-fallback",
	};
}

export function defaultResolveSessionSelectionRequest(
	selection: SessionSelectionRequest,
): SessionSelectionSnapshot {
	switch (selection.kind) {
		case "inherit":
			return createDefaultSessionSelectionSnapshot();
		case "tier":
			return {
				selection,
				source: "session",
			};
		case "model":
			return {
				selection,
				resolved: selection.model,
				source: "session",
			};
		case "unqualified_model":
			throw new Error(
				`Cannot resolve unqualified model '${selection.modelId}' without a provider catalog`,
			);
	}
}

export function resolveSessionSelectionRequest(
	selection: SessionSelectionRequest,
	context: SessionSelectionContext,
): SessionSelectionSnapshot {
	if (selection.kind === "inherit") {
		return createDefaultSessionSelectionSnapshot();
	}

	if (selection.kind === "unqualified_model" && context.catalog.length === 0) {
		throw new Error(
			`Cannot resolve unqualified model '${selection.modelId}' without a provider catalog`,
		);
	}

	const resolvedModel =
		selection.kind === "tier"
			? resolveModel(selection.tier, context.settings, context.catalog)
			: selection.kind === "model"
				? resolveModel(selection.model, context.settings, context.catalog)
				: resolveModel(selection.modelId, context.settings, context.catalog);

	return {
		selection:
			selection.kind === "unqualified_model"
				? {
						kind: "model",
						model: {
							providerId: resolvedModel.provider,
							modelId: resolvedModel.model,
						},
					}
				: selection,
		resolved: {
			providerId: resolvedModel.provider,
			modelId: resolvedModel.model,
		},
		source: "session",
	};
}

export function selectionSnapshotToModelOverride(
	selection: SessionSelectionSnapshot,
): ModelOverride | undefined {
	if (selection.resolved) {
		return selection.resolved;
	}
	return selectionRequestToModelOverride(selection.selection);
}

export function formatSessionSelectionSnapshot(
	selection: SessionSelectionSnapshot,
): string | undefined {
	if (selection.selection.kind === "inherit") {
		return undefined;
	}
	return formatSessionSelectionRequest(selection.selection);
}

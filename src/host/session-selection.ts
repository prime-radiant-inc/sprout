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
	settings: Pick<SproutSettings, "providers" | "defaults">;
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
			return {
				selection,
				source: "runtime-fallback",
			};
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
	}
}

export function resolveSessionSelectionRequest(
	selection: SessionSelectionRequest,
	context: SessionSelectionContext,
): SessionSelectionSnapshot {
	if (selection.kind === "inherit") {
		return {
			selection,
			source: "runtime-fallback",
		};
	}

	const resolvedModel =
		selection.kind === "tier"
			? resolveModel(selection.tier, context.settings, context.catalog)
			: resolveModel(selection.model, context.settings, context.catalog);

	return {
		selection,
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

export function selectionSnapshotToProviderId(
	selection: SessionSelectionSnapshot,
): string | undefined {
	if (selection.selection.kind === "model") {
		return selection.selection.model.providerId;
	}
	return selection.resolved?.providerId;
}

export function selectionSnapshotToCurrentModel(
	selection: SessionSelectionSnapshot,
): string | undefined {
	if (selection.resolved) {
		return selection.resolved.modelId;
	}
	if (selection.selection.kind === "model") {
		return selection.selection.model.modelId;
	}
	return undefined;
}

export function selectionRequestToCurrentModel(
	selection: SessionSelectionRequest | undefined,
): string | undefined {
	if (!selection || selection.kind === "inherit") {
		return undefined;
	}
	if (selection.kind === "model") {
		return selection.model.modelId;
	}
	return undefined;
}

export function formatSessionSelectionSnapshot(
	selection: SessionSelectionSnapshot,
): string | undefined {
	if (selection.selection.kind === "inherit") {
		return undefined;
	}
	return formatSessionSelectionRequest(selection.selection);
}

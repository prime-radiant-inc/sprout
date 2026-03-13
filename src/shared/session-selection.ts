import type { ModelRef, SessionModelSelection, Tier } from "./provider-settings.ts";

export type SessionSelectionRequest = SessionModelSelection;

export type AgentModelInput =
	| { kind: "tier"; tier: Tier }
	| { kind: "unqualified_model"; modelId: string };

export type ModelOverride = string | ModelRef;

const TIER_NAMES = new Set<Tier>(["best", "balanced", "fast"]);

export function parseSessionSelectionRequest(input: string): SessionSelectionRequest {
	const trimmed = requireNonEmptySelection(input, "Session model selection");
	if (trimmed === "inherit") {
		return { kind: "inherit" };
	}
	if (isTier(trimmed)) {
		return { kind: "tier", tier: trimmed };
	}
	const explicitModel = parseProviderQualifiedModel(trimmed);
	if (explicitModel) {
		return { kind: "model", model: explicitModel };
	}
	throw new Error("Session model selections must use a provider-qualified model ref");
}

export function parseAgentModelInput(input: string): AgentModelInput {
	const trimmed = requireNonEmptySelection(input, "Agent model");
	if (trimmed === "inherit") {
		throw new Error("Agent frontmatter does not allow inherit");
	}
	if (isTier(trimmed)) {
		return { kind: "tier", tier: trimmed };
	}
	if (parseProviderQualifiedModel(trimmed)) {
		throw new Error("Agent frontmatter does not allow provider-qualified model refs");
	}
	return { kind: "unqualified_model", modelId: trimmed };
}

export function formatSessionSelectionRequest(selection: SessionSelectionRequest): string {
	switch (selection.kind) {
		case "inherit":
			return "inherit";
		case "tier":
			return selection.tier;
		case "model":
			return formatModelRef(selection.model);
	}
}

export function selectionRequestToModelOverride(
	selection: SessionSelectionRequest | undefined,
): ModelOverride | undefined {
	if (!selection || selection.kind === "inherit") {
		return undefined;
	}
	switch (selection.kind) {
		case "tier":
			return selection.tier;
		case "model":
			return selection.model;
	}
}

export function formatModelOverride(model: ModelOverride | undefined): string | undefined {
	if (!model) {
		return undefined;
	}
	return typeof model === "string" ? model : formatModelRef(model);
}

function requireNonEmptySelection(input: string, label: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error(`${label} cannot be empty`);
	}
	return trimmed;
}

function isTier(input: string): input is Tier {
	return TIER_NAMES.has(input as Tier);
}

function parseProviderQualifiedModel(input: string): ModelRef | null {
	const separatorIndex = input.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === input.length - 1) {
		return null;
	}
	return {
		providerId: input.slice(0, separatorIndex),
		modelId: input.slice(separatorIndex + 1),
	};
}

function formatModelRef(model: ModelRef): string {
	return `${model.providerId}:${model.modelId}`;
}

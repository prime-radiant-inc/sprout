import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type {
	SessionModelSelection,
	SessionSelectionSnapshot,
	SettingsSnapshot,
} from "../kernel/types.ts";
import { formatSessionSelectionRequest } from "../shared/session-selection.ts";

interface ModelPickerSelectionOption {
	kind: "selection";
	key: string;
	label: string;
	selection: SessionModelSelection;
}

export type ModelPickerOption = ModelPickerSelectionOption;

type ModelPickerRow =
	| {
			kind: "heading";
			key: string;
			label: string;
	  }
	| {
			kind: "option";
			key: string;
			label: string;
			optionIndex: number;
	  };

export interface BuildModelPickerOptionsArgs {
	availableModels: string[];
	settings?: SettingsSnapshot | null;
	currentSelection: SessionSelectionSnapshot;
	currentModel: string;
}

export interface ModelPickerProps extends BuildModelPickerOptionsArgs {
	onSelect: (selection: SessionModelSelection) => void;
	onCancel: () => void;
}

const TIER_LABELS = {
	best: "Best",
	balanced: "Balanced",
	fast: "Fast",
} as const;

export function buildModelPickerOptions({
	availableModels,
	settings,
	currentSelection,
	currentModel,
}: BuildModelPickerOptionsArgs): ModelPickerOption[] {
	const options: ModelPickerOption[] = [];
	const seenSelections = new Set<string>();

	const pushSelection = (selection: SessionModelSelection, label: string) => {
		const key = formatSessionSelectionRequest(selection);
		if (seenSelections.has(key)) return;
		seenSelections.add(key);
		options.push({ kind: "selection", key, selection, label });
	};

	if (!settings) {
		pushSelection(
			{ kind: "inherit" },
			currentModel ? `Use agent default · ${currentModel}` : "Use agent default",
		);
		for (const tier of ["best", "balanced", "fast"] as const) {
			if (availableModels.includes(tier)) {
				pushSelection({ kind: "tier", tier }, TIER_LABELS[tier]);
			}
		}
		if (currentSelection.selection.kind !== "inherit") {
			pushSelection(currentSelection.selection, formatSelectionLabel(currentSelection, settings));
		}
		return options;
	}

	const enabledProviders = settings.settings.providers.filter((provider) => provider.enabled);
	pushSelection({ kind: "inherit" }, formatDefaultSelectionLabel(currentModel));

	for (const tier of ["best", "balanced", "fast"] as const) {
		const modelRef = settings.settings.defaults[tier];
		if (!modelRef) continue;
		const provider = enabledProviders.find((candidate) => candidate.id === modelRef.providerId);
		const model = settings.catalog
			.find((entry) => entry.providerId === modelRef.providerId)
			?.models.find((candidate) => candidate.id === modelRef.modelId);
		pushSelection(
			{ kind: "tier", tier },
			`${TIER_LABELS[tier]} · ${provider?.label ?? modelRef.providerId} · ${
				model?.label ?? modelRef.modelId
			}`,
		);
	}

	for (const provider of enabledProviders) {
		const entry = settings.catalog.find((catalogEntry) => catalogEntry.providerId === provider.id);
		for (const model of entry?.models ?? []) {
			const selectionKey = `${provider.id}:${model.id}`;
			if (availableModels.length > 0 && !availableModels.includes(selectionKey)) continue;
			pushSelection(
				{
					kind: "model",
					model: {
						providerId: provider.id,
						modelId: model.id,
					},
				},
				`${provider.label} · ${model.label}`,
			);
		}
	}

	if (currentSelection.selection.kind !== "inherit") {
		pushSelection(currentSelection.selection, formatSelectionLabel(currentSelection, settings));
	}

	return options;
}

export function ModelPicker({
	availableModels,
	settings,
	currentSelection,
	currentModel,
	onSelect,
	onCancel,
}: ModelPickerProps) {
	const [cursor, setCursor] = useState(0);
	const options = buildModelPickerOptions({
		availableModels,
		settings,
		currentSelection,
		currentModel,
	});
	const rows = buildModelPickerRows(options, settings);
	const selectableRows = rows.filter(
		(row): row is Extract<ModelPickerRow, { kind: "option" }> => row.kind === "option",
	);

	useEffect(() => {
		setCursor((prev) => Math.min(prev, Math.max(0, selectableRows.length - 1)));
	}, [selectableRows.length]);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.return && selectableRows.length > 0) {
			const row = selectableRows[cursor];
			if (!row) return;
			const option = options[row.optionIndex];
			if (!option) return;
			onSelect(option.selection);
			return;
		}

		if (key.downArrow) {
			setCursor((prev) => Math.min(prev + 1, selectableRows.length - 1));
			return;
		}

		if (key.upArrow) {
			setCursor((prev) => Math.max(prev - 1, 0));
		}
	});

	if (selectableRows.length === 0) {
		return <Text>No models available.</Text>;
	}

	return (
		<Box flexDirection="column">
			<Text bold>Select model (Enter to confirm, Esc to cancel):</Text>
			{rows.map((row) => {
				if (row.kind === "heading") {
					return (
						<Text key={row.key} dimColor>
							{row.label}
						</Text>
					);
				}
				const selected = row.optionIndex === selectableRows[cursor]?.optionIndex;
				return (
					<Text key={row.key} color={selected ? "cyan" : undefined}>
						{selected ? "> " : "  "}
						{row.label}
					</Text>
				);
			})}
		</Box>
	);
}

function buildModelPickerRows(
	options: ModelPickerOption[],
	settings: SettingsSnapshot | null | undefined,
): ModelPickerRow[] {
	if (!settings) {
		return options.map((option, optionIndex) => ({
			kind: "option",
			key: option.key,
			label: option.label,
			optionIndex,
		}));
	}

	const rows: ModelPickerRow[] = [];
	let addedDefaultHeading = false;
	let currentProviderGroup: string | null = null;

	for (const [optionIndex, option] of options.entries()) {
		switch (option.selection.kind) {
			case "inherit":
				rows.push({
					kind: "option",
					key: option.key,
					label: option.label,
					optionIndex,
				});
				break;
			case "tier":
				if (!addedDefaultHeading) {
					rows.push({
						kind: "heading",
						key: "heading:defaults",
						label: "Default models",
					});
					addedDefaultHeading = true;
				}
				rows.push({
					kind: "option",
					key: option.key,
					label: option.label,
					optionIndex,
				});
				break;
			case "model": {
				const selectedModel = option.selection.model;
				const provider = settings.settings.providers.find(
					(candidate) => candidate.id === selectedModel.providerId,
				);
				const providerLabel = provider?.label ?? selectedModel.providerId;
				if (currentProviderGroup !== selectedModel.providerId) {
					rows.push({
						kind: "heading",
						key: `heading:${selectedModel.providerId}`,
						label: providerLabel,
					});
					currentProviderGroup = selectedModel.providerId;
				}
				rows.push({
					kind: "option",
					key: option.key,
					label: formatExactModelRowLabel(option, settings),
					optionIndex,
				});
				break;
			}
		}
	}

	return rows;
}

function formatExactModelRowLabel(
	option: ModelPickerOption,
	settings: SettingsSnapshot | null | undefined,
): string {
	if (option.selection.kind !== "model") {
		return option.label;
	}
	const selectedModel = option.selection.model;
	const model = settings?.catalog
		.find((entry) => entry.providerId === selectedModel.providerId)
		?.models.find((candidate) => candidate.id === selectedModel.modelId);
	return model?.label ?? selectedModel.modelId;
}

function formatSelectionLabel(
	selection: SessionSelectionSnapshot,
	settings: SettingsSnapshot | null | undefined,
): string {
	const currentSelection = selection.selection;
	switch (currentSelection.kind) {
		case "inherit":
			return formatDefaultSelectionLabel();
		case "tier": {
			const providerId =
				selection.resolved?.providerId ??
				settings?.settings.defaults[currentSelection.tier]?.providerId;
			const provider = providerId
				? settings?.settings.providers.find((candidate) => candidate.id === providerId)
				: undefined;
			const modelId =
				selection.resolved?.modelId ?? settings?.settings.defaults[currentSelection.tier]?.modelId;
			const model =
				providerId && modelId
					? settings?.catalog
							.find((entry) => entry.providerId === providerId)
							?.models.find((candidate) => candidate.id === modelId)
					: undefined;
			return provider
				? `${TIER_LABELS[currentSelection.tier]} · ${provider.label} · ${
						model?.label ?? modelId ?? ""
					}`.trim()
				: TIER_LABELS[currentSelection.tier];
		}
		case "model": {
			const selectedModel = currentSelection.model;
			const provider = settings?.settings.providers.find(
				(candidate) => candidate.id === selectedModel.providerId,
			);
			const model = settings?.catalog
				.find((entry) => entry.providerId === selectedModel.providerId)
				?.models.find((candidate) => candidate.id === selectedModel.modelId);
			return `${provider?.label ?? selectedModel.providerId} · ${model?.label ?? selectedModel.modelId}`;
		}
	}
}

function formatDefaultSelectionLabel(currentModel?: string): string {
	return currentModel ? `Use agent default · ${currentModel}` : "Use agent default";
}

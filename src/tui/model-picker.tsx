import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type {
	SessionModelSelection,
	SessionSelectionSnapshot,
	SettingsSnapshot,
} from "../kernel/types.ts";
import { formatSessionSelectionRequest } from "../shared/session-selection.ts";

export interface ModelPickerOption {
	label: string;
	selection: SessionModelSelection;
}

export interface BuildModelPickerOptionsArgs {
	availableModels: string[];
	settings?: SettingsSnapshot | null;
	currentSelection: SessionSelectionSnapshot;
	currentModel: string;
}

export interface ModelPickerProps {
	options: ModelPickerOption[];
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
	const seen = new Set<string>();

	const push = (selection: SessionModelSelection, label: string) => {
		const key = formatSessionSelectionRequest(selection);
		if (seen.has(key)) return;
		seen.add(key);
		options.push({ selection, label });
	};

	push({ kind: "inherit" }, currentModel ? `Default · ${currentModel}` : "Default");

	for (const tier of ["best", "balanced", "fast"] as const) {
		if (availableModels.includes(tier)) {
			push({ kind: "tier", tier }, TIER_LABELS[tier]);
		}
	}

	for (const provider of settings?.settings.providers ?? []) {
		if (!provider.enabled) continue;
		const catalogEntry = settings?.catalog.find((entry) => entry.providerId === provider.id);
		for (const model of catalogEntry?.models ?? []) {
			if (!availableModels.includes(model.id)) continue;
			push(
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

	if (currentSelection.selection.kind === "model") {
		const selection = currentSelection.selection;
		const provider = settings?.settings.providers.find(
			(candidate) => candidate.id === selection.model.providerId,
		);
		const model = settings?.catalog
			.find((entry) => entry.providerId === selection.model.providerId)
			?.models.find((candidate) => candidate.id === selection.model.modelId);
		push(
			selection,
			`${provider?.label ?? selection.model.providerId} · ${
				model?.label ?? selection.model.modelId
			}`,
		);
	}

	if (currentSelection.selection.kind === "tier") {
		push(currentSelection.selection, TIER_LABELS[currentSelection.selection.tier]);
	}

	return options;
}

export function ModelPicker({ options, onSelect, onCancel }: ModelPickerProps) {
	const [cursor, setCursor] = useState(0);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.return && options.length > 0) {
			onSelect(options[cursor]!.selection);
			return;
		}

		if (key.downArrow) {
			setCursor((prev) => Math.min(prev + 1, options.length - 1));
			return;
		}

		if (key.upArrow) {
			setCursor((prev) => Math.max(prev - 1, 0));
		}
	});

	if (options.length === 0) {
		return <Text>No models available.</Text>;
	}

	return (
		<Box flexDirection="column">
			<Text bold>Select model (Enter to confirm, Esc to cancel):</Text>
			{options.map((option, index) => {
				const selected = index === cursor;
				return (
					<Text
						key={formatSessionSelectionRequest(option.selection)}
						color={selected ? "cyan" : undefined}
					>
						{selected ? "> " : "  "}
						{option.label}
					</Text>
				);
			})}
		</Box>
	);
}

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

interface ModelPickerProviderOption {
	kind: "provider";
	key: string;
	label: string;
	providerId: string;
}

export type ModelPickerOption = ModelPickerSelectionOption | ModelPickerProviderOption;

export interface BuildModelPickerOptionsArgs {
	availableModels: string[];
	settings?: SettingsSnapshot | null;
	currentSelection: SessionSelectionSnapshot;
	currentModel: string;
	selectedProviderId?: string;
}

export interface ModelPickerProps extends Omit<BuildModelPickerOptionsArgs, "selectedProviderId"> {
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
	selectedProviderId,
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
			currentModel ? `Default provider · ${currentModel}` : "Default provider",
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
	const activeProviderId = resolveActiveProviderId(settings, currentSelection, selectedProviderId);
	const activeProvider = enabledProviders.find((provider) => provider.id === activeProviderId);
	const activeCatalogEntry = settings.catalog.find(
		(entry) => entry.providerId === activeProvider?.id,
	);

	pushSelection({ kind: "inherit" }, formatGlobalDefaultLabel(settings, currentModel));

	for (const provider of enabledProviders) {
		options.push({
			kind: "provider",
			key: `provider:${provider.id}`,
			providerId: provider.id,
			label: `Provider · ${provider.label}${provider.id === activeProviderId ? " (selected)" : ""}`,
		});
	}

	if (!activeProvider) {
		return options;
	}

	for (const tier of ["best", "balanced", "fast"] as const) {
		const modelRef = settings.settings.defaults.tierDefaults?.[tier];
		if (!modelRef) continue;
		const provider = enabledProviders.find((candidate) => candidate.id === modelRef.providerId);
		pushSelection(
			{ kind: "tier", tier },
			`${TIER_LABELS[tier]} · ${provider?.label ?? modelRef.providerId}`,
		);
	}

	for (const model of activeCatalogEntry?.models ?? []) {
		pushSelection(
			{
				kind: "model",
				model: {
					providerId: activeProvider.id,
					modelId: model.id,
				},
			},
			`${activeProvider.label} · ${model.label}`,
		);
	}

	if (currentSelection.selection.kind === "model") {
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
	const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined);
	const options = buildModelPickerOptions({
		availableModels,
		settings,
		currentSelection,
		currentModel,
		selectedProviderId,
	});

	useEffect(() => {
		setCursor((prev) => Math.min(prev, Math.max(0, options.length - 1)));
	}, [options.length]);

	useInput((_input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}

		if (key.return && options.length > 0) {
			const option = options[cursor];
			if (!option) return;
			if (option.kind === "provider") {
				setSelectedProviderId(option.providerId);
				return;
			}
			onSelect(option.selection);
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
					<Text key={option.key} color={selected ? "cyan" : undefined}>
						{selected ? "> " : "  "}
						{option.label}
					</Text>
				);
			})}
		</Box>
	);
}

function resolveActiveProviderId(
	settings: SettingsSnapshot,
	currentSelection: SessionSelectionSnapshot,
	selectedProviderId?: string,
): string | undefined {
	const enabledProviderIds = new Set(
		settings.settings.providers
			.filter((provider) => provider.enabled)
			.map((provider) => provider.id),
	);
	if (selectedProviderId && enabledProviderIds.has(selectedProviderId)) {
		return selectedProviderId;
	}

	if (
		currentSelection.selection.kind === "model" &&
		enabledProviderIds.has(currentSelection.selection.model.providerId)
	) {
		return currentSelection.selection.model.providerId;
	}

	const defaultProviderId = settings.settings.defaults.defaultProviderId;
	if (defaultProviderId && enabledProviderIds.has(defaultProviderId)) {
		return defaultProviderId;
	}

	return settings.settings.providers.find((provider) => provider.enabled)?.id;
}

function formatGlobalDefaultLabel(settings: SettingsSnapshot, currentModel: string): string {
	const provider = settings.settings.defaults.defaultProviderId
		? settings.settings.providers.find(
				(candidate) => candidate.id === settings.settings.defaults.defaultProviderId,
			)
		: undefined;
	if (provider) {
		return `Default provider · ${provider.label}`;
	}
	return currentModel ? `Default provider · ${currentModel}` : "Default provider";
}

function formatSelectionLabel(
	selection: SessionSelectionSnapshot,
	settings: SettingsSnapshot | null | undefined,
): string {
	const currentSelection = selection.selection;
	switch (currentSelection.kind) {
		case "inherit": {
			const providerId = settings?.settings.defaults.defaultProviderId;
			const provider = providerId
				? settings?.settings.providers.find((candidate) => candidate.id === providerId)
				: undefined;
			return provider ? `${provider.label} · Default` : "Default provider";
		}
		case "tier": {
			const providerId =
				selection.resolved?.providerId ??
				settings?.settings.defaults.tierDefaults?.[currentSelection.tier]?.providerId;
			const provider = providerId
				? settings?.settings.providers.find((candidate) => candidate.id === providerId)
				: undefined;
			return provider
				? `${provider.label} · ${TIER_LABELS[currentSelection.tier]}`
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

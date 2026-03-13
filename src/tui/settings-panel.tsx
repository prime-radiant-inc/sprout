import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SettingsCommand, SettingsCommandResult, SettingsSnapshot } from "../kernel/types.ts";
import {
	applyProviderEditorCommand,
	createProviderEditorDraft,
	type ProviderEditorDraft,
	ProviderSettingsEditor,
} from "./provider-settings-editor.tsx";

type SelectedView = "default-provider" | "create" | string;

export interface SettingsPanelProps {
	settings: SettingsSnapshot | null;
	lastResult: SettingsCommandResult | null;
	onCommand: (command: SettingsCommand) => void;
	onClose: () => void;
}

function selectInitialView(settings: SettingsSnapshot | null): SelectedView {
	if (!settings) return "create";
	if (settings.settings.providers.length === 0) return "create";
	return "default-provider";
}

function createInitialDrafts(
	settings: SettingsSnapshot | null,
): Record<string, ProviderEditorDraft> {
	if (!settings) return {};
	return Object.fromEntries(
		settings.settings.providers.map((provider) => [
			provider.id,
			createProviderEditorDraft(provider),
		]),
	);
}

export function SettingsPanel({ settings, lastResult, onCommand, onClose }: SettingsPanelProps) {
	const [selectedView, setSelectedView] = useState<SelectedView>(() => selectInitialView(settings));
	const [input, setInput] = useState("");
	const [message, setMessage] = useState<string | null>(null);
	const [createDraft, setCreateDraft] = useState(() => createProviderEditorDraft());
	const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderEditorDraft>>(() =>
		createInitialDrafts(settings),
	);
	const selectedViewRef = useRef(selectedView);
	const createDraftRef = useRef(createDraft);
	const providerDraftsRef = useRef(providerDrafts);
	const settingsRef = useRef(settings);
	const inputRef = useRef(input);
	const previousProviderIdsRef = useRef<string[]>(
		settings?.settings.providers.map((provider) => provider.id) ?? [],
	);

	selectedViewRef.current = selectedView;
	createDraftRef.current = createDraft;
	providerDraftsRef.current = providerDrafts;
	settingsRef.current = settings;
	inputRef.current = input;

	const updateInput = (update: (current: string) => string) => {
		const next = update(inputRef.current);
		inputRef.current = next;
		setInput(next);
	};

	useEffect(() => {
		if (!settings) return;
		const previousProviderIds = previousProviderIdsRef.current;
		const currentProviderIds = settings.settings.providers.map((provider) => provider.id);
		previousProviderIdsRef.current = currentProviderIds;
		setProviderDrafts((current) => {
			const next = { ...current };
			for (const provider of settings.settings.providers) {
				next[provider.id] ??= createProviderEditorDraft(provider);
			}
			return next;
		});
		const createdProviderId = currentProviderIds.find(
			(providerId) => !previousProviderIds.includes(providerId),
		);
		if (selectedView === "create" && createdProviderId) {
			setCreateDraft(createProviderEditorDraft());
			setSelectedView(createdProviderId);
			return;
		}
		if (
			selectedView !== "default-provider" &&
			selectedView !== "create" &&
			!settings.settings.providers.some((provider) => provider.id === selectedView)
		) {
			setSelectedView(selectInitialView(settings));
		}
	}, [settings, selectedView]);

	useInput((character, key) => {
		if (key.escape) {
			onClose();
			return;
		}
		if (key.return) {
			executeInput();
			return;
		}
		if (key.backspace || key.delete) {
			updateInput((current) => current.slice(0, -1));
			return;
		}
		if (character) {
			updateInput((current) => current + character);
		}
	});

	const selectedProvider = useMemo(
		() =>
			selectedView === "default-provider" || selectedView === "create"
				? undefined
				: settings?.settings.providers.find((provider) => provider.id === selectedView),
		[settings, selectedView],
	);
	const selectedStatus = settings?.providers.find(
		(status) => status.providerId === selectedProvider?.id,
	);
	const selectedCatalog = settings?.catalog.find(
		(entry) => entry.providerId === selectedProvider?.id,
	);

	if (!settings) {
		return (
			<Box flexDirection="column">
				<Text bold>Provider settings</Text>
				<Text color="gray">Loading provider settings</Text>
			</Box>
		);
	}

	const executeInput = () => {
		const commandText = inputRef.current.trim();
		const currentSettings = settingsRef.current;
		const currentView = selectedViewRef.current;
		inputRef.current = "";
		setInput("");
		if (!commandText || !currentSettings) return;

		const global = applyGlobalCommand(
			commandText,
			currentSettings,
			currentView,
			setSelectedView,
			onClose,
		);
		if (global.handled) {
			setMessage(global.message ?? null);
			return;
		}

		if (currentView === "default-provider") {
			const next = applyDefaultProviderCommand(commandText, currentSettings);
			if (next.error) {
				setMessage(next.error);
				return;
			}
			if (next.command) {
				onCommand(next.command);
				setMessage(null);
			}
			return;
		}

		if (currentView === "create") {
			const result = applyProviderEditorCommand(commandText, createDraftRef.current, "create");
			setCreateDraft(result.draft);
			if (result.command) {
				onCommand(result.command);
				setMessage(null);
				return;
			}
			setMessage(result.error ?? null);
			return;
		}

		const currentDraft =
			providerDraftsRef.current[currentView] ?? createProviderEditorDraft(selectedProvider);
		const result = applyProviderEditorCommand(commandText, currentDraft, "edit", currentView);
		setProviderDrafts((current) => ({
			...current,
			[currentView]: result.draft,
		}));
		if (result.command) {
			onCommand(result.command);
			setMessage(null);
			return;
		}
		setMessage(result.error ?? null);
	};

	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>Provider settings</Text>
			{settings.runtime.warnings.map((warning) => (
				<Text key={`${warning.code}-${warning.message}`} color="yellow">
					{warning.message}
				</Text>
			))}
			{settings.settings.providers.length === 0 && (
				<Text color="gray">No providers configured</Text>
			)}
			<Box gap={4}>
				<Box flexDirection="column" width={24}>
					<Text bold>Views</Text>
					<Text color={selectedView === "default-provider" ? "cyan" : undefined}>
						{selectedView === "default-provider" ? "> " : "  "}
						Default provider
					</Text>
					{settings.settings.providers.map((provider) => (
						<Text key={provider.id} color={selectedView === provider.id ? "cyan" : undefined}>
							{selectedView === provider.id ? "> " : "  "}
							{formatProviderNavLabel(provider, settings)}
						</Text>
					))}
					<Text color={selectedView === "create" ? "cyan" : undefined}>
						{selectedView === "create" ? "> " : "  "}
						Create provider
					</Text>
				</Box>

				<Box flexDirection="column" flexGrow={1}>
					{selectedView === "default-provider" ? (
						<DefaultProviderSummary settings={settings} lastResult={lastResult} />
					) : (
						<ProviderSettingsEditor
							mode={selectedView === "create" ? "create" : "edit"}
							draft={
								selectedView === "create"
									? createDraft
									: (providerDrafts[selectedView] ?? createProviderEditorDraft(selectedProvider))
							}
							provider={selectedProvider}
							status={selectedStatus}
							catalogEntry={selectedCatalog}
							lastResult={lastResult}
						/>
					)}
				</Box>
			</Box>

			{message && <Text color="yellow">{message}</Text>}
			<Text color="gray">
				Navigation: default-provider · create · open &lt;provider-id&gt; · next · prev · close
			</Text>
			<Text color="gray">Shortcuts are optional; use them when you already know the action.</Text>
			<Text>shortcut&gt; {input}</Text>
		</Box>
	);
}

function DefaultProviderSummary({
	settings,
	lastResult,
}: {
	settings: SettingsSnapshot;
	lastResult: SettingsCommandResult | null;
}) {
	const enabledProviders = settings.settings.providers.filter((provider) => provider.enabled);
	const defaultProvider = settings.settings.defaults.defaultProviderId
		? settings.settings.providers.find(
				(provider) => provider.id === settings.settings.defaults.defaultProviderId,
			)
		: undefined;

	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>Default provider</Text>
			{lastResult && !lastResult.ok && <Text color="red">{lastResult.message}</Text>}
			<Text>
				Current default:{" "}
				{defaultProvider
					? `${defaultProvider.label} (${defaultProvider.id})`
					: "Automatic provider selection"}
			</Text>
			<Text bold>Enabled providers</Text>
			{enabledProviders.length === 0 ? (
				<Text color="gray">No enabled providers available.</Text>
			) : (
				enabledProviders.map((provider) => (
					<Text key={provider.id}>
						{provider.label} ({provider.id})
						{provider.id === settings.settings.defaults.defaultProviderId ? " · default" : ""}
					</Text>
				))
			)}
			<Text color="gray">Commands: default &lt;provider-id&gt; | default none</Text>
		</Box>
	);
}

function formatProviderNavLabel(
	provider: SettingsSnapshot["settings"]["providers"][number],
	settings: SettingsSnapshot,
): string {
	const markers = [
		provider.id === settings.settings.defaults.defaultProviderId ? "default" : undefined,
		!provider.enabled ? "disabled" : undefined,
	].filter(Boolean);
	if (markers.length === 0) return provider.label;
	return `${provider.label} · ${markers.join(" · ")}`;
}

function applyGlobalCommand(
	input: string,
	settings: SettingsSnapshot,
	currentView: SelectedView,
	setSelectedView: (view: SelectedView) => void,
	onClose: () => void,
): { handled: boolean; message?: string } {
	const trimmed = input.trim();
	if (trimmed === "create") {
		setSelectedView("create");
		return { handled: true };
	}
	if (trimmed === "default-provider") {
		setSelectedView("default-provider");
		return { handled: true };
	}
	if (trimmed === "close") {
		onClose();
		return { handled: true };
	}
	if (trimmed === "next" || trimmed === "prev") {
		const order = [
			"default-provider",
			...settings.settings.providers.map((provider) => provider.id),
			"create",
		];
		const currentIndex = Math.max(0, order.indexOf(currentView));
		const delta = trimmed === "next" ? 1 : -1;
		const nextIndex = Math.min(order.length - 1, Math.max(0, currentIndex + delta));
		setSelectedView(order[nextIndex] ?? currentView);
		return { handled: true };
	}
	if (trimmed.startsWith("open ")) {
		const providerId = trimmed.slice("open ".length).trim();
		if (!providerId) return { handled: true, message: "Provider id is required." };
		if (!settings.settings.providers.some((provider) => provider.id === providerId)) {
			return { handled: true, message: `Unknown provider: ${providerId}` };
		}
		setSelectedView(providerId);
		return { handled: true };
	}
	return { handled: false };
}

function applyDefaultProviderCommand(
	input: string,
	settings: SettingsSnapshot,
): { command?: SettingsCommand; error?: string } {
	const trimmed = input.trim();
	if (trimmed === "default none") {
		return {
			command: { kind: "set_default_provider", data: {} },
		};
	}
	if (!trimmed.startsWith("default ")) {
		return { error: "Unknown default-provider command." };
	}
	const providerId = trimmed.slice("default ".length).trim();
	if (!providerId) {
		return { error: "Provider id is required." };
	}
	const provider = settings.settings.providers.find((candidate) => candidate.id === providerId);
	if (!provider) {
		return { error: `Unknown provider: ${providerId}` };
	}
	if (!provider.enabled) {
		return { error: `Default provider must be enabled: ${providerId}` };
	}
	return {
		command: {
			kind: "set_default_provider",
			data: { providerId },
		},
	};
}

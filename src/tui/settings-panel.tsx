import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SettingsCommand, SettingsCommandResult, SettingsSnapshot } from "../kernel/types.ts";
import {
	applyProviderEditorCommand,
	createProviderEditorDraft,
	type ProviderEditorDraft,
	ProviderSettingsEditor,
} from "./provider-settings-editor.tsx";

type SelectedView = "defaults" | "create" | string;

export interface SettingsPanelProps {
	settings: SettingsSnapshot | null;
	lastResult: SettingsCommandResult | null;
	onCommand: (command: SettingsCommand) => void;
	onClose: () => void;
}

function selectInitialView(settings: SettingsSnapshot | null): SelectedView {
	if (!settings) return "create";
	if (settings.settings.providers.length === 0) return "create";
	return settings.settings.providers[0]?.id ?? "create";
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

	selectedViewRef.current = selectedView;
	createDraftRef.current = createDraft;
	providerDraftsRef.current = providerDrafts;
	settingsRef.current = settings;

	useEffect(() => {
		if (!settings) return;
		setProviderDrafts((current) => {
			const next = { ...current };
			for (const provider of settings.settings.providers) {
				next[provider.id] ??= createProviderEditorDraft(provider);
			}
			return next;
		});
		if (
			selectedView !== "defaults" &&
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
			setInput((current) => current.slice(0, -1));
			return;
		}
		if (character) {
			setInput((current) => current + character);
		}
	});

	const selectedProvider = useMemo(
		() =>
			selectedView === "defaults" || selectedView === "create"
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
		const commandText = input.trim();
		const currentSettings = settingsRef.current;
		const currentView = selectedViewRef.current;
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

		if (currentView === "defaults") {
			const next = applyDefaultsCommand(commandText);
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
			{settings.settings.providers.length === 0 && (
				<Text color="gray">No providers configured</Text>
			)}
			<Box gap={4}>
				<Box flexDirection="column" width={24}>
					<Text bold>Views</Text>
					<Text color={selectedView === "defaults" ? "cyan" : undefined}>
						{selectedView === "defaults" ? "> " : "  "}
						Defaults and routing
					</Text>
					{settings.settings.providers.map((provider) => (
						<Text key={provider.id} color={selectedView === provider.id ? "cyan" : undefined}>
							{selectedView === provider.id ? "> " : "  "}
							{provider.label}
						</Text>
					))}
					<Text color={selectedView === "create" ? "cyan" : undefined}>
						{selectedView === "create" ? "> " : "  "}
						Create provider
					</Text>
				</Box>

				<Box flexDirection="column" flexGrow={1}>
					{selectedView === "defaults" ? (
						<DefaultsSummary settings={settings} />
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
				Navigation: create · defaults · open &lt;provider-id&gt; · next · prev · close
			</Text>
			<Text>settings&gt; {input}</Text>
		</Box>
	);
}

function DefaultsSummary({ settings }: { settings: SettingsSnapshot }) {
	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>Defaults and routing</Text>
			<Text>Default selection: {formatDefaultSelection(settings)}</Text>
			<Text>
				Provider priority: {settings.settings.routing.providerPriority.join(", ") || "(empty)"}
			</Text>
			<Text>Best: {settings.settings.routing.tierOverrides.best?.join(", ") || "(inherit)"}</Text>
			<Text>
				Balanced: {settings.settings.routing.tierOverrides.balanced?.join(", ") || "(inherit)"}
			</Text>
			<Text>Fast: {settings.settings.routing.tierOverrides.fast?.join(", ") || "(inherit)"}</Text>
			<Text color="gray">
				Commands: default none | default tier &lt;tier&gt; | default model &lt;provider:model&gt;
			</Text>
			<Text color="gray">
				priority &lt;provider-a,provider-b&gt; | tier &lt;tier&gt; &lt;provider-a,provider-b&gt;
			</Text>
		</Box>
	);
}

function formatDefaultSelection(settings: SettingsSnapshot): string {
	const selection = settings.settings.defaults.selection;
	switch (selection.kind) {
		case "none":
			return "none";
		case "tier":
			return selection.tier;
		case "model":
			return `${selection.model.providerId}:${selection.model.modelId}`;
	}
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
	if (trimmed === "defaults") {
		setSelectedView("defaults");
		return { handled: true };
	}
	if (trimmed === "close") {
		onClose();
		return { handled: true };
	}
	if (trimmed === "next" || trimmed === "prev") {
		const order = [
			"defaults",
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

function applyDefaultsCommand(input: string): { command?: SettingsCommand; error?: string } {
	const trimmed = input.trim();
	if (trimmed === "default none") {
		return {
			command: { kind: "set_default_selection", data: { selection: { kind: "none" } } },
		};
	}
	if (trimmed.startsWith("default tier ")) {
		const tier = trimmed.slice("default tier ".length).trim();
		if (!isTier(tier)) return { error: "Unknown tier." };
		return {
			command: {
				kind: "set_default_selection",
				data: { selection: { kind: "tier", tier } },
			},
		};
	}
	if (trimmed.startsWith("default model ")) {
		const value = trimmed.slice("default model ".length).trim();
		const model = parseModelRef(value);
		if (!model) return { error: "Use providerId:modelId for explicit models." };
		return {
			command: {
				kind: "set_default_selection",
				data: { selection: { kind: "model", model } },
			},
		};
	}
	if (trimmed.startsWith("priority ")) {
		return {
			command: {
				kind: "set_provider_priority",
				data: { providerIds: parseProviderList(trimmed.slice("priority ".length)) },
			},
		};
	}
	if (trimmed.startsWith("tier ")) {
		const [, tier, providerIds] = trimmed.match(/^tier\s+(\S+)\s+(.+)$/) ?? [];
		if (!tier || !providerIds || !isTier(tier)) {
			return { error: "Use tier <best|balanced|fast> <provider-a,provider-b>." };
		}
		return {
			command: {
				kind: "set_tier_priority",
				data: { tier, providerIds: parseProviderList(providerIds) },
			},
		};
	}
	return { error: "Unknown defaults command." };
}

function parseProviderList(input: string): string[] {
	return input
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function parseModelRef(input: string): { providerId: string; modelId: string } | null {
	const separator = input.indexOf(":");
	if (separator <= 0 || separator >= input.length - 1) return null;
	return {
		providerId: input.slice(0, separator),
		modelId: input.slice(separator + 1),
	};
}

function isTier(input: string): input is "best" | "balanced" | "fast" {
	return input === "best" || input === "balanced" || input === "fast";
}

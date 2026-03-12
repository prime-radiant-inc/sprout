import { Box, Text } from "ink";
import type {
	ProviderConfig,
	SettingsCommand,
	SettingsCommandResult,
	SettingsSnapshot,
} from "../kernel/types.ts";

const PROVIDER_KINDS = new Set([
	"anthropic",
	"openai",
	"openai-compatible",
	"openrouter",
	"gemini",
] as const);

const DISCOVERY_STRATEGIES = new Set(["remote-only", "manual-only", "remote-with-manual"] as const);

export interface ProviderEditorDraft {
	kind: ProviderConfig["kind"];
	label: string;
	baseUrl: string;
	discoveryStrategy: ProviderConfig["discoveryStrategy"];
	enabled: boolean;
}

export interface ProviderEditorCommandResult {
	draft: ProviderEditorDraft;
	command?: SettingsCommand;
	error?: string;
}

export interface ProviderSettingsEditorProps {
	mode: "create" | "edit";
	draft: ProviderEditorDraft;
	provider?: ProviderConfig;
	status?: SettingsSnapshot["providers"][number];
	catalogEntry?: SettingsSnapshot["catalog"][number];
	lastResult?: SettingsCommandResult | null;
}

export function createProviderEditorDraft(provider?: ProviderConfig): ProviderEditorDraft {
	return {
		kind: provider?.kind ?? "anthropic",
		label: provider?.label ?? "",
		baseUrl: provider?.baseUrl ?? "",
		discoveryStrategy: provider?.discoveryStrategy ?? "remote-with-manual",
		enabled: provider?.enabled ?? false,
	};
}

export function applyProviderEditorCommand(
	input: string,
	draft: ProviderEditorDraft,
	mode: "create" | "edit",
	providerId?: string,
): ProviderEditorCommandResult {
	const trimmed = input.trim();
	if (!trimmed) {
		return { draft, error: "Enter a provider command." };
	}

	const [command] = trimmed.split(/\s+/);
	const argument = trimmed.slice(command?.length ?? 0).trim();
	const nextDraft = { ...draft };

	switch (command) {
		case "label":
			if (!argument) return { draft, error: "Label cannot be empty." };
			nextDraft.label = argument;
			return { draft: nextDraft };
		case "kind":
			if (!argument || !PROVIDER_KINDS.has(argument as ProviderConfig["kind"])) {
				return { draft, error: "Unknown provider kind." };
			}
			nextDraft.kind = argument as ProviderConfig["kind"];
			if (nextDraft.kind !== "openai-compatible") {
				nextDraft.baseUrl = "";
			}
			return { draft: nextDraft };
		case "discovery":
			if (!argument || !DISCOVERY_STRATEGIES.has(argument as ProviderConfig["discoveryStrategy"])) {
				return { draft, error: "Unknown discovery strategy." };
			}
			nextDraft.discoveryStrategy = argument as ProviderConfig["discoveryStrategy"];
			return { draft: nextDraft };
		case "base-url":
			nextDraft.baseUrl = argument;
			return { draft: nextDraft };
		case "save":
			if (!draft.label.trim()) {
				return { draft, error: "Label is required before saving." };
			}
			if (mode === "create") {
				return {
					draft,
					command: {
						kind: "create_provider",
						data: {
							kind: draft.kind,
							label: draft.label.trim(),
							discoveryStrategy: draft.discoveryStrategy,
							...(supportsBaseUrl(draft.kind) && draft.baseUrl.trim()
								? { baseUrl: draft.baseUrl.trim() }
								: {}),
						},
					},
				};
			}
			if (!providerId) {
				return { draft, error: "Provider id is required in edit mode." };
			}
			return {
				draft,
				command: {
					kind: "update_provider",
					data: {
						providerId,
						patch: {
							label: draft.label.trim(),
							discoveryStrategy: draft.discoveryStrategy,
							...(supportsBaseUrl(draft.kind) ? { baseUrl: draft.baseUrl.trim() } : {}),
						},
					},
				},
			};
		case "enable":
		case "disable":
			return providerCommand(draft, providerId, "set_provider_enabled", {
				providerId: providerId ?? "",
				enabled: command === "enable",
			});
		case "test":
			return providerCommand(draft, providerId, "test_provider_connection", {
				providerId: providerId ?? "",
			});
		case "refresh":
			return providerCommand(draft, providerId, "refresh_provider_models", {
				providerId: providerId ?? "",
			});
		case "delete":
			return providerCommand(draft, providerId, "delete_provider", {
				providerId: providerId ?? "",
			});
		case "secret":
			if (!argument) return { draft, error: "Secret cannot be empty." };
			return providerCommand(draft, providerId, "set_provider_secret", {
				providerId: providerId ?? "",
				secret: argument,
			});
		case "remove-secret":
			return providerCommand(draft, providerId, "delete_provider_secret", {
				providerId: providerId ?? "",
			});
		default:
			return { draft, error: `Unknown provider command: ${command}` };
	}
}

function providerCommand<K extends SettingsCommand["kind"]>(
	draft: ProviderEditorDraft,
	providerId: string | undefined,
	kind: K,
	data: Extract<SettingsCommand, { kind: K }>["data"],
): ProviderEditorCommandResult {
	if (!providerId) {
		return { draft, error: "Select a saved provider first." };
	}
	return {
		draft,
		command: { kind, data } as Extract<SettingsCommand, { kind: K }>,
	};
}

function supportsBaseUrl(kind: ProviderConfig["kind"]): boolean {
	return kind === "openai-compatible";
}

export function ProviderSettingsEditor({
	mode,
	draft,
	provider,
	status,
	catalogEntry,
	lastResult,
}: ProviderSettingsEditorProps) {
	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>{mode === "create" ? "Create provider" : (provider?.label ?? "Provider")}</Text>
			<Text color="gray">
				{mode === "create"
					? "Use commands to build a new provider draft and save it."
					: "Edit this provider, inspect health, and run provider actions."}
			</Text>
			{lastResult && !lastResult.ok && <Text color="red">{lastResult.message}</Text>}

			<Text>Kind: {draft.kind}</Text>
			<Text>Label: {draft.label || "(unset)"}</Text>
			{supportsBaseUrl(draft.kind) && <Text>Base URL: {draft.baseUrl || "(unset)"}</Text>}
			<Text>Discovery: {draft.discoveryStrategy}</Text>
			{mode === "edit" && provider && <Text>Enabled: {provider.enabled ? "yes" : "no"}</Text>}

			{mode === "edit" && (
				<Box flexDirection="column">
					<Text bold>Health</Text>
					{status?.validationErrors.map((error) => (
						<Text key={error} color="red">
							{error}
						</Text>
					))}
					{status?.connectionError && <Text color="red">{status.connectionError}</Text>}
					{status?.catalogStatus === "stale" && status.catalogError && (
						<Text color="yellow">{status.catalogError}</Text>
					)}
					{!status?.validationErrors.length &&
						!status?.connectionError &&
						!(status?.catalogStatus === "stale" && status.catalogError) && (
							<Text color="gray">No provider warnings.</Text>
						)}
				</Box>
			)}

			{mode === "edit" && (
				<Box flexDirection="column">
					<Text bold>Discovered models</Text>
					{(catalogEntry?.models.length ?? 0) === 0 ? (
						<Text color="gray">No models discovered yet.</Text>
					) : (
						catalogEntry?.models.map((model) => (
							<Text key={model.id}>
								{model.label} [{model.id}] {model.tierHint ? `· ${model.tierHint}` : ""}
							</Text>
						))
					)}
				</Box>
			)}

			<Box flexDirection="column">
				<Text bold>Commands</Text>
				<Text color="gray">
					label &lt;text&gt; · kind &lt;kind&gt; · discovery &lt;strategy&gt;
				</Text>
				<Text color="gray">base-url &lt;url&gt; · save</Text>
				{mode === "edit" && (
					<Text color="gray">
						enable · disable · test · refresh · secret &lt;token&gt; · remove-secret · delete
					</Text>
				)}
			</Box>
		</Box>
	);
}

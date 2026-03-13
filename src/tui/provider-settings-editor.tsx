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

export interface HeaderDraft {
	key: string;
	value: string;
}

export interface ProviderEditorDraft {
	kind: ProviderConfig["kind"];
	label: string;
	baseUrl: string;
	enabled: boolean;
	nonSecretHeaders: HeaderDraft[];
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
		enabled: provider?.enabled ?? false,
		nonSecretHeaders: Object.entries(provider?.nonSecretHeaders ?? {}).map(([key, value]) => ({
			key,
			value,
		})),
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
	const nextDraft = structuredClone(draft);

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
			if (!supportsBaseUrl(nextDraft.kind)) {
				nextDraft.baseUrl = "";
			}
			if (!supportsNonSecretHeaders(nextDraft.kind)) {
				nextDraft.nonSecretHeaders = [];
			}
			return { draft: nextDraft };
		case "base-url":
			nextDraft.baseUrl = argument;
			return { draft: nextDraft };
		case "add-header":
			nextDraft.nonSecretHeaders.push({ key: "", value: "" });
			return { draft: nextDraft };
		case "remove-header":
			return removeIndexedItem(nextDraft, "header", argument);
		case "header-key":
			return updateIndexedHeader(nextDraft, "key", argument);
		case "header-value":
			return updateIndexedHeader(nextDraft, "value", argument);
		case "save":
			if (!draft.label.trim()) {
				return { draft, error: "Label is required before saving." };
			}
			return {
				draft,
				command: createProviderSaveCommand(mode, draft, providerId),
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

function createProviderSaveCommand(
	mode: "create" | "edit",
	draft: ProviderEditorDraft,
	providerId?: string,
): SettingsCommand {
	const trimmedLabel = draft.label.trim();
	const baseUrl = draft.baseUrl.trim();
	const nonSecretHeaders = normalizeHeaders(draft.nonSecretHeaders);

	if (mode === "create") {
		return {
			kind: "create_provider",
			data: {
				kind: draft.kind,
				label: trimmedLabel,
				...(supportsBaseUrl(draft.kind) && baseUrl ? { baseUrl } : {}),
				...(supportsNonSecretHeaders(draft.kind) && nonSecretHeaders ? { nonSecretHeaders } : {}),
			},
		};
	}

	if (!providerId) {
		throw new Error("Provider id is required in edit mode.");
	}

	return {
		kind: "update_provider",
		data: {
			providerId,
			patch: {
				label: trimmedLabel,
				...(supportsBaseUrl(draft.kind) ? { baseUrl } : {}),
				...(supportsNonSecretHeaders(draft.kind)
					? { nonSecretHeaders: nonSecretHeaders ?? {} }
					: {}),
			},
		},
	};
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

function supportsNonSecretHeaders(kind: ProviderConfig["kind"]): boolean {
	return kind !== "gemini";
}

function normalizeHeaders(headers: HeaderDraft[]): Record<string, string> | undefined {
	const entries = headers
		.map((header) => [header.key.trim(), header.value.trim()] as const)
		.filter(([key, value]) => key.length > 0 || value.length > 0);
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries);
}

function removeIndexedItem(
	draft: ProviderEditorDraft,
	kind: "header",
	argument: string,
): ProviderEditorCommandResult {
	const index = parseOneBasedIndex(argument);
	if (index === undefined) {
		return { draft, error: `Provide a ${kind} index.` };
	}
	const next = structuredClone(draft);
	const list = next.nonSecretHeaders;
	if (!list[index]) {
		return { draft, error: `Unknown ${kind} index.` };
	}
	list.splice(index, 1);
	return { draft: next };
}

function updateIndexedHeader(
	draft: ProviderEditorDraft,
	field: keyof HeaderDraft,
	argument: string,
): ProviderEditorCommandResult {
	const parsed = parseIndexedArgument(argument);
	if (!parsed) return { draft, error: "Provide an index and value." };
	const next = structuredClone(draft);
	const header = next.nonSecretHeaders[parsed.index];
	if (!header) return { draft, error: "Unknown header index." };
	header[field] = parsed.value;
	return { draft: next };
}

function parseOneBasedIndex(raw: string): number | undefined {
	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value < 1) return undefined;
	return value - 1;
}

function parseIndexedArgument(argument: string): { index: number; value: string } | undefined {
	const [indexText] = argument.split(/\s+/);
	const value = argument.slice(indexText?.length ?? 0).trim();
	const index = parseOneBasedIndex(indexText ?? "");
	if (index === undefined || !value) return undefined;
	return { index, value };
}

export function ProviderSettingsEditor({
	mode,
	draft,
	provider,
	status,
	catalogEntry,
	lastResult,
}: ProviderSettingsEditorProps) {
	const fieldErrors = lastResult && !lastResult.ok ? lastResult.fieldErrors : undefined;

	return (
		<Box flexDirection="column" gap={1}>
			<Text bold>{mode === "create" ? "Create provider" : (provider?.label ?? "Provider")}</Text>
			<Text color="gray">
				{mode === "create"
					? "Use visible actions first; shortcuts are available when you already know the move."
					: "Review provider details, take actions, and use shortcuts for quick edits."}
			</Text>
			{lastResult && !lastResult.ok && <Text color="red">{lastResult.message}</Text>}

			<Text>Kind: {draft.kind}</Text>
			<Text>Label: {draft.label || "(unset)"}</Text>
			{fieldErrors?.label && <Text color="red">Label: {fieldErrors.label}</Text>}
			{supportsBaseUrl(draft.kind) && (
				<>
					<Text>Base URL: {draft.baseUrl || "(unset)"}</Text>
					{fieldErrors?.baseUrl && <Text color="red">Base URL: {fieldErrors.baseUrl}</Text>}
				</>
			)}
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

			{supportsNonSecretHeaders(draft.kind) && (
				<Box flexDirection="column">
					<Text bold>Custom headers</Text>
					{draft.nonSecretHeaders.length === 0 ? (
						<Text color="gray">No custom headers configured.</Text>
					) : (
						draft.nonSecretHeaders.map((header, index) => (
							<Text key={`${header.key}-${index}`}>
								{index + 1}. {header.key || "(missing key)"} = {header.value || "(empty)"}
							</Text>
						))
					)}
					{fieldErrors?.nonSecretHeaders && <Text color="red">{fieldErrors.nonSecretHeaders}</Text>}
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
								{model.label} [{model.id}]
							</Text>
						))
					)}
				</Box>
			)}

			<Box flexDirection="column">
				<Text bold>Actions</Text>
				<Text color="gray">Save provider: save</Text>
				{supportsNonSecretHeaders(draft.kind) && <Text color="gray">Add header: add-header</Text>}
				{mode === "edit" && (
					<Text color="gray">
						Enable/disable · test · refresh · secret &lt;token&gt; · remove-secret · delete
					</Text>
				)}
				<Text color="gray">Shortcuts</Text>
				<Text color="gray">label &lt;text&gt; · kind &lt;kind&gt; · base-url &lt;url&gt;</Text>
				{supportsNonSecretHeaders(draft.kind) && (
					<Text color="gray">
						header-key &lt;n&gt; &lt;key&gt; · header-value &lt;n&gt; &lt;value&gt; · remove-header
						&lt;n&gt;
					</Text>
				)}
			</Box>
		</Box>
	);
}

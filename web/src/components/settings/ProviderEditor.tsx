import { useEffect, useState } from "react";
import type {
	ProviderConfig,
	ProviderKind,
	SettingsCommand,
	SettingsSnapshot,
} from "@kernel/types.ts";
import { HeadersEditor, type HeaderDraft } from "./HeadersEditor.tsx";
import styles from "./ProviderSettingsPanel.module.css";

const PROVIDER_KIND_OPTIONS: Array<{ value: ProviderKind; label: string }> = [
	{ value: "anthropic", label: "Anthropic" },
	{ value: "openai", label: "OpenAI" },
	{ value: "openai-compatible", label: "OpenAI-compatible" },
	{ value: "openrouter", label: "OpenRouter" },
	{ value: "gemini", label: "Gemini" },
];

export interface ProviderEditorProps {
	mode: "create" | "edit";
	provider?: ProviderConfig;
	status?: SettingsSnapshot["providers"][number];
	catalogEntry?: SettingsSnapshot["catalog"][number];
	message?: string | null;
	pendingMessage?: string | null;
	fieldErrors?: Record<string, string>;
	onCommand: (command: SettingsCommand) => void;
}

export interface ProviderDraft {
	kind: ProviderKind;
	label: string;
	baseUrl?: string;
	nonSecretHeaders: HeaderDraft[];
}

export function validateProviderDraftForSave(
	draft: ProviderDraft,
): Record<string, string> | undefined {
	const fieldErrors: Record<string, string> = {};
	if (!draft.label.trim()) {
		fieldErrors.label = "Label is required.";
	}
	if (supportsBaseUrl(draft.kind) && !draft.baseUrl?.trim()) {
		fieldErrors.baseUrl = "Base URL is required.";
	}
	return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
}

function supportsBaseUrl(kind: ProviderKind): boolean {
	return kind === "openai-compatible";
}

function supportsNonSecretHeaders(kind: ProviderKind): boolean {
	return kind !== "gemini";
}

function createProviderDraft(provider?: ProviderConfig): ProviderDraft {
	return {
		kind: provider?.kind ?? "anthropic",
		label: provider?.label ?? "",
		baseUrl: provider?.baseUrl ?? "",
		nonSecretHeaders: Object.entries(provider?.nonSecretHeaders ?? {}).map(([key, value]) => ({
			key,
			value,
		})),
	};
}

function normalizeHeaders(
	headers: HeaderDraft[] | Record<string, string> | undefined,
): Record<string, string> | undefined {
	const rows = Array.isArray(headers)
		? headers
		: Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
	const entries = rows
		.map((header) => [header.key.trim(), header.value.trim()] as const)
		.filter(([key, value]) => key.length > 0 || value.length > 0);
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries);
}

export function createProviderSaveCommand(
	mode: "create" | "edit",
	draft: ProviderDraft,
	providerId?: string,
): SettingsCommand {
	const trimmedLabel = draft.label.trim();
	const baseUrl = draft.baseUrl?.trim();
	const nonSecretHeaders = normalizeHeaders(draft.nonSecretHeaders);
	if (mode === "create") {
		return {
			kind: "create_provider",
			data: {
				kind: draft.kind,
				label: trimmedLabel,
				...(supportsBaseUrl(draft.kind) && baseUrl ? { baseUrl } : {}),
				...(supportsNonSecretHeaders(draft.kind) && nonSecretHeaders
					? { nonSecretHeaders }
					: {}),
			},
		};
	}
	if (!providerId) {
		throw new Error("providerId is required when updating a provider");
	}
	return {
		kind: "update_provider",
		data: {
			providerId,
			patch: {
				label: trimmedLabel,
				...(supportsBaseUrl(draft.kind) ? { baseUrl: baseUrl ?? "" } : {}),
				...(supportsNonSecretHeaders(draft.kind)
					? { nonSecretHeaders: nonSecretHeaders ?? {} }
					: {}),
			},
		},
	};
}

export function createSetProviderSecretCommand(
	providerId: string,
	secret: string,
): SettingsCommand {
	return {
		kind: "set_provider_secret",
		data: {
			providerId,
			secret: secret.trim(),
		},
	};
}

export function createDeleteProviderSecretCommand(providerId: string): SettingsCommand {
	return {
		kind: "delete_provider_secret",
		data: { providerId },
	};
}

export function createToggleProviderEnabledCommand(
	providerId: string,
	enabled: boolean,
): SettingsCommand {
	return {
		kind: "set_provider_enabled",
		data: { providerId, enabled },
	};
}

export function createTestProviderConnectionCommand(providerId: string): SettingsCommand {
	return {
		kind: "test_provider_connection",
		data: { providerId },
	};
}

export function createRefreshProviderModelsCommand(providerId: string): SettingsCommand {
	return {
		kind: "refresh_provider_models",
		data: { providerId },
	};
}

export function createDeleteProviderCommand(providerId: string): SettingsCommand {
	return {
		kind: "delete_provider",
		data: { providerId },
	};
}

export function describePendingProviderAction(
	command: SettingsCommand,
): { providerId: string; message: string } | undefined {
	switch (command.kind) {
		case "test_provider_connection":
			return {
				providerId: command.data.providerId,
				message: "Testing connection...",
			};
		case "refresh_provider_models":
			return {
				providerId: command.data.providerId,
				message: "Refreshing models...",
			};
		default:
			return undefined;
	}
}

export function ProviderEditor({
	mode,
	provider,
	status,
	catalogEntry,
	message,
	pendingMessage,
	fieldErrors,
	onCommand,
}: ProviderEditorProps) {
	const [draft, setDraft] = useState<ProviderDraft>(() => createProviderDraft(provider));
	const [secret, setSecret] = useState("");
	const [localFieldErrors, setLocalFieldErrors] = useState<Record<string, string>>();

	useEffect(() => {
		setDraft(createProviderDraft(provider));
		setSecret("");
		setLocalFieldErrors(undefined);
	}, [provider]);

	const handleSave = () => {
		const validationErrors = validateProviderDraftForSave(draft);
		if (validationErrors) {
			setLocalFieldErrors(validationErrors);
			return;
		}
		setLocalFieldErrors(undefined);
		onCommand(createProviderSaveCommand(mode, draft, provider?.id));
	};

	const mergedFieldErrors =
		fieldErrors || localFieldErrors
			? {
					...localFieldErrors,
					...fieldErrors,
				}
			: undefined;

	return (
		<div className={styles.section}>
			<div>
				<h2 className={styles.sectionTitle}>
					{mode === "create" ? "Create provider" : provider?.label ?? "Provider"}
				</h2>
				<p className={styles.sectionText}>
					{mode === "create"
						? "Add a provider instance with its own endpoint and credentials."
						: "Edit connection details, credentials, and cached model catalog state for this provider."}
				</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}
			{pendingMessage && <div className={styles.messageBanner}>{pendingMessage}</div>}

			<div className={styles.formGrid}>
				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="provider-kind">
						Provider kind
					</label>
					{mode === "create" ? (
						<select
							id="provider-kind"
							name="kind"
							className={styles.fieldSelect}
							value={draft.kind}
							onChange={(event) =>
								setDraft((current) => {
									const kind = event.target.value as ProviderKind;
									setLocalFieldErrors((errors) => {
										if (!errors?.baseUrl) return errors;
										if (supportsBaseUrl(kind)) return errors;
										const nextErrors = { ...errors };
										delete nextErrors.baseUrl;
										return Object.keys(nextErrors).length > 0 ? nextErrors : undefined;
									});
									return {
										...current,
										kind,
									};
								})
							}
						>
							{PROVIDER_KIND_OPTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					) : (
						<input
							className={styles.fieldInput}
							value={provider?.kind ?? ""}
							readOnly
						/>
					)}
				</div>

				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="provider-label">
						Label
					</label>
					<input
						id="provider-label"
						name="label"
						className={styles.fieldInput}
						value={draft.label}
						onChange={(event) =>
							setDraft((current) => {
								setLocalFieldErrors((errors) => {
									if (!errors?.label) return errors;
									const nextErrors = { ...errors };
									delete nextErrors.label;
									return Object.keys(nextErrors).length > 0 ? nextErrors : undefined;
								});
								return {
									...current,
									label: event.target.value,
								};
							})
						}
					/>
					{mergedFieldErrors?.label && (
						<div className={styles.fieldError}>{mergedFieldErrors.label}</div>
					)}
				</div>

				{supportsBaseUrl(draft.kind) && (
					<div className={styles.field}>
						<label className={styles.fieldLabel} htmlFor="provider-base-url">
							Base URL
						</label>
						<input
							id="provider-base-url"
							name="baseUrl"
							className={styles.fieldInput}
							value={draft.baseUrl ?? ""}
							onChange={(event) =>
								setDraft((current) => {
									setLocalFieldErrors((errors) => {
										if (!errors?.baseUrl) return errors;
										const nextErrors = { ...errors };
										delete nextErrors.baseUrl;
										return Object.keys(nextErrors).length > 0 ? nextErrors : undefined;
									});
									return {
										...current,
										baseUrl: event.target.value,
									};
								})
							}
						/>
						{mergedFieldErrors?.baseUrl && (
							<div className={styles.fieldError}>{mergedFieldErrors.baseUrl}</div>
						)}
					</div>
				)}
			</div>

			{supportsNonSecretHeaders(draft.kind) && (
				<HeadersEditor
					headers={draft.nonSecretHeaders}
					error={mergedFieldErrors?.nonSecretHeaders}
					onChange={(nonSecretHeaders) =>
						setDraft((current) => ({
							...current,
							nonSecretHeaders,
						}))
					}
				/>
			)}

			<div className={styles.actions}>
				<button
					type="button"
					className={styles.primaryButton}
					data-action="save-provider"
					onClick={handleSave}
				>
					Save provider
				</button>
				{mode === "edit" && provider && (
					<>
						<button
							type="button"
							className={styles.secondaryButton}
							data-action="toggle-provider-enabled"
							data-provider-id={provider.id}
							onClick={() =>
								onCommand(
									createToggleProviderEnabledCommand(
										provider.id,
										!provider.enabled,
									),
								)
							}
						>
							{provider.enabled ? "Disable provider" : "Enable provider"}
						</button>
						<button
							type="button"
							className={styles.secondaryButton}
							data-action="test-provider"
							data-provider-id={provider.id}
							disabled={Boolean(pendingMessage)}
							onClick={() => onCommand(createTestProviderConnectionCommand(provider.id))}
						>
							Test connection
						</button>
						<button
							type="button"
							className={styles.secondaryButton}
							data-action="refresh-provider-models"
							data-provider-id={provider.id}
							disabled={Boolean(pendingMessage)}
							onClick={() => onCommand(createRefreshProviderModelsCommand(provider.id))}
						>
							Refresh models
						</button>
						<button
							type="button"
							className={styles.dangerButton}
							data-action="delete-provider"
							data-provider-id={provider.id}
							onClick={() => onCommand(createDeleteProviderCommand(provider.id))}
						>
							Delete provider
						</button>
					</>
				)}
			</div>

			{mode === "edit" && provider && (
				<div className={styles.section}>
					<h3 className={styles.sectionTitle}>Secret</h3>
					<div className={styles.formGrid}>
						<div className={styles.field}>
							<label className={styles.fieldLabel} htmlFor="provider-secret">
								API key or token
							</label>
							<input
								id="provider-secret"
								name="secret"
								type="password"
								className={styles.fieldInput}
								value={secret}
								onChange={(event) => setSecret(event.target.value)}
								placeholder={status?.hasSecret ? "Secret already stored" : "Enter secret"}
							/>
							<span className={styles.hint}>
								{status?.hasSecret ? "A secret is already stored." : "No secret stored yet."}
							</span>
							{mergedFieldErrors?.secret && (
								<div className={styles.fieldError}>{mergedFieldErrors.secret}</div>
							)}
						</div>
					</div>
					<div className={styles.actions}>
						<button
							type="button"
							className={styles.secondaryButton}
							data-action="save-secret"
							data-provider-id={provider.id}
							onClick={() => {
								if (!secret.trim()) return;
								onCommand(createSetProviderSecretCommand(provider.id, secret));
								setSecret("");
							}}
						>
							Save secret
						</button>
						{status?.hasSecret && (
							<button
								type="button"
								className={styles.dangerButton}
								data-action="remove-secret"
								data-provider-id={provider.id}
								onClick={() => onCommand(createDeleteProviderSecretCommand(provider.id))}
							>
								Remove secret
							</button>
						)}
					</div>
				</div>
			)}

			{mode === "edit" && (
				<div className={styles.splitGrid}>
					<div className={styles.section}>
						<h3 className={styles.sectionTitle}>Health</h3>
						<div className={styles.statusList}>
							{status?.validationErrors.map((error) => (
								<div key={error} className={styles.errorBanner}>
									{error}
								</div>
							))}
							{status?.connectionError && (
								<div className={styles.errorBanner}>{status.connectionError}</div>
							)}
							{status?.catalogStatus === "stale" && status.catalogError && (
								<div className={styles.messageBanner}>{status.catalogError}</div>
							)}
							{!status?.validationErrors.length &&
								!status?.connectionError &&
								!(status?.catalogStatus === "stale" && status.catalogError) && (
									<div className={styles.emptyState}>
										No validation or connectivity warnings for this provider.
									</div>
								)}
						</div>
					</div>

					<div className={styles.section}>
						<h3 className={styles.sectionTitle}>Discovered models</h3>
						<div className={styles.modelList}>
							{(catalogEntry?.models.length ?? 0) === 0 ? (
								<div className={styles.emptyState}>No models discovered yet.</div>
							) : (
								catalogEntry?.models.map((model) => (
										<div key={model.id} className={styles.modelItem}>
											<div className={styles.itemMeta}>
												<span className={styles.itemTitle}>{model.label}</span>
												<span className={styles.itemSubtitle}>{model.id}</span>
											</div>
											<div className={styles.badges}>
												<span className={styles.badge}>{model.source}</span>
											</div>
										</div>
								))
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

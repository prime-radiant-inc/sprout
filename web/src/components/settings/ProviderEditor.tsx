import { useEffect, useState } from "react";
import type {
	ProviderConfig,
	ProviderKind,
	SettingsCommand,
	SettingsSnapshot,
} from "@kernel/types.ts";
import styles from "./ProviderSettingsPanel.module.css";

const PROVIDER_KIND_OPTIONS: Array<{ value: ProviderKind; label: string }> = [
	{ value: "anthropic", label: "Anthropic" },
	{ value: "openai", label: "OpenAI" },
	{ value: "openai-compatible", label: "OpenAI-compatible" },
	{ value: "openrouter", label: "OpenRouter" },
	{ value: "gemini", label: "Gemini" },
];

const DISCOVERY_OPTIONS: Array<{
	value: ProviderConfig["discoveryStrategy"];
	label: string;
}> = [
	{ value: "remote-only", label: "Remote only" },
	{ value: "manual-only", label: "Manual only" },
	{ value: "remote-with-manual", label: "Remote with manual fallback" },
];

export interface ProviderEditorProps {
	mode: "create" | "edit";
	provider?: ProviderConfig;
	status?: SettingsSnapshot["providers"][number];
	catalogEntry?: SettingsSnapshot["catalog"][number];
	message?: string | null;
	onCommand: (command: SettingsCommand) => void;
}

export interface ProviderDraft {
	kind: ProviderKind;
	label: string;
	baseUrl?: string;
	discoveryStrategy: ProviderConfig["discoveryStrategy"];
}

function supportsBaseUrl(kind: ProviderKind): boolean {
	return kind === "openai-compatible";
}

export function createProviderSaveCommand(
	mode: "create" | "edit",
	draft: ProviderDraft,
	providerId?: string,
): SettingsCommand {
	const trimmedLabel = draft.label.trim();
	const baseUrl = draft.baseUrl?.trim();
	if (mode === "create") {
		return {
			kind: "create_provider",
			data: {
				kind: draft.kind,
				label: trimmedLabel,
				discoveryStrategy: draft.discoveryStrategy,
				...(supportsBaseUrl(draft.kind) && baseUrl ? { baseUrl } : {}),
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
				discoveryStrategy: draft.discoveryStrategy,
				...(supportsBaseUrl(draft.kind) ? { baseUrl: baseUrl ?? "" } : {}),
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

export function ProviderEditor({
	mode,
	provider,
	status,
	catalogEntry,
	message,
	onCommand,
}: ProviderEditorProps) {
	const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? "anthropic");
	const [label, setLabel] = useState(provider?.label ?? "");
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
	const [discoveryStrategy, setDiscoveryStrategy] = useState<
		ProviderConfig["discoveryStrategy"]
	>(provider?.discoveryStrategy ?? "remote-with-manual");
	const [secret, setSecret] = useState("");

	useEffect(() => {
		setKind(provider?.kind ?? "anthropic");
		setLabel(provider?.label ?? "");
		setBaseUrl(provider?.baseUrl ?? "");
		setDiscoveryStrategy(provider?.discoveryStrategy ?? "remote-with-manual");
		setSecret("");
	}, [
		provider?.id,
		provider?.kind,
		provider?.label,
		provider?.baseUrl,
		provider?.discoveryStrategy,
	]);

	const handleSave = () => {
		const trimmedLabel = label.trim();
		if (!trimmedLabel) return;
		onCommand(
			createProviderSaveCommand(
				mode,
				{ kind, label: trimmedLabel, baseUrl, discoveryStrategy },
				provider?.id,
			),
		);
	};

	return (
		<div className={styles.section}>
			<div>
				<h2 className={styles.sectionTitle}>
					{mode === "create" ? "Create provider" : provider?.label ?? "Provider"}
				</h2>
				<p className={styles.sectionText}>
					{mode === "create"
						? "Add a provider instance with its own endpoint, discovery mode, and credentials."
						: "Edit connection details, credentials, and catalog state for this provider."}
				</p>
			</div>

			{message && <div className={styles.errorBanner}>{message}</div>}

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
							value={kind}
							onChange={(event) => setKind(event.target.value as ProviderKind)}
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
						value={label}
						onChange={(event) => setLabel(event.target.value)}
					/>
				</div>

				<div className={styles.field}>
					<label className={styles.fieldLabel} htmlFor="provider-discovery">
						Discovery strategy
					</label>
					<select
						id="provider-discovery"
						name="discoveryStrategy"
						className={styles.fieldSelect}
						value={discoveryStrategy}
						onChange={(event) =>
							setDiscoveryStrategy(
								event.target.value as ProviderConfig["discoveryStrategy"],
							)
						}
					>
						{DISCOVERY_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>

				{supportsBaseUrl(kind) && (
					<div className={styles.field}>
						<label className={styles.fieldLabel} htmlFor="provider-base-url">
							Base URL
						</label>
						<input
							id="provider-base-url"
							name="baseUrl"
							className={styles.fieldInput}
							value={baseUrl}
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					</div>
				)}
			</div>

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
							onClick={() => onCommand(createTestProviderConnectionCommand(provider.id))}
						>
							Test connection
						</button>
						<button
							type="button"
							className={styles.secondaryButton}
							data-action="refresh-provider-models"
							data-provider-id={provider.id}
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
											{model.tierHint && (
												<span className={styles.badge}>{model.tierHint}</span>
											)}
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

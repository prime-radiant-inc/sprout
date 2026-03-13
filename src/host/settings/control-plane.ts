import {
	createProviderSecretRef,
	type SecretBackendState,
	type SecretStorageBackend,
	type SecretStore,
} from "./secret-store.ts";
import type {
	ManualModelConfig,
	ModelRef,
	ProviderConfig,
	SproutSettings,
	Tier,
	TierModelDefaults,
} from "./types.ts";
import {
	providerRequiresSecret,
	validateProviderConfig,
	validateProviderRuntimeReadiness,
} from "./validation.ts";

export interface ProviderModel {
	id: string;
	label: string;
	source: "remote" | "manual";
}

export interface ProviderCatalogEntry {
	providerId: string;
	models: ProviderModel[];
	lastRefreshAt?: string;
}

export interface ProviderStatusSnapshot {
	providerId: string;
	hasSecret: boolean;
	validationErrors: string[];
	connectionStatus: "unknown" | "ok" | "error";
	connectionError?: string;
	catalogStatus: "never-loaded" | "current" | "stale" | "error";
	catalogError?: string;
}

export interface SettingsSnapshot {
	settings: SproutSettings;
	runtime: SettingsRuntimeSnapshot;
	providers: ProviderStatusSnapshot[];
	catalog: ProviderCatalogEntry[];
}

export interface SettingsRuntimeWarning {
	code: "secret_backend_unavailable" | "invalid_settings_recovered" | "secret_cleanup_failed";
	message: string;
}

export interface SettingsRuntimeSnapshot {
	secretBackend: SecretBackendState;
	warnings: SettingsRuntimeWarning[];
}

export interface SelectionContextSnapshot {
	settings: Pick<SproutSettings, "providers" | "defaults">;
	catalog: ProviderCatalogEntry[];
}

export type SettingsCommand =
	| { kind: "get_settings"; data: Record<string, never> }
	| {
			kind: "create_provider";
			data: {
				kind: ProviderConfig["kind"];
				label: string;
				baseUrl?: string;
				nonSecretHeaders?: Record<string, string>;
				discoveryStrategy: ProviderConfig["discoveryStrategy"];
				manualModels?: ManualModelConfig[];
			};
	  }
	| {
			kind: "update_provider";
			data: {
				providerId: string;
				patch: {
					label?: string;
					baseUrl?: string;
					nonSecretHeaders?: Record<string, string>;
					discoveryStrategy?: ProviderConfig["discoveryStrategy"];
					manualModels?: ManualModelConfig[];
				};
			};
	  }
	| { kind: "delete_provider"; data: { providerId: string } }
	| { kind: "set_provider_secret"; data: { providerId: string; secret: string } }
	| { kind: "delete_provider_secret"; data: { providerId: string } }
	| { kind: "set_provider_enabled"; data: { providerId: string; enabled: boolean } }
	| { kind: "test_provider_connection"; data: { providerId: string } }
	| { kind: "refresh_provider_models"; data: { providerId: string } }
	| { kind: "set_global_tier_default"; data: { tier: Tier; model?: ModelRef } }
	| { kind: "set_default_provider"; data: { providerId?: string } };

export type SettingsCommandResult =
	| { ok: true; snapshot: SettingsSnapshot }
	| { ok: false; code: string; message: string; fieldErrors?: Record<string, string> };

export interface SettingsStoreLike {
	save(settings: SproutSettings): Promise<void>;
}

interface StatusState {
	connectionStatus: "unknown" | "ok" | "error";
	connectionError?: string;
	catalogStatus: "never-loaded" | "current" | "stale" | "error";
	catalogError?: string;
}

export interface SettingsControlPlaneOptions {
	settingsStore: SettingsStoreLike;
	secretStore: SecretStore;
	secretBackend: SecretStorageBackend;
	secretBackendState?: SecretBackendState;
	initialSettings: SproutSettings;
	initialValidationErrors?: Record<string, string[]>;
	runtimeWarnings?: SettingsRuntimeWarning[];
	onSettingsUpdated?: (snapshot: SettingsSnapshot) => void | Promise<void>;
	checkConnection?: (provider: ProviderConfig, secret?: string) => Promise<void>;
	refreshModels?: (provider: ProviderConfig, secret?: string) => Promise<ProviderModel[]>;
	now?: () => string;
}

export class SettingsControlPlane {
	private settings: SproutSettings;
	private readonly settingsStore: SettingsStoreLike;
	private readonly secretStore: SecretStore;
	private readonly secretBackend: SecretStorageBackend;
	private readonly secretBackendState: SecretBackendState;
	private initialValidationErrors: Record<string, string[]>;
	private runtimeWarnings: SettingsRuntimeWarning[];
	private readonly onSettingsUpdated?: (snapshot: SettingsSnapshot) => void | Promise<void>;
	private readonly checkConnection?: (provider: ProviderConfig, secret?: string) => Promise<void>;
	private readonly refreshModels?: (
		provider: ProviderConfig,
		secret?: string,
	) => Promise<ProviderModel[]>;
	private readonly now: () => string;
	private readonly providerState = new Map<string, StatusState>();
	private readonly providerCatalog = new Map<string, ProviderCatalogEntry>();

	constructor(options: SettingsControlPlaneOptions) {
		this.settings = structuredClone(options.initialSettings);
		this.settingsStore = options.settingsStore;
		this.secretStore = options.secretStore;
		this.secretBackend = options.secretBackend;
		this.secretBackendState = structuredClone(
			options.secretBackendState ?? {
				backend: options.secretBackend,
				available: true,
			},
		);
		this.initialValidationErrors = structuredClone(options.initialValidationErrors ?? {});
		this.runtimeWarnings = structuredClone(options.runtimeWarnings ?? []);
		this.onSettingsUpdated = options.onSettingsUpdated;
		this.checkConnection = options.checkConnection;
		this.refreshModels = options.refreshModels;
		this.now = options.now ?? (() => new Date().toISOString());

		for (const provider of this.settings.providers) {
			this.providerState.set(provider.id, {
				connectionStatus: "unknown",
				catalogStatus: "never-loaded",
			});
		}
	}

	getSelectionContext(): SelectionContextSnapshot {
		return {
			settings: {
				providers: structuredClone(this.settings.providers),
				defaults: structuredClone(this.settings.defaults),
			},
			catalog: this.buildCatalogEntries(),
		};
	}

	async execute(command: SettingsCommand): Promise<SettingsCommandResult> {
		switch (command.kind) {
			case "get_settings":
				return this.ok(await this.buildSnapshot());
			case "create_provider":
				return this.createProvider(command.data);
			case "update_provider":
				return this.updateProvider(command.data.providerId, command.data.patch);
			case "delete_provider":
				return this.deleteProvider(command.data.providerId);
			case "set_provider_secret":
				return this.setProviderSecret(command.data.providerId, command.data.secret);
			case "delete_provider_secret":
				return this.deleteProviderSecret(command.data.providerId);
			case "set_provider_enabled":
				return this.setProviderEnabled(command.data.providerId, command.data.enabled);
			case "test_provider_connection":
				return this.testProviderConnection(command.data.providerId);
			case "refresh_provider_models":
				return this.refreshProviderModels(command.data.providerId);
			case "set_global_tier_default":
				return this.setGlobalTierDefault(command.data.tier, command.data.model);
			case "set_default_provider":
				return this.setDefaultProvider(command.data.providerId);
		}
	}

	private async createProvider(
		data: Extract<SettingsCommand, { kind: "create_provider" }>["data"],
	): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		const providerId = buildNextProviderId(next.providers, data.kind);
		const timestamp = this.now();
		const provider: ProviderConfig = {
			id: providerId,
			kind: data.kind,
			label: data.label,
			enabled: false,
			baseUrl: data.baseUrl,
			nonSecretHeaders: data.nonSecretHeaders,
			discoveryStrategy: data.discoveryStrategy,
			manualModels: data.manualModels,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const validation = validateProviderConfig(provider);
		if (validation.errors.length > 0) {
			return this.error("validation_failed", validation.errors.join("; "), validation.fieldErrors);
		}
		next.providers.push(provider);
		return this.persistSettings(next, [providerId], true);
	}

	private async updateProvider(
		providerId: string,
		patch: Extract<SettingsCommand, { kind: "update_provider" }>["data"]["patch"],
	): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		const provider = next.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);

		if (patch.label !== undefined) provider.label = patch.label;
		if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl;
		if (patch.nonSecretHeaders !== undefined) provider.nonSecretHeaders = patch.nonSecretHeaders;
		if (patch.discoveryStrategy !== undefined) provider.discoveryStrategy = patch.discoveryStrategy;
		if (patch.manualModels !== undefined) provider.manualModels = patch.manualModels;
		provider.updatedAt = this.now();
		const validation = validateProviderConfig(provider);
		if (validation.errors.length > 0) {
			return this.error("validation_failed", validation.errors.join("; "), validation.fieldErrors);
		}

		return this.persistSettings(next, [providerId], true);
	}

	private async deleteProvider(providerId: string): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		const providerIndex = next.providers.findIndex((provider) => provider.id === providerId);
		if (providerIndex === -1) return this.error("not_found", `Unknown provider: ${providerId}`);

		next.providers.splice(providerIndex, 1);
		if (next.defaults.defaultProviderId === providerId) {
			delete next.defaults.defaultProviderId;
		}
		next.defaults.tierDefaults = removeTierDefaultsForProvider(
			next.defaults.tierDefaults,
			providerId,
		);
		if (next.defaults.tierDefaults && Object.keys(next.defaults.tierDefaults).length === 0) {
			delete next.defaults.tierDefaults;
		}

		this.providerState.delete(providerId);
		this.providerCatalog.delete(providerId);
		delete this.initialValidationErrors[providerId];

		const persisted = await this.persistSettings(next, [], true);
		if (!persisted.ok) {
			return persisted;
		}

		try {
			await this.secretStore.deleteSecret(createProviderSecretRef(providerId, this.secretBackend));
		} catch (error) {
			this.addRuntimeWarning({
				code: "secret_cleanup_failed",
				message: `Deleted provider '${providerId}' from settings, but failed to remove its stored secret: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}

		return this.emitUpdatedSnapshot();
	}

	private async setProviderSecret(
		providerId: string,
		secret: string,
	): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);

		try {
			await this.secretStore.setSecret(
				createProviderSecretRef(providerId, this.secretBackend),
				secret,
			);
		} catch (error) {
			if (!this.secretBackendState.available) {
				return this.error(
					"secret_backend_unavailable",
					this.secretBackendState.message ?? "Secret storage backend is unavailable",
					{
						secret: this.secretBackendState.message ?? "Secret storage backend is unavailable",
					},
				);
			}
			return this.error(
				"secret_store_failed",
				error instanceof Error ? error.message : String(error),
			);
		}

		delete this.initialValidationErrors[providerId];
		this.markCatalogStale(providerId);
		return this.emitUpdatedSnapshot();
	}

	private async deleteProviderSecret(providerId: string): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);

		try {
			await this.secretStore.deleteSecret(createProviderSecretRef(providerId, this.secretBackend));
		} catch (error) {
			if (!this.secretBackendState.available) {
				return this.error(
					"secret_backend_unavailable",
					this.secretBackendState.message ?? "Secret storage backend is unavailable",
					{
						secret: this.secretBackendState.message ?? "Secret storage backend is unavailable",
					},
				);
			}
			return this.error(
				"secret_store_failed",
				error instanceof Error ? error.message : String(error),
			);
		}

		delete this.initialValidationErrors[providerId];
		this.markCatalogStale(providerId);
		return this.emitUpdatedSnapshot();
	}

	private async setProviderEnabled(
		providerId: string,
		enabled: boolean,
	): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		const provider = next.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);

		provider.enabled = enabled;
		provider.updatedAt = this.now();
		if (enabled) {
			const validation = await this.getValidationResult(provider);
			if (validation.errors.length > 0) {
				return this.error(
					"validation_failed",
					validation.errors.join("; "),
					validation.fieldErrors,
				);
			}
		} else {
			if (next.defaults.defaultProviderId === providerId) {
				delete next.defaults.defaultProviderId;
			}
			next.defaults.tierDefaults = removeTierDefaultsForProvider(
				next.defaults.tierDefaults,
				providerId,
			);
			if (next.defaults.tierDefaults && Object.keys(next.defaults.tierDefaults).length === 0) {
				delete next.defaults.tierDefaults;
			}
		}

		return this.persistSettings(next, [providerId], true);
	}

	private async testProviderConnection(providerId: string): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);
		const validation = await this.getValidationResult(provider);
		if (validation.errors.length > 0) {
			return this.error("validation_failed", validation.errors.join("; "), validation.fieldErrors);
		}

		const secret = await this.getProviderSecret(provider);
		const state = this.getOrCreateProviderState(providerId);
		try {
			await this.checkConnection?.(provider, secret);
			state.connectionStatus = "ok";
			delete state.connectionError;
		} catch (error) {
			state.connectionStatus = "error";
			state.connectionError = error instanceof Error ? error.message : String(error);
		}
		return this.emitUpdatedSnapshot();
	}

	private async setGlobalTierDefault(tier: Tier, model?: ModelRef): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		if (!model) {
			if (next.defaults.tierDefaults) {
				delete next.defaults.tierDefaults[tier];
				if (Object.keys(next.defaults.tierDefaults).length === 0) {
					delete next.defaults.tierDefaults;
				}
			}
			return this.persistSettings(next, [], true);
		}

		const validation = this.validateGlobalTierDefault(next, tier, model);
		if (validation) {
			return validation;
		}

		next.defaults.tierDefaults ??= {};
		next.defaults.tierDefaults[tier] = model;
		return this.persistSettings(next, [], true);
	}

	private async refreshProviderModels(providerId: string): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);
		const validation = await this.getValidationResult(provider);
		if (validation.errors.length > 0) {
			return this.error("validation_failed", validation.errors.join("; "), validation.fieldErrors);
		}

		const secret = await this.getProviderSecret(provider);
		const state = this.getOrCreateProviderState(providerId);
		try {
			const models = await this.loadProviderModels(provider, secret);
			this.providerCatalog.set(providerId, {
				providerId,
				models,
				lastRefreshAt: this.now(),
			});
			state.connectionStatus = "ok";
			delete state.connectionError;
			state.catalogStatus = "current";
			delete state.catalogError;
		} catch (error) {
			state.connectionStatus = "error";
			state.connectionError = error instanceof Error ? error.message : String(error);
			state.catalogStatus = "error";
			state.catalogError = state.connectionError;
		}
		return this.emitUpdatedSnapshot();
	}

	private async setDefaultProvider(providerId?: string): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		if (!providerId) {
			delete next.defaults.defaultProviderId;
			return this.persistSettings(next, [], true);
		}

		const provider = next.providers.find((candidate) => candidate.id === providerId);
		if (!provider) {
			return this.error("validation_failed", `Unknown provider: ${providerId}`);
		}
		if (!provider.enabled) {
			return this.error("validation_failed", `Default provider must be enabled: ${providerId}`);
		}

		next.defaults.defaultProviderId = providerId;
		return this.persistSettings(next, [], true);
	}

	private async persistSettings(
		nextSettings: SproutSettings,
		touchedProviderIds: string[],
		emitUpdate: boolean,
	): Promise<SettingsCommandResult> {
		try {
			await this.settingsStore.save(nextSettings);
		} catch (error) {
			return this.error("persist_failed", error instanceof Error ? error.message : String(error));
		}

		this.settings = nextSettings;
		for (const provider of nextSettings.providers) {
			this.getOrCreateProviderState(provider.id);
		}
		for (const providerId of touchedProviderIds) {
			delete this.initialValidationErrors[providerId];
			this.markCatalogStale(providerId);
		}
		for (const providerId of [...this.providerCatalog.keys()]) {
			if (!nextSettings.providers.some((provider) => provider.id === providerId)) {
				this.providerCatalog.delete(providerId);
				this.providerState.delete(providerId);
			}
		}

		if (!emitUpdate) return this.ok(await this.buildSnapshot());
		return this.emitUpdatedSnapshot();
	}

	private async emitUpdatedSnapshot(): Promise<SettingsCommandResult> {
		const snapshot = await this.buildSnapshot();
		await this.onSettingsUpdated?.(snapshot);
		return this.ok(snapshot);
	}

	private async buildSnapshot(): Promise<SettingsSnapshot> {
		const providers: ProviderStatusSnapshot[] = [];
		for (const provider of this.settings.providers) {
			const hasSecret = await this.providerHasSecret(provider);
			const validation = await this.getValidationResult(provider, hasSecret);
			const state = this.getOrCreateProviderState(provider.id);
			providers.push({
				providerId: provider.id,
				hasSecret,
				validationErrors: validation.errors,
				connectionStatus: state.connectionStatus,
				connectionError: state.connectionError,
				catalogStatus: state.catalogStatus,
				catalogError: state.catalogError,
			});
		}

		return {
			settings: structuredClone(this.settings),
			runtime: {
				secretBackend: structuredClone(this.secretBackendState),
				warnings: this.buildRuntimeWarnings(),
			},
			providers,
			catalog: this.buildCatalogEntries(),
		};
	}

	private buildCatalogEntries(): ProviderCatalogEntry[] {
		return this.settings.providers.map((provider) => {
			const entry = this.providerCatalog.get(provider.id);
			if (entry) return structuredClone(entry);
			if (provider.discoveryStrategy === "manual-only") {
				return {
					providerId: provider.id,
					models: normalizeManualModels(provider.manualModels),
				};
			}
			return {
				providerId: provider.id,
				models: [],
			};
		});
	}

	private async loadProviderModels(
		provider: ProviderConfig,
		secret?: string,
	): Promise<ProviderModel[]> {
		if (provider.discoveryStrategy === "manual-only") {
			return normalizeManualModels(provider.manualModels);
		}
		if (!this.refreshModels) {
			throw new Error(`No model refresh handler registered for provider kind: ${provider.kind}`);
		}
		const remoteModels = await this.refreshModels(provider, secret);
		if (provider.discoveryStrategy === "remote-with-manual") {
			return mergeProviderModels(remoteModels, normalizeManualModels(provider.manualModels));
		}
		return remoteModels;
	}

	private async providerHasSecret(provider: ProviderConfig): Promise<boolean> {
		if (!providerRequiresSecret(provider)) return false;
		return this.secretStore.hasSecret(createProviderSecretRef(provider.id, this.secretBackend));
	}

	private async getProviderSecret(provider: ProviderConfig): Promise<string | undefined> {
		if (!providerRequiresSecret(provider)) return undefined;
		return this.secretStore.getSecret(createProviderSecretRef(provider.id, this.secretBackend));
	}

	private async getValidationResult(
		provider: ProviderConfig,
		hasSecret?: boolean,
	): Promise<{ errors: string[]; fieldErrors: Record<string, string> }> {
		const resolvedHasSecret = hasSecret ?? (await this.providerHasSecret(provider));
		const validation = validateProviderRuntimeReadiness(provider, {
			hasSecret: resolvedHasSecret,
			secretBackendAvailable: this.secretBackendState.available,
		});
		return {
			errors: dedupe([...(this.initialValidationErrors[provider.id] ?? []), ...validation.errors]),
			fieldErrors: validation.fieldErrors,
		};
	}

	private validateGlobalTierDefault(
		settings: SproutSettings,
		tier: Tier,
		model: ModelRef,
	): SettingsCommandResult | undefined {
		const provider = settings.providers.find((candidate) => candidate.id === model.providerId);
		if (!provider) {
			return this.error(
				"validation_failed",
				`Unknown provider '${model.providerId}' for global '${tier}' model`,
				{ tierDefaults: `Unknown provider '${model.providerId}' for global '${tier}' model` },
			);
		}
		if (!provider.enabled) {
			return this.error(
				"validation_failed",
				`Provider '${model.providerId}' must be enabled before setting '${tier}'`,
				{ tierDefaults: `Provider '${model.providerId}' must be enabled before setting '${tier}'` },
			);
		}

		const availableModels =
			provider.discoveryStrategy === "manual-only"
				? normalizeManualModels(provider.manualModels)
				: (this.providerCatalog.get(provider.id)?.models ?? []);
		if (availableModels.length === 0) {
			return this.error("validation_failed", "Refresh models to configure tier defaults", {
				tierDefaults: "Refresh models to configure tier defaults",
			});
		}

		if (!availableModels.some((candidate) => candidate.id === model.modelId)) {
			return this.error(
				"validation_failed",
				`Unknown model '${model.modelId}' for provider '${model.providerId}'`,
				{
					tierDefaults: `Unknown model '${model.modelId}' for provider '${model.providerId}'`,
				},
			);
		}

		return undefined;
	}

	private buildRuntimeWarnings(): SettingsRuntimeWarning[] {
		const warnings = [...this.runtimeWarnings];
		if (!this.secretBackendState.available) {
			warnings.push({
				code: "secret_backend_unavailable",
				message: this.secretBackendState.message ?? "Secret storage backend is unavailable",
			});
		}
		return warnings.filter(
			(warning, index, all) =>
				all.findIndex(
					(candidate) => candidate.code === warning.code && candidate.message === warning.message,
				) === index,
		);
	}

	private addRuntimeWarning(warning: SettingsRuntimeWarning): void {
		this.runtimeWarnings = dedupeWarnings([...this.runtimeWarnings, warning]);
	}

	private getOrCreateProviderState(providerId: string): StatusState {
		const existing = this.providerState.get(providerId);
		if (existing) return existing;
		const state: StatusState = {
			connectionStatus: "unknown",
			catalogStatus: "never-loaded",
		};
		this.providerState.set(providerId, state);
		return state;
	}

	private markCatalogStale(providerId: string): void {
		const state = this.getOrCreateProviderState(providerId);
		if (state.catalogStatus === "current") {
			state.catalogStatus = "stale";
		}
	}

	private ok(snapshot: SettingsSnapshot): SettingsCommandResult {
		return { ok: true, snapshot };
	}

	private error(
		code: string,
		message: string,
		fieldErrors?: Record<string, string>,
	): SettingsCommandResult {
		return fieldErrors && Object.keys(fieldErrors).length > 0
			? { ok: false, code, message, fieldErrors }
			: { ok: false, code, message };
	}
}

function buildNextProviderId(providers: ProviderConfig[], kind: ProviderConfig["kind"]): string {
	const ids = new Set(providers.map((provider) => provider.id));
	if (!ids.has(kind)) return kind;
	let suffix = 2;
	while (ids.has(`${kind}-${suffix}`)) suffix += 1;
	return `${kind}-${suffix}`;
}

function mergeProviderModels(
	remoteModels: ProviderModel[],
	manualModels: ProviderModel[],
): ProviderModel[] {
	const merged = new Map<string, ProviderModel>();
	for (const model of remoteModels) {
		merged.set(model.id, model);
	}
	for (const model of manualModels) {
		if (!merged.has(model.id)) merged.set(model.id, model);
	}
	return [...merged.values()];
}

function normalizeManualModels(models: ManualModelConfig[] | undefined): ProviderModel[] {
	return (models ?? []).map((model) => ({
		id: model.id,
		label: model.label ?? model.id,
		source: "manual",
	}));
}

function removeTierDefaultsForProvider(
	tierDefaults: TierModelDefaults | undefined,
	providerId: string,
): TierModelDefaults | undefined {
	if (!tierDefaults) return undefined;
	const next: TierModelDefaults = {};
	for (const tier of ["best", "balanced", "fast"] as const) {
		const modelRef = tierDefaults[tier];
		if (!modelRef || modelRef.providerId === providerId) continue;
		next[tier] = modelRef;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

function dedupeWarnings(warnings: SettingsRuntimeWarning[]): SettingsRuntimeWarning[] {
	return warnings.filter(
		(warning, index, all) =>
			all.findIndex(
				(candidate) => candidate.code === warning.code && candidate.message === warning.message,
			) === index,
	);
}

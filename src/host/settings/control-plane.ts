import {
	createProviderSecretRef,
	type SecretStorageBackend,
	type SecretStore,
} from "./secret-store.ts";
import type {
	DefaultSelection,
	ManualModelConfig,
	ProviderConfig,
	SproutSettings,
	Tier,
} from "./types.ts";

export interface ProviderModel {
	id: string;
	label: string;
	tierHint?: Tier;
	rank?: number;
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
	providers: ProviderStatusSnapshot[];
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
	| { kind: "set_default_selection"; data: { selection: DefaultSelection } }
	| { kind: "set_provider_priority"; data: { providerIds: string[] } }
	| { kind: "set_tier_priority"; data: { tier: Tier; providerIds: string[] } };

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
	initialSettings: SproutSettings;
	initialValidationErrors?: Record<string, string[]>;
	onSettingsUpdated?: (snapshot: SettingsSnapshot) => void;
	checkConnection?: (provider: ProviderConfig, secret?: string) => Promise<void>;
	refreshModels?: (provider: ProviderConfig, secret?: string) => Promise<ProviderModel[]>;
	now?: () => string;
}

export class SettingsControlPlane {
	private settings: SproutSettings;
	private readonly settingsStore: SettingsStoreLike;
	private readonly secretStore: SecretStore;
	private readonly secretBackend: SecretStorageBackend;
	private readonly initialValidationErrors: Record<string, string[]>;
	private readonly onSettingsUpdated?: (snapshot: SettingsSnapshot) => void;
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
		this.initialValidationErrors = structuredClone(options.initialValidationErrors ?? {});
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
			case "set_default_selection":
				return this.setDefaultSelection(command.data.selection);
			case "set_provider_priority":
				return this.setProviderPriority(command.data.providerIds);
			case "set_tier_priority":
				return this.setTierPriority(command.data.tier, command.data.providerIds);
		}
	}

	private async createProvider(
		data: Extract<SettingsCommand, { kind: "create_provider" }>["data"],
	): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		const providerId = buildNextProviderId(next.providers, data.kind);
		const timestamp = this.now();
		next.providers.push({
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
		});
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

		return this.persistSettings(next, [providerId], true);
	}

	private async deleteProvider(providerId: string): Promise<SettingsCommandResult> {
		const next = structuredClone(this.settings);
		const providerIndex = next.providers.findIndex((provider) => provider.id === providerId);
		if (providerIndex === -1) return this.error("not_found", `Unknown provider: ${providerId}`);

		next.providers.splice(providerIndex, 1);
		next.routing.providerPriority = next.routing.providerPriority.filter((id) => id !== providerId);
		for (const tier of Object.keys(next.routing.tierOverrides) as Tier[]) {
			const filtered = next.routing.tierOverrides[tier]?.filter((id) => id !== providerId) ?? [];
			if (filtered.length === 0) {
				delete next.routing.tierOverrides[tier];
			} else {
				next.routing.tierOverrides[tier] = filtered;
			}
		}
		next.defaults.selection = clearSelectionForProvider(next.defaults.selection, providerId);

		try {
			await this.secretStore.deleteSecret(createProviderSecretRef(providerId, this.secretBackend));
		} catch {}

		this.providerState.delete(providerId);
		this.providerCatalog.delete(providerId);
		delete this.initialValidationErrors[providerId];

		return this.persistSettings(next, [], true);
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
			return this.error(
				"secret_store_failed",
				error instanceof Error ? error.message : String(error),
			);
		}

		this.markCatalogStale(providerId);
		return this.emitUpdatedSnapshot();
	}

	private async deleteProviderSecret(providerId: string): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);

		try {
			await this.secretStore.deleteSecret(createProviderSecretRef(providerId, this.secretBackend));
		} catch (error) {
			return this.error(
				"secret_store_failed",
				error instanceof Error ? error.message : String(error),
			);
		}

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
			const errors = await this.getValidationErrors(provider);
			if (errors.length > 0) {
				return this.error("validation_failed", errors.join("; "));
			}
			if (!next.routing.providerPriority.includes(providerId)) {
				next.routing.providerPriority.push(providerId);
			}
		} else {
			next.routing.providerPriority = next.routing.providerPriority.filter(
				(id) => id !== providerId,
			);
			for (const tier of Object.keys(next.routing.tierOverrides) as Tier[]) {
				const filtered = next.routing.tierOverrides[tier]?.filter((id) => id !== providerId) ?? [];
				if (filtered.length === 0) {
					delete next.routing.tierOverrides[tier];
				} else {
					next.routing.tierOverrides[tier] = filtered;
				}
			}
			next.defaults.selection = clearSelectionForProvider(next.defaults.selection, providerId);
		}

		return this.persistSettings(next, [providerId], true);
	}

	private async testProviderConnection(providerId: string): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);
		const validationErrors = await this.getValidationErrors(provider);
		if (validationErrors.length > 0) {
			return this.error("validation_failed", validationErrors.join("; "));
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

	private async refreshProviderModels(providerId: string): Promise<SettingsCommandResult> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return this.error("not_found", `Unknown provider: ${providerId}`);
		const validationErrors = await this.getValidationErrors(provider);
		if (validationErrors.length > 0) {
			return this.error("validation_failed", validationErrors.join("; "));
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

	private async setDefaultSelection(selection: DefaultSelection): Promise<SettingsCommandResult> {
		if (selection.kind === "model") {
			const provider = this.settings.providers.find(
				(candidate) => candidate.id === selection.model.providerId,
			);
			if (!provider) {
				return this.error("validation_failed", `Unknown provider: ${selection.model.providerId}`);
			}
		}

		const next = structuredClone(this.settings);
		next.defaults.selection = selection;
		return this.persistSettings(next, [], true);
	}

	private async setProviderPriority(providerIds: string[]): Promise<SettingsCommandResult> {
		const enabledProviderIds = this.settings.providers
			.filter((provider) => provider.enabled)
			.map((provider) => provider.id);
		if (!sameMembers(providerIds, enabledProviderIds)) {
			return this.error(
				"validation_failed",
				"Provider priority must contain every enabled provider exactly once",
			);
		}

		const next = structuredClone(this.settings);
		next.routing.providerPriority = [...providerIds];
		return this.persistSettings(next, [], true);
	}

	private async setTierPriority(tier: Tier, providerIds: string[]): Promise<SettingsCommandResult> {
		const enabledProviderIds = new Set(
			this.settings.providers.filter((provider) => provider.enabled).map((provider) => provider.id),
		);
		if (new Set(providerIds).size !== providerIds.length) {
			return this.error("validation_failed", "Tier priority cannot contain duplicates");
		}
		for (const providerId of providerIds) {
			if (!enabledProviderIds.has(providerId)) {
				return this.error(
					"validation_failed",
					`Tier priority provider must be enabled: ${providerId}`,
				);
			}
		}

		const next = structuredClone(this.settings);
		if (providerIds.length === 0) {
			delete next.routing.tierOverrides[tier];
		} else {
			next.routing.tierOverrides[tier] = [...providerIds];
		}
		return this.persistSettings(next, [], true);
	}

	private async persistSettings(
		nextSettings: SproutSettings,
		staleProviderIds: string[],
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
		for (const providerId of staleProviderIds) {
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
		this.onSettingsUpdated?.(snapshot);
		return this.ok(snapshot);
	}

	private async buildSnapshot(): Promise<SettingsSnapshot> {
		const providers: ProviderStatusSnapshot[] = [];
		for (const provider of this.settings.providers) {
			const hasSecret = await this.providerHasSecret(provider);
			const validationErrors = await this.getValidationErrors(provider, hasSecret);
			const state = this.getOrCreateProviderState(provider.id);
			providers.push({
				providerId: provider.id,
				hasSecret,
				validationErrors,
				connectionStatus: state.connectionStatus,
				connectionError: state.connectionError,
				catalogStatus: state.catalogStatus,
				catalogError: state.catalogError,
			});
		}

		const catalog = this.settings.providers.map((provider) => {
			const entry = this.providerCatalog.get(provider.id);
			if (entry) return entry;
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

		return {
			settings: structuredClone(this.settings),
			providers,
			catalog,
		};
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

	private async getValidationErrors(
		provider: ProviderConfig,
		hasSecret?: boolean,
	): Promise<string[]> {
		const resolvedHasSecret = hasSecret ?? (await this.providerHasSecret(provider));
		const errors = [...(this.initialValidationErrors[provider.id] ?? [])];
		if (provider.kind === "openai-compatible" && !provider.baseUrl?.trim()) {
			errors.push("Base URL is required for openai-compatible providers");
		}
		if (provider.kind !== "openai-compatible" && provider.baseUrl !== undefined) {
			errors.push("Base URL is only supported for openai-compatible providers");
		}
		if (
			provider.kind === "gemini" &&
			provider.nonSecretHeaders &&
			Object.keys(provider.nonSecretHeaders).length > 0
		) {
			errors.push("Gemini providers do not support custom non-secret headers");
		}
		if (providerRequiresSecret(provider) && !resolvedHasSecret) {
			errors.push("API key is required");
		}
		return dedupe(errors);
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

	private error(code: string, message: string): SettingsCommandResult {
		return { ok: false, code, message };
	}
}

function providerRequiresSecret(provider: ProviderConfig): boolean {
	return provider.kind !== "openai-compatible";
}

function buildNextProviderId(providers: ProviderConfig[], kind: ProviderConfig["kind"]): string {
	const ids = new Set(providers.map((provider) => provider.id));
	if (!ids.has(kind)) return kind;
	let suffix = 2;
	while (ids.has(`${kind}-${suffix}`)) suffix += 1;
	return `${kind}-${suffix}`;
}

function clearSelectionForProvider(
	selection: DefaultSelection,
	providerId: string,
): DefaultSelection {
	if (selection.kind !== "model") return selection;
	return selection.model.providerId === providerId ? { kind: "none" } : selection;
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
		tierHint: model.tierHint,
		rank: model.rank,
		source: "manual",
	}));
}

function sameMembers(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		left.every((id) => right.includes(id))
	);
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}

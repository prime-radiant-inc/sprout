import { join } from "node:path";
import { createResolverSettings, getAvailableModels } from "../agents/model-resolver.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { ResultMessage } from "../bus/types.ts";
import type { Genome } from "../genome/genome.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import { buildCatalogEntry, type ProviderCatalogEntry } from "../llm/model-catalog.ts";
import { ProviderRegistry, type ProviderRegistryEntry } from "../llm/provider-registry.ts";
import type { Message, ProviderAdapter } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { EventBus } from "./event-bus.ts";
import { SessionLogger } from "./logger.ts";
import { SessionController } from "./session-controller.ts";
import {
	defaultResolveSessionSelectionRequest,
	resolveSessionSelectionRequest,
	type SessionSelectionContext,
	type SessionSelectionSnapshot,
} from "./session-selection.ts";
import { SettingsControlPlane } from "./settings/control-plane.ts";
import { type EnvImportResult, importSettingsFromEnv } from "./settings/env-import.ts";
import {
	createSecretStoreRuntime,
	type SecretBackendState,
	type SecretStorageBackend,
	type SecretStore,
} from "./settings/secret-store.ts";
import { type SettingsLoadResult, SettingsStore } from "./settings/store.ts";
import type { SproutSettings } from "./settings/types.ts";

export type StderrLevel = "debug" | "info" | undefined;

export function resolveStderrLevel(opts: { logStderr?: boolean; debug?: boolean }): StderrLevel {
	if (!opts.logStderr) return undefined;
	return opts.debug ? "debug" : "info";
}

export interface SessionBootstrapOptions {
	genomePath: string;
	projectDataDir: string;
	rootDir: string;
	sessionId: string;
	atifPath?: string;
	evalMode?: boolean;
	nonInteractive?: boolean;
	initialHistory?: Message[];
	initialSelectionRequest?: SessionSelectionRequest;
	completedHandles?: Array<{ handleId: string; result: ResultMessage; ownerId: string }>;
	infra: { spawner: AgentSpawner; genome: Genome };
	logStderr?: boolean;
	debug?: boolean;
}

interface InteractiveBootstrapDeps {
	createBus: () => unknown;
	createSettingsStore: () => {
		load(): Promise<SettingsLoadResult>;
		save(settings: SettingsLoadResult["settings"]): Promise<void>;
	};
	createSecretStore: () => {
		secretRefBackend: SecretStorageBackend;
		secretBackendState: SecretBackendState;
		secretStore: SecretStore;
	};
	importSettingsFromEnv: (options: {
		secretStore: SecretStore;
		secretBackend: SecretStorageBackend;
	}) => Promise<EnvImportResult>;
	createProviderRegistry: (options: {
		settings: SproutSettings;
		secretStore: SecretStore;
		secretBackend: SecretStorageBackend;
		secretBackendState: SecretBackendState;
	}) => {
		getEntries(): Promise<ProviderRegistryEntry[]>;
		getEntry(providerId: string): Promise<ProviderRegistryEntry | undefined>;
	};
	createLogger: (opts: {
		logPath: string;
		component: string;
		sessionId: string;
		bus: unknown;
		stderrLevel?: "debug" | "info";
	}) => unknown;
	createClient: (options: {
		logger: unknown;
		providers: Record<string, ProviderAdapter>;
	}) => Promise<unknown>;
	createSettingsControlPlane: (
		options: ConstructorParameters<typeof SettingsControlPlane>[0],
	) => unknown;
	createController: (opts: {
		bus: unknown;
		genomePath: string;
		projectDataDir: string;
		rootDir: string;
		sessionId: string;
		evalMode?: boolean;
		nonInteractive?: boolean;
		initialHistory?: Message[];
		initialSelection?: SessionSelectionSnapshot;
		resolveSelection?: (selection: SessionSelectionRequest) => SessionSelectionSnapshot;
		getResolverSettings?: () => ReturnType<typeof createResolverSettings>;
		spawner: AgentSpawner;
		genome: Genome;
		completedHandles?: Array<{ handleId: string; result: ResultMessage; ownerId: string }>;
		logger: unknown;
		client: unknown;
	}) => unknown;
	loadAvailableModels: (catalog: ProviderCatalogEntry[]) => Promise<string[]>;
	onLoggingEnabled: (logger: unknown, level: "debug" | "info", sessionId: string) => void;
}

export async function bootstrapSessionRuntime(
	opts: SessionBootstrapOptions,
	deps: Partial<InteractiveBootstrapDeps> = {},
): Promise<{
	bus: unknown;
	logger: unknown;
	llmClient: unknown;
	settingsControlPlane: unknown;
	controller: unknown;
	availableModels: string[];
}> {
	const d: InteractiveBootstrapDeps = {
		createBus: deps.createBus ?? (() => new EventBus()),
		createSettingsStore: deps.createSettingsStore ?? (() => new SettingsStore()),
		createSecretStore:
			deps.createSecretStore ?? (() => createSecretStoreRuntime({ env: process.env })),
		importSettingsFromEnv:
			deps.importSettingsFromEnv ??
			(async ({ secretStore, secretBackend }) => {
				return importSettingsFromEnv({ secretStore, secretBackend });
			}),
		createProviderRegistry:
			deps.createProviderRegistry ??
			((options) => {
				return new ProviderRegistry(options);
			}),
		createLogger:
			deps.createLogger ??
			((loggerOpts) => {
				return new SessionLogger({
					logPath: loggerOpts.logPath,
					component: loggerOpts.component,
					sessionId: loggerOpts.sessionId,
					bus: loggerOpts.bus as EventBus,
					stderrLevel: loggerOpts.stderrLevel,
				});
			}),
		createClient:
			deps.createClient ??
			(async ({ logger, providers }) => {
				return Client.fromProviders(providers, {
					middleware: [loggingMiddleware(logger as SessionLogger)],
				});
			}),
		createSettingsControlPlane:
			deps.createSettingsControlPlane ??
			((options) => {
				return new SettingsControlPlane(options);
			}),
		createController:
			deps.createController ??
			((controllerOpts) => {
				return new SessionController({
					bus: controllerOpts.bus as EventBus,
					genomePath: controllerOpts.genomePath,
					projectDataDir: controllerOpts.projectDataDir,
					rootDir: controllerOpts.rootDir,
					sessionId: controllerOpts.sessionId,
					evalMode: controllerOpts.evalMode,
					nonInteractive: controllerOpts.nonInteractive,
					initialHistory: controllerOpts.initialHistory,
					initialSelection: controllerOpts.initialSelection,
					resolveSelection: controllerOpts.resolveSelection,
					getResolverSettings: controllerOpts.getResolverSettings,
					spawner: controllerOpts.spawner,
					genome: controllerOpts.genome,
					completedHandles: controllerOpts.completedHandles,
					logger: controllerOpts.logger as SessionLogger,
					client: controllerOpts.client as Client,
				});
			}),
		loadAvailableModels:
			deps.loadAvailableModels ??
			(async (catalog) => {
				return getAvailableModels(catalog);
			}),
		onLoggingEnabled:
			deps.onLoggingEnabled ??
			((logger, level, sessionId) => {
				(logger as SessionLogger).info("session", "Logging to stderr enabled", {
					level,
					sessionId,
				});
			}),
	};

	const bus = d.createBus();
	const logPath = join(opts.projectDataDir, "logs", opts.sessionId, "session.log.jsonl");
	const stderrLevel = resolveStderrLevel({
		logStderr: opts.logStderr,
		debug: opts.debug,
	});
	const logger = d.createLogger({
		logPath,
		component: "cli",
		sessionId: opts.sessionId,
		bus,
		stderrLevel,
	});
	if (stderrLevel) {
		d.onLoggingEnabled(logger, stderrLevel, opts.sessionId);
	}

	const settingsStore = d.createSettingsStore();
	const settingsLoadResult = await settingsStore.load();
	const { secretRefBackend, secretBackendState, secretStore } = d.createSecretStore();
	const runtimeWarnings = buildBootstrapRuntimeWarnings(settingsLoadResult);
	let settings = settingsLoadResult.settings;
	let initialValidationErrors: Record<string, string[]> = {};
	const registryOptions = {
		secretStore,
		secretBackend: secretRefBackend,
		secretBackendState,
	};
	if (settingsLoadResult.source === "missing") {
		const imported = await d.importSettingsFromEnv({
			secretStore,
			secretBackend: secretRefBackend,
		});
		const importedHasSettings =
			imported.settings.providers.length > 0 ||
			imported.settings.defaults.best !== undefined ||
			imported.settings.defaults.balanced !== undefined ||
			imported.settings.defaults.fast !== undefined;
		if (importedHasSettings) {
			settings = imported.settings;
			initialValidationErrors = imported.validationErrorsByProvider;
			if (secretRefBackend !== "memory" && imported.settings.providers.length > 0) {
				await settingsStore.save(imported.settings);
			}
		}
	}

	let registry = d.createProviderRegistry({
		settings,
		...registryOptions,
	});
	const startupState = await loadStartupProvidersAndCatalog(registry);
	const llmClient = await d.createClient({ logger, providers: startupState.providers });
	const availableModels = await d.loadAvailableModels(startupState.catalog);
	const settingsControlPlane = d.createSettingsControlPlane({
		settingsStore,
		secretStore,
		secretBackend: secretRefBackend,
		secretBackendState,
		initialSettings: settings,
		runtimeWarnings,
		initialValidationErrors: {
			...initialValidationErrors,
			...startupState.validationErrorsByProvider,
		},
		checkConnection: createRuntimeConnectionChecker(() => registry),
		refreshModels: createRuntimeModelRefresher(() => registry),
		onSettingsUpdated: async (snapshot) => {
			registry = d.createProviderRegistry({
				settings: snapshot.settings,
				...registryOptions,
			});
			const updatedProviders = await loadRuntimeProviders(registry);
			replaceRuntimeClientProviders(llmClient, updatedProviders);
			replaceArrayContents(availableModels, await d.loadAvailableModels(snapshot.catalog));
		},
	});
	const resolveSelection = createSelectionResolver(
		settingsControlPlane as { getSelectionContext?: () => SessionSelectionContext },
	);
	const initialSelection = opts.initialSelectionRequest
		? resolveSelection(opts.initialSelectionRequest)
		: undefined;
	const controller = d.createController({
		bus,
		genomePath: opts.genomePath,
		projectDataDir: opts.projectDataDir,
		rootDir: opts.rootDir,
		sessionId: opts.sessionId,
		evalMode: opts.evalMode,
		nonInteractive: opts.nonInteractive,
		initialHistory: opts.initialHistory,
		initialSelection,
		resolveSelection,
		getResolverSettings: () => {
			const context = (
				settingsControlPlane as { getSelectionContext?: () => SessionSelectionContext }
			).getSelectionContext?.();
			if (!context) {
				return createResolverSettings([]);
			}
			return createResolverSettings(context.settings.providers, context.settings.defaults);
		},
		spawner: opts.infra.spawner,
		genome: opts.infra.genome,
		completedHandles: opts.completedHandles,
		logger,
		client: llmClient,
	});
	return { bus, logger, llmClient, settingsControlPlane, controller, availableModels };
}

function buildBootstrapRuntimeWarnings(
	settingsLoadResult: SettingsLoadResult,
): ConstructorParameters<typeof SettingsControlPlane>[0]["runtimeWarnings"] {
	const warnings: NonNullable<
		ConstructorParameters<typeof SettingsControlPlane>[0]["runtimeWarnings"]
	> = [];
	if (settingsLoadResult.recoveredInvalidFilePath) {
		warnings.push({
			code: "invalid_settings_recovered",
			message: `Recovered invalid settings file to ${settingsLoadResult.recoveredInvalidFilePath}`,
		});
	}
	return warnings;
}

function createSelectionResolver(controlPlane: {
	getSelectionContext?: () => SessionSelectionContext;
}): (selection: SessionSelectionRequest) => SessionSelectionSnapshot {
	if (!controlPlane.getSelectionContext) {
		return defaultResolveSessionSelectionRequest;
	}
	return (selection) =>
		resolveSessionSelectionRequest(selection, controlPlane.getSelectionContext!());
}

async function loadStartupProvidersAndCatalog(registry: {
	getEntries(): Promise<ProviderRegistryEntry[]>;
}): Promise<{
	providers: Record<string, ProviderAdapter>;
	catalog: ProviderCatalogEntry[];
	validationErrorsByProvider: Record<string, string[]>;
}> {
	const providers: Record<string, ProviderAdapter> = {};
	const catalog: ProviderCatalogEntry[] = [];
	const validationErrorsByProvider: Record<string, string[]> = {};

	for (const entry of await registry.getEntries()) {
		if (entry.validationErrors.length > 0) {
			validationErrorsByProvider[entry.provider.id] = entry.validationErrors;
		}
		if (entry.adapter && entry.provider.enabled) {
			providers[entry.provider.id] = entry.adapter;
		}
		if (!entry.adapter || entry.validationErrors.length > 0 || !entry.provider.enabled) {
			catalog.push(
				buildCatalogEntry(entry.provider, {
					validationErrors: entry.validationErrors,
				}),
			);
			continue;
		}
		try {
			catalog.push(
				buildCatalogEntry(entry.provider, {
					remoteModels: await entry.adapter.listModels(),
					lastRefreshAt: new Date().toISOString(),
				}),
			);
		} catch (error) {
			catalog.push(
				buildCatalogEntry(entry.provider, {
					validationErrors: [error instanceof Error ? error.message : String(error)],
				}),
			);
		}
	}

	return { providers, catalog, validationErrorsByProvider };
}

function createRuntimeConnectionChecker(
	getRegistry: () => {
		getEntry(providerId: string): Promise<ProviderRegistryEntry | undefined>;
	},
) {
	return async (provider: ProviderRegistryEntry["provider"]) => {
		const entry = await getRegistry().getEntry(provider.id);
		if (!entry?.adapter) {
			throw new Error(entry?.validationErrors[0] ?? `Unknown provider: ${provider.id}`);
		}
		const result = await entry.adapter.checkConnection();
		if (!result.ok) {
			throw new Error(result.message);
		}
	};
}

function createRuntimeModelRefresher(
	getRegistry: () => {
		getEntry(providerId: string): Promise<ProviderRegistryEntry | undefined>;
	},
) {
	return async (provider: ProviderRegistryEntry["provider"]) => {
		const entry = await getRegistry().getEntry(provider.id);
		if (!entry?.adapter) {
			throw new Error(entry?.validationErrors[0] ?? `Unknown provider: ${provider.id}`);
		}
		return entry.adapter.listModels();
	};
}

async function loadRuntimeProviders(registry: {
	getEntries(): Promise<ProviderRegistryEntry[]>;
}): Promise<Record<string, ProviderAdapter>> {
	const providers: Record<string, ProviderAdapter> = {};
	for (const entry of await registry.getEntries()) {
		if (!entry.adapter || !entry.provider.enabled || entry.validationErrors.length > 0) continue;
		providers[entry.provider.id] = entry.adapter;
	}
	return providers;
}

function replaceRuntimeClientProviders(
	client: unknown,
	providers: Record<string, ProviderAdapter>,
): void {
	if (
		client &&
		typeof client === "object" &&
		"replaceProviders" in client &&
		typeof client.replaceProviders === "function"
	) {
		client.replaceProviders(providers);
	}
}

function replaceArrayContents(target: string[], next: string[]): void {
	target.splice(0, target.length, ...next);
}

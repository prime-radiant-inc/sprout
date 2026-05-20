import { Buffer } from "node:buffer";
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
import { type CallbackListener, listenForCallback } from "./openai-codex-oauth/callback-server.ts";
import { buildAuthorizeUrl } from "./openai-codex-oauth/config.ts";
import { generatePkce, type PkcePair } from "./openai-codex-oauth/pkce.ts";
import {
	type CredentialDeleteResult,
	type LoginWithCodeInput,
	OpenAICodexOAuthService,
	type OpenAICodexRuntimeCredentials,
} from "./openai-codex-oauth/service.ts";
import { SessionController } from "./session-controller.ts";
import type { SessionMemorySurfaceSnapshot } from "./session-metadata.ts";
import {
	defaultResolveSessionSelectionRequest,
	resolveSessionSelectionRequest,
	type SessionSelectionContext,
	type SessionSelectionSnapshot,
} from "./session-selection.ts";
import { buildAgentModelCatalog } from "./settings/agent-model-catalog.ts";
import type { ProviderOAuthOperations } from "./settings/control-plane.ts";
import { SettingsControlPlane } from "./settings/control-plane.ts";
import { type EnvImportResult, importSettingsFromEnv } from "./settings/env-import.ts";
import {
	type ModelConfigOverrides,
	parseModelConfigOverrides,
	validateModelConfigOverrides,
} from "./settings/model-overrides.ts";
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
	workDir?: string;
	atifPath?: string;
	evalMode?: boolean;
	nonInteractive?: boolean;
	initialHistory?: Message[];
	initialMemorySurface?: SessionMemorySurfaceSnapshot;
	initialSelectionRequest?: SessionSelectionRequest;
	completedHandles?: Array<{
		handleId: string;
		result: ResultMessage;
		ownerId: string;
		agentName: string;
		agentId?: string;
	}>;
	infra: {
		spawner: AgentSpawner;
		genome: Genome;
		genomeService?: {
			updateRuntimeClient(
				client: Client,
				resolverSettings: ReturnType<typeof createResolverSettings>,
			): void;
		};
	};
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
	parseModelConfigOverrides: () => ModelConfigOverrides;
	createProviderRegistry: (options: {
		settings: SproutSettings;
		secretStore: SecretStore;
		secretBackend: SecretStorageBackend;
		secretBackendState: SecretBackendState;
		openAICodexCredentialResolver?: (providerId: string) => Promise<OpenAICodexRuntimeCredentials>;
	}) => {
		getEntries(): Promise<ProviderRegistryEntry[]>;
		getEntry(providerId: string): Promise<ProviderRegistryEntry | undefined>;
	};
	createOpenAICodexOAuthService: (options: {
		secretStore: SecretStore;
		secretBackend: SecretStorageBackend;
	}) => OpenAICodexOAuthRuntimeService;
	generateOpenAICodexPkce: () => Promise<PkcePair>;
	generateOpenAICodexOAuthState: () => string;
	listenForOpenAICodexOAuthCallback: (options: {
		expectedState: string;
		appReturnUrl?: string;
		onSuccessfulCallback?: (code: string) => Promise<void>;
	}) => Promise<CallbackListener>;
	openExternalUrl: (url: string) => Promise<void>;
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
		workDir?: string;
		evalMode?: boolean;
		nonInteractive?: boolean;
		initialHistory?: Message[];
		initialMemorySurface?: SessionMemorySurfaceSnapshot;
		initialSelection?: SessionSelectionSnapshot;
		resolveSelection?: (selection: SessionSelectionRequest) => SessionSelectionSnapshot;
		getResolverSettings?: () => ReturnType<typeof createResolverSettings>;
		spawner: AgentSpawner;
		genome: Genome;
		completedHandles?: Array<{
			handleId: string;
			result: ResultMessage;
			ownerId: string;
			agentName: string;
			agentId?: string;
		}>;
		logger: unknown;
		client: unknown;
	}) => unknown;
	loadAvailableModels: (catalog: ProviderCatalogEntry[]) => Promise<string[]>;
	onLoggingEnabled: (logger: unknown, level: "debug" | "info", sessionId: string) => void;
}

interface OpenAICodexOAuthRuntimeService {
	resolveCredentials(providerId: string): Promise<OpenAICodexRuntimeCredentials>;
	loginWithCode(input: LoginWithCodeInput): Promise<void>;
	logout(providerId: string): Promise<void>;
	deleteCredentials(providerId: string): Promise<CredentialDeleteResult>;
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
	setOpenAICodexOAuthReturnUrl: (url?: string) => void;
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
		parseModelConfigOverrides:
			deps.parseModelConfigOverrides ?? (() => parseModelConfigOverrides()),
		createProviderRegistry:
			deps.createProviderRegistry ??
			((options) => {
				return new ProviderRegistry(options);
			}),
		createOpenAICodexOAuthService:
			deps.createOpenAICodexOAuthService ??
			((options) => {
				return new OpenAICodexOAuthService(options);
			}),
		generateOpenAICodexPkce: deps.generateOpenAICodexPkce ?? (() => generatePkce()),
		generateOpenAICodexOAuthState:
			deps.generateOpenAICodexOAuthState ?? (() => crypto.randomUUID()),
		listenForOpenAICodexOAuthCallback:
			deps.listenForOpenAICodexOAuthCallback ??
			((options) => {
				return listenForCallback(options);
			}),
		openExternalUrl: deps.openExternalUrl ?? openExternalUrl,
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
					workDir: controllerOpts.workDir,
					sessionId: controllerOpts.sessionId,
					evalMode: controllerOpts.evalMode,
					nonInteractive: controllerOpts.nonInteractive,
					initialHistory: controllerOpts.initialHistory,
					initialMemorySurface: controllerOpts.initialMemorySurface,
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
	const openAICodexOAuthService = d.createOpenAICodexOAuthService({
		secretStore,
		secretBackend: secretRefBackend,
	});
	let openAICodexOAuthReturnUrl: string | undefined;
	const runtimeWarnings = buildBootstrapRuntimeWarnings(settingsLoadResult);
	let settings = settingsLoadResult.settings;
	let initialValidationErrors: Record<string, string[]> = {};
	const registryOptions = {
		secretStore,
		secretBackend: secretRefBackend,
		secretBackendState,
		openAICodexCredentialResolver: (providerId: string) =>
			openAICodexOAuthService.resolveCredentials(providerId),
	};
	if (settingsLoadResult.source === "missing") {
		const imported = await d.importSettingsFromEnv({
			secretStore,
			secretBackend: secretRefBackend,
		});
		const importedHasSettings = imported.settings.providers.length > 0;
		if (importedHasSettings) {
			settings = imported.settings;
			initialValidationErrors = imported.validationErrorsByProvider;
			if (secretRefBackend !== "memory" && imported.settings.providers.length > 0) {
				await settingsStore.save(imported.settings);
			}
		}
	}

	const modelOverrides = d.parseModelConfigOverrides();
	const initialAgentModelCatalog = await buildAgentModelCatalog({
		rootDir: opts.rootDir,
		genome: opts.infra.genome,
	});
	validateModelConfigOverrides(modelOverrides, settings, {
		agentKeys: initialAgentModelCatalog.map((entry) => entry.key),
	});

	let registry = d.createProviderRegistry({
		settings,
		...registryOptions,
	});
	const startupState = await loadStartupProvidersAndCatalog(registry);
	const llmClient = await d.createClient({ logger, providers: startupState.providers });
	const availableModels = await d.loadAvailableModels(startupState.catalog);
	let settingsControlPlaneRef: { getSelectionContext?: () => SessionSelectionContext } | undefined;
	const getCurrentResolverSettings = () => {
		const context = settingsControlPlaneRef?.getSelectionContext?.();
		if (!context) return createResolverSettings([]);
		return createResolverSettings(
			context.settings.providers,
			context.settings.defaults,
			context.settings.memoryModels,
			context.settings.agentModelOverrides,
		);
	};
	const updateGenomeServiceRuntime = () => {
		opts.infra.genomeService?.updateRuntimeClient(
			llmClient as Client,
			getCurrentResolverSettings(),
		);
	};
	const settingsControlPlane = d.createSettingsControlPlane({
		settingsStore,
		secretStore,
		secretBackend: secretRefBackend,
		secretBackendState,
		initialSettings: settings,
		initialCatalog: startupState.catalog,
		modelOverrides,
		runtimeWarnings,
		initialValidationErrors: {
			...initialValidationErrors,
			...startupState.validationErrorsByProvider,
		},
		checkConnection: createRuntimeConnectionChecker(() => registry),
		refreshModels: createRuntimeModelRefresher(() => registry),
		oauthOperations: createOpenAICodexOAuthOperations(openAICodexOAuthService, {
			generatePkce: d.generateOpenAICodexPkce,
			generateState: d.generateOpenAICodexOAuthState,
			listenForCallback: d.listenForOpenAICodexOAuthCallback,
			openExternalUrl: d.openExternalUrl,
			getAppReturnUrl: () => openAICodexOAuthReturnUrl,
		}),
		loadAgentModelCatalog: () =>
			buildAgentModelCatalog({
				rootDir: opts.rootDir,
				genome: opts.infra.genome,
			}),
		onSettingsUpdated: async (snapshot) => {
			registry = d.createProviderRegistry({
				settings: snapshot.settings,
				...registryOptions,
			});
			const updatedProviders = await loadRuntimeProviders(registry);
			replaceRuntimeClientProviders(llmClient, updatedProviders);
			replaceArrayContents(availableModels, await d.loadAvailableModels(snapshot.catalog));
			updateGenomeServiceRuntime();
		},
	});
	settingsControlPlaneRef = settingsControlPlane as {
		getSelectionContext?: () => SessionSelectionContext;
	};
	updateGenomeServiceRuntime();
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
		workDir: opts.workDir,
		evalMode: opts.evalMode,
		nonInteractive: opts.nonInteractive,
		initialHistory: opts.initialHistory,
		initialMemorySurface: opts.initialMemorySurface,
		initialSelection,
		resolveSelection,
		getResolverSettings: getCurrentResolverSettings,
		spawner: opts.infra.spawner,
		genome: opts.infra.genome,
		completedHandles: opts.completedHandles,
		logger,
		client: llmClient,
	});
	return {
		bus,
		logger,
		llmClient,
		settingsControlPlane,
		controller,
		availableModels,
		setOpenAICodexOAuthReturnUrl: (url?: string) => {
			openAICodexOAuthReturnUrl = url;
		},
	};
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

function createOpenAICodexOAuthOperations(
	oauthService: OpenAICodexOAuthRuntimeService,
	deps: {
		generatePkce: () => Promise<PkcePair>;
		generateState: () => string;
		listenForCallback: (options: {
			expectedState: string;
			appReturnUrl?: string;
			onSuccessfulCallback?: (code: string) => Promise<void>;
		}) => Promise<CallbackListener>;
		openExternalUrl: (url: string) => Promise<void>;
		getAppReturnUrl?: () => string | undefined;
	},
): ProviderOAuthOperations {
	return {
		status: async (providerId) => {
			try {
				const credentials = await oauthService.resolveCredentials(providerId);
				return {
					kind: "oauth",
					signedIn: true,
					accountId: credentials.accountId,
					expiresAt: credentials.expiresAt,
				};
			} catch {
				return {
					kind: "oauth",
					signedIn: false,
				};
			}
		},
		login: async (providerId) => {
			const state = deps.generateState();
			const pkce = await deps.generatePkce();
			const appReturnUrl = deps.getAppReturnUrl?.();
			let callbackRedirectUri: string | undefined;
			const listener = await deps.listenForCallback({
				expectedState: state,
				...(appReturnUrl !== undefined ? { appReturnUrl } : {}),
				onSuccessfulCallback: async (code) => {
					if (callbackRedirectUri === undefined) {
						throw new Error("OpenAI Codex OAuth callback listener was not ready");
					}
					await oauthService.loginWithCode({
						providerId,
						code,
						codeVerifier: pkce.codeVerifier,
						redirectUri: callbackRedirectUri,
					});
				},
			});
			callbackRedirectUri = listener.redirectUri;
			try {
				const authorizeUrl = buildAuthorizeUrl({
					redirectUri: listener.redirectUri,
					state,
					codeChallenge: pkce.codeChallenge,
				});
				await deps.openExternalUrl(authorizeUrl.toString());
				const callback = await listener.result;
				if (!callback.ok) {
					throw new Error(callback.error);
				}
			} finally {
				listener.stop();
			}
		},
		logout: (providerId) => oauthService.logout(providerId),
		deleteCredentials: (providerId) => oauthService.deleteCredentials(providerId),
	};
}

async function openExternalUrl(url: string): Promise<void> {
	const command = buildOpenExternalUrlCommand(url, process.platform);
	const processHandle = Bun.spawn(command, {
		stdout: "ignore",
		stderr: "ignore",
	});
	const exitCode = await processHandle.exited;
	if (exitCode !== 0) {
		throw new Error("Failed to open OpenAI Codex OAuth authorization URL");
	}
}

export function buildOpenExternalUrlCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform === "darwin") {
		return ["open", url];
	}
	if (platform === "win32") {
		return [
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encodePowerShellCommand(`Start-Process -FilePath '${escapePowerShellString(url)}'`),
		];
	}
	return ["xdg-open", url];
}

function encodePowerShellCommand(command: string): string {
	return Buffer.from(command, "utf16le").toString("base64");
}

function escapePowerShellString(value: string): string {
	return value.replace(/'/gu, "''");
}

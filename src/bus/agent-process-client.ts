/**
 * LLM-client bootstrap for an agent subprocess: settings + secret store +
 * provider registry + Codex OAuth resolution → a middleware-wrapped Client.
 * Split from agent-process.ts (cycle-2 decomposition): zero bus coupling —
 * this is host/llm wiring the bus lifecycle merely consumes.
 */

import type { SessionLogger } from "../host/logger.ts";
import {
	OpenAICodexOAuthService,
	type OpenAICodexRuntimeCredentials,
} from "../host/openai-codex-oauth/service.ts";
import { importSettingsFromEnv } from "../host/settings/env-import.ts";
import {
	createSecretStoreRuntime,
	type SecretStoreRuntime,
} from "../host/settings/secret-store.ts";
import { type SettingsLoadResult, SettingsStore } from "../host/settings/store.ts";
import { Client } from "../llm/client.ts";
import { loggingMiddleware } from "../llm/logging-middleware.ts";
import { ProviderRegistry, type ProviderRegistryEntry } from "../llm/provider-registry.ts";
import type { ProviderAdapter } from "../llm/types.ts";

export interface AgentProcessClientDeps {
	createSettingsStore?: () => Pick<SettingsStore, "load">;
	createSecretStoreRuntime?: () => SecretStoreRuntime;
	importSettingsFromEnv?: typeof importSettingsFromEnv;
	createProviderRegistry?: (options: ConstructorParameters<typeof ProviderRegistry>[0]) => {
		getEntries(): Promise<ProviderRegistryEntry[]>;
	};
	createOpenAICodexOAuthService?: (options: {
		secretStore: SecretStoreRuntime["secretStore"];
		secretBackend: SecretStoreRuntime["secretRefBackend"];
	}) => {
		resolveCredentials(providerId: string): Promise<OpenAICodexRuntimeCredentials>;
	};
	createClient?: (options: {
		providers: Record<string, ProviderAdapter>;
		logger: SessionLogger;
	}) => Client;
}

export async function createAgentProcessClient(
	logger: SessionLogger,
	deps: AgentProcessClientDeps = {},
): Promise<Client> {
	const settingsStore = deps.createSettingsStore?.() ?? new SettingsStore();
	const settingsLoadResult = (await settingsStore.load()) as SettingsLoadResult;
	const secretStoreRuntime =
		deps.createSecretStoreRuntime?.() ?? createSecretStoreRuntime({ env: process.env });
	const openAICodexOAuthService =
		deps.createOpenAICodexOAuthService?.({
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
		}) ??
		new OpenAICodexOAuthService({
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
		});
	const importFromEnv = deps.importSettingsFromEnv ?? importSettingsFromEnv;
	let settings = settingsLoadResult.settings;
	if (settingsLoadResult.source === "missing") {
		const imported = await importFromEnv({
			env: process.env,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
		});
		if (imported.settings.providers.length > 0) {
			settings = imported.settings;
		}
	}
	const registry =
		deps.createProviderRegistry?.({
			settings,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
			secretBackendState: secretStoreRuntime.secretBackendState,
			openAICodexCredentialResolver: (providerId: string) =>
				openAICodexOAuthService.resolveCredentials(providerId),
		}) ??
		new ProviderRegistry({
			settings,
			secretStore: secretStoreRuntime.secretStore,
			secretBackend: secretStoreRuntime.secretRefBackend,
			secretBackendState: secretStoreRuntime.secretBackendState,
			openAICodexCredentialResolver: (providerId: string) =>
				openAICodexOAuthService.resolveCredentials(providerId),
		});

	const providers: Record<string, ProviderAdapter> = {};
	for (const entry of await registry.getEntries()) {
		if (!entry.provider.enabled || entry.validationErrors.length > 0 || !entry.adapter) {
			continue;
		}
		providers[entry.provider.id] = entry.adapter;
	}

	return (
		deps.createClient?.({ providers, logger }) ??
		Client.fromProviders(providers, {
			middleware: [loggingMiddleware(logger)],
		})
	);
}

/**
 * Run an agent process that connects to the bus, waits for a start message,
 * runs the agent loop, publishes results, and handles continue messages.
 *
 * Lifecycle:
 * 1. Connect to bus, subscribe to inbox
 * 2. Wait for a start message
 * 3. Load genome, create Agent, run agent loop
 * 4. Publish result to the agent's result topic
 * 5. If shared: stay in idle, handle continue messages
 * 6. If not shared: disconnect and return
 * 7. On abort signal: disconnect and return at any point
 */

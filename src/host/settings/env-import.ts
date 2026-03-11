import {
	createProviderSecretRef,
	type SecretStorageBackend,
	type SecretStore,
} from "./secret-store.ts";
import {
	createEmptySettings,
	type ProviderConfig,
	type ProviderKind,
	type SproutSettings,
} from "./types.ts";

export interface EnvImportOptions {
	env?: Record<string, string | undefined>;
	secretStore: SecretStore;
	secretBackend: SecretStorageBackend;
	now?: () => string;
}

export interface EnvImportResult {
	settings: SproutSettings;
	validationErrorsByProvider: Record<string, string[]>;
}

interface EnvProviderSource {
	kind: ProviderKind;
	id: string;
	label: string;
	envKeys: string[];
}

const ENV_PROVIDER_SOURCES: EnvProviderSource[] = [
	{
		kind: "anthropic",
		id: "anthropic",
		label: "Anthropic",
		envKeys: ["ANTHROPIC_API_KEY"],
	},
	{
		kind: "openai",
		id: "openai",
		label: "OpenAI",
		envKeys: ["OPENAI_API_KEY"],
	},
	{
		kind: "gemini",
		id: "gemini",
		label: "Gemini",
		envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	},
];

export async function importSettingsFromEnv(options: EnvImportOptions): Promise<EnvImportResult> {
	const env = options.env ?? process.env;
	const now = options.now ?? (() => new Date().toISOString());
	const settings = createEmptySettings();
	const validationErrorsByProvider: Record<string, string[]> = {};

	for (const source of ENV_PROVIDER_SOURCES) {
		const secret = resolveEnvSecret(env, source.envKeys);
		if (!secret) continue;

		const provider = createImportedProviderConfig(source, now());
		try {
			await options.secretStore.setSecret(
				createProviderSecretRef(provider.id, options.secretBackend),
				secret,
			);
			settings.routing.providerPriority.push(provider.id);
		} catch (error) {
			provider.enabled = false;
			validationErrorsByProvider[provider.id] = [
				`Credential migration failed: ${error instanceof Error ? error.message : String(error)}`,
			];
		}
		settings.providers.push(provider);
	}

	return {
		settings,
		validationErrorsByProvider,
	};
}

function resolveEnvSecret(
	env: Record<string, string | undefined>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return undefined;
}

function createImportedProviderConfig(
	source: EnvProviderSource,
	timestamp: string,
): ProviderConfig {
	return {
		id: source.id,
		kind: source.kind,
		label: source.label,
		enabled: true,
		discoveryStrategy: "remote-only",
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

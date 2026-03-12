import {
	createProviderSecretRef,
	type SecretBackendState,
	type SecretStorageBackend,
	type SecretStore,
} from "../host/settings/secret-store.ts";
import type { ProviderConfig, SproutSettings } from "../host/settings/types.ts";
import {
	providerRequiresSecret,
	validateProviderRuntimeReadiness,
} from "../host/settings/validation.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenAIAdapter } from "./openai.ts";
import type { ProviderAdapter, ProviderModel, Request, Response, StreamEvent } from "./types.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;

export interface ProviderRegistryOptions {
	settings: SproutSettings;
	secretStore: SecretStore;
	secretBackend: SecretStorageBackend;
	secretBackendState?: SecretBackendState;
}

export interface ProviderRegistryEntry {
	provider: ProviderConfig;
	adapter?: ProviderAdapter;
	validationErrors: string[];
}

export class ProviderRegistry {
	private readonly settings: SproutSettings;
	private readonly secretStore: SecretStore;
	private readonly secretBackend: SecretStorageBackend;
	private readonly secretBackendState: SecretBackendState;
	private readonly cache = new Map<string, Promise<ProviderRegistryEntry>>();

	constructor(options: ProviderRegistryOptions) {
		this.settings = options.settings;
		this.secretStore = options.secretStore;
		this.secretBackend = options.secretBackend;
		this.secretBackendState = options.secretBackendState ?? {
			backend: options.secretBackend,
			available: true,
		};
	}

	async getEntry(providerId: string): Promise<ProviderRegistryEntry | undefined> {
		const provider = this.settings.providers.find((candidate) => candidate.id === providerId);
		if (!provider) return undefined;
		if (!this.cache.has(providerId)) {
			this.cache.set(providerId, this.buildEntry(provider));
		}
		return this.cache.get(providerId);
	}

	async getEntries(): Promise<ProviderRegistryEntry[]> {
		return Promise.all(
			this.settings.providers.map((provider) => this.getEntry(provider.id)),
		) as Promise<ProviderRegistryEntry[]>;
	}

	private async buildEntry(provider: ProviderConfig): Promise<ProviderRegistryEntry> {
		const validationErrors = await this.validateProvider(provider);
		if (validationErrors.length > 0) {
			return { provider, validationErrors };
		}

		const secret = await this.getProviderSecret(provider);
		return {
			provider,
			adapter: createProviderAdapter(provider, secret),
			validationErrors: [],
		};
	}

	private async validateProvider(provider: ProviderConfig): Promise<string[]> {
		const hasSecret = providerRequiresSecret(provider)
			? await this.secretStore.hasSecret(this.secretRef(provider.id))
			: false;
		return validateProviderRuntimeReadiness(provider, {
			hasSecret,
			secretBackendAvailable: this.secretBackendState.available,
		}).errors;
	}

	private async getProviderSecret(provider: ProviderConfig): Promise<string | undefined> {
		if (!providerRequiresSecret(provider)) return undefined;
		return this.secretStore.getSecret(this.secretRef(provider.id));
	}

	private secretRef(providerId: string) {
		return createProviderSecretRef(providerId, this.secretBackend);
	}
}

function createProviderAdapter(
	provider: ProviderConfig,
	secret: string | undefined,
): ProviderAdapter {
	switch (provider.kind) {
		case "anthropic":
			return new AnthropicAdapter(secret!, {
				providerId: provider.id,
				headers: provider.nonSecretHeaders,
			});
		case "openai":
			return new OpenAIAdapter(secret!, {
				providerId: provider.id,
				kind: "openai",
				headers: provider.nonSecretHeaders,
			});
		case "openai-compatible":
			return new OpenAIAdapter(secret ?? "unused-api-key", {
				providerId: provider.id,
				kind: "openai-compatible",
				baseUrl: provider.baseUrl,
				headers: provider.nonSecretHeaders,
			});
		case "openrouter":
			return new OpenRouterAdapter(provider, secret!);
		case "gemini":
			return new GeminiAdapter(secret!, {
				providerId: provider.id,
			});
	}
}

class OpenRouterAdapter implements ProviderAdapter {
	readonly name = "openrouter";
	readonly providerId: string;
	readonly kind = "openrouter" as const;
	private readonly delegate: OpenAIAdapter;
	private readonly headers: Record<string, string>;

	constructor(provider: ProviderConfig, apiKey: string) {
		this.providerId = provider.id;
		this.headers = {
			Authorization: `Bearer ${apiKey}`,
			...provider.nonSecretHeaders,
		};
		this.delegate = new OpenAIAdapter(apiKey, {
			providerId: provider.id,
			kind: "openrouter",
			baseUrl: OPENROUTER_BASE_URL,
			headers: provider.nonSecretHeaders,
		});
	}

	async complete(request: Request): Promise<Response> {
		return this.delegate.complete(request);
	}

	stream(request: Request): AsyncIterable<StreamEvent> {
		return this.delegate.stream(request);
	}

	async listModels(): Promise<ProviderModel[]> {
		const response = await fetch(OPENROUTER_MODELS_URL, {
			headers: this.headers,
		});
		if (!response.ok) {
			throw new Error(`OpenRouter models request failed: ${response.status}`);
		}
		const payload = (await response.json()) as { data?: Array<{ id: string }> };
		return (payload.data ?? []).map((model) => ({
			id: model.id,
			label: model.id,
			source: "remote",
		}));
	}

	async checkConnection(): Promise<{ ok: true } | { ok: false; message: string }> {
		try {
			await this.listModels();
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
}

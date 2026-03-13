import type { ProviderConfig } from "./types.ts";

export interface ProviderValidationResult {
	errors: string[];
	fieldErrors: Record<string, string>;
}

export interface ProviderRuntimeValidationOptions {
	hasSecret: boolean;
	secretBackendAvailable: boolean;
}

export function validateProviderConfig(provider: ProviderConfig): ProviderValidationResult {
	const errors: string[] = [];
	const fieldErrors: Record<string, string> = {};
	const legacyProvider = provider as ProviderConfig & {
		discoveryStrategy?: unknown;
		manualModels?: unknown;
	};

	if (!provider.label.trim()) {
		addFieldError(errors, fieldErrors, "label", "Label is required");
	}

	const baseUrl = provider.baseUrl?.trim();
	if (provider.kind === "openai-compatible") {
		if (!baseUrl) {
			addFieldError(
				errors,
				fieldErrors,
				"baseUrl",
				"Base URL is required for openai-compatible providers",
			);
		} else if (!isValidHttpUrl(baseUrl)) {
			addFieldError(errors, fieldErrors, "baseUrl", "Base URL must be a valid http or https URL");
		} else if (isOpenRouterBaseUrl(baseUrl)) {
			addFieldError(
				errors,
				fieldErrors,
				"baseUrl",
				"OpenRouter endpoints must use the OpenRouter provider kind",
			);
		}
	}
	if (provider.kind !== "openai-compatible" && provider.baseUrl !== undefined) {
		addFieldError(
			errors,
			fieldErrors,
			"baseUrl",
			"Base URL is only supported for openai-compatible providers",
		);
	}

	if (
		provider.kind === "gemini" &&
		provider.nonSecretHeaders &&
		Object.keys(provider.nonSecretHeaders).length > 0
	) {
		addFieldError(
			errors,
			fieldErrors,
			"nonSecretHeaders",
			"Gemini providers do not support custom non-secret headers",
		);
	}

	if ("discoveryStrategy" in legacyProvider) {
		addFieldError(
			errors,
			fieldErrors,
			"discoveryStrategy",
			"Discovery strategy is no longer supported",
		);
	}

	if ("manualModels" in legacyProvider) {
		addFieldError(
			errors,
			fieldErrors,
			"manualModels",
			"Manual model configuration is no longer supported",
		);
	}

	return {
		errors,
		fieldErrors,
	};
}

export function normalizeProviderConfig(provider: ProviderConfig): ProviderConfig {
	const normalizedKind =
		provider.kind === "openai-compatible" && provider.baseUrl?.trim()
			? isOpenRouterBaseUrl(provider.baseUrl.trim())
				? "openrouter"
				: "openai-compatible"
			: provider.kind;

	return {
		id: provider.id,
		kind: normalizedKind,
		label: provider.label,
		enabled: provider.enabled,
		...(normalizedKind === "openai-compatible" && provider.baseUrl?.trim()
			? { baseUrl: provider.baseUrl.trim() }
			: {}),
		...(provider.nonSecretHeaders ? { nonSecretHeaders: provider.nonSecretHeaders } : {}),
		createdAt: provider.createdAt,
		updatedAt: provider.updatedAt,
	};
}

export function validateProviderRuntimeReadiness(
	provider: ProviderConfig,
	options: ProviderRuntimeValidationOptions,
): ProviderValidationResult {
	const result = validateProviderConfig(provider);
	if (!providerRequiresSecret(provider)) {
		return result;
	}
	if (!options.secretBackendAvailable) {
		addFieldError(
			result.errors,
			result.fieldErrors,
			"secret",
			"Secret storage backend is unavailable",
		);
		return result;
	}
	if (!options.hasSecret) {
		addFieldError(result.errors, result.fieldErrors, "secret", "API key is required");
	}
	return result;
}

export function providerRequiresSecret(provider: ProviderConfig): boolean {
	return provider.kind !== "openai-compatible";
}

function addFieldError(
	errors: string[],
	fieldErrors: Record<string, string>,
	field: string,
	message: string,
): void {
	errors.push(message);
	fieldErrors[field] ??= message;
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isOpenRouterBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.host === "openrouter.ai" && /^\/api\/v1\/?$/.test(url.pathname);
	} catch {
		return false;
	}
}

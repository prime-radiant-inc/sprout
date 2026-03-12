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

	const manualModelIds = new Set<string>();
	for (const model of provider.manualModels ?? []) {
		const modelId = model.id.trim();
		if (!modelId) {
			addFieldError(errors, fieldErrors, "manualModels", "Manual models require a non-empty id");
			continue;
		}
		if (manualModelIds.has(modelId)) {
			addFieldError(errors, fieldErrors, "manualModels", "Manual models must use unique ids");
			continue;
		}
		manualModelIds.add(modelId);
	}

	return {
		errors,
		fieldErrors,
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

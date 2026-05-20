export function redactCredentialText(value: string): string {
	return value
		.replace(/Authorization:\s*Bearer\s+[^\s]+/gi, "Authorization: Bearer [redacted]")
		.replace(/([?&]code=)[^&\s]+/gi, "$1[redacted]")
		.replace(/([?&]state=)[^&\s]+/gi, "$1[redacted]")
		.replace(/\b(code|state)\s+[A-Za-z0-9._~-]{6,}\b/gi, "$1 [redacted]")
		.replace(/sprout\/providers\/[A-Za-z0-9._-]+\/(?:api-key|oauth)/g, "[redacted]")
		.replace(/\b(?:access|refresh|id)?_?token_[A-Za-z0-9._-]+\b/gi, "[redacted]")
		.replace(/\b(access_token|refresh_token|id_token|token)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "[redacted]");
}

export function redactCredentialText(value: string): string {
	return value
		.replace(/Authorization:\s*Bearer\s+[^\s]+/gi, "Authorization: Bearer [redacted]")
		.replace(/([?&]code=)[^&\s]+/gi, "$1[redacted]")
		.replace(/([?&]state=)[^&\s]+/gi, "$1[redacted]")
		.replace(/\b(code|state)(\s*[:=]\s*)[^\s&]+/gi, "$1$2[redacted]")
		.replace(
			/\b((?:oauth|pasteback|paste back)(?:\s+callback)?\s+(?:code|state))\s+[A-Za-z0-9._~-]{6,}\b/gi,
			"$1 [redacted]",
		)
		.replace(/\b(raw\s+(?:code|state))\s+[A-Za-z0-9._~-]{6,}\b/gi, "$1 [redacted]")
		.replace(/sprout\/providers\/[A-Za-z0-9._-]+\/(?:api-key|oauth)/g, "[redacted]")
		.replace(/\b(?:access|refresh|id)?_?token_[A-Za-z0-9._-]+\b/gi, "[redacted]")
		.replace(/\b(access_token|refresh_token|id_token|token)\s*[:=]\s*[^\s&]+/gi, "$1=[redacted]")
		.replace(
			/(["'])(accessToken|refreshToken|idToken)\1(\s*[:=]\s*)(["'])[^"']+\4/g,
			"$1$2$1$3$4[redacted]$4",
		)
		.replace(
			/\b(accessToken|refreshToken|idToken)(\s*[:=]\s*)(["'])[^"']+\3/g,
			"$1$2$3[redacted]$3",
		)
		.replace(/\b(accessToken|refreshToken|idToken)(\s*[:=]\s*)[^'"\s,}&]+/g, "$1$2[redacted]")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "[redacted]");
}

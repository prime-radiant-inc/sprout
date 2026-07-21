export function redactSensitiveTranscriptContent(content: string): string {
	return content
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
			"[REDACTED_PRIVATE_KEY]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [REDACTED_TOKEN]")
		// Covers sk-ant-… (Anthropic) and every other sk-… provider key shape.
		.replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_API_KEY]")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
		.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
		.replace(
			/\b([A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE[_-]?KEY)[A-Z0-9_]*\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gi,
			(_match, prefix: string, value: string) => redactGenericKeyedSecret(prefix, value),
		)
		.replace(
			/(["']?\b(?:api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token|private[_-]?key)\b["']?\s*[:=]\s*)(["'][^"'\n]*["']|[^\s,}]+)/gi,
			(_match, prefix: string, value: string) => redactGenericKeyedSecret(prefix, value),
		);
}

function redactGenericKeyedSecret(prefix: string, value: string): string {
	return `${prefix}${isRedactionMarkerValue(value) ? value : "[REDACTED_SECRET]"}`;
}

function isRedactionMarkerValue(value: string): boolean {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	return /^\[REDACTED_[A-Z_]+\]$/.test(unquoted);
}

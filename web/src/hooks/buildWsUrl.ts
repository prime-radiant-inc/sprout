/** Build a WebSocket URL, upgrading to wss: when served over HTTPS. */
export function buildWsUrl(protocol: string, host: string, envOverride?: string): string {
	if (envOverride) return envOverride;
	return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
}

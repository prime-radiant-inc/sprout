/** Build a WebSocket URL, upgrading to wss: when served over HTTPS. */
export function buildWsUrl(
	protocol: string,
	host: string,
	envOverride?: string,
	search = "",
): string {
	const base = envOverride || `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
	const token = new URLSearchParams(search).get("token");
	if (!token) return base;
	try {
		const url = new URL(base);
		if (!url.searchParams.has("token")) {
			url.searchParams.set("token", token);
		}
		return url.toString();
	} catch {
		return base;
	}
}

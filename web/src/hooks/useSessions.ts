import { useCallback, useEffect, useState } from "react";
import type { SessionListEntry } from "@kernel/types.ts";

export interface SessionsState {
	sessions: SessionListEntry[];
	/** The session this web server is live on; null until the list loads. */
	liveSessionId: string | null;
	loading: boolean;
	error: string | null;
	/** Re-fetch the list (e.g. a refresh button). */
	reload: () => void;
}

interface SessionsResponse {
	sessions: SessionListEntry[];
	liveSessionId: string;
}

/** Build /api/sessions carrying the page's token, mirroring the /api/events fetch. */
export function sessionsUrl(search: string): string {
	const token = new URLSearchParams(search).get("token");
	return token ? `/api/sessions?token=${encodeURIComponent(token)}` : "/api/sessions";
}

/**
 * Fetch the project's session list when `enabled` — the multi-session switcher
 * polls once each time it opens (the design's "poll on switcher open"), which
 * is simpler than a live push channel and fresh enough for a manual list.
 */
export function useSessions(enabled: boolean): SessionsState {
	const [sessions, setSessions] = useState<SessionListEntry[]>([]);
	const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		const search = typeof window === "undefined" ? "" : window.location.search;
		setLoading(true);
		setError(null);
		try {
			const resp = await fetch(sessionsUrl(search), { cache: "no-store" });
			if (!resp.ok) {
				setError(`Failed to load sessions (${resp.status})`);
				return;
			}
			const body = (await resp.json()) as SessionsResponse;
			setSessions(body.sessions);
			setLiveSessionId(body.liveSessionId);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load sessions");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (enabled) void reload();
	}, [enabled, reload]);

	return { sessions, liveSessionId, loading, error, reload: () => void reload() };
}

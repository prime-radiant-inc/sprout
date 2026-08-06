import { useCallback, useEffect, useState } from "react";
import type { ProjectSessionEntry } from "@kernel/types.ts";

export interface SessionsState {
	/** Every persisted session across all projects, tagged with its project. */
	sessions: ProjectSessionEntry[];
	/** The session this web server is live on; null until the list loads. */
	liveSessionId: string | null;
	/** The project (slug) this web server is bound to; null until loaded. */
	currentProject: string | null;
	loading: boolean;
	error: string | null;
	/** Re-fetch the list (e.g. a refresh button). */
	reload: () => void;
}

interface SessionsResponse {
	sessions: ProjectSessionEntry[];
	liveSessionId: string;
	currentProject: string | null;
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
	const [sessions, setSessions] = useState<ProjectSessionEntry[]>([]);
	const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
	const [currentProject, setCurrentProject] = useState<string | null>(null);
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
			setCurrentProject(body.currentProject);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load sessions");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (enabled) void reload();
	}, [enabled, reload]);

	return { sessions, liveSessionId, currentProject, loading, error, reload: () => void reload() };
}

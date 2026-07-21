import type { ProjectSessionEntry } from "@kernel/types.ts";
import styles from "./SessionList.module.css";

interface SessionListProps {
	sessions: ProjectSessionEntry[];
	liveSessionId: string | null;
	currentProject: string | null;
	loading: boolean;
	error: string | null;
	onReload: () => void;
	onClose: () => void;
}

/** Human date for a session's last activity; falls back to the raw string. */
function formatUpdated(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	return new Date(ms).toLocaleString();
}

function sessionLabel(session: ProjectSessionEntry): string {
	return session.firstPrompt?.trim() || session.memorySurface?.goal?.trim() || "(no goal recorded)";
}

/**
 * Best-effort readable path from a project slug. Slugs replace both "/" and
 * spaces with "-" (lossy), so this can't be a perfect inverse — it just trims
 * the leading separator for a friendlier label.
 */
function projectLabel(slug: string): string {
	return slug.replace(/^-/, "") || slug;
}

interface ProjectGroup {
	project: string;
	sessions: ProjectSessionEntry[];
}

/** Group sessions by project, current project first, newest session first within each. */
function groupByProject(
	sessions: ProjectSessionEntry[],
	currentProject: string | null,
): ProjectGroup[] {
	const groups = new Map<string, ProjectSessionEntry[]>();
	for (const session of sessions) {
		groups.set(session.project, [...(groups.get(session.project) ?? []), session]);
	}
	const ordered = [...groups.entries()].sort(([a], [b]) => {
		if (a === currentProject) return -1;
		if (b === currentProject) return 1;
		return a < b ? -1 : 1;
	});
	return ordered.map(([project, list]) => ({
		project,
		// Session ids are ULIDs, so a reverse id sort is time order.
		sessions: [...list].sort((x, y) => (x.sessionId < y.sessionId ? 1 : -1)),
	}));
}

/**
 * Read-only list of every persisted session across ALL projects (multi-session
 * UI, Phase 1). Sessions are grouped by project (the current project first),
 * and the live session is marked. Opening another session is a later phase, so
 * rows are informational for now.
 */
export function SessionList({
	sessions,
	liveSessionId,
	currentProject,
	loading,
	error,
	onReload,
	onClose,
}: SessionListProps) {
	const groups = groupByProject(sessions, currentProject);
	return (
		<div className={styles.overlay} onClick={onClose} data-testid="session-list">
			<div className={styles.modal} onClick={(e) => e.stopPropagation()}>
				<div className={styles.header}>
					<h2 className={styles.title}>Sessions</h2>
					<div className={styles.headerActions}>
						<button
							type="button"
							className={styles.reload}
							data-action="reload-sessions"
							onClick={onReload}
						>
							Refresh
						</button>
						<button type="button" className={styles.close} onClick={onClose}>
							{"✕"}
						</button>
					</div>
				</div>
				{error && <div className={styles.error}>{error}</div>}
				{loading && sessions.length === 0 && <div className={styles.empty}>Loading sessions…</div>}
				{!loading && sessions.length === 0 && !error && (
					<div className={styles.empty}>No sessions yet.</div>
				)}
				<div className={styles.groups}>
					{groups.map(({ project, sessions: projectSessions }) => (
						<section key={project} className={styles.group} data-project={project}>
							<h3 className={styles.projectHeading}>
								{projectLabel(project)}
								{project === currentProject && (
									<span className={styles.currentBadge}>current</span>
								)}
							</h3>
							<ul className={styles.list}>
								{projectSessions.map((session) => {
									const isLive = session.sessionId === liveSessionId;
									return (
										<li
											key={session.sessionId}
											className={isLive ? `${styles.row} ${styles.live}` : styles.row}
											data-live={isLive ? "true" : "false"}
										>
											<div className={styles.rowMain}>
												<span className={styles.goal}>{sessionLabel(session)}</span>
												<span className={styles.meta}>
													<span className={styles.agent}>{session.agentSpec}</span>
													<span className={styles.status} data-status={session.status}>
														{session.status}
													</span>
													{isLive && <span className={styles.liveBadge}>live</span>}
												</span>
											</div>
											<div className={styles.rowSub}>
												<span className={styles.sessionId}>{session.sessionId}</span>
												<span className={styles.turns}>{session.turns} turns</span>
												<span className={styles.updated}>{formatUpdated(session.updatedAt)}</span>
											</div>
										</li>
									);
								})}
							</ul>
						</section>
					))}
				</div>
			</div>
		</div>
	);
}

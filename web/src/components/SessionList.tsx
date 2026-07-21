import type { SessionListEntry } from "@kernel/types.ts";
import styles from "./SessionList.module.css";

interface SessionListProps {
	sessions: SessionListEntry[];
	liveSessionId: string | null;
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

function sessionLabel(session: SessionListEntry): string {
	return session.firstPrompt?.trim() || session.memorySurface?.goal?.trim() || "(no goal recorded)";
}

/**
 * Read-only list of every persisted session for this project (multi-session UI,
 * Phase 1). The live session is marked; opening another session is a later
 * phase, so rows are informational for now.
 */
export function SessionList({
	sessions,
	liveSessionId,
	loading,
	error,
	onReload,
	onClose,
}: SessionListProps) {
	// Newest first — session ids are ULIDs, so a reverse id sort is time order.
	const ordered = [...sessions].sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1));
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
				<ul className={styles.list}>
					{ordered.map((session) => {
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
			</div>
		</div>
	);
}

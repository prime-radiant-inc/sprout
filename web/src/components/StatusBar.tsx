import type { SessionStatus } from "../hooks/useEvents.ts";
import { formatTokens, shortModelName } from "./format.ts";
import styles from "./StatusBar.module.css";

export interface StatusBarProps {
	status: SessionStatus;
	connected: boolean;
	onInterrupt?: () => void;
}

/** Status bar showing context, turns, I/O tokens, model, session ID, and connection state. */
export function StatusBar({ status, connected }: StatusBarProps) {
	const {
		contextTokens,
		contextWindowSize,
		turns,
		inputTokens,
		outputTokens,
		model,
		sessionId,
		status: runStatus,
	} = status;

	const pressure =
		contextWindowSize > 0 ? contextTokens / contextWindowSize : 0;
	const percentStr = `${Math.round(pressure * 100)}%`;
	const turnLabel = `${turns} ${turns === 1 ? "turn" : "turns"}`;

	const handleCopySessionId = () => {
		navigator.clipboard.writeText(sessionId).catch(() => {
			// Clipboard write can fail in non-secure contexts; ignore silently.
		});
	};

	return (
		<div className={styles.statusBar}>
			<span className={styles.connectionDot} data-connected={String(connected)} />
			<span className={styles.section}>
				ctx: {formatTokens(contextTokens)}/{formatTokens(contextWindowSize)} ({percentStr})
			</span>
			<span className={styles.separator}>{"\u2502"}</span>
			<span className={styles.section}>{turnLabel}</span>
			{runStatus === "running" && (
				<>
					<span className={styles.separator}>{"\u2502"}</span>
					<span className={styles.section}>
						{"\u2191"}{formatTokens(inputTokens)} {"\u2193"}{formatTokens(outputTokens)}
					</span>
				</>
			)}
			<span className={styles.spacer} />
			<span className={styles.section}>{shortModelName(model)}</span>
			<span className={styles.separator}>{"\u2502"}</span>
			<span
				className={styles.sessionId}
				data-action="copy-session-id"
				onClick={handleCopySessionId}
				title="Click to copy session ID"
			>
				{sessionId}
			</span>
		</div>
	);
}

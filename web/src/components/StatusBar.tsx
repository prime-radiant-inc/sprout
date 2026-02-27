import type { SessionStatus } from "../hooks/useEvents.ts";
import { formatTokens, shortModelName } from "./format.ts";
import styles from "./StatusBar.module.css";

export interface StatusBarProps {
	status: SessionStatus;
	connected: boolean;
	onInterrupt?: () => void;
}

/** Determine context pressure bar color based on usage percentage. */
function pressureColor(percent: number): string {
	if (percent >= 85) return "var(--color-error)";
	if (percent >= 60) return "var(--color-warning)";
	return "var(--color-success)";
}

/** Top command bar showing context pressure, cost, model, session controls. */
export function StatusBar({ status, connected, onInterrupt }: StatusBarProps) {
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
	const percentRound = Math.round(pressure * 100);
	const percentStr = `${percentRound}%`;
	const turnLabel = `${turns} ${turns === 1 ? "turn" : "turns"}`;

	const handleCopySessionId = () => {
		navigator.clipboard.writeText(sessionId).catch(() => {
			// Clipboard write can fail in non-secure contexts; ignore silently.
		});
	};

	return (
		<div className={styles.statusBar}>
			{/* Left group */}
			<div className={styles.leftGroup}>
				<span className={styles.connectionDot} data-connected={String(connected)} />
				<div
					className={styles.pressureBarTrack}
					data-testid="context-pressure-bar"
				>
					<div
						className={styles.pressureBarFill}
						style={{
							width: percentStr,
							background: pressureColor(percentRound),
						}}
					/>
				</div>
				<span>
					{formatTokens(contextTokens)}/{formatTokens(contextWindowSize)} {percentStr}
				</span>
				<span>{turnLabel}</span>
				{runStatus === "running" && (
					<span>
						{"\u2191"}{formatTokens(inputTokens)} {"\u2193"}{formatTokens(outputTokens)}
					</span>
				)}
			</div>

			<span className={styles.spacer} />

			{/* Right group */}
			<div className={styles.rightGroup}>
				<span>{shortModelName(model)}</span>
				{runStatus === "running" && (
					<button
						type="button"
						className={styles.iconButton}
						onClick={onInterrupt}
						title="Interrupt"
					>
						{"\u23F9"}
					</button>
				)}
				<button
					type="button"
					className={styles.sessionId}
					data-action="copy-session-id"
					onClick={handleCopySessionId}
					title="Click to copy session ID"
				>
					{sessionId}
				</button>
			</div>
		</div>
	);
}

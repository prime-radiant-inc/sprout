import type { SessionStatus } from "../hooks/useEvents.ts";
import { formatTokens, shortModelName } from "./format.ts";
import styles from "./StatusBar.module.css";

export interface StatusBarProps {
	status: SessionStatus;
	connected: boolean;
	onInterrupt?: () => void;
	onSwitchModel?: (model: string) => void;
}

/** Determine context pressure bar color based on usage percentage. */
function pressureColor(percent: number): string {
	if (percent >= 85) return "var(--color-error)";
	if (percent >= 60) return "var(--color-warning)";
	return "var(--color-success)";
}

/** Top status bar with session info, context pressure, model, and controls. */
export function StatusBar({ status, connected, onInterrupt, onSwitchModel }: StatusBarProps) {
	const {
		contextTokens,
		contextWindowSize,
		turns,
		inputTokens,
		outputTokens,
		model,
		sessionId,
		status: runStatus,
		availableModels,
	} = status;

	const pressure =
		contextWindowSize > 0 ? contextTokens / contextWindowSize : 0;
	const percentRound = Math.round(pressure * 100);
	const percentStr = `${percentRound}%`;

	const handleCopySessionId = () => {
		navigator.clipboard.writeText(sessionId).catch(() => {});
	};

	return (
		<div className={styles.statusBar}>
			{/* Connection + status */}
			<div className={styles.group}>
				<span className={styles.connectionDot} data-connected={String(connected)} />
				<span className={styles.statusLabel} data-status={runStatus}>
					{runStatus === "running" ? "Running" : runStatus === "interrupted" ? "Interrupted" : "Idle"}
				</span>
			</div>

			{/* Context pressure */}
			<div className={styles.group}>
				<span className={styles.label}>Context</span>
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
				<span className={styles.value}>{percentStr}</span>
			</div>

			{/* Token usage */}
			<div className={styles.group}>
				<span className={styles.label}>Tokens</span>
				<span className={styles.value}>
					{formatTokens(contextTokens)}/{formatTokens(contextWindowSize)}
				</span>
			</div>

			{/* Turns */}
			<div className={styles.group}>
				<span className={styles.label}>Turns</span>
				<span className={styles.value}>{turns}</span>
			</div>

			{/* I/O tokens during run */}
			{runStatus === "running" && (
				<div className={styles.group}>
					<span className={styles.ioUp}>{"\u2191"}{formatTokens(inputTokens)}</span>
					<span className={styles.ioDown}>{"\u2193"}{formatTokens(outputTokens)}</span>
				</div>
			)}

			<span className={styles.spacer} />

			{/* Model selector */}
			{availableModels.length > 0 && onSwitchModel ? (
				<select
					className={styles.modelSelect}
					value={model}
					onChange={(e) => onSwitchModel(e.target.value)}
				>
					{availableModels.map((m) => (
						<option key={m} value={m}>
							{shortModelName(m)}
						</option>
					))}
				</select>
			) : (
				<span className={styles.modelLabel}>{shortModelName(model)}</span>
			)}

			{/* Interrupt button */}
			{runStatus === "running" && (
				<button
					type="button"
					className={styles.interruptBtn}
					onClick={onInterrupt}
					title="Interrupt (Esc)"
				>
					Stop
				</button>
			)}

			{/* Session ID */}
			<button
				type="button"
				className={styles.sessionId}
				data-action="copy-session-id"
				onClick={handleCopySessionId}
				title="Click to copy session ID"
			>
				{sessionId.slice(0, 8)}
			</button>
		</div>
	);
}

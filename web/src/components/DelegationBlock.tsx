import { formatDuration } from "./format.ts";
import styles from "./DelegationBlock.module.css";

interface DelegationBlockProps {
	agentName: string;
	goal: string;
	status: "running" | "completed" | "failed";
	turns?: number;
	durationMs?: number | null;
	livePeek?: string;
	onOpenThread?: () => void;
}

/** Delegation block — status card with left accent stripe showing agent activity. */
export function DelegationBlock(props: DelegationBlockProps) {
	const { agentName, goal, status, turns, durationMs, livePeek, onOpenThread } = props;

	const displayGoal =
		goal.length > 80 ? `${goal.slice(0, 77)}...` : goal;

	const dur = formatDuration(durationMs ?? null);

	return (
		<div className={styles.card} data-status={status}>
			<div className={styles.header}>
				<span className={styles.agentName}>{agentName}</span>
				<span className={styles.goal}>{displayGoal}</span>
				{status === "completed" && (
					<span className={styles.success}>{"\u2713"}</span>
				)}
				{status === "failed" && (
					<span className={styles.failed}>failed</span>
				)}
			</div>
			{(turns != null || dur) && (
				<div className={styles.meta}>
					{turns != null && (
						<span className={styles.turns}>{turns} turns</span>
					)}
					{dur && <span className={styles.duration}>{dur}</span>}
				</div>
			)}
			{livePeek && status === "running" && (
				<div className={styles.peek}>
					{livePeek}
				</div>
			)}
			{onOpenThread && (
				<div className={styles.footer}>
					<button
						type="button"
						className={styles.threadLink}
						onClick={onOpenThread}
					>
						{"View thread \u2192"}
					</button>
				</div>
			)}
		</div>
	);
}

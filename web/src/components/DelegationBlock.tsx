import type { ToolCallSummary } from "./groupEvents.ts";
import { formatDuration } from "./format.ts";
import styles from "./DelegationBlock.module.css";

interface DelegationBlockProps {
	agentName: string;
	mnemonicName?: string;
	goal: string;
	/** Short label for compact display; falls back to goal when absent */
	description?: string;
	status: "running" | "completed" | "failed";
	turns?: number;
	durationMs?: number | null;
	livePeek?: string;
	livePeekTools?: ToolCallSummary[];
	onOpenThread?: () => void;
}

/** Delegation block — status card with left accent stripe showing agent activity. */
export function DelegationBlock(props: DelegationBlockProps) {
	const { agentName, mnemonicName, goal, description, status, turns, durationMs, livePeek, livePeekTools, onOpenThread } = props;

	const dur = formatDuration(durationMs ?? null);

	return (
		<div className={styles.card} data-status={status}>
			<div className={styles.header}>
				{status === "running" && (
					<span className={styles.spinner} data-testid="spinner">{"\u25CF"}</span>
				)}
				<span className={styles.agentName}>
					{mnemonicName ? `${mnemonicName} (${agentName})` : agentName}
				</span>
				{status === "completed" && (
					<span className={styles.success}>{"\u2713"}</span>
				)}
				{status === "failed" && (
					<span className={styles.failed}>failed</span>
				)}
				{(turns != null || dur) && (
					<span className={styles.meta}>
						{turns != null && `${turns} turns`}
						{turns != null && dur && " \u00B7 "}
						{dur}
					</span>
				)}
			</div>
			<div className={styles.goal}>{description ?? goal}</div>
			{livePeekTools && livePeekTools.length > 0 && status === "running" && (
				<div className={styles.toolList}>
					{livePeekTools.map((tool, i) => (
						<div key={i} className={styles.toolItem}>
							<span className={tool.success ? styles.toolSuccess : styles.toolError}>
								{tool.success ? "\u2713" : "\u2717"}
							</span>
							<span className={styles.toolName}>{tool.name}</span>
							{tool.args && <span className={styles.toolArgs}>{tool.args}</span>}
						</div>
					))}
				</div>
			)}
			{livePeek && !livePeekTools?.length && status === "running" && (
				<div className={styles.peek}>{livePeek}</div>
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

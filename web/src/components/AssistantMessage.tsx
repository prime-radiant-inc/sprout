import { MarkdownBlock } from "./MarkdownBlock.tsx";
import { formatTime } from "./format.ts";
import styles from "./AssistantMessage.module.css";

interface AssistantMessageProps {
	text?: string;
	reasoning?: string;
	agentName?: string;
	isFirstInGroup?: boolean;
	timestamp?: number;
}

/** Assistant message with optional grouped header, collapsible reasoning, and themed styling. */
export function AssistantMessage({ text, reasoning, agentName, isFirstInGroup, timestamp }: AssistantMessageProps) {
	return (
		<div className={styles.assistantMessage}>
			{isFirstInGroup && (
				<div className={styles.header}>
					<span className={styles.name}>{agentName ?? "Assistant"}</span>
					{timestamp !== undefined && (
						<span className={styles.timestamp}>{formatTime(timestamp)}</span>
					)}
				</div>
			)}
			{reasoning && (
				<details className={styles.thinking}>
					<summary className={styles.thinkingSummary}>thinking</summary>
					<div className={styles.thinkingContent}>{reasoning}</div>
				</details>
			)}
			{text && <MarkdownBlock content={text} />}
		</div>
	);
}

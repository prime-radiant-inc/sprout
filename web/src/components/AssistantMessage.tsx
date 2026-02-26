import { MarkdownBlock } from "./MarkdownBlock.tsx";
import styles from "./AssistantMessage.module.css";

interface AssistantMessageProps {
	text?: string;
	reasoning?: string;
}

/** Assistant message with optional collapsible reasoning/thinking section. */
export function AssistantMessage({ text, reasoning }: AssistantMessageProps) {
	return (
		<div className={styles.assistantMessage}>
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

import styles from "./UserMessage.module.css";

interface UserMessageProps {
	text: string;
	isSteering?: boolean;
}

/** User message — blue accent, with prompt indicator. Steering variant is visually distinct. */
export function UserMessage({ text, isSteering }: UserMessageProps) {
	const className = isSteering
		? `${styles.userMessage} ${styles.steering}`
		: styles.userMessage;

	return (
		<div className={className} data-kind={isSteering ? "steering" : "user"}>
			<span className={styles.prompt}>&gt;</span>
			<span className={styles.text}>{text}</span>
		</div>
	);
}

import styles from "./UserMessage.module.css";

interface UserMessageProps {
	text: string;
	isSteering?: boolean;
	isFirstInGroup?: boolean;
	timestamp?: number;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = d.getHours().toString().padStart(2, "0");
	const m = d.getMinutes().toString().padStart(2, "0");
	return `${h}:${m}`;
}

/** User message with optional grouped header (name + timestamp) and accent-tinted card. */
export function UserMessage({ text, isSteering, isFirstInGroup, timestamp }: UserMessageProps) {
	const wrapperClass = isSteering
		? `${styles.userMessage} ${styles.steering}`
		: styles.userMessage;

	return (
		<div className={wrapperClass} data-kind={isSteering ? "steering" : "user"}>
			{isFirstInGroup && (
				<div className={styles.header}>
					<span className={styles.name}>You</span>
					{timestamp !== undefined && (
						<span className={styles.timestamp}>{formatTime(timestamp)}</span>
					)}
				</div>
			)}
			<div className={styles.card}>
				<span className={styles.text}>{text}</span>
				{isSteering && <span className={styles.badge}>steering</span>}
			</div>
		</div>
	);
}

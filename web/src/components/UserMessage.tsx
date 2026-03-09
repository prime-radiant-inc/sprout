import { formatTime } from "./format.ts";
import styles from "./UserMessage.module.css";

interface UserMessageProps {
	text: string;
	isSteering?: boolean;
	isFirstInGroup?: boolean;
	timestamp?: number;
	name?: string;
}

/** User message with optional grouped header (name + timestamp) and accent-tinted card. */
export function UserMessage({ text, isSteering, isFirstInGroup, timestamp, name = "You" }: UserMessageProps) {
	const wrapperClass = isSteering
		? `${styles.userMessage} ${styles.steering}`
		: styles.userMessage;

	return (
		<div className={wrapperClass} data-kind={isSteering ? "steering" : "user"}>
			{isFirstInGroup && (
				<div className={styles.header}>
					<span className={styles.name}>{name}</span>
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

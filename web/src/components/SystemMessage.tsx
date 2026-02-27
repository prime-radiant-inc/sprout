import styles from "./SystemMessage.module.css";

interface SystemMessageProps {
	kind: string;
	message: string;
}

/** Centered pill-shaped system message with themed status dot. */
export function SystemMessage({ kind, message }: SystemMessageProps) {
	return (
		<div className={styles.wrapper} data-testid="system-message-wrapper">
			<div className={styles.pill} data-kind={kind}>
				<span className={styles.dot} data-testid="dot" />
				<span className={styles.text}>{message}</span>
			</div>
		</div>
	);
}

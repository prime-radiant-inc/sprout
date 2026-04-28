import styles from "./SystemMessage.module.css";

interface SystemMessageProps {
	kind: string;
	message: string;
	details?: string;
	defaultOpen?: boolean;
}

/** Centered pill-shaped system message with themed status dot. */
export function SystemMessage({ kind, message, details, defaultOpen }: SystemMessageProps) {
	if (details) {
		return (
			<div className={styles.wrapper} data-testid="system-message-wrapper">
				<details className={styles.details} open={defaultOpen}>
					<summary className={styles.pill} data-kind={kind}>
						<span className={styles.dot} data-testid="dot" />
						<span className={styles.text}>{message}</span>
					</summary>
					<pre className={styles.detailText}>{details}</pre>
				</details>
			</div>
		);
	}

	return (
		<div className={styles.wrapper} data-testid="system-message-wrapper">
			<div className={styles.pill} data-kind={kind}>
				<span className={styles.dot} data-testid="dot" />
				<span className={styles.text}>{message}</span>
			</div>
		</div>
	);
}

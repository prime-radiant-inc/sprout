import styles from "./TypingIndicator.module.css";

export function TypingIndicator() {
	return (
		<span className={styles.indicator} data-testid="typing-indicator">
			<span className={styles.dot} data-testid="dot" style={{ animationDelay: "0ms" }} />
			<span className={styles.dot} data-testid="dot" style={{ animationDelay: "150ms" }} />
			<span className={styles.dot} data-testid="dot" style={{ animationDelay: "300ms" }} />
		</span>
	);
}

import styles from "./EmptyState.module.css";

/** Welcome screen shown when no events exist in the conversation. */
export function EmptyState() {
	return (
		<div className={styles.container}>
			<div className={styles.content}>
				<div className={styles.icon}>
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 2L2 7l10 5 10-5-10-5z" />
						<path d="M2 17l10 5 10-5" />
						<path d="M2 12l10 5 10-5" />
					</svg>
				</div>
				<h2 className={styles.title}>Sprout</h2>
				<p className={styles.subtitle}>
					Enter a goal below to start a session
				</p>
				<div className={styles.hints}>
					<div className={styles.hint}>
						<span className={styles.key}>Enter</span>
						<span>Send message</span>
					</div>
					<div className={styles.hint}>
						<span className={styles.key}>Shift+Enter</span>
						<span>New line</span>
					</div>
					<div className={styles.hint}>
						<span className={styles.key}>/</span>
						<span>Commands</span>
					</div>
				</div>
			</div>
		</div>
	);
}

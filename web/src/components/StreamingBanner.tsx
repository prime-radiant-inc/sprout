import { TypingIndicator } from "./TypingIndicator.tsx";
import styles from "./StreamingBanner.module.css";

interface StreamingBannerProps {
	agentName?: string;
}

export function StreamingBanner({ agentName }: StreamingBannerProps) {
	return (
		<div className={styles.banner}>
			<span className={styles.agentName}>{agentName ?? "Assistant"}</span>
			<span className={styles.label}>is responding</span>
			<TypingIndicator />
		</div>
	);
}

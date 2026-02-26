import styles from "./SystemMessage.module.css";

interface SystemMessageProps {
	kind: string;
	message: string;
}

const SYSTEM_ICONS: Record<string, string> = {
	session_start: "\u25C6",
	session_end: "\u25C7",
	session_resume: "\u21BB",
	session_clear: "\u25C6",
	compaction: "\u2298",
	steering: "\u21AA",
	learn_start: "\u25CB",
	learn_mutation: "\u25CB",
	interrupted: "\u2298",
};

/** System/infrastructure message — dim, warning (yellow), error (red). */
export function SystemMessage({ kind, message }: SystemMessageProps) {
	let className: string;
	let icon: string;

	if (kind === "error") {
		className = styles.error ?? "";
		icon = "\u2717";
	} else if (kind === "warning") {
		className = styles.warning ?? "";
		icon = "\u26A0";
	} else {
		className = styles.dim ?? "";
		icon = SYSTEM_ICONS[kind] ?? "\u25CB";
	}

	return (
		<div className={className} data-kind={kind}>
			<span className={styles.icon}>{icon}</span>
			<span>{message}</span>
		</div>
	);
}

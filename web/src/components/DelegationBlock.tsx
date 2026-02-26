import { formatDuration } from "./format.ts";
import styles from "./DelegationBlock.module.css";

interface DelegationStartProps {
	variant: "start";
	agentName: string;
	goal: string;
	success?: never;
	turns?: never;
	durationMs?: never;
}

interface DelegationEndProps {
	variant: "end";
	agentName: string;
	goal?: never;
	success: boolean;
	turns?: number;
	durationMs?: number | null;
}

type DelegationBlockProps = DelegationStartProps | DelegationEndProps;

/** Delegation block — shows agent name, goal, and status. Colored left border. */
export function DelegationBlock(props: DelegationBlockProps) {
	const { variant, agentName } = props;

	if (variant === "start") {
		const displayGoal =
			props.goal.length > 80
				? `${props.goal.slice(0, 79)}...`
				: props.goal;
		return (
			<div className={styles.delegation} data-variant="start">
				<span className={styles.bracket}>{"\u256D\u2500"}</span>
				<span className={styles.agentName}>{agentName}</span>
				<span className={styles.goal}>{displayGoal}</span>
			</div>
		);
	}

	const dur = formatDuration(props.durationMs ?? null);

	return (
		<div className={styles.delegation} data-variant="end" data-status={props.success ? "success" : "failed"}>
			<span className={styles.bracket}>{"\u2570\u2500"}</span>
			<span className={styles.agentName}>{agentName}</span>
			{props.success ? (
				<span className={styles.success}> {"\u2713"}</span>
			) : (
				<span className={styles.failed}> {"\u2717"} failed</span>
			)}
			{props.turns != null && (
				<span className={styles.turns}>{props.turns} turns</span>
			)}
			{dur && <span className={styles.duration}>{dur}</span>}
		</div>
	);
}

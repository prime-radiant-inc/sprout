import type { LearnDiagnosticSummary, StumbleDetail, ToolCallSummary } from "./groupEvents.ts";
import { formatDuration } from "./format.ts";
import styles from "./DelegationBlock.module.css";

interface DelegationBlockProps {
	agentName: string;
	mnemonicName?: string;
	goal: string;
	/** Short label for compact display; falls back to goal when absent */
	description?: string;
	status: "running" | "completed" | "failed";
	turns?: number;
	durationMs?: number | null;
	livePeek?: string;
	livePeekTools?: ToolCallSummary[];
	stumbleCount?: number;
	stumbles?: StumbleDetail[];
	learnEvents?: LearnDiagnosticSummary[];
	onOpenThread?: () => void;
}

/** Delegation block — status card with left accent stripe showing agent activity. */
export function DelegationBlock(props: DelegationBlockProps) {
	const { agentName, mnemonicName, goal, description, status, turns, durationMs, livePeek, livePeekTools, stumbleCount, stumbles, learnEvents, onOpenThread } = props;

	const dur = formatDuration(durationMs ?? null);
	const hasStumbles = (stumbleCount ?? 0) > 0;
	const canShowDiagnostics = status === "running" || hasStumbles;
	const hasDetailedDiagnostics = Boolean(stumbles?.length || learnEvents?.length);

	return (
		<div className={styles.card} data-status={status}>
			<div className={styles.header}>
				{status === "running" && (
					<span className={styles.spinner} data-testid="spinner">{"\u25CF"}</span>
				)}
				<span className={styles.agentName}>
					{mnemonicName ? `${mnemonicName} (${agentName})` : agentName}
				</span>
				{status === "completed" && (
					<span className={styles.success}>{"\u2713"}</span>
				)}
				{status === "failed" && (
					<span className={styles.failed}>failed</span>
				)}
				{hasStumbles && (
					<span className={styles.stumble}>
						{stumbleCount} {stumbleCount === 1 ? "stumble" : "stumbles"}
					</span>
				)}
				{(turns != null || dur) && (
					<span className={styles.meta}>
						{turns != null && `${turns} turns`}
						{turns != null && dur && " \u00B7 "}
						{dur}
					</span>
				)}
			</div>
			<div className={styles.goal}>{description ?? goal}</div>
			{livePeekTools && livePeekTools.length > 0 && canShowDiagnostics && (
				<div className={styles.toolList}>
					{livePeekTools.map((tool, i) => (
						<div key={i} className={styles.toolItem}>
							<span className={tool.success ? styles.toolSuccess : styles.toolError}>
								{tool.success ? "\u2713" : "\u2717"}
							</span>
							<span className={styles.toolName}>{tool.name}</span>
							{tool.args && <span className={styles.toolArgs}>{tool.args}</span>}
						</div>
					))}
				</div>
			)}
			{livePeek && !livePeekTools?.length && canShowDiagnostics && (
				<div className={styles.peek}>{livePeek}</div>
			)}
			{hasDetailedDiagnostics && (
				<details className={styles.diagnostics}>
					<summary className={styles.diagnosticsSummary}>Stumble details</summary>
					{stumbles && stumbles.length > 0 && (
						<div className={styles.diagnosticsSection}>
							<div className={styles.diagnosticsTitle}>Stumbles</div>
							{stumbles.map((stumble, i) => (
								<div key={i} className={styles.diagnosticItem}>
									<div className={styles.diagnosticLine}>
										<span className={styles.failed}>Failed tool</span>
										<span className={styles.toolName}>{stumble.toolName}</span>
										{stumble.args && <span className={styles.toolArgs}>{stumble.args}</span>}
									</div>
									{diagnosticDetail(stumble) && (
										<pre className={styles.diagnosticDetail}>{diagnosticDetail(stumble)}</pre>
									)}
								</div>
							))}
						</div>
					)}
					{learnEvents && learnEvents.length > 0 && (
						<div className={styles.diagnosticsSection}>
							<div className={styles.diagnosticsTitle}>Learning</div>
							{learnEvents.map((event, i) => (
								<div key={i} className={styles.diagnosticItem}>
									<div className={styles.diagnosticLine}>
										<span className={styles.learnKind}>{learnKindLabel(event.kind)}</span>
										<span className={styles.learnSummary}>{event.summary}</span>
									</div>
									{event.detail && (
										<pre className={styles.diagnosticDetail}>{truncateDiagnostic(event.detail)}</pre>
									)}
								</div>
							))}
						</div>
					)}
				</details>
			)}
			{onOpenThread && (
				<div className={styles.footer}>
					<button
						type="button"
						className={styles.threadLink}
						onClick={onOpenThread}
					>
						{"View thread \u2192"}
					</button>
				</div>
			)}
		</div>
	);
}

function diagnosticDetail(stumble: StumbleDetail): string | undefined {
	const detail = [stumble.error, stumble.output].filter(Boolean).join("\n");
	return detail ? truncateDiagnostic(detail) : undefined;
}

function truncateDiagnostic(value: string): string {
	return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function learnKindLabel(kind: LearnDiagnosticSummary["kind"]): string {
	switch (kind) {
		case "signal":
			return "signal";
		case "start":
			return "start";
		case "mutation":
			return "mutation";
		case "end":
			return "end";
	}
}

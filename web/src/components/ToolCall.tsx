import { formatDuration, smartArgs } from "./format.ts";
import styles from "./ToolCall.module.css";
import { getRenderer } from "./tools/ToolRendererRegistry.ts";

interface ToolCallProps {
	toolName: string;
	success: boolean;
	args?: Record<string, unknown>;
	error?: string;
	output?: string;
	durationMs?: number | null;
}

/** Collapsible tool call with status icon, duration, and type-specific expanded renderer. */
export function ToolCall({
	toolName,
	success,
	args,
	error,
	output,
	durationMs,
}: ToolCallProps) {
	const argStr = smartArgs(toolName, args);
	const dur = formatDuration(durationMs ?? null);

	// Compact output summary: short output inline, long output shows line count
	let outputHint: string | null = null;
	if (success && output) {
		const outputLines = output.split("\n");
		if (outputLines.length === 1 && output.length <= 60) {
			outputHint = output;
		} else if (outputLines.length > 1) {
			outputHint = `${outputLines.length} lines`;
		}
	}

	const statusClass = success ? styles.success : styles.error;
	const Renderer = getRenderer(toolName);

	return (
		<details className={styles.toolCall} data-status={success ? "success" : "error"}>
			<summary className={styles.summary}>
				<span className={styles.indicator}>&#x25B8;</span>
				<span className={styles.toolName}>{toolName}</span>
				{argStr && <span className={styles.args}>{argStr}</span>}
				<span className={statusClass}>
					{success ? " \u2713" : ` \u2717${error ? ` ${error}` : ""}`}
				</span>
				{outputHint && (
					<span className={styles.outputHint}> &rarr; {outputHint}</span>
				)}
				{dur && <span className={styles.duration}>{dur}</span>}
			</summary>
			{output && (
				<Renderer
					toolName={toolName}
					args={args ?? {}}
					output={output}
					success={success}
					error={error}
				/>
			)}
		</details>
	);
}

import { formatDuration } from "../format.ts";
import { ExpandableOutput } from "./ExpandableOutput.tsx";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Renderer for exec tool: terminal-styled command + output block. */
export function ExecRenderer({ args, output, success, error, durationMs }: ToolRendererProps) {
	const command = typeof args.command === "string" ? args.command : null;
	const dur = formatDuration(durationMs ?? null);

	return (
		<div className={styles.rendererBlock}>
			{(command || dur) && (
				<div className={styles.commandHeader}>
					{command && (
						<div className={styles.commandLine}>
							<span className={styles.prompt}>$</span> {command}
						</div>
					)}
					{dur && <div className={styles.commandMeta}>{dur}</div>}
				</div>
			)}
			{output && (
				<ExpandableOutput
					output={output}
					maxLines={5}
					collapsedLabel={(remainingLines) => `Show ${remainingLines} more lines`}
					showEllipsis={false}
				/>
			)}
			{!success && error && (
				<div className={styles.errorLine}>{error}</div>
			)}
		</div>
	);
}

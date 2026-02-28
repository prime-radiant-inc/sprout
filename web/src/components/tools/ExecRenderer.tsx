import { ExpandableOutput } from "./ExpandableOutput.tsx";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Renderer for exec tool: terminal-styled command + output block. */
export function ExecRenderer({ args, output, success, error }: ToolRendererProps) {
	const command = typeof args.command === "string" ? args.command : null;

	return (
		<div className={styles.rendererBlock}>
			{command && (
				<div className={styles.commandLine}>
					<span className={styles.prompt}>$</span> {command}
				</div>
			)}
			{output && <ExpandableOutput output={output} />}
			{!success && error && (
				<div className={styles.errorLine}>{error}</div>
			)}
		</div>
	);
}

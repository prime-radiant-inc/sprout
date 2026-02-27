import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

const MAX_PREVIEW_LINES = 10;

/** Renderer for read_file tool: shows filename, line count, and first 10 lines. */
export function ReadFileRenderer({ args, output }: ToolRendererProps) {
	const path = typeof args.path === "string" ? args.path : null;
	const lines = output.split("\n");
	const lineCount = lines.length;
	const preview = lines.slice(0, MAX_PREVIEW_LINES).join("\n");
	const truncated = lineCount > MAX_PREVIEW_LINES;

	return (
		<div className={styles.rendererBlock}>
			{path && <div className={styles.filePath}>{path}</div>}
			{lineCount > 0 && (
				<div className={styles.meta}>{lineCount} lines</div>
			)}
			<pre className={styles.codeBlock}>
				{preview}
				{truncated && "\n..."}
			</pre>
		</div>
	);
}

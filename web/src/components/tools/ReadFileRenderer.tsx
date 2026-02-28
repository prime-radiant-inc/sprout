import { ExpandableOutput } from "./ExpandableOutput.tsx";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Renderer for read_file tool: shows filename, line count, and expandable preview. */
export function ReadFileRenderer({ args, output }: ToolRendererProps) {
	const path = typeof args.path === "string" ? args.path : null;
	const lineCount = output.split("\n").length;

	return (
		<div className={styles.rendererBlock}>
			{path && <div className={styles.filePath}>{path}</div>}
			{lineCount > 0 && (
				<div className={styles.meta}>{lineCount} lines</div>
			)}
			<ExpandableOutput output={output} maxLines={10} />
		</div>
	);
}

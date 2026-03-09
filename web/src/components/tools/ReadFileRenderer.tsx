import { ExpandableOutput } from "./ExpandableOutput.tsx";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Renderer for read_file tool: shows an expandable content preview. */
export function ReadFileRenderer({ output }: ToolRendererProps) {
	return (
		<div className={styles.rendererBlock}>
			<ExpandableOutput output={output} maxLines={10} />
		</div>
	);
}

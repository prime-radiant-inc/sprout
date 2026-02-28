import { ExpandableOutput } from "./ExpandableOutput.tsx";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Generic fallback renderer: pretty-prints args as JSON and shows output. */
export function FallbackRenderer({ args, output }: ToolRendererProps) {
	const hasArgs = Object.keys(args).length > 0;

	return (
		<div className={styles.rendererBlock}>
			{hasArgs && (
				<pre className={styles.codeBlock}>
					{JSON.stringify(args, null, 2)}
				</pre>
			)}
			{output && <ExpandableOutput output={output} />}
		</div>
	);
}

import { ExpandableOutput } from "./ExpandableOutput.tsx";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Generic fallback renderer: pretty-prints args as JSON and shows output. */
export function FallbackRenderer({ args, output, error }: ToolRendererProps) {
	const hasArgs = Object.keys(args).length > 0;

	return (
		<div className={styles.rendererBlock}>
			{hasArgs && (
				<details className={styles.technicalDetails} data-testid="technical-details">
					<summary className={styles.detailsSummary}>Arguments</summary>
					<pre className={styles.codeBlock}>{JSON.stringify(args, null, 2)}</pre>
				</details>
			)}
			{output && <ExpandableOutput output={output} />}
			{error && <div className={styles.errorLine}>{error}</div>}
		</div>
	);
}

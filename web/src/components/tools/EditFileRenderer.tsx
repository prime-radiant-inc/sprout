import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Check whether output contains diff-like +/- lines. */
function hasDiffLines(output: string): boolean {
	return output.split("\n").some(
		(line) => line.startsWith("+") || line.startsWith("-"),
	);
}

/** Renderer for edit_file/write_file: shows diff lines with color indicators. */
export function EditFileRenderer({ args, output }: ToolRendererProps) {
	const path = typeof args.path === "string" ? args.path : null;
	const isDiff = hasDiffLines(output);

	return (
		<div className={styles.rendererBlock}>
			{path && <div className={styles.filePath}>{path}</div>}
			{isDiff ? (
				<pre className={styles.codeBlock}>
					{output.split("\n").map((line, i) => {
						let diffType: string | undefined;
						if (line.startsWith("+")) diffType = "added";
						else if (line.startsWith("-")) diffType = "removed";

						return (
							<div
								key={i}
								className={diffType ? styles[diffType] : undefined}
								data-diff={diffType}
							>
								{line}
							</div>
						);
					})}
				</pre>
			) : (
				<pre className={styles.codeBlock}>{output}</pre>
			)}
		</div>
	);
}

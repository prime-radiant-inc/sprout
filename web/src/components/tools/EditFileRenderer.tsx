import DOMPurify from "isomorphic-dompurify";
import { highlightCode } from "../../lib/highlight.ts";
import type { ToolRendererProps } from "./ToolRendererRegistry.ts";
import styles from "./tools.module.css";

/** Check whether output contains diff-like +/- lines. */
function hasDiffLines(output: string): boolean {
	return output.split("\n").some(
		(line) => line.startsWith("+") || line.startsWith("-"),
	);
}

/** Renderer for edit_file/write_file: shows syntax-highlighted diff output. */
export function EditFileRenderer({ output }: ToolRendererProps) {
	const isDiff = hasDiffLines(output);

	return (
		<div className={styles.rendererBlock}>
			{isDiff ? (
				<pre className={styles.codeBlock}>
					<code
						className="hljs language-diff"
						dangerouslySetInnerHTML={{
							__html: DOMPurify.sanitize(highlightCode(output, "diff")),
						}}
					/>
				</pre>
			) : (
				<pre className={styles.codeBlock}>{output}</pre>
			)}
		</div>
	);
}

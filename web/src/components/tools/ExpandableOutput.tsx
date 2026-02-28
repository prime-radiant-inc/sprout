import { useState } from "react";
import styles from "./tools.module.css";

interface ExpandableOutputProps {
	output: string;
	maxLines?: number;
}

const DEFAULT_MAX_LINES = 15;

/** Output block that shows first N lines with expand toggle for longer content. */
export function ExpandableOutput({
	output,
	maxLines = DEFAULT_MAX_LINES,
}: ExpandableOutputProps) {
	const [expanded, setExpanded] = useState(false);
	const lines = output.split("\n");
	const totalLines = lines.length;
	const needsTruncation = totalLines > maxLines;
	const displayText =
		expanded || !needsTruncation
			? output
			: lines.slice(0, maxLines).join("\n");

	return (
		<>
			<pre className={styles.codeBlock}>
				{displayText}
				{!expanded && needsTruncation && "\n..."}
			</pre>
			{needsTruncation && (
				<button
					type="button"
					className={styles.expandBtn}
					data-action="expand-output"
					onClick={() => setExpanded((prev) => !prev)}
				>
					{expanded ? "Collapse" : `Show all (${totalLines} lines)`}
				</button>
			)}
		</>
	);
}

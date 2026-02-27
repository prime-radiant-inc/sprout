import { useMemo } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import type { SessionStatus } from "../hooks/useEvents.ts";
import styles from "./SidebarSessionSummary.module.css";

interface SidebarSessionSummaryProps {
	status: SessionStatus;
	events: SessionEvent[];
}

const FILE_TOOLS = new Set(["edit_file", "write_file", "read_file"]);

/** Extract unique file paths from primitive_start events for file tools. */
function deriveFilesTouched(events: SessionEvent[]): string[] {
	const paths = new Set<string>();
	for (const event of events) {
		if (event.kind !== "primitive_start") continue;
		const name = event.data.name as string | undefined;
		if (!name || !FILE_TOOLS.has(name)) continue;
		const args = event.data.args as Record<string, unknown> | undefined;
		const path = args?.path as string | undefined;
		if (path) paths.add(path);
	}
	return [...paths];
}

/** Session summary shown in the sidebar when the session is idle. */
export function SidebarSessionSummary({
	status,
	events,
}: SidebarSessionSummaryProps) {
	const filesTouched = useMemo(() => deriveFilesTouched(events), [events]);

	return (
		<div className={styles.summary}>
			<h3 className={styles.heading}>Session</h3>

			<dl className={styles.stats}>
				<div className={styles.stat}>
					<dt className={styles.label}>Turns</dt>
					<dd className={styles.value}>{status.turns}</dd>
				</div>
				<div className={styles.stat}>
					<dt className={styles.label}>Model</dt>
					<dd className={styles.value}>{status.model}</dd>
				</div>
				<div className={styles.stat}>
					<dt className={styles.label}>Session ID</dt>
					<dd className={styles.value}>{status.sessionId}</dd>
				</div>
			</dl>

			{filesTouched.length > 0 && (
				<div className={styles.filesSection}>
					<h4 className={styles.filesHeading}>Files touched</h4>
					<ul className={styles.fileList}>
						{filesTouched.map((path) => (
							<li key={path} className={styles.fileItem}>
								{path}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

import { getToolDisplayName, getToolPathDetail } from "@shared/tool-display.ts";
import { formatDuration, smartArgs } from "./format.ts";
import styles from "./ToolCall.module.css";
import { getToolIcon } from "./tools/toolIcons.ts";
import { getRenderer } from "./tools/ToolRendererRegistry.ts";

interface ToolCallProps {
	toolName: string;
	displayName?: string;
	success: boolean;
	args?: Record<string, unknown>;
	error?: string;
	output?: string;
	durationMs?: number | null;
}

/** Flat tool row with a collapsible detail pane for output and errors. */
export function ToolCall({
	toolName,
	displayName,
	success,
	args,
	error,
	output,
	durationMs,
}: ToolCallProps) {
	const argStr = smartArgs(toolName, args);
	const label = getToolDisplayName(toolName, displayName);
	const pathDetail = getToolPathDetail(args);
	const dur = formatDuration(durationMs ?? null);
	const showSummaryDuration = toolName !== "exec";

	const icon = getToolIcon(toolName);
	const Renderer = getRenderer(toolName);
	const hasBody = Boolean(output) || Boolean(error);
	const hasMetaLine = Boolean(pathDetail) || Boolean(showSummaryDuration && dur);

	return (
		<details className={styles.toolCall} data-status={success ? "success" : "error"}>
			<summary className={styles.summary}>
				<span className={styles.indicator}>&#x25B8;</span>
				{icon && <span className={styles.toolIcon} data-testid="tool-icon">{icon}</span>}
				<span className={styles.summaryBody}>
					<span className={styles.primaryLine}>
						<span className={styles.toolName}>{label}</span>
						{argStr && <span className={styles.args}>{argStr}</span>}
					</span>
					{hasMetaLine && (
						<span className={styles.metaLine}>
							{pathDetail && <span className={styles.pathDetail}>{pathDetail}</span>}
							{showSummaryDuration && dur && <span className={styles.duration}>{dur}</span>}
						</span>
					)}
				</span>
				{!success && (
					<span className={styles.errorPill}>
						Failed
					</span>
				)}
			</summary>
			{hasBody && (
				<div className={styles.body}>
					{error && !output && <div className={styles.errorBlock}>{error}</div>}
					{output && (
						<Renderer
							toolName={toolName}
							args={args ?? {}}
							output={output}
							success={success}
							error={error}
							durationMs={durationMs}
						/>
					)}
				</div>
			)}
		</details>
	);
}

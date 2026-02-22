export type TruncationMode = "head_tail" | "tail";

/** Default character limits per tool */
export const DEFAULT_CHAR_LIMITS: Record<string, number> = {
	read_file: 50_000,
	exec: 30_000,
	grep: 20_000,
	glob: 20_000,
	edit_file: 10_000,
	apply_patch: 10_000,
	write_file: 1_000,
	fetch: 30_000,
};

/** Default line limits per tool (undefined = no line limit) */
export const DEFAULT_LINE_LIMITS: Record<string, number> = {
	exec: 256,
	grep: 200,
	glob: 500,
};

/** Default truncation mode per tool */
const DEFAULT_MODES: Record<string, TruncationMode> = {
	read_file: "head_tail",
	exec: "head_tail",
	grep: "tail",
	glob: "tail",
	edit_file: "tail",
	apply_patch: "tail",
	write_file: "tail",
	fetch: "head_tail",
};

/**
 * Character-based truncation with head/tail split.
 * This is the primary safeguard — handles all cases including pathological
 * single-line inputs (e.g., 10MB CSV).
 */
export function truncateOutput(output: string, maxChars: number, mode: TruncationMode): string {
	if (output.length <= maxChars) {
		return output;
	}

	const removed = output.length - maxChars;

	if (mode === "head_tail") {
		const half = Math.floor(maxChars / 2);
		const head = output.slice(0, half);
		const tail = output.slice(-half);
		return (
			`${head}\n\n` +
			`[WARNING: Tool output was truncated. ` +
			`${removed} characters were removed from the middle. ` +
			`The full output is available in the event stream. ` +
			`If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` +
			tail
		);
	}

	// tail mode: keep the end
	const tail = output.slice(-maxChars);
	return (
		`[WARNING: Tool output was truncated. First ` +
		`${removed} characters were removed. ` +
		`The full output is available in the event stream.]\n\n` +
		tail
	);
}

/**
 * Line-based truncation with head/tail split.
 * Secondary readability pass — runs AFTER character truncation.
 */
export function truncateLines(output: string, maxLines: number): string {
	const lines = output.split("\n");
	if (lines.length <= maxLines) {
		return output;
	}

	const headCount = Math.floor(maxLines / 2);
	const tailCount = maxLines - headCount;
	const omitted = lines.length - headCount - tailCount;

	const head = lines.slice(0, headCount).join("\n");
	const tail = lines.slice(-tailCount).join("\n");
	return `${head}\n[... ${omitted} lines omitted ...]\n${tail}`;
}

export interface TruncationOverrides {
	charLimit?: number;
	lineLimit?: number;
	mode?: TruncationMode;
}

/**
 * Full truncation pipeline for tool output.
 * Character truncation runs first (handles pathological cases),
 * then line truncation (readability).
 */
export function truncateToolOutput(
	output: string,
	toolName: string,
	overrides?: TruncationOverrides,
): string {
	const charLimit = overrides?.charLimit ?? DEFAULT_CHAR_LIMITS[toolName] ?? 30_000;
	const mode = overrides?.mode ?? DEFAULT_MODES[toolName] ?? "head_tail";

	// Step 1: Character-based truncation (always runs)
	let result = truncateOutput(output, charLimit, mode);

	// Step 2: Line-based truncation (if configured for this tool)
	const lineLimit = overrides?.lineLimit ?? DEFAULT_LINE_LIMITS[toolName];
	if (lineLimit !== undefined) {
		result = truncateLines(result, lineLimit);
	}

	return result;
}

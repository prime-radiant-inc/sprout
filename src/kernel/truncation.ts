export type TruncationMode = "head_tail" | "tail";

/**
 * Inline budget for a child's ResultMessage.output (sap spec §2 Auto-bind):
 * output past this auto-binds and auto-publishes in full, with only the head
 * sent inline.
 */
export const SUMMARY_BUDGET_CHARS = 4_000;

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

/**
 * Preview budgets (capture-all spec v10): the svelte thresholds the three
 * output gates read, in CHARS. `default` covers every capture-capable tool
 * without its own row; `cell` is explicit so tuning `default` cannot silently
 * move the data-plane transcript gate.
 */
export const DEFAULT_PREVIEW_BUDGETS: Record<string, number> = {
	default: 2_000,
	read_file: 4_000,
	delegate: 4_000,
	cell: 2_000,
};

/**
 * Resolve preview budgets from the environment: SPROUT_PREVIEW_BUDGETS holds a
 * JSON map merged over the defaults. Any invalid input warns and falls back
 * wholesale — a bad env var must never crash or partially configure a session.
 */
export function resolvePreviewBudgets(
	env: Record<string, string | undefined>,
	warn: (message: string) => void = console.warn,
): Record<string, number> {
	const defaults = { ...DEFAULT_PREVIEW_BUDGETS };
	const raw = env.SPROUT_PREVIEW_BUDGETS;
	if (raw === undefined || raw === "") return defaults;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("must be a JSON object map");
		}
		const merged = { ...defaults };
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
				throw new Error(`budget for '${key}' must be a positive number`);
			}
			merged[key] = value;
		}
		return merged;
	} catch (err) {
		warn(
			`invalid SPROUT_PREVIEW_BUDGETS ignored (${err instanceof Error ? err.message : String(err)}); using defaults`,
		);
		return defaults;
	}
}

/**
 * The one capture-marker format (capture-all spec v10): every gate composes
 * its tail onto this prefix, so wording converges by construction. The
 * machine contract is the ⟦…⟧ glyph pair inside ref-naming tails.
 */
export function captureMarker(dropped: string, tail: string): string {
	return `[... ${dropped} truncated${tail}]`;
}

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

/** One truncation pass's outcome: the text plus what was dropped. */
export interface PassResult {
	text: string;
	dropped: boolean;
	droppedLines: number;
	droppedChars: number;
}

function countLines(text: string): number {
	return text.split("\n").length;
}

/**
 * Character-based truncation with head/tail split.
 * This is the primary safeguard — handles all cases including pathological
 * single-line inputs (e.g., 10MB CSV).
 */
export function truncateOutput(output: string, maxChars: number, mode: TruncationMode): string {
	return truncateOutputDetailed(output, maxChars, mode).text;
}

function truncateOutputDetailed(
	output: string,
	maxChars: number,
	mode: TruncationMode,
	marker?: string,
): PassResult {
	if (output.length <= maxChars) {
		return { text: output, dropped: false, droppedLines: 0, droppedChars: 0 };
	}

	const removed = output.length - maxChars;

	if (mode === "head_tail") {
		const half = Math.floor(maxChars / 2);
		const head = output.slice(0, half);
		const tail = output.slice(-half);
		const banner =
			marker ??
			`[WARNING: Tool output was truncated. ` +
				`${removed} characters were removed from the middle. ` +
				`The full output is available in the event stream. ` +
				`If you need to see specific parts, re-run the tool with more targeted parameters.]`;
		return {
			text: `${head}\n\n${banner}\n\n${tail}`,
			dropped: true,
			// The head's last and the tail's first line are cut mid-line, so
			// wholly-dropped lines can bottom out at 0 for single-line inputs.
			droppedLines: Math.max(0, countLines(output) - countLines(head) - countLines(tail)),
			droppedChars: removed,
		};
	}

	// tail mode: keep the end
	const tail = output.slice(-maxChars);
	const banner =
		marker ??
		`[WARNING: Tool output was truncated. First ` +
			`${removed} characters were removed. ` +
			`The full output is available in the event stream.]`;
	return {
		text: `${banner}\n\n${tail}`,
		dropped: true,
		droppedLines: Math.max(0, countLines(output) - countLines(tail)),
		droppedChars: removed,
	};
}

/**
 * Line-based truncation with head/tail split.
 * Secondary readability pass — runs AFTER character truncation.
 */
export function truncateLines(output: string, maxLines: number): string {
	return truncateLinesDetailed(output, maxLines).text;
}

function truncateLinesDetailed(output: string, maxLines: number, marker?: string): PassResult {
	const lines = output.split("\n");
	if (lines.length <= maxLines) {
		return { text: output, dropped: false, droppedLines: 0, droppedChars: 0 };
	}

	const headCount = Math.floor(maxLines / 2);
	const tailCount = maxLines - headCount;
	const omitted = lines.length - headCount - tailCount;

	const head = lines.slice(0, headCount).join("\n");
	const tail = lines.slice(-tailCount).join("\n");
	const banner = marker ?? `[... ${omitted} lines omitted ...]`;
	return {
		text: `${head}\n${banner}\n${tail}`,
		dropped: true,
		droppedLines: omitted,
		droppedChars: output.length - head.length - tail.length,
	};
}

/**
 * The svelte-gate char pass (capture-all spec v10): on the capture path the
 * budget is the ONLY truncation — no line limits — shaped by the tool's mode
 * so tails stay visible where they matter (exec/read_file/fetch: head_tail).
 */
export function truncateAtBudgetDetailed(
	output: string,
	toolName: string,
	budget: number,
	marker?: string,
): PassResult {
	return truncateOutputDetailed(output, budget, DEFAULT_MODES[toolName] ?? "head_tail", marker);
}

export interface TruncationOverrides {
	charLimit?: number;
	lineLimit?: number;
	mode?: TruncationMode;
}

/** What the full pipeline dropped — capture's auto-bind decision keys on this. */
export interface TruncationDetail {
	text: string;
	truncated: boolean;
	/** Whole lines dropped across both passes (0 for mid-line char cuts). */
	droppedLines: number;
	/** Characters removed by the char pass (0 when only the line pass trips). */
	droppedChars: number;
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
	return truncateToolOutputDetailed(output, toolName, overrides).text;
}

/**
 * The pipeline with its losses reported, and an optional custom marker that
 * replaces the default banner/omission text in whichever pass trips — the
 * auto-capture path uses it to point at the bound full-output value.
 */
export function truncateToolOutputDetailed(
	output: string,
	toolName: string,
	overrides?: TruncationOverrides,
	marker?: string,
): TruncationDetail {
	const charLimit = overrides?.charLimit ?? DEFAULT_CHAR_LIMITS[toolName] ?? 30_000;
	const mode = overrides?.mode ?? DEFAULT_MODES[toolName] ?? "head_tail";

	// Step 1: Character-based truncation (always runs)
	const charPass = truncateOutputDetailed(output, charLimit, mode, marker);
	let text = charPass.text;
	let truncated = charPass.dropped;
	let droppedLines = charPass.droppedLines;

	// Step 2: Line-based truncation (if configured for this tool)
	const lineLimit = overrides?.lineLimit ?? DEFAULT_LINE_LIMITS[toolName];
	if (lineLimit !== undefined) {
		let lineInput = text;
		// A custom marker must appear exactly once: when the char pass already
		// inserted it and the line pass will trip too, strip the char-pass copy
		// so the line pass re-inserts the single authoritative one.
		if (marker !== undefined && charPass.dropped) {
			const without = text.split("\n").filter((line) => line !== marker);
			if (without.length > lineLimit) lineInput = without.join("\n");
		}
		const linePass = truncateLinesDetailed(lineInput, lineLimit, marker);
		text = linePass.text;
		truncated = truncated || linePass.dropped;
		droppedLines += linePass.droppedLines;
	}

	return { text, truncated, droppedLines, droppedChars: charPass.droppedChars };
}

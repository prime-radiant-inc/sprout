/**
 * Formatting helpers for event rendering and status display.
 * Ported from src/tui/ to avoid depending on Ink/TUI code.
 */
import { formatToolKeyArg } from "@shared/tool-display.ts";

/** Format a unix timestamp as HH:MM in local time. */
export function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = d.getHours().toString().padStart(2, "0");
	const m = d.getMinutes().toString().padStart(2, "0");
	return `${h}:${m}`;
}

/** Format a token count with k/M suffixes. */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** Shorten model names by stripping date suffixes (e.g. "claude-sonnet-4-20250514" -> "claude-sonnet-4"). */
export function shortModelName(model: string): string {
	return model.replace(/-\d{8}$/, "");
}

/** Format duration in seconds, showing one decimal place. */
export function formatDuration(durationMs: number | null): string | null {
	if (durationMs === null) return null;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Truncate a string to maxLen, adding ellipsis if truncated. */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Build a smart display string for primitive tool arguments.
 * Returns the formatted arg string (without leading space).
 */
export function smartArgs(
	name: string,
	args: Record<string, unknown> | undefined,
): string {
	return truncate(formatToolKeyArg(name, args), 60);
}

/**
 * Formatting helpers for event rendering.
 * Ported from src/tui/render-event.ts to avoid depending on Ink/TUI code.
 */

/** Format duration in seconds, showing one decimal place. */
export function formatDuration(durationMs: number | null): string | null {
	if (durationMs === null) return null;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Truncate a string to maxLen, adding ellipsis if truncated. */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}...`;
}

/** Count newlines in content to report line count. */
function lineCount(content: unknown): number | null {
	if (typeof content !== "string" || content === "") return null;
	return content.split("\n").length;
}

/**
 * Build a smart display string for primitive tool arguments.
 * Returns the formatted arg string (without leading space).
 */
export function smartArgs(
	name: string,
	args: Record<string, unknown> | undefined,
): string {
	if (!args) return "";
	switch (name) {
		case "exec": {
			const cmd = args.command;
			if (typeof cmd !== "string") return "";
			return truncate(cmd, 60);
		}
		case "read_file": {
			const path = args.path;
			if (typeof path !== "string") return "";
			const offset = args.offset;
			const limit = args.limit;
			if (typeof offset === "number" || typeof limit === "number") {
				const parts: string[] = [];
				if (typeof offset === "number") parts.push(String(offset));
				if (typeof limit === "number") parts.push(`+${limit}`);
				return `${path}:${parts.join("")}`;
			}
			return path;
		}
		case "write_file": {
			const path = args.path;
			if (typeof path !== "string") return "";
			const lines = lineCount(args.content);
			return lines ? `${path} (${lines} lines)` : path;
		}
		case "edit_file": {
			const path = args.path;
			return typeof path === "string" ? path : "";
		}
		case "grep": {
			const pattern = args.pattern;
			const path = args.path;
			if (typeof pattern !== "string") return "";
			const parts = [`\`${pattern}\``];
			if (typeof path === "string") parts.push(path);
			return parts.join(" ");
		}
		case "glob": {
			const pattern = args.pattern;
			return typeof pattern === "string" ? `\`${pattern}\`` : "";
		}
		default: {
			for (const [key, val] of Object.entries(args)) {
				const str = typeof val === "string" ? val : JSON.stringify(val);
				if (str !== undefined && str.length <= 40) {
					return `${key}=${str}`;
				}
			}
			return "";
		}
	}
}

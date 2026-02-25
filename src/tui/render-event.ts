import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { SessionEvent } from "../kernel/types.ts";

// marked-terminal uses chalk for styling, but chalk may have level 0 in
// non-TTY contexts (tests, pipes), stripping all formatting. Override the
// key style functions with raw ANSI codes so bold/italic always render.
const ansi = (code: number, reset: number) => (text: string) =>
	`\x1B[${code}m${text}\x1B[${reset}m`;

const terminalMarkdown = new Marked(
	markedTerminal({
		strong: ansi(1, 22),
		em: ansi(3, 23),
		codespan: ansi(33, 39), // yellow
		del: ansi(9, 29),
	}),
);

/** Parse markdown to terminal-formatted string with proper bold/italic. */
export function renderMarkdown(text: string): string {
	return (terminalMarkdown.parse(text) as string).trim();
}

/** Truncate text to maxLines, appending an ellipsis if truncated. */
export function truncateLines(text: string, maxLines: number): string {
	if (!text) return text;
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const remaining = lines.length - maxLines;
	return `${lines.slice(0, maxLines).join("\n")}\n... (${remaining} more lines)`;
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
 * Returns the formatted arg string (without leading space — caller adds that).
 */
export function smartArgs(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	switch (name) {
		case "exec": {
			const cmd = args.command;
			if (typeof cmd !== "string") return "";
			return `\`${truncate(cmd, 60)}\``;
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
			// Show first key=value pair where value is short enough to display
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

/** Extract the key argument for a primitive (the most informative single arg). */
export function primitiveKeyArg(name: string, args: Record<string, unknown> | undefined): string {
	const result = smartArgs(name, args);
	return result ? ` ${result}` : "";
}

/** Format duration in seconds, showing one decimal place. */
export function formatDuration(durationMs: number | null): string | null {
	if (durationMs === null) return null;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Render a SessionEvent as a terminal-friendly plain string.
 * Used by the one-shot CLI mode (--prompt). The TUI uses renderEventComponent instead.
 * Returns null for events that shouldn't be shown.
 */
export function renderEvent(event: SessionEvent): string | null {
	const { kind, depth, data } = event;
	const ind = "  ".repeat(depth);

	switch (kind) {
		case "session_start":
			return `${ind}\u25C6 Starting session...`;

		case "session_resume":
			return `${ind}\u21BB Resumed session (${data.history_length ?? 0} messages of history)`;

		case "session_clear":
			return `${ind}\u25C6 New session started`;

		case "plan_start": {
			const turnLabel = data.turn ? ` (turn ${data.turn})` : "";
			return `${ind}\u25CC planning${turnLabel}...`;
		}

		case "plan_end": {
			const lines: string[] = [];
			if (data.reasoning) {
				for (const line of String(data.reasoning).split("\n")) {
					lines.push(`${ind}  ${line}`);
				}
			}
			if (data.text) {
				const rendered = renderMarkdown(String(data.text));
				for (const line of rendered.split("\n")) {
					lines.push(`${ind}${line}`);
				}
			}
			return lines.length > 0 ? lines.join("\n") : null;
		}

		case "primitive_start": {
			const argStr = smartArgs(data.name as string, data.args as Record<string, unknown>);
			return `${ind}  \u25B8 ${data.name}${argStr ? ` ${argStr}` : ""}`;
		}

		case "primitive_end": {
			const name = data.name;
			const argStr = smartArgs(name as string, data.args as Record<string, unknown>);
			const argSuffix = argStr ? ` ${argStr}` : "";
			if (!data.success) {
				const errMsg = data.error ? ` ${data.error}` : "";
				return `${ind}  \u25B8 ${name}${argSuffix} \u2717${errMsg}`;
			}
			return `${ind}  \u25B8 ${name}${argSuffix} \u2713`;
		}

		case "act_start":
			return `${ind}\u2192 ${data.agent_name}: ${truncate(String(data.goal), 80)}`;

		case "act_end": {
			const turns = data.turns != null ? ` (${data.turns} turns)` : "";
			if (!data.success) {
				return `${ind}\u2190 \u2717 failed${turns}`;
			}
			return `${ind}\u2190 \u2713${turns}`;
		}

		case "session_end": {
			const t = data.turns === 1 ? "1 turn" : `${data.turns} turns`;
			const s = data.stumbles === 1 ? "1 stumble" : `${data.stumbles} stumbles`;
			return `${ind}\u25C7 Done. ${t}, ${s}.`;
		}

		case "interrupted":
			return `${ind}\u2298 ${data.message ?? "user interrupt"}`;

		case "context_update":
			return null;

		case "compaction": {
			const summary = data.summary ? `\n${data.summary}` : "";
			return `${ind}\u2298 Context compacted: ${data.beforeCount} \u2192 ${data.afterCount} messages${summary}`;
		}

		case "learn_start":
			return `${ind}\u25CB Learning from stumble...`;

		case "learn_mutation":
			return `${ind}\u25CB Genome updated: ${data.mutation_type}`;

		case "warning":
			return `${ind}\u26A0 ${data.message}`;

		case "error":
			return `${ind}\u2717 ${data.error}`;

		case "steering":
			return `${ind}\u276F ${data.text}`;

		case "perceive":
			return `${ind}\u276F ${data.goal}`;

		default:
			return null;
	}
}

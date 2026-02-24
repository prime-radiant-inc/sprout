import type { SessionEvent } from "../kernel/types.ts";

/** Truncate text to maxLines, appending an ellipsis if truncated. */
export function truncateLines(text: string, maxLines: number): string {
	if (!text) return text;
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const remaining = lines.length - maxLines;
	return `${lines.slice(0, maxLines).join("\n")}\n... (${remaining} more lines)`;
}

/** Extract the key argument for a primitive (the most informative single arg). */
export function primitiveKeyArg(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	switch (name) {
		case "exec":
			return args.command ? ` \`${args.command}\`` : "";
		case "read_file":
		case "write_file":
		case "edit_file":
			return args.path ? ` ${args.path}` : "";
		case "grep":
		case "glob":
			return args.pattern ? ` \`${args.pattern}\`` : "";
		default:
			return "";
	}
}

/** Render a SessionEvent as a terminal-friendly string. Returns null for events that shouldn't be shown. */
export function renderEvent(event: SessionEvent): string | null {
	const { kind, agent_id, depth, data } = event;
	const indent = "  ".repeat(depth);
	const prefix = `${indent}[${agent_id}]`;

	switch (kind) {
		case "session_start":
			return `${prefix} Starting session...`;

		case "session_resume":
			return `${prefix} Resumed session (${data.history_length ?? 0} messages of history)`;

		case "plan_start":
			return `${prefix} Planning (turn ${data.turn})...`;

		case "plan_end": {
			const lines: string[] = [];
			if (data.reasoning) {
				for (const line of String(data.reasoning).split("\n")) {
					lines.push(`${prefix} ${line}`);
				}
			}
			if (data.text) {
				for (const line of String(data.text).split("\n")) {
					lines.push(`${prefix} ${line}`);
				}
			}
			return lines.length > 0 ? lines.join("\n") : null;
		}

		case "primitive_start": {
			const keyArg = primitiveKeyArg(data.name as string, data.args as Record<string, unknown>);
			return `${prefix}   ${data.name}${keyArg}`;
		}

		case "primitive_end": {
			const name = data.name;
			if (!data.success) {
				const errMsg = data.error ? ` \u2014 ${data.error}` : "";
				return `${prefix}   ${name}: failed${errMsg}`;
			}
			const output = data.output ? String(data.output) : "";
			const lineCount = output ? output.split("\n").length : 0;
			const suffix = lineCount > 0 ? ` (${lineCount} lines)` : "";
			return `${prefix}   ${name}: done${suffix}`;
		}

		case "act_start":
			return `${prefix} \u2192 ${data.agent_name}: ${data.goal}`;

		case "act_end": {
			if (!data.success) {
				return `${prefix} \u2190 ${data.agent_name}: failed`;
			}
			const turns = data.turns != null ? ` (${data.turns} turns)` : "";
			return `${prefix} \u2190 ${data.agent_name}: done${turns}`;
		}

		case "session_end":
			return `${prefix} Session complete. ${data.turns} turns, ${data.stumbles} stumbles.`;

		case "interrupted":
			return `${prefix} Interrupted: ${data.message ?? "user interrupt"}`;

		case "context_update":
			return null;

		case "compaction":
			return `${prefix} Context compacted: ${data.beforeCount} → ${data.afterCount} messages`;

		case "learn_start":
			return `${prefix} Learning from stumble...`;

		case "learn_mutation":
			return `${prefix}   Genome updated: ${data.mutation_type}`;

		case "warning":
			return `${prefix} \u26a0 ${data.message}`;

		case "error":
			return `${prefix} \u2717 ${data.error}`;

		default:
			return null;
	}
}

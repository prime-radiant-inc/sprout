import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "../kernel/types.ts";

const DEFAULT_GENOME_PATH = join(homedir(), ".local/share/sprout-genome");

export type CliCommand =
	| { kind: "run"; goal: string; genomePath: string }
	| { kind: "genome-list"; genomePath: string }
	| { kind: "genome-log"; genomePath: string }
	| { kind: "genome-rollback"; genomePath: string; commit: string }
	| { kind: "help" };

/** Parse CLI arguments (process.argv.slice(2)) into a typed command.
 * Note: --genome-path must come before --genome subcommands. */
export function parseArgs(argv: string[]): CliCommand {
	let genomePath = DEFAULT_GENOME_PATH;
	const rest: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;

		if (arg === "--help") {
			return { kind: "help" };
		}

		if (arg === "--genome-path") {
			genomePath = argv[++i] ?? DEFAULT_GENOME_PATH;
			continue;
		}

		if (arg === "--genome") {
			const sub = argv[++i];
			if (sub === "list") {
				return { kind: "genome-list", genomePath };
			}
			if (sub === "log") {
				return { kind: "genome-log", genomePath };
			}
			if (sub === "rollback") {
				const commit = argv[++i];
				if (!commit) return { kind: "help" };
				return { kind: "genome-rollback", genomePath, commit };
			}
			return { kind: "help" };
		}

		rest.push(arg);
	}

	if (rest.length === 0) {
		return { kind: "help" };
	}

	return { kind: "run", goal: rest.join(" "), genomePath };
}

/** Truncate text to maxLines, appending an ellipsis if truncated. */
export function truncateLines(text: string, maxLines: number): string {
	if (!text) return text;
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	const remaining = lines.length - maxLines;
	return lines.slice(0, maxLines).join("\n") + `\n... (${remaining} more lines)`;
}

/** Extract the key argument for a primitive (the most informative single arg). */
function primitiveKeyArg(name: string, args: Record<string, unknown> | undefined): string {
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

const USAGE = `Usage: sprout [options] <goal>

Commands:
  sprout "Fix the bug"                  Run agent with a goal
  sprout --genome list                  List agents in the genome
  sprout --genome log                   Show genome git log
  sprout --genome rollback <commit>     Revert a genome commit

Options:
  --genome-path <path>   Path to genome directory (default: ~/.local/share/sprout-genome)
  --help                 Show this help message`;

/** Execute a parsed CLI command. */
export async function runCli(command: CliCommand): Promise<void> {
	if (command.kind === "help") {
		console.log(USAGE);
		return;
	}

	if (command.kind === "genome-list") {
		const { Genome } = await import("../genome/genome.ts");
		const genome = new Genome(command.genomePath);
		await genome.loadFromDisk();
		const agents = genome.allAgents();
		if (agents.length === 0) {
			console.log("No agents in genome.");
		} else {
			for (const agent of agents) {
				console.log(`  ${agent.name} (v${agent.version}) — ${agent.description}`);
			}
		}
		return;
	}

	if (command.kind === "genome-log") {
		const proc = Bun.spawn(["git", "-C", command.genomePath, "log", "--oneline"], {
			stdout: "inherit",
			stderr: "inherit",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	if (command.kind === "genome-rollback") {
		const proc = Bun.spawn(
			["git", "-C", command.genomePath, "revert", "--no-edit", command.commit],
			{
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	// kind === "run"
	// Load environment variables from the .env file
	const { config } = await import("dotenv");
	config(); // loads .env from current working directory

	const { createAgent } = await import("../agents/factory.ts");
	const { submitGoal } = await import("./session.ts");

	const bootstrapDir = join(import.meta.dir, "../../bootstrap");
	const { agent, events, learnProcess } = await createAgent({
		genomePath: command.genomePath,
		bootstrapDir,
	});

	for await (const event of submitGoal(command.goal, { agent, events, learnProcess })) {
		const line = renderEvent(event);
		if (line !== null) {
			console.log(line);
		}
	}
}

if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	await runCli(command);
}

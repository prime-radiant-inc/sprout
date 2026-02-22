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

/** Render a SessionEvent as a terminal-friendly string. Returns null for events that shouldn't be shown. */
export function renderEvent(event: SessionEvent): string | null {
	const { kind, data } = event;

	switch (kind) {
		case "session_start":
			return "Starting session...";
		case "plan_start":
			return "Thinking...";
		case "act_start":
			return `\u2192 Delegating to ${data.agent_name}: ${data.goal}`;
		case "act_end":
			return `\u2190 ${data.agent_name}: ${data.success ? "done" : "failed"}`;
		case "primitive_start":
			return `  Running ${data.name}...`;
		case "primitive_end":
			return `  ${data.name}: ${data.success ? "done" : "failed"}`;
		case "learn_start":
			return "Learning from stumble...";
		case "learn_mutation":
			return `  Genome updated: ${data.mutation_type}`;
		case "session_end":
			return `Session complete. ${data.turns} turns, ${data.stumbles} stumbles.`;
		case "warning":
			return `\u26a0 ${data.message}`;
		case "error":
			return `\u2717 ${data.error}`;
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
	config({ path: join(import.meta.dir, "../../../serf/.env") });

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

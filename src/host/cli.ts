import { homedir } from "node:os";
import { join } from "node:path";
import { renderEvent } from "../tui/render-event.ts";

export { renderEvent, truncateLines } from "../tui/render-event.ts";

const DEFAULT_GENOME_PATH = join(homedir(), ".local/share/sprout-genome");

export type CliCommand =
	| { kind: "interactive"; genomePath: string }
	| { kind: "oneshot"; goal: string; genomePath: string }
	| { kind: "resume"; sessionId: string; genomePath: string }
	| { kind: "resume-last"; genomePath: string }
	| { kind: "list"; genomePath: string }
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

		if (arg === "--prompt") {
			const goal = argv.slice(i + 1).join(" ");
			if (!goal) return { kind: "help" };
			return { kind: "oneshot", goal, genomePath };
		}

		if (arg === "--resume") {
			const sessionId = argv[++i];
			if (!sessionId) return { kind: "help" };
			return { kind: "resume", sessionId, genomePath };
		}

		if (arg === "--resume-last") {
			return { kind: "resume-last", genomePath };
		}

		if (arg === "--list") {
			return { kind: "list", genomePath };
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
		return { kind: "interactive", genomePath };
	}

	return { kind: "oneshot", goal: rest.join(" "), genomePath };
}

const USAGE = `Usage: sprout [options] [goal]

Modes:
  sprout                                Interactive mode (default)
  sprout --prompt "Fix the bug"         One-shot mode
  sprout "Fix the bug"                  One-shot mode (bare goal)
  sprout --resume <session-id>          Resume a session
  sprout --resume-last                  Resume the most recent session
  sprout --list                         List all sessions

Genome management:
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

	if (command.kind === "interactive") {
		// Interactive mode will be wired in Task 13
		console.log("Interactive mode not yet implemented. Use --prompt for one-shot mode.");
		return;
	}

	if (command.kind === "resume" || command.kind === "resume-last") {
		// Resume will be wired in Task 13
		console.log("Resume not yet implemented.");
		return;
	}

	if (command.kind === "list") {
		// Session listing will be wired in Task 13
		console.log("Session listing not yet implemented.");
		return;
	}

	// kind === "oneshot"
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

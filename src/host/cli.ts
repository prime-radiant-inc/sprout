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

/** Handle SIGINT: interrupt if running, exit if idle. */
export function handleSigint(
	bus: { emitCommand(cmd: import("../kernel/types.ts").Command): void },
	controller: { isRunning: boolean },
	rl: { close(): void },
): void {
	if (controller.isRunning) {
		bus.emitCommand({ kind: "interrupt", data: {} });
	} else {
		rl.close();
	}
}

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

	if (command.kind === "list") {
		const { listSessions } = await import("./session-metadata.ts");
		const sessionsDir = join(command.genomePath, "../sprout-sessions");
		const sessions = await listSessions(sessionsDir);
		if (sessions.length === 0) {
			console.log("No sessions found.");
		} else {
			for (const s of sessions) {
				console.log(
					`  ${s.sessionId.slice(0, 8)}... | ${s.status} | ${s.turns} turns | ${s.agentSpec} | ${s.createdAt}`,
				);
			}
		}
		return;
	}

	// All remaining modes need dotenv + SessionController setup
	const { config } = await import("dotenv");
	config();

	const { EventBus } = await import("./event-bus.ts");
	const { SessionController } = await import("./session-controller.ts");

	const bootstrapDir = join(import.meta.dir, "../../bootstrap");
	const sessionsDir = join(command.genomePath, "../sprout-sessions");

	if (command.kind === "oneshot") {
		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: command.genomePath,
			sessionsDir,
			bootstrapDir,
		});

		bus.onEvent((event) => {
			const line = renderEvent(event);
			if (line !== null) console.log(line);
		});

		await controller.submitGoal(command.goal);
		return;
	}

	let resumeSessionId: string | undefined;
	let resumeHistory: import("../llm/types.ts").Message[] | undefined;

	if (command.kind === "resume" || command.kind === "resume-last") {
		const { listSessions } = await import("./session-metadata.ts");
		const { replayEventLog } = await import("./resume.ts");

		let sessionId: string;
		if (command.kind === "resume-last") {
			const sessions = await listSessions(sessionsDir);
			if (sessions.length === 0) {
				console.log("No sessions found.");
				return;
			}
			sessionId = sessions[sessions.length - 1]!.sessionId;
		} else {
			sessionId = command.sessionId;
		}

		const logPath = join(sessionsDir, `${sessionId}.jsonl`);
		const history = await replayEventLog(logPath);
		console.log(
			`Resumed session ${sessionId.slice(0, 8)}... with ${history.length} messages of history`,
		);

		resumeSessionId = sessionId;
		resumeHistory = history;
	}

	// Interactive mode (also reached via resume)
	const bus = new EventBus();
	const controller = new SessionController({
		bus,
		genomePath: command.genomePath,
		sessionsDir,
		bootstrapDir,
		sessionId: resumeSessionId,
		initialHistory: resumeHistory,
	});

	const readline = await import("node:readline");
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

	const { InputHistory } = await import("../tui/history.ts");
	const historyPath = join(command.genomePath, "../sprout-history");
	const inputHistory = new InputHistory(historyPath);
	await inputHistory.load();

	// Feed saved history into readline for up-arrow support
	const rlHistory = (rl as any).history;
	if (Array.isArray(rlHistory)) {
		for (const entry of inputHistory.all().reverse()) {
			rlHistory.push(entry);
		}
	}

	process.on("SIGINT", () => handleSigint(bus, controller, rl));

	bus.onEvent((event) => {
		const line = renderEvent(event);
		if (line !== null) console.log(line);
	});

	console.log(`Sprout interactive mode (session: ${controller.sessionId.slice(0, 8)}...)`);
	console.log("Type a goal, or /help for commands. /quit to exit.\n");

	const { parseSlashCommand } = await import("../tui/slash-commands.ts");

	rl.on("line", (input: string) => {
		const trimmed = input.trim();
		if (!trimmed) return;

		const slash = parseSlashCommand(trimmed);
		if (slash) {
			if (slash.kind === "quit") {
				bus.emitCommand({ kind: "quit", data: {} });
				rl.close();
				return;
			}
			if (slash.kind === "help") {
				console.log("Commands: /help, /quit, /compact, /clear, /model [name], /status");
				return;
			}
			if (slash.kind === "compact") {
				bus.emitCommand({ kind: "compact", data: {} });
				return;
			}
			if (slash.kind === "clear") {
				bus.emitCommand({ kind: "clear", data: {} });
				return;
			}
			if (slash.kind === "switch_model") {
				bus.emitCommand({ kind: "switch_model", data: { model: slash.model } });
				console.log(slash.model ? `Model set to: ${slash.model}` : "Model reset to default");
				return;
			}
			if (slash.kind === "status") {
				console.log(
					`Session: ${controller.sessionId.slice(0, 8)}... | ${controller.isRunning ? "running" : "idle"} | model: ${controller.currentModel ?? "default"}`,
				);
				return;
			}
			if (slash.kind === "unknown") {
				console.log(`Unknown command: ${slash.raw}`);
				return;
			}
			return;
		}

		inputHistory.add(trimmed);
		bus.emitCommand({ kind: "submit_goal", data: { goal: trimmed } });
	});

	await new Promise<void>((resolve) => rl.on("close", resolve));
	await inputHistory.save();
}

if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	await runCli(command);
}

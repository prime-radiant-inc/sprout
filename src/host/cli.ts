import { homedir } from "node:os";
import { join } from "node:path";
import { renderEvent } from "../tui/render-event.ts";

export { renderEvent, truncateLines } from "../tui/render-event.ts";

const DEFAULT_GENOME_PATH = join(homedir(), ".local/share/sprout-genome");

function printResumeHint(sessionId: string): void {
	console.error(`\nTo resume this session:\n  sprout --resume ${sessionId}\n`);
}

/** Returns the path to the persistent input history file inside the genome directory. */
export function inputHistoryPath(genomePath: string): string {
	return join(genomePath, "input_history.txt");
}

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

export type SlashCommandResult =
	| { action: "none" }
	| { action: "show_model_picker" }
	| { action: "exit" };

/** Handle a slash command from the TUI input area. */
export function handleSlashCommand(
	cmd: import("../tui/slash-commands.ts").SlashCommand,
	bus: {
		emitCommand(cmd: import("../kernel/types.ts").Command): void;
		emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>): void;
	},
	controller: { sessionId: string; isRunning: boolean; currentModel: string | undefined },
): SlashCommandResult {
	switch (cmd.kind) {
		case "quit":
			bus.emitCommand({ kind: "quit", data: {} });
			return { action: "exit" };
		case "help":
			bus.emitEvent("warning", "cli", 0, {
				message:
					"Commands: /help, /quit, /compact, /clear, /model [name], /status\nKeys: Ctrl+J = newline, Ctrl+C = interrupt/exit",
			});
			break;
		case "compact":
			bus.emitCommand({ kind: "compact", data: {} });
			break;
		case "clear":
			bus.emitCommand({ kind: "clear", data: {} });
			break;
		case "switch_model":
			if (cmd.model) {
				bus.emitCommand({ kind: "switch_model", data: { model: cmd.model } });
				bus.emitEvent("warning", "cli", 0, {
					message: `Model set to: ${cmd.model}`,
				});
			} else {
				return { action: "show_model_picker" };
			}
			break;
		case "status":
			bus.emitEvent("warning", "cli", 0, {
				message: `Session: ${controller.sessionId} | ${controller.isRunning ? "running" : "idle"} | model: ${controller.currentModel ?? "default"}`,
			});
			break;
		case "unknown":
			bus.emitEvent("warning", "cli", 0, {
				message: `Unknown command: ${cmd.raw}`,
			});
			break;
	}
	return { action: "none" };
}

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
		const sessionsDir = join(command.genomePath, "sessions");
		const sessions = await listSessions(sessionsDir);
		if (sessions.length === 0) {
			console.log("No sessions found.");
			return;
		}

		const { render } = await import("ink");
		const React = await import("react");
		const { SessionPicker } = await import("../tui/session-picker.tsx");

		const selectedId = await new Promise<string | null>((resolve) => {
			const { unmount } = render(
				React.createElement(SessionPicker, {
					sessions,
					onSelect: (id: string) => {
						unmount();
						resolve(id);
					},
					onCancel: () => {
						unmount();
						resolve(null);
					},
				}),
			);
		});

		if (selectedId) {
			// Resume the selected session
			await runCli({
				kind: "resume",
				sessionId: selectedId,
				genomePath: command.genomePath,
			});
		}
		return;
	}

	// All remaining modes need dotenv + SessionController setup
	const { config } = await import("dotenv");
	config();

	const { EventBus } = await import("./event-bus.ts");
	const { SessionController } = await import("./session-controller.ts");

	const bootstrapDir = join(import.meta.dir, "../../bootstrap");
	const sessionsDir = join(command.genomePath, "sessions");

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
		printResumeHint(controller.sessionId);
		return;
	}

	let resumeSessionId: string | undefined;
	let resumeHistory: import("../llm/types.ts").Message[] | undefined;
	let resumeEvents: import("../kernel/types.ts").SessionEvent[] | undefined;

	if (command.kind === "resume" || command.kind === "resume-last") {
		const { listSessions } = await import("./session-metadata.ts");
		const { replayEventLog } = await import("./resume.ts");
		const { readFile } = await import("node:fs/promises");

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

		const logPath = join(command.genomePath, "logs", `${sessionId}.jsonl`);
		const history = await replayEventLog(logPath);
		console.error(`Resumed session ${sessionId} with ${history.length} messages of history`);

		// Read raw events for display in the TUI
		try {
			const raw = await readFile(logPath, "utf-8");
			resumeEvents = raw
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((e): e is import("../kernel/types.ts").SessionEvent => e !== null);
		} catch {
			// Log file missing — no events to display
		}

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

	const { InputHistory } = await import("../tui/history.ts");
	const historyPath = inputHistoryPath(command.genomePath);
	const inputHistory = new InputHistory(historyPath);
	await inputHistory.load();

	const { render } = await import("ink");
	const React = await import("react");
	const { App } = await import("../tui/app.tsx");

	const { waitUntilExit, unmount } = render(
		React.createElement(App, {
			bus,
			sessionId: controller.sessionId,
			initialHistory: inputHistory.all(),
			initialEvents: resumeEvents,
			onSubmit: (text: string) => {
				inputHistory.add(text);
				bus.emitCommand({ kind: "submit_goal", data: { goal: text } });
			},
			onSlashCommand: (cmd: import("../tui/slash-commands.ts").SlashCommand) => {
				const result = handleSlashCommand(cmd, bus, controller);
				if (result.action === "exit") unmount();
			},
			onSteer: (text: string) => {
				inputHistory.add(text);
			},
			onExit: () => {
				bus.emitCommand({ kind: "quit", data: {} });
				unmount();
			},
		}),
		{ exitOnCtrlC: false },
	);

	// Ctrl+C is handled by InputArea via ink's useInput (\x03 keystroke)
	// with two-stage logic: first press interrupts, second press exits.
	// Ink's signal-exit dependency registers a SIGINT handler that re-raises
	// the signal to kill the process. In Bun, setRawMode may not fully
	// suppress OS-level SIGINT generation from Ctrl+C, so we must remove
	// signal-exit's listeners and register our own no-op to prevent death.
	for (const listener of process.listeners("SIGINT")) {
		process.removeListener("SIGINT", listener);
	}
	process.on("SIGINT", () => {});

	await waitUntilExit();
	process.removeAllListeners("SIGINT");
	await inputHistory.save();
	printResumeHint(controller.sessionId);
}

if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	await runCli(command);
}

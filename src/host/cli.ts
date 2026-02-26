import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BusClient } from "../bus/client.ts";
import type { BusServer } from "../bus/server.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import { renderEvent } from "../tui/render-event.ts";

export { renderEvent, truncateLines } from "../tui/render-event.ts";

const DEFAULT_GENOME_PATH = join(homedir(), ".local/share/sprout-genome");

export interface BusInfrastructureOptions {
	genomePath: string;
	sessionId: string;
}

export interface BusInfrastructure {
	server: BusServer;
	bus: BusClient;
	spawner: AgentSpawner;
	genome: import("../genome/genome.ts").Genome;
	cleanup: () => Promise<void>;
}

/**
 * Start the bus server, a connected client, genome mutation service, and
 * agent spawner. Returns a cleanup function that tears everything down.
 */
export async function startBusInfrastructure(
	options: BusInfrastructureOptions,
): Promise<BusInfrastructure> {
	const { BusServer } = await import("../bus/server.ts");
	const { BusClient } = await import("../bus/client.ts");
	const { AgentSpawner } = await import("../bus/spawner.ts");
	const { GenomeMutationService } = await import("../bus/genome-service.ts");
	const { Genome } = await import("../genome/genome.ts");

	const server = new BusServer({ port: 0 });
	await server.start();

	const bus = new BusClient(server.url);
	await bus.connect();

	// Load the genome for the mutation service
	const genome = new Genome(options.genomePath);
	try {
		await genome.loadFromDisk();
	} catch {
		// Genome may not exist yet; init will happen in createAgent
	}

	const genomeService = new GenomeMutationService({
		bus,
		genome,
		sessionId: options.sessionId,
	});
	await genomeService.start();

	const spawner = new AgentSpawner(bus, server.url, options.sessionId);

	const cleanup = async () => {
		await genomeService.stop();
		spawner.shutdown();
		await bus.disconnect();
		await server.stop();
	};

	return { server, bus, spawner, genome, cleanup };
}

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
	| { kind: "list"; genomePath: string } // session picker (via --resume with no arg)
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
			const next = argv[i + 1];
			if (!next || next.startsWith("-")) {
				// No session ID provided — show the session picker
				return { kind: "list", genomePath };
			}
			i++;
			return { kind: "resume", sessionId: next, genomePath };
		}

		if (arg === "--resume-last") {
			return { kind: "resume-last", genomePath };
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
  sprout --resume                       List sessions and pick one to resume
  sprout --resume <session-id>          Resume a specific session
  sprout --resume-last                  Resume the most recent session

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
export async function handleSlashCommand(
	cmd: import("../tui/slash-commands.ts").SlashCommand,
	bus: {
		emitCommand(cmd: import("../kernel/types.ts").Command): void;
		emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>): void;
	},
	controller: { sessionId: string; isRunning: boolean; currentModel: string | undefined },
): Promise<SlashCommandResult> {
	switch (cmd.kind) {
		case "quit":
			bus.emitCommand({ kind: "quit", data: {} });
			return { action: "exit" };
		case "help":
			bus.emitEvent("warning", "cli", 0, {
				message:
					"Commands: /help, /quit, /compact, /clear, /model [name], /status, /terminal-setup\nKeys: Shift+Enter = newline, Ctrl+J = newline (fallback), Ctrl+C = interrupt/exit",
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
		case "terminal_setup": {
			const message = await configureTerminal();
			bus.emitEvent("warning", "cli", 0, { message });
			break;
		}
		case "unknown":
			bus.emitEvent("warning", "cli", 0, {
				message: `Unknown command: ${cmd.raw}`,
			});
			break;
	}
	return { action: "none" };
}

export interface SpawnResult {
	exitCode: number;
	stdout: string;
}

export interface ConfigureTerminalOptions {
	spawn?: (args: string[]) => SpawnResult | Promise<SpawnResult>;
	tmuxConfPath?: string;
}

async function defaultSpawn(args: string[]): Promise<SpawnResult> {
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	return { exitCode, stdout };
}

const PLIST_PATH = `${homedir()}/Library/Preferences/com.apple.Terminal.plist`;

async function configureTerminalApp(
	spawn: (args: string[]) => SpawnResult | Promise<SpawnResult>,
): Promise<string> {
	// Read the active profile name
	const profileResult = await spawn([
		"/usr/libexec/PlistBuddy",
		"-c",
		"Print :Startup\\ Window\\ Settings",
		PLIST_PATH,
	]);
	const profile = profileResult.stdout.trim();
	if (profileResult.exitCode !== 0 || !profile) {
		return "Terminal.app: could not read active profile. Set Option as Meta Key manually:\n  Terminal > Settings > Profiles > Keyboard > Use Option as Meta Key";
	}

	// Set useOptionAsMetaKey = true
	await spawn([
		"/usr/libexec/PlistBuddy",
		"-c",
		`Set :Window\\ Settings:${profile}:useOptionAsMetaKey true`,
		PLIST_PATH,
	]);

	// Set Bell = false (suppress audible bell)
	await spawn([
		"/usr/libexec/PlistBuddy",
		"-c",
		`Set :Window\\ Settings:${profile}:Bell false`,
		PLIST_PATH,
	]);

	return `Terminal.app (profile "${profile}"): enabled Option as Meta Key and silenced audible bell.\nPlease restart Terminal.app for changes to take effect.`;
}

const TMUX_REQUIRED_LINES = [
	"set -s extended-keys on",
	"set -as terminal-features 'xterm*:extkeys'",
	"set -s extended-keys-format csi-u",
];

async function configureTmux(
	spawn: (args: string[]) => SpawnResult | Promise<SpawnResult>,
	confPath: string,
): Promise<string> {
	// Read existing config (or start fresh)
	let existing = "";
	try {
		existing = await readFile(confPath, "utf-8");
	} catch {
		// File doesn't exist yet — will create it
	}

	const missing = TMUX_REQUIRED_LINES.filter((line) => !existing.includes(line));

	if (missing.length === 0) {
		return "tmux: extended keyboard support is already configured.";
	}

	// Append missing lines
	const suffix =
		(existing.length > 0 && !existing.endsWith("\n") ? "\n" : "") +
		missing.map((l) => `${l}\n`).join("");
	await appendFile(confPath, suffix);

	// Reload tmux config
	await spawn(["tmux", "source-file", confPath]);

	return `tmux: added ${missing.length} line(s) to ${confPath} and reloaded:\n  ${missing.join("\n  ")}`;
}

/** Detect terminal environment, auto-configure where possible, and return a status message. */
export async function configureTerminal(options: ConfigureTerminalOptions = {}): Promise<string> {
	const spawn = options.spawn ?? defaultSpawn;
	const inTmux = !!process.env.TMUX;
	const termProgram = process.env.TERM_PROGRAM ?? "";
	const term = process.env.TERM ?? "";

	const sections: string[] = [];

	const nativeTerminals = ["kitty", "ghostty", "WezTerm", "WarpTerminal"];
	const isNative = nativeTerminals.some(
		(t) =>
			termProgram.toLowerCase().includes(t.toLowerCase()) ||
			term.toLowerCase().includes(t.toLowerCase()),
	);

	if (inTmux) {
		const tmuxConfPath = options.tmuxConfPath ?? join(homedir(), ".tmux.conf");
		const tmuxResult = await configureTmux(spawn, tmuxConfPath);
		sections.push(tmuxResult);
	}

	if (termProgram === "iTerm.app") {
		sections.push(
			"iTerm2 detected. Shift+Enter should work automatically.\n" +
				"If not: Preferences > Profiles > Keys > General > Report modifiers using CSI u",
		);
	} else if (termProgram === "Apple_Terminal") {
		const result = await configureTerminalApp(spawn);
		sections.push(result);
	} else if (termProgram === "vscode") {
		sections.push(
			'VS Code terminal detected. Add to settings.json:\n  "terminal.integrated.enableKittyKeyboardProtocol": true',
		);
	} else if (isNative) {
		sections.push(
			`${termProgram || term} detected. Extended keyboard support is built-in. No setup needed.`,
		);
	} else if (!inTmux) {
		sections.push(
			"Your terminal may need configuration for extended keyboard support.\n" +
				'Check your terminal\'s docs for "Kitty keyboard protocol" or "CSI u" support.',
		);
	}

	sections.push("Newline keys: Shift+Enter (primary), Alt+Enter, Ctrl+J (universal fallback)");

	return sections.join("\n\n");
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
		const { loadSessionSummaries } = await import("./session-metadata.ts");
		const sessionsDir = join(command.genomePath, "sessions");
		const logsDir = join(command.genomePath, "logs");
		const sessions = await loadSessionSummaries(sessionsDir, logsDir);
		if (sessions.length === 0) {
			console.log("No sessions found.");
			return;
		}

		const { render } = await import("ink");
		const React = await import("react");
		const { SessionPicker } = await import("../tui/session-picker.tsx");

		// Enter alternate screen so the picker doesn't pollute the scrollback buffer.
		process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

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
				{ kittyKeyboard: { mode: "enabled" as const } },
			);
		});

		// Exit alternate screen, restoring the previous terminal content.
		process.stdout.write("\x1b[?1049l");

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
	const { ulid } = await import("../util/ulid.ts");

	const bootstrapDir = join(import.meta.dir, "../../bootstrap");
	const sessionsDir = join(command.genomePath, "sessions");

	if (command.kind === "oneshot") {
		const sessionId = ulid();
		const infra = await startBusInfrastructure({
			genomePath: command.genomePath,
			sessionId,
		});

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath: command.genomePath,
			sessionsDir,
			bootstrapDir,
			sessionId,
			spawner: infra.spawner,
			genome: infra.genome,
		});

		bus.onEvent((event) => {
			const line = renderEvent(event);
			if (line !== null) console.log(line);
		});

		try {
			await controller.submitGoal(command.goal);
			printResumeHint(controller.sessionId);
		} finally {
			await infra.cleanup();
		}
		return;
	}

	let resumeSessionId: string | undefined;
	let resumeHistory: import("../llm/types.ts").Message[] | undefined;
	let resumeEvents: import("../kernel/types.ts").SessionEvent[] | undefined;
	let resumeCompletedHandles:
		| Array<{ handleId: string; result: import("../bus/types.ts").ResultMessage; ownerId: string }>
		| undefined;

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

		// Extract child handle info from the root log and reconstruct completed results
		const { extractChildHandles, checkHandleCompleted, readHandleResult } = await import(
			"../bus/resume.ts"
		);
		const childHandles = await extractChildHandles(logPath);
		if (childHandles.length > 0) {
			const handleLogDir = join(command.genomePath, "logs", sessionId);
			const completed: typeof resumeCompletedHandles = [];
			for (const handle of childHandles) {
				if (!handle.completed) {
					handle.completed = await checkHandleCompleted(handleLogDir, handle.handleId);
				}
				if (handle.completed) {
					const result = await readHandleResult(handleLogDir, handle.handleId);
					if (result) {
						completed.push({ handleId: handle.handleId, result, ownerId: "root" });
					}
				}
			}
			if (completed.length > 0) {
				resumeCompletedHandles = completed;
			}
			const completedCount = childHandles.filter((h) => h.completed).length;
			const pendingCount = childHandles.length - completedCount;
			console.error(
				`  Child handles: ${childHandles.length} total, ${completedCount} completed, ${pendingCount} pending`,
			);
		}

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
	const sessionId = resumeSessionId ?? ulid();
	const infra = await startBusInfrastructure({
		genomePath: command.genomePath,
		sessionId,
	});

	const bus = new EventBus();
	const controller = new SessionController({
		bus,
		genomePath: command.genomePath,
		sessionsDir,
		bootstrapDir,
		sessionId,
		initialHistory: resumeHistory,
		spawner: infra.spawner,
		genome: infra.genome,
		completedHandles: resumeCompletedHandles,
	});

	const { InputHistory } = await import("../tui/history.ts");
	const historyPath = inputHistoryPath(command.genomePath);
	const inputHistory = new InputHistory(historyPath);
	await inputHistory.load();

	const { render } = await import("ink");
	const React = await import("react");
	const { App } = await import("../tui/app.tsx");

	// Register a SIGINT handler BEFORE ink renders. Ink uses signal-exit
	// which registers its own SIGINT handler. signal-exit's handler checks
	// if it's the sole listener — if so, it re-kills the process via
	// process.kill(). By registering our handler first, signal-exit always
	// sees another listener and defers instead of killing.
	// This is necessary because Bun's setRawMode may not fully suppress
	// OS-level SIGINT generation from Ctrl+C (unlike Node which clears
	// the ISIG termios flag).
	//
	// Two-stage logic: first Ctrl+C interrupts (or warns if idle),
	// second Ctrl+C exits. The flag resets when a new goal starts running.
	let unmountFn: (() => void) | undefined;
	let pendingSigintExit = false;
	let pendingSigintTimer: ReturnType<typeof setTimeout> | null = null;
	const SIGINT_WINDOW = 5000;

	const clearSigintPending = () => {
		if (pendingSigintTimer) {
			clearTimeout(pendingSigintTimer);
			pendingSigintTimer = null;
		}
		pendingSigintExit = false;
	};
	// Reset when a new goal starts or when a keystroke cancels from InputArea
	bus.onEvent((event) => {
		if (event.kind === "perceive") clearSigintPending();
		if (event.kind === "exit_hint" && event.data.visible === false) clearSigintPending();
	});

	const sigintHandler = () => {
		if (pendingSigintExit) {
			clearSigintPending();
			bus.emitCommand({ kind: "quit", data: {} });
			unmountFn?.();
			return;
		}

		pendingSigintExit = true;
		pendingSigintTimer = setTimeout(() => {
			clearSigintPending();
			bus.emitEvent("exit_hint", "cli", 0, { visible: false });
		}, SIGINT_WINDOW);

		if (controller.isRunning) {
			bus.emitCommand({ kind: "interrupt", data: {} });
		} else {
			bus.emitEvent("exit_hint", "cli", 0, { visible: true });
		}
	};
	process.on("SIGINT", sigintHandler);

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
			onSlashCommand: async (cmd: import("../tui/slash-commands.ts").SlashCommand) => {
				const result = await handleSlashCommand(cmd, bus, controller);
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
		{ exitOnCtrlC: false, kittyKeyboard: { mode: "enabled" as const } },
	);
	unmountFn = unmount;

	await waitUntilExit();
	process.removeListener("SIGINT", sigintHandler);
	await infra.cleanup();
	await inputHistory.save();
	printResumeHint(controller.sessionId);
}

if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	await runCli(command);
}

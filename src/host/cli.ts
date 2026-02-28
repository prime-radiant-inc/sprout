import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

export interface WebFlags {
	web?: boolean;
	webOnly?: boolean;
	port?: number;
	host?: string;
}

export interface LogFlags {
	logStderr?: boolean;
	debug?: boolean;
}

export type CliCommand =
	| ({ kind: "interactive"; genomePath: string } & WebFlags & LogFlags)
	| { kind: "oneshot"; goal: string; genomePath: string }
	| ({ kind: "resume"; sessionId: string; genomePath: string } & WebFlags & LogFlags)
	| ({ kind: "resume-last"; genomePath: string } & WebFlags & LogFlags)
	| { kind: "list"; genomePath: string } // session picker (via --resume with no arg)
	| { kind: "genome-list"; genomePath: string }
	| { kind: "genome-log"; genomePath: string }
	| { kind: "genome-rollback"; genomePath: string; commit: string }
	| { kind: "genome-export"; genomePath: string }
	| { kind: "help" };

import { parseArgs as nodeParseArgs } from "node:util";

/** Only include truthy/defined values, keeping result objects clean. */
function collectFlags(opts: {
	web: boolean;
	webOnly: boolean;
	port: number | undefined;
	host: string | undefined;
	logStderr: boolean;
	debug: boolean;
}): WebFlags & LogFlags {
	const out: WebFlags & LogFlags = {};
	if (opts.web) out.web = true;
	if (opts.webOnly) out.webOnly = true;
	if (opts.port !== undefined) out.port = opts.port;
	if (opts.host !== undefined) out.host = opts.host;
	if (opts.logStderr) out.logStderr = true;
	if (opts.debug) out.debug = true;
	return out;
}

/** Known flags for validating prefix args in pre-scan paths. */
const KNOWN_FLAGS = new Set([
	"--help",
	"--genome-path",
	"--web",
	"--web-only",
	"--port",
	"--host",
	"--log-stderr",
	"--debug",
	"--prompt",
	"--resume",
	"--resume-last",
	"--genome",
]);

/** Check that all --flags in an arg list are known. */
function hasUnknownFlags(args: string[]): boolean {
	return args.some((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a));
}

/** Parse CLI arguments (process.argv.slice(2)) into a typed command. */
export function parseArgs(argv: string[]): CliCommand {
	// Pre-scan for --prompt: it consumes all remaining args as the goal,
	// which doesn't fit node:util.parseArgs' model. Handle it separately.
	const promptIdx = argv.indexOf("--prompt");
	if (promptIdx !== -1) {
		const goal = argv.slice(promptIdx + 1).join(" ");
		if (!goal) return { kind: "help" };
		const prefix = argv.slice(0, promptIdx);
		if (hasUnknownFlags(prefix)) return { kind: "help" };
		const gpIdx = prefix.indexOf("--genome-path");
		const genomePath =
			gpIdx !== -1 ? (prefix[gpIdx + 1] ?? DEFAULT_GENOME_PATH) : DEFAULT_GENOME_PATH;
		return { kind: "oneshot", goal, genomePath };
	}

	// Pre-scan for --genome subcommand: it consumes 1-2 positional tokens
	// that would confuse the main parser.
	const genomeIdx = argv.indexOf("--genome");
	if (genomeIdx !== -1) {
		const sub = argv[genomeIdx + 1];
		const prefix = argv.slice(0, genomeIdx);
		const gpIdx = prefix.indexOf("--genome-path");
		const genomePath =
			gpIdx !== -1 ? (prefix[gpIdx + 1] ?? DEFAULT_GENOME_PATH) : DEFAULT_GENOME_PATH;
		if (sub === "list") return { kind: "genome-list", genomePath };
		if (sub === "log") return { kind: "genome-log", genomePath };
		if (sub === "rollback") {
			const commit = argv[genomeIdx + 2];
			if (!commit) return { kind: "help" };
			return { kind: "genome-rollback", genomePath, commit };
		}
		if (sub === "export") return { kind: "genome-export", genomePath };
		return { kind: "help" };
	}

	// Pre-scan for --resume with no value: node:util.parseArgs with
	// type: "string" throws if no value follows. Detect this case and
	// rewrite argv so the main parser sees --resume-list instead.
	const resumeIdx = argv.indexOf("--resume");
	if (resumeIdx !== -1) {
		const next = argv[resumeIdx + 1];
		if (next === undefined || next.startsWith("-")) {
			// Bare --resume → session picker. Remove it and parse remaining flags,
			// then return "list" (which doesn't carry web/log flags).
			const without = [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 1)];
			// Validate remaining flags
			if (hasUnknownFlags(without)) return { kind: "help" };
			const gpIdx = without.indexOf("--genome-path");
			const genomePath =
				gpIdx !== -1 ? (without[gpIdx + 1] ?? DEFAULT_GENOME_PATH) : DEFAULT_GENOME_PATH;
			return { kind: "list", genomePath };
		}
	}

	let parsed: ReturnType<typeof nodeParseArgs>;
	try {
		parsed = nodeParseArgs({
			args: argv,
			strict: true,
			allowPositionals: true,
			options: {
				help: { type: "boolean" },
				"genome-path": { type: "string" },
				web: { type: "boolean" },
				"web-only": { type: "boolean" },
				port: { type: "string" }, // parsed as string, validated below
				host: { type: "string" },
				"log-stderr": { type: "boolean" },
				debug: { type: "boolean" },
				resume: { type: "string" },
				"resume-last": { type: "boolean" },
			},
		});
	} catch {
		// Unknown flag or missing value → show help
		return { kind: "help" };
	}

	const vals = parsed.values;
	if (vals.help) return { kind: "help" };

	const genomePath = (vals["genome-path"] as string | undefined) ?? DEFAULT_GENOME_PATH;

	// Validate --port
	let port: number | undefined;
	if (vals.port !== undefined) {
		const n = Number(vals.port);
		if (Number.isNaN(n) || n <= 0) return { kind: "help" };
		port = n;
	}

	const flags = collectFlags({
		web: vals.web === true,
		webOnly: vals["web-only"] === true,
		port,
		host: vals.host as string | undefined,
		logStderr: vals["log-stderr"] === true,
		debug: vals.debug === true,
	});

	// --resume: node:util.parseArgs treats it as a string option.
	// If the user wrote `--resume` with no value, parseArgs in strict mode
	// will throw (caught above). But `--resume` followed by another flag
	// like `--resume --web` will also throw. We handle the "no session ID"
	// case by checking if the value looks like a flag (shouldn't happen with
	// strict mode, but defensive). For bare `--resume` we need a pre-scan.
	if (vals.resume !== undefined) {
		const sessionId = vals.resume as string;
		if (!sessionId || sessionId.startsWith("-")) {
			return { kind: "list", genomePath };
		}
		return { kind: "resume", sessionId, genomePath, ...flags };
	}

	if (vals["resume-last"]) {
		return { kind: "resume-last", genomePath, ...flags };
	}

	const positionals = parsed.positionals;
	if (positionals.length === 0) {
		return { kind: "interactive", genomePath, ...flags };
	}

	return { kind: "oneshot", goal: positionals.join(" "), genomePath };
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
  sprout --genome export                Show learnings that evolved beyond bootstrap

Web interface:
  --web                  Start web server alongside TUI
  --web-only             Start web server without TUI (headless/remote)
  --port <port>          Web server port (default: 7777)
  --host <addr>          Web server bind address (default: localhost, use 0.0.0.0 for all interfaces)
  /web, /web stop        Start/stop web server from interactive mode

Logging:
  --log-stderr           Print log entries to stderr (info level and above)
  --debug                Include debug-level entries (use with --log-stderr)

Options:
  --genome-path <path>   Path to genome directory (default: ~/.local/share/sprout-genome)
  --help                 Show this help message`;

export type SlashCommandResult =
	| { action: "none" }
	| { action: "show_model_picker" }
	| { action: "start_web" }
	| { action: "stop_web" }
	| { action: "exit" };

/** Handle a slash command from the TUI input area. */
export async function handleSlashCommand(
	cmd: import("../tui/slash-commands.ts").SlashCommand,
	bus: {
		emitCommand(cmd: import("../kernel/types.ts").Command): void;
		emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>): void;
	},
	controller: { sessionId: string; isRunning: boolean; currentModel: string | undefined },
	terminalOptions?: ConfigureTerminalOptions,
): Promise<SlashCommandResult> {
	switch (cmd.kind) {
		case "quit":
			bus.emitCommand({ kind: "quit", data: {} });
			return { action: "exit" };
		case "help":
			bus.emitEvent("warning", "cli", 0, {
				message:
					"Commands: /help, /quit, /compact, /clear, /model [name], /status, /terminal-setup, /web, /web stop\nKeys: Shift+Enter = newline, Ctrl+J = newline (fallback), Ctrl+C = interrupt/exit",
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
			const message = await configureTerminal(terminalOptions);
			bus.emitEvent("warning", "cli", 0, { message });
			break;
		}
		case "web":
			return { action: "start_web" };
		case "web_stop":
			return { action: "stop_web" };
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
	plistPath?: string;
}

async function defaultSpawn(args: string[]): Promise<SpawnResult> {
	try {
		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		return { exitCode, stdout };
	} catch {
		return { exitCode: 1, stdout: "" };
	}
}

const PLIST_PATH = `${homedir()}/Library/Preferences/com.apple.Terminal.plist`;

/** Set or Add a PlistBuddy key. Returns true if the value was applied. */
async function plistSet(
	spawn: (args: string[]) => SpawnResult | Promise<SpawnResult>,
	plistPath: string,
	profilePath: string,
	key: string,
	type: string,
	value: string,
): Promise<boolean> {
	const setResult = await spawn([
		"/usr/libexec/PlistBuddy",
		"-c",
		`Set ${profilePath}:${key} ${value}`,
		plistPath,
	]);
	if (setResult.exitCode === 0) return true;

	// Key may not exist yet — try Add
	const addResult = await spawn([
		"/usr/libexec/PlistBuddy",
		"-c",
		`Add ${profilePath}:${key} ${type} ${value}`,
		plistPath,
	]);
	return addResult.exitCode === 0;
}

async function configureTerminalApp(
	spawn: (args: string[]) => SpawnResult | Promise<SpawnResult>,
	plistPath: string,
): Promise<string> {
	// Read the active profile name
	const profileResult = await spawn([
		"/usr/libexec/PlistBuddy",
		"-c",
		"Print :Startup\\ Window\\ Settings",
		plistPath,
	]);
	const profile = profileResult.stdout.trim();
	if (profileResult.exitCode !== 0 || !profile) {
		return "Terminal.app: could not read active profile. Set manually:\n  Terminal > Settings > Profiles > Keyboard > Use Option as Meta Key\n  Terminal > Settings > Profiles > Advanced > uncheck Audible bell";
	}

	// Escape spaces in profile name for PlistBuddy key paths
	const escapedProfile = profile.replace(/ /g, "\\ ");
	const profilePath = `:Window\\ Settings:${escapedProfile}`;

	const metaOk = await plistSet(
		spawn,
		plistPath,
		profilePath,
		"useOptionAsMetaKey",
		"bool",
		"true",
	);
	const bellOk = await plistSet(spawn, plistPath, profilePath, "Bell", "bool", "false");

	if (!metaOk || !bellOk) {
		const failed = [!metaOk && "Option as Meta Key", !bellOk && "Bell"].filter(Boolean).join(", ");
		const instructions = [
			!metaOk && "Terminal > Settings > Profiles > Keyboard > Use Option as Meta Key",
			!bellOk && "Terminal > Settings > Profiles > Advanced > uncheck Audible bell",
		].filter(Boolean);
		return `Terminal.app: failed to set ${failed} on profile "${profile}". Set manually:\n  ${instructions.join("\n  ")}`;
	}

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

	const activeLines = new Set(
		existing
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => !l.startsWith("#"))
			.map((l) => l.replace(/#.*$/, "").trim()),
	);
	const missing = TMUX_REQUIRED_LINES.filter((line) => !activeLines.has(line));

	if (missing.length === 0) {
		return "tmux: extended keyboard support is already configured.";
	}

	// Append missing lines
	const suffix =
		(existing.length > 0 && !existing.endsWith("\n") ? "\n" : "") +
		missing.map((l) => `${l}\n`).join("");
	try {
		await appendFile(confPath, suffix);
	} catch {
		return `Could not write to ${confPath}. Please add these lines manually:\n  ${missing.join("\n  ")}`;
	}

	// Reload tmux config
	const reloadResult = await spawn(["tmux", "source-file", confPath]);

	if (reloadResult.exitCode !== 0) {
		return `tmux: added ${missing.length} line(s) to ${confPath} but could not reload. Run manually:\n  tmux source-file ${confPath}\nLines added:\n  ${missing.join("\n  ")}`;
	}

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
		const plistPath = options.plistPath ?? PLIST_PATH;
		const result = await configureTerminalApp(spawn, plistPath);
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

	if (command.kind === "genome-export") {
		const { exportLearnings, stageLearnings } = await import("../genome/export-learnings.ts");
		const bootstrapDir = join(import.meta.dir, "../../bootstrap");

		let result: Awaited<ReturnType<typeof exportLearnings>>;
		try {
			result = await exportLearnings(command.genomePath, bootstrapDir);
		} catch (err) {
			console.error(`Failed to load genome at ${command.genomePath}: ${err instanceof Error ? err.message : err}`);
			process.exitCode = 1;
			return;
		}

		if (result.evolved.length === 0 && result.genomeOnly.length === 0) {
			console.log("No learnings to export. Genome matches bootstrap.");
			return;
		}

		if (result.evolved.length > 0) {
			console.log("\nEvolved agents (genome improved beyond bootstrap):");
			for (const agent of result.evolved) {
				console.log(`  ${agent.name}: v${agent.bootstrapVersion} → v${agent.genomeVersion}`);
			}
		}

		if (result.genomeOnly.length > 0) {
			console.log("\nGenome-only agents (created by learn process):");
			for (const agent of result.genomeOnly) {
				console.log(`  ${agent.name} (v${agent.version}) — ${agent.description}`);
			}
		}

		const stagingDir = await mkdtemp(join(tmpdir(), "sprout-export-"));
		const written = await stageLearnings(result.genome, result, stagingDir);
		console.log(`\nWrote ${written.length} agent YAML files to: ${stagingDir}/`);
		console.log("Copy desired files to bootstrap/ to incorporate learnings.");
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

	// Early check: warn if no LLM API keys are available
	if (
		!process.env.ANTHROPIC_API_KEY &&
		!process.env.OPENAI_API_KEY &&
		!process.env.GEMINI_API_KEY &&
		!process.env.GOOGLE_API_KEY
	) {
		console.error(
			"[sprout] Warning: No LLM API keys found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.\n" +
				"         Ensure your .env file is in the working directory, or export the variables directly.",
		);
	}

	const { EventBus } = await import("./event-bus.ts");
	const { SessionController } = await import("./session-controller.ts");
	const { ulid } = await import("../util/ulid.ts");

	const bootstrapDir = join(import.meta.dir, "../../bootstrap");
	const sessionsDir = join(command.genomePath, "sessions");

	const { SessionLogger } = await import("./logger.ts");
	const { loggingMiddleware } = await import("../llm/logging-middleware.ts");

	if (command.kind === "oneshot") {
		const sessionId = ulid();
		const infra = await startBusInfrastructure({
			genomePath: command.genomePath,
			sessionId,
		});

		const bus = new EventBus();
		const logPath = join(command.genomePath, "logs", sessionId, "session.log.jsonl");
		const logger = new SessionLogger({ logPath, component: "cli", sessionId, bus });
		const { Client } = await import("../llm/client.ts");
		const llmClient = Client.fromEnv({ middleware: [loggingMiddleware(logger)] });

		const controller = new SessionController({
			bus,
			genomePath: command.genomePath,
			sessionsDir,
			bootstrapDir,
			sessionId,
			spawner: infra.spawner,
			genome: infra.genome,
			logger,
			client: llmClient,
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
	const logPath = join(command.genomePath, "logs", sessionId, "session.log.jsonl");
	const stderrLevel = command.logStderr
		? command.debug
			? ("debug" as const)
			: ("info" as const)
		: undefined;
	const logger = new SessionLogger({ logPath, component: "cli", sessionId, bus, stderrLevel });
	if (stderrLevel) {
		logger.info("session", "Logging to stderr enabled", { level: stderrLevel, sessionId });
	}
	const { Client } = await import("../llm/client.ts");
	const llmClient = Client.fromEnv({ middleware: [loggingMiddleware(logger)] });

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
		logger,
		client: llmClient,
	});

	// Fetch available models from provider APIs
	const { getAvailableModels } = await import("../agents/model-resolver.ts");
	const modelsByProvider = await llmClient.listModelsByProvider();
	const availableModels = getAvailableModels(modelsByProvider);

	// Start web server if requested (webPort also used by /web slash command)
	const webPort = command.port ?? 7777;
	const webHost = command.host;
	const staticDir = join(import.meta.dir, "../../web/dist");
	let webServer: import("../web/server.ts").WebServer | null = null;
	if (command.web || command.webOnly) {
		const { WebServer } = await import("../web/server.ts");
		webServer = new WebServer({
			bus,
			port: webPort,
			staticDir,
			sessionId,
			hostname: webHost,
			initialEvents: resumeEvents,
			availableModels,
			logger,
		});
		await webServer.start();
		const displayHost = webHost ?? "localhost";
		logger.info("session", "Web server started", { host: displayHost, port: webPort });
		console.error(`Web UI: http://${displayHost}:${webPort}`);
	}

	if (command.webOnly) {
		// Headless mode: no TUI, wait for quit command via web interface
		const webOnlySigintHandler = () => {
			bus.emitCommand({ kind: "quit", data: {} });
		};
		const quitPromise = new Promise<void>((resolve) => {
			bus.onCommand((cmd) => {
				if (cmd.kind === "quit") resolve();
			});
			process.on("SIGINT", webOnlySigintHandler);
		});
		await quitPromise;
		process.removeListener("SIGINT", webOnlySigintHandler);
		await webServer!.stop();
		await infra.cleanup();
		printResumeHint(controller.sessionId);
		return;
	}

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
				else if (result.action === "start_web") {
					if (webServer) {
						bus.emitEvent("warning", "cli", 0, {
							message: `Web UI already running at http://localhost:${webPort}`,
						});
					} else {
						(async () => {
							try {
								const { WebServer } = await import("../web/server.ts");
								webServer = new WebServer({
									bus,
									port: webPort,
									staticDir,
									sessionId,
									availableModels,
									logger,
								});
								await webServer.start();
								bus.emitEvent("warning", "cli", 0, {
									message: `Web UI: http://localhost:${webPort}`,
								});
								// TODO: macOS-only. On Linux use xdg-open, on Windows use start.
								Bun.spawn(["open", `http://localhost:${webPort}`]);
							} catch (err) {
								bus.emitEvent("error", "cli", 0, { error: String(err) });
							}
						})();
					}
				} else if (result.action === "stop_web") {
					if (webServer) {
						const server = webServer;
						webServer = null;
						(async () => {
							try {
								await server.stop();
								bus.emitEvent("warning", "cli", 0, { message: "Web server stopped." });
							} catch (err) {
								bus.emitEvent("error", "cli", 0, { error: String(err) });
							}
						})();
					} else {
						bus.emitEvent("warning", "cli", 0, { message: "Web server is not running." });
					}
				}
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
	if (webServer) await webServer.stop();
	await infra.cleanup();
	await inputHistory.save();
	printResumeHint(controller.sessionId);
}

if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	await runCli(command);
}

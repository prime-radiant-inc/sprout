import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BusClient } from "../bus/client.ts";
import type { BusServer } from "../bus/server.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import { formatSessionSelectionRequest } from "../shared/session-selection.ts";
import { projectDataDir as computeProjectDataDir } from "../util/project-id.ts";
import { bootstrapInteractiveRuntime } from "./cli-bootstrap.ts";
import { isGenomeCommand, runGenomeCommand } from "./cli-genome.ts";
import { type InteractiveModeOptions, runInteractiveMode } from "./cli-interactive.ts";
import { runListMode } from "./cli-list.ts";
import { runOneshotMode } from "./cli-oneshot.ts";
import { loadResumeState } from "./cli-resume.ts";

export { renderEvent, truncateLines } from "../tui/render-event.ts";

export function defaultGenomePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const explicitGenomePath = env.SPROUT_GENOME_PATH?.trim();
	if (explicitGenomePath) return explicitGenomePath;

	const xdgDataHome = env.XDG_DATA_HOME?.trim();
	if (xdgDataHome) return join(xdgDataHome, "sprout-genome");

	return join(homedir(), ".local/share/sprout-genome");
}

export interface BusInfrastructureOptions {
	genomePath: string;
	sessionId: string;
	rootDir?: string;
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
	const genome = new Genome(options.genomePath, options.rootDir);
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

/**
 * Resolve the project root directory.
 * For git repos, uses the active checkout root (works for worktrees too).
 * Falls back to cwd.
 */
export async function resolveProjectDir(): Promise<string> {
	try {
		const { execSync } = await import("node:child_process");
		// git rev-parse --show-toplevel resolves to the active checkout root.
		// In worktrees this is the worktree directory, not the main repo path.
		const topLevel = execSync("git rev-parse --show-toplevel", {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return topLevel;
	} catch {
		return process.cwd();
	}
}

/** Returns the path to the persistent input history file inside the genome directory. */
export function inputHistoryPath(genomePath: string): string {
	return join(genomePath, "input_history.txt");
}

export function buildInteractiveModeRuntime(
	runtime: Awaited<ReturnType<typeof bootstrapInteractiveRuntime>>,
): InteractiveModeOptions["runtime"] {
	return {
		bus: runtime.bus as import("./event-bus.ts").EventBus,
		logger: runtime.logger as import("./logger.ts").SessionLogger,
		controller: runtime.controller as import("./session-controller.ts").SessionController,
		availableModels: runtime.availableModels,
		settingsControlPlane:
			runtime.settingsControlPlane as InteractiveModeOptions["runtime"]["settingsControlPlane"],
	};
}

export interface WebFlags {
	web?: boolean;
	webOnly?: boolean;
	port?: number;
	host?: string;
	webToken?: string;
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
	| { kind: "genome-sync"; genomePath: string }
	| { kind: "help" };

import { parseArgs as nodeParseArgs } from "node:util";

/** Only include truthy/defined values, keeping result objects clean. */
function collectFlags(opts: {
	web: boolean;
	webOnly: boolean;
	port: number | undefined;
	host: string | undefined;
	webToken: string | undefined;
	logStderr: boolean;
	debug: boolean;
}): WebFlags & LogFlags {
	const out: WebFlags & LogFlags = {};
	if (opts.web) out.web = true;
	if (opts.webOnly) out.webOnly = true;
	if (opts.port !== undefined) out.port = opts.port;
	if (opts.host !== undefined) out.host = opts.host;
	if (opts.webToken !== undefined) out.webToken = opts.webToken;
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
	"--web-token",
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
	const defaultGenomePath = defaultGenomePathFromEnv();
	// Pre-scan for --prompt: it consumes all remaining args as the goal,
	// which doesn't fit node:util.parseArgs' model. Handle it separately.
	const promptIdx = argv.indexOf("--prompt");
	if (promptIdx !== -1) {
		const goal = argv.slice(promptIdx + 1).join(" ");
		if (!goal) return { kind: "help" };
		const prefix = argv.slice(0, promptIdx);
		if (hasUnknownFlags(prefix)) return { kind: "help" };
		const gpIdx = prefix.indexOf("--genome-path");
		const genomePath = gpIdx !== -1 ? (prefix[gpIdx + 1] ?? defaultGenomePath) : defaultGenomePath;
		return { kind: "oneshot", goal, genomePath };
	}

	// Pre-scan for --genome subcommand: it consumes 1-2 positional tokens
	// that would confuse the main parser.
	const genomeIdx = argv.indexOf("--genome");
	if (genomeIdx !== -1) {
		const sub = argv[genomeIdx + 1];
		const prefix = argv.slice(0, genomeIdx);
		const gpIdx = prefix.indexOf("--genome-path");
		const genomePath = gpIdx !== -1 ? (prefix[gpIdx + 1] ?? defaultGenomePath) : defaultGenomePath;
		if (sub === "list") return { kind: "genome-list", genomePath };
		if (sub === "log") return { kind: "genome-log", genomePath };
		if (sub === "rollback") {
			const commit = argv[genomeIdx + 2];
			if (!commit) return { kind: "help" };
			return { kind: "genome-rollback", genomePath, commit };
		}
		if (sub === "export") return { kind: "genome-export", genomePath };
		if (sub === "sync") return { kind: "genome-sync", genomePath };
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
				gpIdx !== -1 ? (without[gpIdx + 1] ?? defaultGenomePath) : defaultGenomePath;
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
				"web-token": { type: "string" },
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

	const genomePath = (vals["genome-path"] as string | undefined) ?? defaultGenomePath;

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
		webToken: vals["web-token"] as string | undefined,
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
  sprout --genome sync                  Sync root agents to runtime genome
  sprout --genome rollback <commit>     Revert a genome commit
  sprout --genome export                Show learnings that evolved beyond root specs

Web interface:
  --web                  Start web server alongside TUI
  --web-only             Start web server without TUI (headless/remote)
  --port <port>          Web server port (default: 7777)
  --host <addr>          Web server bind address (default: localhost, use 0.0.0.0 for all interfaces)
  --web-token <token>    WebSocket auth token (required for non-localhost binds)
  /web, /web stop        Start/stop web server from interactive mode

Logging:
  --log-stderr           Print log entries to stderr (info level and above)
  --debug                Include debug-level entries (use with --log-stderr)

Options:
  --genome-path <path>   Path to genome directory (default: $SPROUT_GENOME_PATH or $XDG_DATA_HOME/sprout-genome or ~/.local/share/sprout-genome)
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
					"Commands: /help, /quit, /compact, /clear, /model [name], /settings, /status, /terminal-setup, /web, /web stop\nKeys: Shift+Enter = newline, Ctrl+J = newline (fallback), Ctrl+C = interrupt/exit",
			});
			break;
		case "settings":
			break;
		case "compact":
			bus.emitCommand({ kind: "compact", data: {} });
			break;
		case "clear":
			bus.emitCommand({ kind: "clear", data: {} });
			break;
		case "switch_model":
			if (cmd.selection) {
				bus.emitCommand({ kind: "switch_model", data: { selection: cmd.selection } });
				bus.emitEvent("warning", "cli", 0, {
					message: `Model set to: ${formatSessionSelectionRequest(cmd.selection)}`,
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

	if (isGenomeCommand(command)) {
		await runGenomeCommand(command);
		return;
	}

	if (command.kind === "list") {
		const { loadSessionSummaries } = await import("./session-metadata.ts");
		const listProjDir = await resolveProjectDir();
		const listDataDir = computeProjectDataDir(command.genomePath, listProjDir);
		const sessionsDir = join(listDataDir, "sessions");
		const logsDir = join(listDataDir, "logs");
		await runListMode(
			{
				sessionsDir,
				logsDir,
				onResume: async (selectedId) => {
					await runCli({
						kind: "resume",
						sessionId: selectedId,
						genomePath: command.genomePath,
					});
				},
			},
			{ loadSessionSummaries },
		);
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

	const { ulid } = await import("../util/ulid.ts");

	const rootDir = join(import.meta.dir, "../../root");
	const projDir = await resolveProjectDir();
	const projectDataDir = computeProjectDataDir(command.genomePath, projDir);
	const sessionsDir = join(projectDataDir, "sessions");

	if (command.kind === "oneshot") {
		await runOneshotMode({
			goal: command.goal,
			genomePath: command.genomePath,
			projectDataDir,
			rootDir,
			startBusInfrastructure,
			onResumeHint: printResumeHint,
		});
		return;
	}

	let resumeState: Awaited<ReturnType<typeof loadResumeState>> | undefined;

	if (command.kind === "resume" || command.kind === "resume-last") {
		resumeState = await loadResumeState({
			command,
			projectDataDir,
			sessionsDir,
			onInfo: (line) => {
				console.error(line);
			},
		});
		if (!resumeState) {
			console.log("No sessions found.");
			return;
		}
	}

	// Interactive mode (also reached via resume)
	const sessionId = resumeState?.sessionId ?? ulid();
	const infra = await startBusInfrastructure({
		genomePath: command.genomePath,
		sessionId,
		rootDir,
	});

	const runtime = await bootstrapInteractiveRuntime({
		genomePath: command.genomePath,
		projectDataDir,
		rootDir,
		sessionId,
		initialHistory: resumeState?.history,
		initialSelectionRequest: resumeState?.selectionRequest,
		completedHandles: resumeState?.completedHandles,
		infra,
		logStderr: command.logStderr,
		debug: command.debug,
	});
	await runInteractiveMode({
		command: {
			genomePath: command.genomePath,
			web: command.web,
			webOnly: command.webOnly,
			port: command.port,
			host: command.host,
			webToken: command.webToken,
		},
		sessionId,
		projectDataDir,
		runtime: buildInteractiveModeRuntime(runtime),
		initialEvents: resumeState?.events,
		cleanupInfra: infra.cleanup,
		onResumeHint: printResumeHint,
		inputHistoryPath,
		handleSlashCommand,
	});
}

if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	await runCli(command);
}

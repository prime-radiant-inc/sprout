import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BusClient } from "../bus/client.ts";
import type { BusServer } from "../bus/server.ts";
import type { AgentSpawner } from "../bus/spawner.ts";
import { formatSessionSelectionRequest } from "../shared/session-selection.ts";
import type { bootstrapSessionRuntime } from "./cli-bootstrap.ts";
import type { InteractiveModeOptions } from "./cli-interactive.ts";
import { parseArgs } from "./cli-parse.ts";

export { renderEvent, truncateLines } from "../tui/render-event.ts";
export type { CliCommand, LogFlags, WebFlags } from "./cli-parse.ts";
export { defaultGenomePathFromEnv, parseArgs, USAGE } from "./cli-parse.ts";

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
	runtime: Awaited<ReturnType<typeof bootstrapSessionRuntime>>,
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
					"Commands: /help, /quit, /compact, /clear, /model [best|balanced|fast|inherit|provider:model], /settings, /status, /terminal-setup, /web, /web stop\nKeys: Shift+Enter = newline, Ctrl+J = newline (fallback), Ctrl+C = interrupt/exit",
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
		case "invalid":
			bus.emitEvent("warning", "cli", 0, {
				message: cmd.message,
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
if (import.meta.main) {
	const command = parseArgs(process.argv.slice(2));
	const { runCli } = await import("./cli-run.ts");
	await runCli(command);
}

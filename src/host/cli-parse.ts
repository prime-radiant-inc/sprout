import { homedir } from "node:os";
import { join } from "node:path";
import type { GenomeCommand, GenomeMaintainScope } from "./cli-genome.ts";

export function defaultGenomePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const explicitGenomePath = env.SPROUT_GENOME_PATH?.trim();
	if (explicitGenomePath) return explicitGenomePath;

	const xdgDataHome = env.XDG_DATA_HOME?.trim();
	if (xdgDataHome) return join(xdgDataHome, "sprout-genome");

	return join(homedir(), ".local/share/sprout-genome");
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
	| {
			kind: "headless";
			goal: string;
			genomePath: string;
			sessionId?: string;
			atifPath?: string;
			evalMode?: true;
	  }
	| ({ kind: "resume"; sessionId: string; genomePath: string } & WebFlags & LogFlags)
	| { kind: "list"; genomePath: string }
	| GenomeCommand
	| { kind: "help" };

interface ParseState {
	genomePath: string;
	prompt?: string;
	atifPath?: string;
	evalMode?: true;
	resumeRequested: boolean;
	resumeSessionId?: string;
	web?: boolean;
	webOnly?: boolean;
	port?: number;
	host?: string;
	webToken?: string;
	logStderr?: boolean;
	debug?: boolean;
	genomeCommand?: GenomeCommand;
}

function readPrompt(argv: string[], startIndex: number): { value?: string; nextIndex: number } {
	const parts: string[] = [];
	let index = startIndex;
	while (index < argv.length) {
		const token = argv[index];
		if (token === undefined || token.startsWith("-")) break;
		parts.push(token);
		index++;
	}
	if (parts.length === 0) return { nextIndex: startIndex };
	return { value: parts.join(" "), nextIndex: index };
}

function parsePort(token: string | undefined): number | undefined {
	if (token === undefined) return undefined;
	const port = Number(token);
	if (!Number.isInteger(port) || port <= 0) return undefined;
	return port;
}

function parsePositiveInt(token: string | undefined): number | undefined {
	if (token === undefined) return undefined;
	const value = Number(token);
	if (!Number.isInteger(value) || value <= 0) return undefined;
	return value;
}

function parseGenomeMaintainCommand(
	argv: string[],
	startIndex: number,
	genomePath: string,
): { command?: GenomeCommand; nextIndex: number } {
	let index = startIndex;
	let apply = false;
	let decisionFile: string | undefined;
	let scope: GenomeMaintainScope = "all";
	let limit: number | undefined;

	while (index < argv.length) {
		const token = argv[index];
		if (token === undefined) break;

		if (token === "--dry-run") {
			if (apply) return { nextIndex: index };
			index++;
			continue;
		}

		if (token === "--apply") {
			apply = true;
			index++;
			continue;
		}

		if (token === "--decision-file") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) return { nextIndex: index };
			decisionFile = value;
			index += 2;
			continue;
		}

		if (token === "--only") {
			const value = argv[index + 1];
			if (value !== "consolidation" && value !== "entity-gc") return { nextIndex: index };
			scope = value;
			index += 2;
			continue;
		}

		if (token === "--limit") {
			const value = parsePositiveInt(argv[index + 1]);
			if (value === undefined) return { nextIndex: index };
			limit = value;
			index += 2;
			continue;
		}

		return { nextIndex: index };
	}

	if (apply && decisionFile === undefined) return { nextIndex: startIndex };

	return {
		command: {
			kind: "genome-maintain",
			genomePath,
			apply,
			scope,
			...(decisionFile !== undefined ? { decisionFile } : {}),
			...(limit !== undefined ? { limit } : {}),
		},
		nextIndex: index,
	};
}

function collectInteractiveFlags(state: ParseState): WebFlags & LogFlags {
	const flags: WebFlags & LogFlags = {};
	if (state.web) flags.web = true;
	if (state.webOnly) flags.webOnly = true;
	if (state.port !== undefined) flags.port = state.port;
	if (state.host !== undefined) flags.host = state.host;
	if (state.webToken !== undefined) flags.webToken = state.webToken;
	if (state.logStderr) flags.logStderr = true;
	if (state.debug) flags.debug = true;
	return flags;
}

function hasInteractiveOnlyFlags(state: ParseState): boolean {
	return (
		state.web === true ||
		state.webOnly === true ||
		state.port !== undefined ||
		state.host !== undefined ||
		state.webToken !== undefined ||
		state.logStderr === true ||
		state.debug === true
	);
}

export function parseArgs(argv: string[]): CliCommand {
	const state: ParseState = {
		genomePath: defaultGenomePathFromEnv(),
		resumeRequested: false,
	};

	for (let index = 0; index < argv.length; ) {
		const token = argv[index];
		if (token === undefined) break;

		if (token === "--help") return { kind: "help" };

		if (token === "--genome-path") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) return { kind: "help" };
			state.genomePath = value;
			index += 2;
			continue;
		}

		if (token === "-p" || token === "--prompt") {
			if (state.prompt !== undefined) return { kind: "help" };
			const prompt = readPrompt(argv, index + 1);
			if (!prompt.value) return { kind: "help" };
			state.prompt = prompt.value;
			index = prompt.nextIndex;
			continue;
		}

		if (token === "--resume") {
			if (state.resumeRequested) return { kind: "help" };
			state.resumeRequested = true;
			const next = argv[index + 1];
			if (next && !next.startsWith("-")) {
				state.resumeSessionId = next;
				index += 2;
				continue;
			}
			index += 1;
			continue;
		}

		if (token === "--resume-last") {
			return { kind: "help" };
		}

		if (token === "--log-atif") {
			if (state.atifPath !== undefined) return { kind: "help" };
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) return { kind: "help" };
			state.atifPath = value;
			index += 2;
			continue;
		}

		if (token === "--eval-mode") {
			state.evalMode = true;
			index += 1;
			continue;
		}

		if (token === "--genome") {
			if (state.genomeCommand) return { kind: "help" };
			const subcommand = argv[index + 1];
			if (subcommand === "list") {
				state.genomeCommand = { kind: "genome-list", genomePath: state.genomePath };
				index += 2;
				continue;
			}
			if (subcommand === "log") {
				state.genomeCommand = { kind: "genome-log", genomePath: state.genomePath };
				index += 2;
				continue;
			}
			if (subcommand === "export") {
				state.genomeCommand = { kind: "genome-export", genomePath: state.genomePath };
				index += 2;
				continue;
			}
			if (subcommand === "sync") {
				state.genomeCommand = { kind: "genome-sync", genomePath: state.genomePath };
				index += 2;
				continue;
			}
			if (subcommand === "maintain") {
				const parsed = parseGenomeMaintainCommand(argv, index + 2, state.genomePath);
				if (!parsed.command || parsed.nextIndex !== argv.length) return { kind: "help" };
				state.genomeCommand = parsed.command;
				index = parsed.nextIndex;
				continue;
			}
			if (subcommand === "rollback") {
				const commit = argv[index + 2];
				if (!commit || commit.startsWith("-")) return { kind: "help" };
				state.genomeCommand = {
					kind: "genome-rollback",
					genomePath: state.genomePath,
					commit,
				};
				index += 3;
				continue;
			}
			return { kind: "help" };
		}

		if (token === "--web") {
			state.web = true;
			index += 1;
			continue;
		}

		if (token === "--web-only") {
			state.webOnly = true;
			index += 1;
			continue;
		}

		if (token === "--port") {
			const port = parsePort(argv[index + 1]);
			if (port === undefined) return { kind: "help" };
			state.port = port;
			index += 2;
			continue;
		}

		if (token === "--host") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) return { kind: "help" };
			state.host = value;
			index += 2;
			continue;
		}

		if (token === "--web-token") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-")) return { kind: "help" };
			state.webToken = value;
			index += 2;
			continue;
		}

		if (token === "--log-stderr") {
			state.logStderr = true;
			index += 1;
			continue;
		}

		if (token === "--debug") {
			state.debug = true;
			index += 1;
			continue;
		}

		return { kind: "help" };
	}

	if (state.genomeCommand) {
		if (
			state.prompt !== undefined ||
			state.resumeRequested ||
			hasInteractiveOnlyFlags(state) ||
			state.atifPath !== undefined ||
			state.evalMode === true
		) {
			return { kind: "help" };
		}
		return state.genomeCommand;
	}

	if (state.prompt !== undefined) {
		if (hasInteractiveOnlyFlags(state)) return { kind: "help" };
		if (state.resumeRequested && !state.resumeSessionId) return { kind: "help" };
		return {
			kind: "headless",
			goal: state.prompt,
			genomePath: state.genomePath,
			sessionId: state.resumeSessionId,
			...(state.atifPath !== undefined ? { atifPath: state.atifPath } : {}),
			...(state.evalMode === true ? { evalMode: true as const } : {}),
		};
	}

	if (state.resumeRequested) {
		if (!state.resumeSessionId) {
			if (
				hasInteractiveOnlyFlags(state) ||
				state.atifPath !== undefined ||
				state.evalMode === true
			) {
				return { kind: "help" };
			}
			return { kind: "list", genomePath: state.genomePath };
		}
		if (state.atifPath !== undefined || state.evalMode === true) return { kind: "help" };
		return {
			kind: "resume",
			sessionId: state.resumeSessionId,
			genomePath: state.genomePath,
			...collectInteractiveFlags(state),
		};
	}

	if (state.atifPath !== undefined || state.evalMode === true) return { kind: "help" };

	return {
		kind: "interactive",
		genomePath: state.genomePath,
		...collectInteractiveFlags(state),
	};
}

export const USAGE = `Usage: sprout [options]

Modes:
  sprout                                Interactive mode (default)
  sprout -p "Fix the bug"               Non-interactive mode
  sprout --prompt "Fix the bug"         Non-interactive mode
  sprout --resume                       List sessions and pick one to resume
  sprout --resume <session-id>          Resume a specific session interactively
  sprout --resume <session-id> -p "Continue work"
                                        Resume a specific session non-interactively

Genome management:
  sprout --genome list                  List agents in the genome
  sprout --genome log                   Show genome git log
  sprout --genome sync                  Sync root agents to runtime genome
  sprout --genome rollback <commit>     Revert a genome commit
  sprout --genome export                Show learnings that evolved beyond root specs
  sprout --genome maintain [options]    Review or apply memory consolidation/entity GC

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
  --dry-run              For --genome maintain, print candidates without mutating (default)
  --apply                For --genome maintain, apply reviewed decisions
  --decision-file <path> JSON decisions for --genome maintain --apply
  --only <scope>         For --genome maintain, scope is consolidation or entity-gc
  --limit <n>            For --genome maintain, cap candidates per maintenance type
  --help                 Show this help message`;

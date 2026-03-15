import {
	listReplayTurns,
	replayTurn,
	showReplayTurn,
	type ReplayTurnOptions,
} from "./replay-workshop-lib.ts";

const USAGE = `Usage:
  bun tools/replay-workshop.ts list <log-or-replay-path>
  bun tools/replay-workshop.ts show <log-or-replay-path> --turn <n>
  bun tools/replay-workshop.ts replay <log-or-replay-path> --turn <n> [--system-prompt-prepend <text>] [--system-prompt-append <text>] [--model <provider:model|model>]`;

export interface ReplayWorkshopIo {
	out(line: string): void;
	err(line: string): void;
}

export interface ReplayWorkshopCliDeps {
	loadDotenv?: () => Promise<void>;
	listReplayTurns?: typeof listReplayTurns;
	showReplayTurn?: typeof showReplayTurn;
	replayTurn?: typeof replayTurn;
}

export async function runReplayWorkshopCli(
	args: string[],
	io: ReplayWorkshopIo = defaultIo(),
	deps: ReplayWorkshopCliDeps = {},
): Promise<number> {
	const d = {
		loadDotenv:
			deps.loadDotenv ??
			(async () => {
				const { config } = await import("dotenv");
				config({ quiet: true });
			}),
		listReplayTurns: deps.listReplayTurns ?? listReplayTurns,
		showReplayTurn: deps.showReplayTurn ?? showReplayTurn,
		replayTurn: deps.replayTurn ?? replayTurn,
	};

	const [command, path, ...rest] = args;
	if (!command || !path) {
		io.err(USAGE);
		return 1;
	}

	try {
		await d.loadDotenv();

		switch (command) {
			case "list": {
				for (const entry of await d.listReplayTurns(path)) {
					io.out(
						`turn=${entry.turn} depth=${entry.depth} agent=${entry.agentId} provider=${entry.provider} model=${entry.model} finish=${entry.finishReason} input=${entry.inputTokens} output=${entry.outputTokens}`,
					);
				}
				return 0;
			}
			case "show": {
				const turn = parseTurnArg(rest);
				if (turn === null) {
					io.err(USAGE);
					return 1;
				}
				io.out(JSON.stringify(await d.showReplayTurn(path, turn), null, 2));
				return 0;
			}
			case "replay": {
				const options = parseReplayOptions(rest);
				if (!options) {
					io.err(USAGE);
					return 1;
				}
				io.out(JSON.stringify(await d.replayTurn(path, options), null, 2));
				return 0;
			}
			default:
				io.err(USAGE);
				return 1;
		}
	} catch (error) {
		io.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

function parseTurnArg(args: string[]): number | null {
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== "--turn") continue;
		const turn = Number(args[index + 1]);
		return Number.isInteger(turn) && turn > 0 ? turn : null;
	}
	return null;
}

function parseReplayOptions(args: string[]): ReplayTurnOptions | null {
	const turn = parseTurnArg(args);
	if (turn === null) return null;

	const options: ReplayTurnOptions = { turn };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case "--system-prompt-prepend":
				options.systemPromptPrepend = args[index + 1];
				index += 1;
				break;
			case "--system-prompt-append":
				options.systemPromptAppend = args[index + 1];
				index += 1;
				break;
			case "--model":
				options.modelOverride = args[index + 1];
				index += 1;
				break;
		}
	}
	return options;
}

function defaultIo(): ReplayWorkshopIo {
	return {
		out: (line) => {
			console.log(line);
		},
		err: (line) => {
			console.error(line);
		},
	};
}

if (import.meta.main) {
	process.exit(await runReplayWorkshopCli(process.argv.slice(2)));
}

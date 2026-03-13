import { join } from "node:path";
import { projectDataDir as computeProjectDataDir } from "../util/project-id.ts";
import { ulid } from "../util/ulid.ts";
import {
	buildInteractiveModeRuntime,
	handleSlashCommand,
	inputHistoryPath,
	resolveProjectDir,
	startBusInfrastructure,
} from "./cli.ts";
import { bootstrapSessionRuntime } from "./cli-bootstrap.ts";
import { isGenomeCommand, runGenomeCommand } from "./cli-genome.ts";
import { runHeadlessMode } from "./cli-headless.ts";
import { runInteractiveMode } from "./cli-interactive.ts";
import { runListMode } from "./cli-list.ts";
import { type CliCommand, USAGE } from "./cli-parse.ts";
import { loadResumeState } from "./cli-resume.ts";
import { loadSessionSummaries } from "./session-metadata.ts";

interface CliRunDeps {
	loadDotenv: () => void | Promise<void>;
	logError: (line: string) => void;
	logOut: (line: string) => void;
	resolveProjectDir: typeof resolveProjectDir;
	runGenomeCommand: typeof runGenomeCommand;
	runListMode: typeof runListMode;
	loadSessionSummaries: typeof loadSessionSummaries;
	startBusInfrastructure: typeof startBusInfrastructure;
	bootstrapRuntime: typeof bootstrapSessionRuntime;
	loadResumeState: typeof loadResumeState;
	runInteractiveMode: typeof runInteractiveMode;
	runHeadlessMode: typeof runHeadlessMode;
	createSessionId: () => string;
}

function printResumeHint(sessionId: string, logError: (line: string) => void): void {
	logError(`\nTo resume this session:\n  sprout --resume ${sessionId}\n`);
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export async function runCli(command: CliCommand, deps: Partial<CliRunDeps> = {}): Promise<void> {
	const d: CliRunDeps = {
		loadDotenv:
			deps.loadDotenv ??
			(async () => {
				const { config } = await import("dotenv");
				config({ quiet: true });
			}),
		logError: deps.logError ?? ((line) => console.error(line)),
		logOut: deps.logOut ?? ((line) => console.log(line)),
		resolveProjectDir: deps.resolveProjectDir ?? resolveProjectDir,
		runGenomeCommand: deps.runGenomeCommand ?? runGenomeCommand,
		runListMode: deps.runListMode ?? runListMode,
		loadSessionSummaries: deps.loadSessionSummaries ?? loadSessionSummaries,
		startBusInfrastructure: deps.startBusInfrastructure ?? startBusInfrastructure,
		bootstrapRuntime: deps.bootstrapRuntime ?? bootstrapSessionRuntime,
		loadResumeState: deps.loadResumeState ?? loadResumeState,
		runInteractiveMode: deps.runInteractiveMode ?? runInteractiveMode,
		runHeadlessMode: deps.runHeadlessMode ?? runHeadlessMode,
		createSessionId: deps.createSessionId ?? ulid,
	};

	if (command.kind === "help") {
		d.logOut(USAGE);
		return;
	}

	if (isGenomeCommand(command)) {
		await d.runGenomeCommand(command);
		return;
	}

	if (command.kind === "list") {
		const listProjectDir = await d.resolveProjectDir();
		const listDataDir = computeProjectDataDir(command.genomePath, listProjectDir);
		const sessionsDir = join(listDataDir, "sessions");
		const logsDir = join(listDataDir, "logs");
		await d.runListMode(
			{
				sessionsDir,
				logsDir,
				onResume: async (selectedId) => {
					await runCli(
						{
							kind: "resume",
							sessionId: selectedId,
							genomePath: command.genomePath,
						},
						deps,
					);
				},
			},
			{ loadSessionSummaries: d.loadSessionSummaries },
		);
		return;
	}

	await d.loadDotenv();

	if (
		!process.env.ANTHROPIC_API_KEY &&
		!process.env.OPENAI_API_KEY &&
		!process.env.GEMINI_API_KEY &&
		!process.env.GOOGLE_API_KEY
	) {
		d.logError(
			"[sprout] Warning: No LLM API keys found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.\n" +
				"         Ensure your .env file is in the working directory, or export the variables directly.",
		);
	}

	const rootDir = join(import.meta.dir, "../../root");
	const projectDir = await d.resolveProjectDir();
	const projectDataDirPath = computeProjectDataDir(command.genomePath, projectDir);
	const sessionsDir = join(projectDataDirPath, "sessions");

	let resumeState: Awaited<ReturnType<typeof d.loadResumeState>> | undefined;
	if (command.kind === "resume" || (command.kind === "headless" && command.sessionId)) {
		const resumeSessionId = command.sessionId;
		if (!resumeSessionId) {
			d.logError("Session id is required for resume");
			process.exitCode = 1;
			return;
		}
		resumeState = await d.loadResumeState({
			command: {
				kind: "resume",
				sessionId: resumeSessionId,
			},
			projectDataDir: projectDataDirPath,
			sessionsDir,
			onInfo: (line) => {
				d.logError(line);
			},
		});
		if (!resumeState) {
			d.logError(`Session not found: ${resumeSessionId}`);
			process.exitCode = 1;
			return;
		}
	}

	if (command.kind === "headless") {
		try {
			const result = await d.runHeadlessMode({
				goal: command.goal,
				genomePath: command.genomePath,
				projectDataDir: projectDataDirPath,
				rootDir,
				sessionId: resumeState?.sessionId ?? command.sessionId,
				initialHistory: resumeState?.history,
				initialSelectionRequest: resumeState?.selectionRequest,
				completedHandles: resumeState?.completedHandles,
				startBusInfrastructure: d.startBusInfrastructure,
			});
			if (!result.success) {
				process.exitCode = 1;
			}
		} catch (error) {
			d.logError(`Error: ${formatError(error)}`);
			process.exitCode = 1;
		}
		return;
	}

	const sessionId = resumeState?.sessionId ?? d.createSessionId();
	const infra = await d.startBusInfrastructure({
		genomePath: command.genomePath,
		sessionId,
		rootDir,
	});

	const runtime = await d.bootstrapRuntime({
		genomePath: command.genomePath,
		projectDataDir: projectDataDirPath,
		rootDir,
		sessionId,
		initialHistory: resumeState?.history,
		initialSelectionRequest: resumeState?.selectionRequest,
		completedHandles: resumeState?.completedHandles,
		infra,
		logStderr: command.logStderr,
		debug: command.debug,
	});
	await d.runInteractiveMode({
		command: {
			genomePath: command.genomePath,
			web: command.web,
			webOnly: command.webOnly,
			port: command.port,
			host: command.host,
			webToken: command.webToken,
		},
		sessionId,
		projectDataDir: projectDataDirPath,
		runtime: buildInteractiveModeRuntime(runtime),
		initialEvents: resumeState?.events,
		cleanupInfra: infra.cleanup,
		onResumeHint: (nextSessionId) => {
			printResumeHint(nextSessionId, d.logError);
		},
		inputHistoryPath,
		handleSlashCommand,
	});
}

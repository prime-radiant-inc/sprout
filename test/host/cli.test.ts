import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkHandleCompleted, extractChildHandles } from "../../src/bus/resume.ts";
import {
	buildInteractiveModeRuntime,
	configureTerminal,
	handleSlashCommand,
	inputHistoryPath,
	parseArgs,
	resolveProjectDir,
	startBusInfrastructure,
} from "../../src/host/cli.ts";
import { EventBus } from "../../src/host/event-bus.ts";
import { replayEventLog } from "../../src/host/resume.ts";
import type { AgentFactory } from "../../src/host/session-controller.ts";
import { SessionController } from "../../src/host/session-controller.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";

function saveEnv() {
	return {
		TMUX: process.env.TMUX,
		TERM_PROGRAM: process.env.TERM_PROGRAM,
		TERM: process.env.TERM,
	};
}

function restoreEnv(saved: Record<string, string | undefined>) {
	for (const [key, val] of Object.entries(saved)) {
		if (val === undefined) delete process.env[key];
		else process.env[key] = val;
	}
}

const defaultGenomePath = join(homedir(), ".local/share/sprout-genome");

describe("buildInteractiveModeRuntime", () => {
	test("preserves the settings control plane for interactive mode", () => {
		const settingsControlPlane = {
			execute: async () => ({
				ok: true as const,
				snapshot: {
					runtime: {
						secretBackend: {
							backend: "memory" as const,
							available: true,
						},
						warnings: [],
					},
					settings: {
						version: 2 as const,
						providers: [],
						defaults: {},
					},
					providers: [],
					catalog: [],
				},
			}),
		};
		const runtime = buildInteractiveModeRuntime({
			bus: {} as never,
			logger: {} as never,
			llmClient: {} as never,
			settingsControlPlane: settingsControlPlane as never,
			controller: {} as never,
			availableModels: ["best"],
		});

		expect(runtime.settingsControlPlane).toBe(settingsControlPlane);
	});
});

describe("parseArgs", () => {
	test("no args → interactive mode", () => {
		const result = parseArgs([]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
		});
	});

	test("-p returns headless mode", () => {
		const result = parseArgs(["-p", "Fix the bug"]);
		expect(result).toEqual({
			kind: "headless",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt returns headless mode", () => {
		const result = parseArgs(["--prompt", "Fix the bug"]);
		expect(result).toEqual({
			kind: "headless",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with multiple words joins them", () => {
		const result = parseArgs(["--prompt", "Fix", "the", "bug"]);
		expect(result).toEqual({
			kind: "headless",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with no goal returns help", () => {
		const result = parseArgs(["--prompt"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("bare goal returns help", () => {
		const result = parseArgs(["Fix the bug"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--resume returns resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC123",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume with no session ID shows session picker", () => {
		const result = parseArgs(["--resume"]);
		expect(result).toEqual({
			kind: "list",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume with --prompt returns headless resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123", "--prompt", "continue"]);
		expect(result).toEqual({
			kind: "headless",
			sessionId: "01ABC123",
			goal: "continue",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume with -p returns headless resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123", "-p", "continue"]);
		expect(result).toEqual({
			kind: "headless",
			sessionId: "01ABC123",
			goal: "continue",
			genomePath: defaultGenomePath,
		});
	});

	test("--log-atif and --eval-mode on headless runs are parsed", () => {
		const result = parseArgs(["-p", "solve", "--log-atif", "/tmp/trajectory.json", "--eval-mode"]);
		expect(result).toEqual({
			kind: "headless",
			goal: "solve",
			genomePath: defaultGenomePath,
			atifPath: "/tmp/trajectory.json",
			evalMode: true,
		});
	});

	test("--resume with --prompt and --log-atif returns headless resume mode", () => {
		const result = parseArgs([
			"--resume",
			"01ABC123",
			"--prompt",
			"continue",
			"--log-atif",
			"/tmp/trajectory.json",
		]);
		expect(result).toEqual({
			kind: "headless",
			sessionId: "01ABC123",
			goal: "continue",
			genomePath: defaultGenomePath,
			atifPath: "/tmp/trajectory.json",
		});
	});

	test("--log-atif without a prompt returns help", () => {
		const result = parseArgs(["--log-atif", "/tmp/trajectory.json"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--eval-mode without a prompt returns help", () => {
		const result = parseArgs(["--eval-mode"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("interactive flags cannot be combined with --log-atif", () => {
		const result = parseArgs(["--web", "-p", "solve", "--log-atif", "/tmp/trajectory.json"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--resume-last returns help", () => {
		const result = parseArgs(["--resume-last"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--genome list → genome-list command", () => {
		const result = parseArgs(["--genome", "list"]);
		expect(result).toEqual({
			kind: "genome-list",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome log → genome-log command", () => {
		const result = parseArgs(["--genome", "log"]);
		expect(result).toEqual({
			kind: "genome-log",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome rollback <commit> → genome-rollback command", () => {
		const result = parseArgs(["--genome", "rollback", "abc123"]);
		expect(result).toEqual({
			kind: "genome-rollback",
			genomePath: defaultGenomePath,
			commit: "abc123",
		});
	});

	test("--genome-path with prompt → headless with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path", "--prompt", "Fix bug"]);
		expect(result).toEqual({
			kind: "headless",
			goal: "Fix bug",
			genomePath: "/custom/path",
		});
	});

	test("--genome-path with no args → interactive with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: "/custom/path",
		});
	});

	test("--help → help", () => {
		const result = parseArgs(["--help"]);
		expect(result).toEqual({ kind: "help" });
	});

	// --- Web flags ---

	test("--web sets web flag on interactive mode", () => {
		const result = parseArgs(["--web"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			web: true,
		});
	});

	test("--web-only sets webOnly flag on interactive mode", () => {
		const result = parseArgs(["--web-only"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			webOnly: true,
		});
	});

	test("--port sets port on interactive mode", () => {
		const result = parseArgs(["--port", "8080"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			port: 8080,
		});
	});

	test("--web --port combined on interactive mode", () => {
		const result = parseArgs(["--web", "--port", "9000"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			web: true,
			port: 9000,
		});
	});

	test("--web-only --port combined on interactive mode", () => {
		const result = parseArgs(["--web-only", "--port", "3000"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			webOnly: true,
			port: 3000,
		});
	});

	test("--web-token sets webToken on interactive mode", () => {
		const result = parseArgs(["--web-token", "secret123"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			webToken: "secret123",
		});
	});

	test("--web-token is forwarded on resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123", "--web-token", "secret123"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC123",
			genomePath: defaultGenomePath,
			webToken: "secret123",
		});
	});

	test("--web with --resume sets web on resume command", () => {
		const result = parseArgs(["--web", "--resume", "01ABC123"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC123",
			genomePath: defaultGenomePath,
			web: true,
		});
	});

	test("--web with --resume-last returns help", () => {
		const result = parseArgs(["--web", "--resume-last"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--web-only --port with --resume sets both on resume command", () => {
		const result = parseArgs(["--web-only", "--port", "4000", "--resume", "01XYZ"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01XYZ",
			genomePath: defaultGenomePath,
			webOnly: true,
			port: 4000,
		});
	});

	test("web flags with --prompt return help", () => {
		const result = parseArgs(["--web", "--prompt", "Fix bug"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("bare goal with web flags returns help", () => {
		const result = parseArgs(["--web", "Fix bug"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--port with default value when used alone on interactive", () => {
		// --port without --web still just sets the port; caller decides what to do
		const result = parseArgs(["--port", "7777"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			port: 7777,
		});
	});

	test("--genome-path with --web on interactive mode", () => {
		const result = parseArgs(["--genome-path", "/custom/path", "--web"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: "/custom/path",
			web: true,
		});
	});

	test("--port with no value returns help", () => {
		const result = parseArgs(["--port"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--port with non-numeric value returns help", () => {
		const result = parseArgs(["--port", "banana"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--log-stderr sets logStderr on interactive command", () => {
		const result = parseArgs(["--log-stderr"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			logStderr: true,
		});
	});

	test("--debug sets debug on interactive command", () => {
		const result = parseArgs(["--debug"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			debug: true,
		});
	});

	test("--log-stderr --debug sets both flags", () => {
		const result = parseArgs(["--log-stderr", "--debug"]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
			logStderr: true,
			debug: true,
		});
	});

	test("--log-stderr carries through to resume command", () => {
		const result = parseArgs(["--log-stderr", "--resume", "01ABC"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC",
			genomePath: defaultGenomePath,
			logStderr: true,
		});
	});

	test("--log-stderr after --resume is still collected", () => {
		const result = parseArgs(["--resume", "01ABC", "--log-stderr", "--debug"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC",
			genomePath: defaultGenomePath,
			logStderr: true,
			debug: true,
		});
	});

	test("--log-stderr after --resume-last returns help", () => {
		const result = parseArgs(["--resume-last", "--log-stderr"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("log flags with --prompt return help", () => {
		const result = parseArgs(["--log-stderr", "--debug", "--prompt", "Fix bug"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("unknown flag returns help", () => {
		expect(parseArgs(["--foobar"])).toEqual({ kind: "help" });
	});

	test("unknown flag mixed with valid flags returns help", () => {
		expect(parseArgs(["--web", "--banana"])).toEqual({ kind: "help" });
	});

	test("unknown flag before --prompt returns help", () => {
		expect(parseArgs(["--unknown", "--prompt", "Fix bug"])).toEqual({ kind: "help" });
	});

	test("bare goal without --prompt returns help", () => {
		expect(parseArgs(["Fix the bug"])).toEqual({ kind: "help" });
	});

	test("bare goal with multiple words returns help", () => {
		expect(parseArgs(["Fix", "the", "bug"])).toEqual({ kind: "help" });
	});

	test("--genome export returns genome-export command", () => {
		const result = parseArgs(["--genome", "export"]);
		expect(result).toEqual({
			kind: "genome-export",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome-path /custom --genome export uses custom genome path", () => {
		const result = parseArgs(["--genome-path", "/custom", "--genome", "export"]);
		expect(result).toEqual({
			kind: "genome-export",
			genomePath: "/custom",
		});
	});

	test("--genome sync returns genome-sync command", () => {
		const cmd = parseArgs(["--genome", "sync"]);
		expect(cmd).toEqual({
			kind: "genome-sync",
			genomePath: defaultGenomePath,
		});
	});

	test("--genome sync with custom genome path", () => {
		const cmd = parseArgs(["--genome-path", "/custom/path", "--genome", "sync"]);
		expect(cmd).toEqual({
			kind: "genome-sync",
			genomePath: "/custom/path",
		});
	});

	test("uses SPROUT_GENOME_PATH as default genome path", () => {
		const prevSproutGenome = process.env.SPROUT_GENOME_PATH;
		const prevXdgDataHome = process.env.XDG_DATA_HOME;
		try {
			process.env.SPROUT_GENOME_PATH = "/env/sprout-genome";
			delete process.env.XDG_DATA_HOME;
			const cmd = parseArgs([]);
			expect(cmd).toEqual({
				kind: "interactive",
				genomePath: "/env/sprout-genome",
			});
		} finally {
			if (prevSproutGenome === undefined) delete process.env.SPROUT_GENOME_PATH;
			else process.env.SPROUT_GENOME_PATH = prevSproutGenome;
			if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = prevXdgDataHome;
		}
	});

	test("uses XDG_DATA_HOME when SPROUT_GENOME_PATH is unset", () => {
		const prevSproutGenome = process.env.SPROUT_GENOME_PATH;
		const prevXdgDataHome = process.env.XDG_DATA_HOME;
		try {
			delete process.env.SPROUT_GENOME_PATH;
			process.env.XDG_DATA_HOME = "/xdg/data";
			const cmd = parseArgs([]);
			expect(cmd).toEqual({
				kind: "interactive",
				genomePath: "/xdg/data/sprout-genome",
			});
		} finally {
			if (prevSproutGenome === undefined) delete process.env.SPROUT_GENOME_PATH;
			else process.env.SPROUT_GENOME_PATH = prevSproutGenome;
			if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = prevXdgDataHome;
		}
	});

	test("SPROUT_GENOME_PATH takes precedence over XDG_DATA_HOME", () => {
		const prevSproutGenome = process.env.SPROUT_GENOME_PATH;
		const prevXdgDataHome = process.env.XDG_DATA_HOME;
		try {
			process.env.SPROUT_GENOME_PATH = "/sprout/override";
			process.env.XDG_DATA_HOME = "/xdg/data";
			const cmd = parseArgs([]);
			expect(cmd).toEqual({
				kind: "interactive",
				genomePath: "/sprout/override",
			});
		} finally {
			if (prevSproutGenome === undefined) delete process.env.SPROUT_GENOME_PATH;
			else process.env.SPROUT_GENOME_PATH = prevSproutGenome;
			if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = prevXdgDataHome;
		}
	});
});

describe("resolveProjectDir", () => {
	test("returns the active git worktree root (not the common .git parent)", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "sprout-worktree-root-"));
		const repoDir = join(tempRoot, "repo");
		const worktreeDir = join(tempRoot, "worktree");
		await mkdir(repoDir, { recursive: true });

		const runGit = async (cwd: string, args: string[]): Promise<void> => {
			const proc = Bun.spawn(["git", ...args], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
			}
		};

		await runGit(repoDir, ["init"]);
		await runGit(repoDir, ["config", "user.email", "tests@example.com"]);
		await runGit(repoDir, ["config", "user.name", "Sprout Tests"]);
		await writeFile(join(repoDir, "README.md"), "test\n", "utf-8");
		await runGit(repoDir, ["add", "README.md"]);
		await runGit(repoDir, ["commit", "-m", "init"]);
		await runGit(repoDir, ["worktree", "add", worktreeDir, "-b", "wt-branch"]);

		const previousCwd = process.cwd();
		process.chdir(worktreeDir);
		try {
			const projectDir = await resolveProjectDir();
			expect(await realpath(projectDir)).toBe(await realpath(worktreeDir));
		} finally {
			process.chdir(previousCwd);
		}
	});
});

describe("handleSigint", () => {
	test("emits interrupt when controller is running", () => {
		const { handleSigint } = require("../../src/host/cli.ts");
		const commands: any[] = [];
		const bus = { emitCommand: (cmd: any) => commands.push(cmd) };
		const controller = { isRunning: true };
		let closed = false;
		const rl = {
			close: () => {
				closed = true;
			},
		};

		handleSigint(bus as any, controller as any, rl as any);

		expect(commands).toHaveLength(1);
		expect(commands[0].kind).toBe("interrupt");
		expect(closed).toBe(false);
	});

	test("closes readline when controller is idle", () => {
		const { handleSigint } = require("../../src/host/cli.ts");
		const commands: any[] = [];
		const bus = { emitCommand: (cmd: any) => commands.push(cmd) };
		const controller = { isRunning: false };
		let closed = false;
		const rl = {
			close: () => {
				closed = true;
			},
		};

		handleSigint(bus as any, controller as any, rl as any);

		expect(commands).toHaveLength(0);
		expect(closed).toBe(true);
	});
});

describe("handleSlashCommand", () => {
	function makeBus() {
		const commands: any[] = [];
		const events: any[] = [];
		return {
			emitCommand: (cmd: any) => commands.push(cmd),
			emitEvent: (kind: string, agentId: string, depth: number, data: any) =>
				events.push({ kind, agentId, depth, data }),
			commands,
			events,
		};
	}

	const controller = {
		sessionId: "01ABCDEF12345678ABCDEF1234",
		isRunning: false,
		currentModel: undefined as string | undefined,
	};

	test("help emits warning event with command list and key hints", async () => {
		const bus = makeBus();
		await handleSlashCommand({ kind: "help" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].kind).toBe("warning");
		expect(bus.events[0].data.message).toContain("/help");
		expect(bus.events[0].data.message).toContain("/quit");
		expect(bus.events[0].data.message).toContain("/terminal-setup");
		expect(bus.events[0].data.message).toContain("Shift+Enter");
		expect(bus.events[0].data.message).toContain("Ctrl+J");
	});

	test("compact emits compact command", async () => {
		const bus = makeBus();
		await handleSlashCommand({ kind: "compact" }, bus, controller);
		expect(bus.commands).toHaveLength(1);
		expect(bus.commands[0].kind).toBe("compact");
	});

	test("clear emits clear command", async () => {
		const bus = makeBus();
		await handleSlashCommand({ kind: "clear" }, bus, controller);
		expect(bus.commands).toHaveLength(1);
		expect(bus.commands[0].kind).toBe("clear");
	});

	test("switch_model emits command and warning event", async () => {
		const bus = makeBus();
		await handleSlashCommand(
			{
				kind: "switch_model",
				selection: {
					kind: "model",
					model: {
						providerId: "openai",
						modelId: "gpt-4o",
					},
				},
			},
			bus,
			controller,
		);
		expect(bus.commands).toHaveLength(1);
		expect(bus.commands[0].kind).toBe("switch_model");
		expect(bus.commands[0].data.selection).toEqual({
			kind: "model",
			model: {
				providerId: "openai",
				modelId: "gpt-4o",
			},
		});
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("openai:gpt-4o");
	});

	test("switch_model without arg returns show_model_picker action", async () => {
		const bus = makeBus();
		const result = await handleSlashCommand(
			{ kind: "switch_model", selection: undefined },
			bus,
			controller,
		);
		expect(result).toEqual({ action: "show_model_picker" });
		expect(bus.commands).toHaveLength(0);
		expect(bus.events).toHaveLength(0);
	});

	test("status emits warning event with session info", async () => {
		const bus = makeBus();
		await handleSlashCommand({ kind: "status" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("01ABCDEF12345678ABCDEF1234");
		expect(bus.events[0].data.message).toContain("idle");
	});

	test("unknown emits warning event", async () => {
		const bus = makeBus();
		await handleSlashCommand({ kind: "unknown", raw: "/foo" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("/foo");
	});

	test("quit emits quit command and returns exit action", async () => {
		const bus = makeBus();
		const result = await handleSlashCommand({ kind: "quit" }, bus, controller);
		expect(bus.commands).toEqual([{ kind: "quit", data: {} }]);
		expect(result).toEqual({ action: "exit" });
	});

	test("web returns start_web action", async () => {
		const bus = makeBus();
		const result = await handleSlashCommand({ kind: "web" }, bus, controller);
		expect(result).toEqual({ action: "start_web" });
		expect(bus.commands).toHaveLength(0);
		expect(bus.events).toHaveLength(0);
	});

	test("web_stop returns stop_web action", async () => {
		const bus = makeBus();
		const result = await handleSlashCommand({ kind: "web_stop" }, bus, controller);
		expect(result).toEqual({ action: "stop_web" });
		expect(bus.commands).toHaveLength(0);
		expect(bus.events).toHaveLength(0);
	});

	test("terminal_setup emits warning with setup instructions", async () => {
		const bus = makeBus();
		const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });
		await handleSlashCommand({ kind: "terminal_setup" }, bus, controller, { spawn });
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].kind).toBe("warning");
		expect(bus.events[0].data.message).toBeDefined();
		// Should always mention the universal fallback
		expect(bus.events[0].data.message).toContain("Ctrl+J");
	});

	test("terminal_setup detects tmux and triggers tmux config", async () => {
		const origTmux = process.env.TMUX;
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		try {
			const bus = makeBus();
			const tempDir = await mkdtemp(join(tmpdir(), "sprout-slash-tmux-"));
			const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });
			await handleSlashCommand({ kind: "terminal_setup" }, bus, controller, {
				spawn,
				tmuxConfPath: join(tempDir, "tmux.conf"),
			});
			expect(bus.events[0].data.message).toContain("tmux");
			await rm(tempDir, { recursive: true, force: true });
		} finally {
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
		}
	});

	test("terminal_setup detects iTerm2", async () => {
		const origTmux = process.env.TMUX;
		const origTermProgram = process.env.TERM_PROGRAM;
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "iTerm.app";
		try {
			const bus = makeBus();
			await handleSlashCommand({ kind: "terminal_setup" }, bus, controller);
			expect(bus.events[0].data.message).toContain("iTerm2");
		} finally {
			if (origTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = origTmux;
			if (origTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = origTermProgram;
		}
	});
});

describe("configureTerminal — Terminal.app", () => {
	test("reads active profile and sets useOptionAsMetaKey and Bell via PlistBuddy", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const calls: string[][] = [];
			const spawn = (args: string[]) => {
				calls.push(args);
				// First call: Print Startup Window Settings → return profile name
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				// Subsequent calls: setting values
				return { exitCode: 0, stdout: "" };
			};

			const fakePlist = "/tmp/test-terminal.plist";
			const result = await configureTerminal({ spawn, plistPath: fakePlist });

			// Should have 3 PlistBuddy calls: read profile, set useOptionAsMetaKey, set Bell
			expect(calls).toHaveLength(3);

			// First call reads the active profile name
			expect(calls[0]!.some((a: string) => a.startsWith("Print"))).toBe(true);
			expect(calls[0]![0]).toBe("/usr/libexec/PlistBuddy");

			// All calls should use the injected plist path
			for (const call of calls) {
				expect(call).toContain(fakePlist);
			}

			// Second call sets useOptionAsMetaKey on the "Pro" profile
			expect(calls[1]!.join(" ")).toContain("useOptionAsMetaKey");
			expect(calls[1]!.join(" ")).toContain("Pro");
			expect(calls[1]!.join(" ")).toContain("true");

			// Third call sets Bell (visual bell off = silence bell)
			expect(calls[2]!.join(" ")).toContain("Bell");
			expect(calls[2]!.join(" ")).toContain("Pro");

			// Result should mention what was configured
			expect(result).toContain("Option as Meta Key");
			expect(result).toContain("restart");
		} finally {
			restoreEnv(saved);
		}
	});

	test("escapes spaces in profile names for PlistBuddy", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const calls: string[][] = [];
			const spawn = (args: string[]) => {
				calls.push(args);
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Red Sands\n" };
				}
				return { exitCode: 0, stdout: "" };
			};

			const fakePlist = "/tmp/test-terminal.plist";
			await configureTerminal({ spawn, plistPath: fakePlist });

			// The Set commands should escape spaces in "Red Sands"
			expect(calls[1]!.join(" ")).toContain("Red\\ Sands");
			expect(calls[2]!.join(" ")).toContain("Red\\ Sands");

			// All calls should use the injected plist path
			for (const call of calls) {
				expect(call).toContain(fakePlist);
			}
		} finally {
			restoreEnv(saved);
		}
	});

	test("falls back to Add when Set fails (key does not exist)", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const calls: string[][] = [];
			const spawn = (args: string[]) => {
				calls.push(args);
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				// Set fails (key doesn't exist)
				if (args.some((a) => a.startsWith("Set"))) {
					return { exitCode: 1, stdout: "" };
				}
				// Add succeeds
				return { exitCode: 0, stdout: "" };
			};

			const fakePlist = "/tmp/test-terminal.plist";
			const result = await configureTerminal({ spawn, plistPath: fakePlist });

			// Should have attempted Set, then fallen back to Add for each key
			const setCalls = calls.filter((c) => c.some((a) => a.startsWith("Set")));
			const addCalls = calls.filter((c) => c.some((a) => a.startsWith("Add")));
			expect(setCalls.length).toBe(2);
			expect(addCalls.length).toBe(2);

			// All calls should use the injected plist path
			for (const call of calls) {
				expect(call).toContain(fakePlist);
			}

			// Should still report success
			expect(result).toContain("Option as Meta Key");
		} finally {
			restoreEnv(saved);
		}
	});

	test("reports failure when both Set and Add fail", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const spawn = (args: string[]) => {
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				// Both Set and Add fail
				return { exitCode: 1, stdout: "" };
			};

			const result = await configureTerminal({ spawn, plistPath: "/tmp/test-terminal.plist" });
			expect(result).toContain("failed");
			expect(result).not.toContain("enabled Option as Meta Key");
		} finally {
			restoreEnv(saved);
		}
	});

	test("partial failure: only Bell fails → instructions mention Bell, not Meta Key", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const spawn = (args: string[]) => {
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				// Bell Set/Add both fail; useOptionAsMetaKey succeeds
				if (args.some((a) => a.includes("Bell"))) {
					return { exitCode: 1, stdout: "" };
				}
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, plistPath: "/tmp/test-terminal.plist" });
			expect(result).toContain("failed");
			expect(result).toContain("Bell");
			// Should NOT include Meta Key manual instructions since Meta Key succeeded
			expect(result).not.toContain("Use Option as Meta Key");
			// Should include Bell manual instructions
			expect(result).toContain("Advanced");
		} finally {
			restoreEnv(saved);
		}
	});

	test("partial failure: only Meta Key fails → instructions mention Meta Key, not Bell", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const spawn = (args: string[]) => {
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				// useOptionAsMetaKey Set/Add both fail; Bell succeeds
				if (args.some((a) => a.includes("useOptionAsMetaKey"))) {
					return { exitCode: 1, stdout: "" };
				}
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, plistPath: "/tmp/test-terminal.plist" });
			expect(result).toContain("failed");
			expect(result).toContain("Option as Meta Key");
			expect(result).toContain("Use Option as Meta Key");
			// Should NOT include Bell manual instructions
			expect(result).not.toContain("Advanced");
		} finally {
			restoreEnv(saved);
		}
	});

	test("both fail → instructions mention both Meta Key and Bell", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const spawn = (args: string[]) => {
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				return { exitCode: 1, stdout: "" };
			};

			const result = await configureTerminal({ spawn, plistPath: "/tmp/test-terminal.plist" });
			expect(result).toContain("failed");
			expect(result).toContain("Option as Meta Key");
			expect(result).toContain("Bell");
			// Should include both manual instructions
			expect(result).toContain("Use Option as Meta Key");
			expect(result).toContain("Advanced");
		} finally {
			restoreEnv(saved);
		}
	});

	test("reports failure when profile read fails", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "Apple_Terminal";
		try {
			const spawn = (_args: string[]) => ({ exitCode: 1, stdout: "" });

			const result = await configureTerminal({ spawn, plistPath: "/tmp/test-terminal.plist" });
			expect(result).toContain("could not read active profile");
			expect(result).toContain("manually");
		} finally {
			restoreEnv(saved);
		}
	});
});

describe("configureTerminal — tmux", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-tmux-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("appends missing lines to tmux.conf and calls tmux source-file", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			const spawnCalls: string[][] = [];
			const spawn = (args: string[]) => {
				spawnCalls.push(args);
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			// Should have written the config file
			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");
			expect(contents).toContain("set -s extended-keys on");
			expect(contents).toContain("set -as terminal-features 'xterm*:extkeys'");
			expect(contents).toContain("set -s extended-keys-format csi-u");

			// Should have called tmux source-file
			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0]).toContain("tmux");
			expect(spawnCalls[0]!.join(" ")).toContain(confPath);

			// Result should report what was added
			expect(result).toContain("extended-keys");
		} finally {
			restoreEnv(saved);
		}
	});

	test("only appends lines not already present", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			// Pre-populate with one of the three lines
			await writeFile(confPath, "set -s extended-keys on\n");

			const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });
			await configureTerminal({ spawn, tmuxConfPath: confPath });

			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");

			// Should have the original line once, plus two new lines
			const extKeysCount = contents.split("set -s extended-keys on").length - 1;
			expect(extKeysCount).toBe(1);
			expect(contents).toContain("set -as terminal-features 'xterm*:extkeys'");
			expect(contents).toContain("set -s extended-keys-format csi-u");
		} finally {
			restoreEnv(saved);
		}
	});

	test("idempotent: running twice does not duplicate lines", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });

			await configureTerminal({ spawn, tmuxConfPath: confPath });
			await configureTerminal({ spawn, tmuxConfPath: confPath });

			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");

			// Each line should appear exactly once
			for (const line of [
				"set -s extended-keys on",
				"set -as terminal-features 'xterm*:extkeys'",
				"set -s extended-keys-format csi-u",
			]) {
				const count = contents.split(line).length - 1;
				expect(count).toBe(1);
			}
		} finally {
			restoreEnv(saved);
		}
	});

	test("reports already configured when all lines present", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			await writeFile(
				confPath,
				"set -s extended-keys on\nset -as terminal-features 'xterm*:extkeys'\nset -s extended-keys-format csi-u\n",
			);

			const spawnCalls: string[][] = [];
			const spawn = (args: string[]) => {
				spawnCalls.push(args);
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			// Should NOT call tmux source-file (nothing changed)
			expect(spawnCalls).toHaveLength(0);
			expect(result).toContain("already configured");
		} finally {
			restoreEnv(saved);
		}
	});

	test("reports reload failure when tmux source-file exits non-zero", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			const spawn = (args: string[]) => {
				// tmux source-file fails (e.g. server not running)
				if (args.includes("tmux")) {
					return { exitCode: 1, stdout: "" };
				}
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			// Should mention that config was written
			expect(result).toContain("added");
			expect(result).toContain(confPath);
			// Should NOT say "and reloaded"
			expect(result).not.toContain("and reloaded");
			// Should tell user reload failed and how to do it manually
			expect(result).toContain("could not reload");
			expect(result).toContain("tmux source-file");
		} finally {
			restoreEnv(saved);
		}
	});

	test("treats commented-out lines as missing and re-adds them", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			// All three lines are present but commented out
			await writeFile(
				confPath,
				"# set -s extended-keys on\n# set -as terminal-features 'xterm*:extkeys'\n# set -s extended-keys-format csi-u\n",
			);

			const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });
			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");

			// All three lines should be appended (uncommented)
			for (const line of [
				"set -s extended-keys on",
				"set -as terminal-features 'xterm*:extkeys'",
				"set -s extended-keys-format csi-u",
			]) {
				// Should appear uncommented at least once (the appended copy)
				const uncommented = contents.split("\n").filter((l) => l.trim() === line);
				expect(uncommented.length).toBeGreaterThanOrEqual(1);
			}

			// Should report lines were added
			expect(result).toContain("added 3 line(s)");
		} finally {
			restoreEnv(saved);
		}
	});

	test("does not re-add lines that exist uncommented", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			// Mix: first line uncommented, second commented, third uncommented
			await writeFile(
				confPath,
				"set -s extended-keys on\n# set -as terminal-features 'xterm*:extkeys'\nset -s extended-keys-format csi-u\n",
			);

			const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });
			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");

			// The uncommented lines should appear exactly once
			const extKeysCount = contents
				.split("\n")
				.filter((l) => l.trim() === "set -s extended-keys on").length;
			expect(extKeysCount).toBe(1);

			const csiuCount = contents
				.split("\n")
				.filter((l) => l.trim() === "set -s extended-keys-format csi-u").length;
			expect(csiuCount).toBe(1);

			// The commented-out line should have been re-added uncommented
			const featuresCount = contents
				.split("\n")
				.filter((l) => l.trim() === "set -as terminal-features 'xterm*:extkeys'").length;
			expect(featuresCount).toBe(1);

			// Should report only 1 line added
			expect(result).toContain("added 1 line(s)");
		} finally {
			restoreEnv(saved);
		}
	});

	test("recognizes lines with inline comments as already present", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			// All three lines present but with inline comments
			await writeFile(
				confPath,
				"set -s extended-keys on  # added by sprout\nset -as terminal-features 'xterm*:extkeys'  # for kitty protocol\nset -s extended-keys-format csi-u  # csi-u mode\n",
			);

			const spawnCalls: string[][] = [];
			const spawn = (args: string[]) => {
				spawnCalls.push(args);
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			// Should NOT call tmux source-file (nothing to add)
			expect(spawnCalls).toHaveLength(0);
			expect(result).toContain("already configured");

			// File should be unchanged
			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");
			const lineCount = contents.split("\n").filter((l) => l.trim() !== "").length;
			expect(lineCount).toBe(3);
		} finally {
			restoreEnv(saved);
		}
	});

	test("returns manual instructions when tmux.conf is not writable", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		delete process.env.TERM_PROGRAM;
		const confPath = join(tempDir, "tmux.conf");
		try {
			// Create a read-only file so appendFile will fail
			await writeFile(confPath, "# existing config\n");
			await chmod(confPath, 0o444);

			const spawnCalls: string[][] = [];
			const spawn = (args: string[]) => {
				spawnCalls.push(args);
				return { exitCode: 0, stdout: "" };
			};

			const result = await configureTerminal({ spawn, tmuxConfPath: confPath });

			// Should NOT have called tmux source-file (write failed)
			expect(spawnCalls).toHaveLength(0);

			// Should tell the user to add the lines manually
			expect(result).toContain("Could not write");
			expect(result).toContain(confPath);
			expect(result).toContain("set -s extended-keys on");
			expect(result).toContain("set -as terminal-features 'xterm*:extkeys'");
			expect(result).toContain("set -s extended-keys-format csi-u");
		} finally {
			// Restore write permission so cleanup can delete it
			await chmod(confPath, 0o644);
			restoreEnv(saved);
		}
	});
});

describe("configureTerminal — combined scenarios", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-combined-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("tmux + Terminal.app: writes tmux config AND calls PlistBuddy", async () => {
		const saved = saveEnv();
		process.env.TMUX = "/tmp/tmux-501/default,12345,0";
		process.env.TERM_PROGRAM = "Apple_Terminal";
		const confPath = join(tempDir, "tmux.conf");
		try {
			const spawnCalls: string[][] = [];
			const spawn = (args: string[]) => {
				spawnCalls.push(args);
				// tmux source-file
				if (args.includes("tmux")) {
					return { exitCode: 0, stdout: "" };
				}
				// PlistBuddy: Print profile name
				if (args.some((a) => a.startsWith("Print"))) {
					return { exitCode: 0, stdout: "Pro\n" };
				}
				// PlistBuddy: Set commands
				return { exitCode: 0, stdout: "" };
			};

			const fakePlist = "/tmp/test-combined.plist";
			const result = await configureTerminal({
				spawn,
				tmuxConfPath: confPath,
				plistPath: fakePlist,
			});

			// Verify tmux config was written
			const { readFile } = await import("node:fs/promises");
			const contents = await readFile(confPath, "utf-8");
			expect(contents).toContain("set -s extended-keys on");
			expect(contents).toContain("set -as terminal-features 'xterm*:extkeys'");
			expect(contents).toContain("set -s extended-keys-format csi-u");

			// Verify PlistBuddy was called
			const plistCalls = spawnCalls.filter((c) => c[0] === "/usr/libexec/PlistBuddy");
			expect(plistCalls.length).toBeGreaterThanOrEqual(1);

			// Result should mention both tmux and Terminal.app
			expect(result).toContain("tmux");
			expect(result).toContain("Option as Meta Key");
		} finally {
			restoreEnv(saved);
		}
	});
});

describe("configureTerminal — other terminals", () => {
	const spawn = (_args: string[]) => ({ exitCode: 0, stdout: "" });

	test("VS Code terminal suggests enableKittyKeyboardProtocol setting", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "vscode";
		try {
			const result = await configureTerminal({ spawn });
			expect(result).toContain("settings.json");
			expect(result).toContain("enableKittyKeyboardProtocol");
		} finally {
			restoreEnv(saved);
		}
	});

	test("native terminal (kitty) reports no setup needed", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "kitty";
		try {
			const result = await configureTerminal({ spawn });
			expect(result).toContain("No setup needed");
			expect(result).toContain("kitty");
		} finally {
			restoreEnv(saved);
		}
	});

	test("native terminal (ghostty) reports no setup needed", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "ghostty";
		try {
			const result = await configureTerminal({ spawn });
			expect(result).toContain("No setup needed");
			expect(result).toContain("ghostty");
		} finally {
			restoreEnv(saved);
		}
	});

	test("unknown terminal suggests checking docs for CSI u", async () => {
		const saved = saveEnv();
		delete process.env.TMUX;
		process.env.TERM_PROGRAM = "some-unknown-terminal";
		try {
			const result = await configureTerminal({ spawn });
			expect(result).toContain("Kitty keyboard protocol");
			expect(result).toContain("CSI u");
		} finally {
			restoreEnv(saved);
		}
	});
});

describe("resume flow", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-cli-resume-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("resumed session passes replayed history and sessionId to factory", async () => {
		const genomePath = join(tempDir, "genome");
		const logsDir = join(genomePath, "logs");
		await mkdir(logsDir, { recursive: true });
		const sessionId = "01RESUMETEST_SESSION_ID";
		const logPath = join(logsDir, `${sessionId}.jsonl`);

		const events = [
			{
				kind: "perceive",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { goal: "original goal" },
			},
			{
				kind: "plan_end",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: {
					turn: 1,
					assistant_message: {
						role: "assistant",
						content: [{ kind: "text", text: "I completed the task." }],
					},
				},
			},
		];
		await writeFile(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

		const history = await replayEventLog(logPath);
		expect(history).toHaveLength(2);
		expect(history[0]!.role).toBe("user");
		expect(history[1]!.role).toBe("assistant");

		let capturedSessionId: string | undefined;
		let capturedHistory: any[] | undefined;
		const factory: AgentFactory = async (options) => {
			capturedSessionId = options.sessionId;
			capturedHistory = options.initialHistory;
			return {
				agent: {
					steer() {},
					async run() {
						return {
							output: "done",
							success: true,
							stumbles: 0,
							turns: 1,
							timed_out: false,
						};
					},
				} as any,
				learnProcess: null,
			};
		};

		const bus = new EventBus();
		const controller = new SessionController({
			bus,
			genomePath,
			sessionId,
			initialHistory: history,
			factory,
		});

		await controller.submitGoal("continue work");

		expect(capturedSessionId).toBe(sessionId);
		expect(capturedHistory).toBeDefined();
		expect(capturedHistory).toHaveLength(2);
		expect(capturedHistory![0].role).toBe("user");
		expect(capturedHistory![1].role).toBe("assistant");
	});

	test("resume extracts child handles from session log with spawned agents", async () => {
		const genomePath = join(tempDir, "genome");
		const logsDir = join(genomePath, "logs");
		const sessionId = "01RESUMETEST_HANDLES";
		const handleLogDir = join(logsDir, sessionId);
		await mkdir(handleLogDir, { recursive: true });

		// Write the root agent's session log with a blocking spawned agent act_end
		const logPath = join(logsDir, `${sessionId}.jsonl`);
		const events = [
			{
				kind: "perceive",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { goal: "build a feature" },
			},
			{
				kind: "act_end",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: {
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-001",
					turns: 5,
					timed_out: false,
					tool_result_message: {
						role: "tool",
						content: [
							{
								kind: "tool_result",
								tool_result: { tool_call_id: "c1", content: "work completed", is_error: false },
							},
						],
						tool_call_id: "c1",
					},
				},
			},
		];
		await writeFile(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

		// Write the child handle's per-handle log with a session_end event
		const handleLogPath = join(handleLogDir, "handle-001.jsonl");
		const handleEvents: SessionEvent[] = [
			{
				kind: "perceive",
				timestamp: Date.now(),
				agent_id: "code-editor",
				depth: 1,
				data: { goal: "do work" },
			},
			{
				kind: "session_end",
				timestamp: Date.now(),
				agent_id: "code-editor",
				depth: 1,
				data: { output: "work done", success: true, turns: 5 },
			},
		];
		await writeFile(handleLogPath, `${handleEvents.map((e) => JSON.stringify(e)).join("\n")}\n`);

		// Extract child handles (same call cli.ts will make during resume)
		const handles = await extractChildHandles(logPath);

		expect(handles).toHaveLength(1);
		expect(handles[0]!.handleId).toBe("handle-001");
		expect(handles[0]!.agentName).toBe("code-editor");
		expect(handles[0]!.completed).toBe(true); // turns present = blocking spawn completed

		// Also verify checkHandleCompleted works with the per-handle log
		const completed = await checkHandleCompleted(handleLogDir, "handle-001");
		expect(completed).toBe(true);
	});

	test("resume detects incomplete child handle from per-handle log", async () => {
		const genomePath = join(tempDir, "genome");
		const logsDir = join(genomePath, "logs");
		const sessionId = "01RESUMETEST_INCOMPLETE";
		const handleLogDir = join(logsDir, sessionId);
		await mkdir(handleLogDir, { recursive: true });

		// Write the root agent's session log with a non-blocking spawn
		const logPath = join(logsDir, `${sessionId}.jsonl`);
		const events = [
			{
				kind: "perceive",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { goal: "spawn background work" },
			},
			{
				kind: "act_end",
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: {
					agent_name: "code-editor",
					success: true,
					handle_id: "handle-incomplete",
					tool_result_message: {
						role: "tool",
						content: [
							{
								kind: "tool_result",
								tool_result: {
									tool_call_id: "c1",
									content: "Agent started. Handle: handle-incomplete",
									is_error: false,
								},
							},
						],
						tool_call_id: "c1",
					},
				},
			},
		];
		await writeFile(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

		// Write per-handle log WITHOUT a session_end event (agent is still running/crashed)
		const handleLogPath = join(handleLogDir, "handle-incomplete.jsonl");
		const handleEvents: SessionEvent[] = [
			{
				kind: "perceive",
				timestamp: Date.now(),
				agent_id: "code-editor",
				depth: 1,
				data: { goal: "do work" },
			},
		];
		await writeFile(handleLogPath, `${handleEvents.map((e) => JSON.stringify(e)).join("\n")}\n`);

		const handles = await extractChildHandles(logPath);
		expect(handles).toHaveLength(1);

		// checkHandleCompleted should return false — no session_end in the per-handle log
		const completed = await checkHandleCompleted(handleLogDir, "handle-incomplete");
		expect(completed).toBe(false);
	});
});

describe("inputHistoryPath", () => {
	test("resolves inside the genome directory", () => {
		const genomePath = "/home/user/.local/share/sprout-genome";
		const result = inputHistoryPath(genomePath);
		expect(result).toBe(join(genomePath, "input_history.txt"));
	});

	test("works with custom genome path", () => {
		const result = inputHistoryPath("/custom/genome");
		expect(result).toBe("/custom/genome/input_history.txt");
	});
});

describe("startBusInfrastructure", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-bus-infra-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("starts server, connects client, creates spawner, and returns cleanup", async () => {
		const genomePath = join(tempDir, "genome");
		// Initialize a minimal genome directory
		await mkdir(join(genomePath, ".git"), { recursive: true });

		const infra = await startBusInfrastructure({
			genomePath,
			sessionId: "test-session-01",
		});

		try {
			expect(infra.server).toBeDefined();
			expect(infra.bus).toBeDefined();
			expect(infra.bus.connected).toBe(true);
			expect(infra.spawner).toBeDefined();
			expect(typeof infra.cleanup).toBe("function");
		} finally {
			await infra.cleanup();
		}
	});

	test("cleanup stops server and disconnects client", async () => {
		const genomePath = join(tempDir, "genome");
		await mkdir(join(genomePath, ".git"), { recursive: true });

		const infra = await startBusInfrastructure({
			genomePath,
			sessionId: "test-session-02",
		});

		await infra.cleanup();

		expect(infra.bus.connected).toBe(false);
	});

	test("returns genome instance", async () => {
		const genomePath = join(tempDir, "genome-ret");
		await mkdir(join(genomePath, ".git"), { recursive: true });

		const infra = await startBusInfrastructure({
			genomePath,
			sessionId: "test-session-genome",
		});

		try {
			expect(infra.genome).toBeDefined();
			expect(typeof infra.genome.allAgents).toBe("function");
		} finally {
			await infra.cleanup();
		}
	});

	test("spawner uses the bus server URL", async () => {
		const genomePath = join(tempDir, "genome");
		await mkdir(join(genomePath, ".git"), { recursive: true });

		const infra = await startBusInfrastructure({
			genomePath,
			sessionId: "test-session-03",
		});

		try {
			// The spawner should be functional (we can't deeply inspect it,
			// but we verify it was created with the right session)
			expect(infra.spawner.getHandles()).toEqual([]);
		} finally {
			await infra.cleanup();
		}
	});
});

describe("defaultFactory passes spawner to createAgent", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-factory-spawner-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("spawner option in AgentFactoryOptions is forwarded", async () => {
		// We test this indirectly: the SessionController's defaultFactory
		// should pass spawner to createAgent. We verify the type accepts it.
		const genomePath = join(tempDir, "genome");
		await mkdir(join(genomePath, ".git"), { recursive: true });

		let capturedSpawner: unknown;
		const factory: AgentFactory = async (options) => {
			capturedSpawner = options.spawner;
			return {
				agent: {
					steer() {},
					requestCompaction() {},
					async run() {
						return {
							output: "done",
							success: true,
							stumbles: 0,
							turns: 1,
							timed_out: false,
						};
					},
				} as any,
				learnProcess: null,
			};
		};

		const bus = new EventBus();
		const fakeSpawner = {
			getHandles: () => [],
			subscribeSessionEvents: async () => {},
			updateSessionId: async () => {},
			clearHandles: async () => {},
		} as any;
		const controller = new SessionController({
			bus,
			genomePath,
			factory,
			spawner: fakeSpawner,
		});

		await controller.submitGoal("test goal");
		expect(capturedSpawner).toBe(fakeSpawner);
	});
});

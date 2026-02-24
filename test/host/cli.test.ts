import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleSlashCommand, inputHistoryPath, parseArgs } from "../../src/host/cli.ts";
import { EventBus } from "../../src/host/event-bus.ts";
import { replayEventLog } from "../../src/host/resume.ts";
import type { AgentFactory } from "../../src/host/session-controller.ts";
import { SessionController } from "../../src/host/session-controller.ts";

const defaultGenomePath = join(homedir(), ".local/share/sprout-genome");

describe("parseArgs", () => {
	test("no args → interactive mode", () => {
		const result = parseArgs([]);
		expect(result).toEqual({
			kind: "interactive",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt returns oneshot mode", () => {
		const result = parseArgs(["--prompt", "Fix the bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with multiple words joins them", () => {
		const result = parseArgs(["--prompt", "Fix", "the", "bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--prompt with no goal returns help", () => {
		const result = parseArgs(["--prompt"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("bare goal returns oneshot mode", () => {
		const result = parseArgs(["Fix the bug"]);
		expect(result).toEqual({
			kind: "oneshot",
			goal: "Fix the bug",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume returns resume mode", () => {
		const result = parseArgs(["--resume", "01ABC123"]);
		expect(result).toEqual({
			kind: "resume",
			sessionId: "01ABC123",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume with no session ID returns help", () => {
		const result = parseArgs(["--resume"]);
		expect(result).toEqual({ kind: "help" });
	});

	test("--resume-last returns resume-last mode", () => {
		const result = parseArgs(["--resume-last"]);
		expect(result).toEqual({
			kind: "resume-last",
			genomePath: defaultGenomePath,
		});
	});

	test("--list returns list mode", () => {
		const result = parseArgs(["--list"]);
		expect(result).toEqual({
			kind: "list",
			genomePath: defaultGenomePath,
		});
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

	test("--genome-path with goal → oneshot with custom path", () => {
		const result = parseArgs(["--genome-path", "/custom/path", "Fix bug"]);
		expect(result).toEqual({
			kind: "oneshot",
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

	test("help emits warning event with command list", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "help" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].kind).toBe("warning");
		expect(bus.events[0].data.message).toContain("/help");
		expect(bus.events[0].data.message).toContain("/quit");
	});

	test("compact emits compact command", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "compact" }, bus, controller);
		expect(bus.commands).toHaveLength(1);
		expect(bus.commands[0].kind).toBe("compact");
	});

	test("clear emits clear command", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "clear" }, bus, controller);
		expect(bus.commands).toHaveLength(1);
		expect(bus.commands[0].kind).toBe("clear");
	});

	test("switch_model emits command and warning event", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "switch_model", model: "gpt-4o" }, bus, controller);
		expect(bus.commands).toHaveLength(1);
		expect(bus.commands[0].kind).toBe("switch_model");
		expect(bus.commands[0].data.model).toBe("gpt-4o");
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("gpt-4o");
	});

	test("switch_model without arg shows usage hint instead of emitting command", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "switch_model", model: undefined }, bus, controller);
		expect(bus.commands).toHaveLength(0);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("Usage: /model");
	});

	test("status emits warning event with session info", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "status" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("01ABCDEF...");
		expect(bus.events[0].data.message).toContain("idle");
	});

	test("unknown emits warning event", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "unknown", raw: "/foo" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("/foo");
	});

	test("quit emits quit command and exits", () => {
		const bus = makeBus();
		const origExit = process.exit;
		let exitCode: number | undefined;
		process.exit = ((code?: number) => {
			exitCode = code ?? 0;
		}) as any;

		try {
			handleSlashCommand({ kind: "quit" }, bus, controller);
			expect(bus.commands).toEqual([{ kind: "quit", data: {} }]);
			expect(exitCode).toBe(0);
		} finally {
			process.exit = origExit;
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

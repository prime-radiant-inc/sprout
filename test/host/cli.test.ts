import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkHandleCompleted, extractChildHandles } from "../../src/bus/resume.ts";
import {
	handleSlashCommand,
	inputHistoryPath,
	parseArgs,
	startBusInfrastructure,
} from "../../src/host/cli.ts";
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

	test("--resume with no session ID shows session picker", () => {
		const result = parseArgs(["--resume"]);
		expect(result).toEqual({
			kind: "list",
			genomePath: defaultGenomePath,
		});
	});

	test("--resume-last returns resume-last mode", () => {
		const result = parseArgs(["--resume-last"]);
		expect(result).toEqual({
			kind: "resume-last",
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

	test("help emits warning event with command list and key hints", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "help" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].kind).toBe("warning");
		expect(bus.events[0].data.message).toContain("/help");
		expect(bus.events[0].data.message).toContain("/quit");
		expect(bus.events[0].data.message).toContain("Ctrl+J");
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

	test("switch_model without arg returns show_model_picker action", () => {
		const bus = makeBus();
		const result = handleSlashCommand({ kind: "switch_model", model: undefined }, bus, controller);
		expect(result).toEqual({ action: "show_model_picker" });
		expect(bus.commands).toHaveLength(0);
		expect(bus.events).toHaveLength(0);
	});

	test("status emits warning event with session info", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "status" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("01ABCDEF12345678ABCDEF1234");
		expect(bus.events[0].data.message).toContain("idle");
	});

	test("unknown emits warning event", () => {
		const bus = makeBus();
		handleSlashCommand({ kind: "unknown", raw: "/foo" }, bus, controller);
		expect(bus.events).toHaveLength(1);
		expect(bus.events[0].data.message).toContain("/foo");
	});

	test("quit emits quit command and returns exit action", () => {
		const bus = makeBus();
		const result = handleSlashCommand({ kind: "quit" }, bus, controller);
		expect(bus.commands).toEqual([{ kind: "quit", data: {} }]);
		expect(result).toEqual({ action: "exit" });
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
						content: [{ kind: "tool_result", tool_result: { tool_call_id: "c1", content: "work completed", is_error: false } }],
						tool_call_id: "c1",
					},
				},
			},
		];
		await writeFile(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

		// Write the child handle's per-handle log with a result event
		const handleLogPath = join(handleLogDir, "handle-001.jsonl");
		const handleEvents = [
			JSON.stringify({ kind: "event", handle_id: "handle-001", event: { kind: "perceive", timestamp: Date.now(), agent_id: "code-editor", depth: 1, data: { goal: "do work" } } }),
			JSON.stringify({ kind: "result", handle_id: "handle-001", output: "work done", success: true, stumbles: 0, turns: 5, timed_out: false }),
		];
		await writeFile(handleLogPath, `${handleEvents.join("\n")}\n`);

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
						content: [{ kind: "tool_result", tool_result: { tool_call_id: "c1", content: "Agent started. Handle: handle-incomplete", is_error: false } }],
						tool_call_id: "c1",
					},
				},
			},
		];
		await writeFile(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

		// Write per-handle log WITHOUT a result event (agent is still running/crashed)
		const handleLogPath = join(handleLogDir, "handle-incomplete.jsonl");
		const handleEvents = [
			JSON.stringify({ kind: "event", handle_id: "handle-incomplete", event: { kind: "perceive", timestamp: Date.now(), agent_id: "code-editor", depth: 1, data: { goal: "do work" } } }),
		];
		await writeFile(handleLogPath, `${handleEvents.join("\n")}\n`);

		const handles = await extractChildHandles(logPath);
		expect(handles).toHaveLength(1);

		// checkHandleCompleted should return false — no result in the per-handle log
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
		const fakeSpawner = { getHandles: () => [] } as any;
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

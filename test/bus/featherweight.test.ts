import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusClient } from "../../src/bus/client.ts";
import { loadCompletedChildHandles } from "../../src/bus/resume.ts";
import { BusServer } from "../../src/bus/server.ts";
import {
	AgentSpawner,
	type FeatherweightExecInput,
	type FeatherweightFn,
	type SpawnAgentOptions,
} from "../../src/bus/spawner.ts";
import { sessionEvents } from "../../src/bus/topics.ts";
import type { EventMessage, ResultMessage } from "../../src/bus/types.ts";
import { parseBusMessage } from "../../src/bus/types.ts";
import { addr } from "../helpers/agent-address.ts";
import { waitFor } from "../helpers/wait-for.ts";

const SESSION_ID = "featherweight-test-session";

describe("featherweight placement (spec §5)", () => {
	let server: BusServer;
	let bus: BusClient;
	let tempDir: string;
	let dataDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-fw-"));
		dataDir = join(tempDir, "data");
		server = new BusServer({ port: 0 });
		await server.start();
		bus = new BusClient(server.url);
		await bus.connect();
	});

	afterEach(async () => {
		await bus.disconnect();
		await server.stop();
		await rm(tempDir, { recursive: true, force: true });
	});

	function baseOpts(goal: string, overrides: Partial<SpawnAgentOptions> = {}): SpawnAgentOptions {
		return {
			agentName: "llm-call",
			genomePath: join(tempDir, "genome"),
			projectDataDir: dataDir,
			caller: addr("root", 0),
			goal,
			blocking: true,
			shared: false,
			workDir: tempDir,
			featherweight: true,
			...overrides,
		};
	}

	/** A featherweight executor that echoes the goal and records its inputs. */
	function recordingExecutor(): { fn: FeatherweightFn; calls: FeatherweightExecInput[] } {
		const calls: FeatherweightExecInput[] = [];
		const fn: FeatherweightFn = async (input) => {
			calls.push(input);
			return {
				output: `answer:${input.goal}`,
				success: true,
				stumbles: 0,
				turns: 1,
				timed_out: false,
			};
		};
		return { fn, calls };
	}

	test("runs in-process without touching the subprocess spawnFn", async () => {
		let spawnFnCalled = false;
		const spawnFn = () => {
			spawnFnCalled = true;
			return { kill: () => {}, exited: Promise.resolve(0) };
		};
		const { fn, calls } = recordingExecutor();
		const spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			spawnFn,
			undefined,
			undefined,
			undefined,
			fn,
		);

		const result = (await spawner.spawnAgent(baseOpts("summarize this"))) as ResultMessage;

		expect(spawnFnCalled).toBe(false);
		expect(calls.length).toBe(1);
		expect(result.output).toBe("answer:summarize this");
		expect(result.success).toBe(true);
	});

	test("falls back to the subprocess path when no executor is wired", async () => {
		let spawnFnCalled = false;
		const spawnFn = () => {
			spawnFnCalled = true;
			return { kill: () => {}, exited: Promise.resolve(0) };
		};
		const spawner = new AgentSpawner(bus, server.url, SESSION_ID, spawnFn);
		// Non-blocking so the test doesn't wait on a result that never comes.
		await spawner.spawnAgent(baseOpts("no executor", { blocking: false })).catch(() => {});
		expect(spawnFnCalled).toBe(true);
		await spawner.shutdown();
	});

	test("publishes session_start and session_end on the session topic", async () => {
		const observerBus = new BusClient(server.url);
		await observerBus.connect();
		const events: EventMessage[] = [];
		await observerBus.subscribe(sessionEvents(SESSION_ID), (payload) => {
			const msg = parseBusMessage(payload);
			if (msg.kind === "event") events.push(msg);
		});

		const { fn } = recordingExecutor();
		const spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			() => ({ kill: () => {}, exited: Promise.resolve(0) }),
			undefined,
			undefined,
			undefined,
			fn,
		);

		await spawner.spawnAgent(baseOpts("visible work"));

		await waitFor(() => events.some((e) => e.event.kind === "session_end"));
		const kinds = events.map((e) => e.event.kind);
		expect(kinds).toContain("session_start");
		expect(kinds).toContain("session_end");
		expect(events.every((e) => typeof e.handle_id === "string")).toBe(true);
		await observerBus.disconnect();
	});

	test("writes a resume-compatible per-handle log that loadCompletedChildHandles reads", async () => {
		const { fn } = recordingExecutor();
		const handleId = "01FEATHERWEIGHTLOGHANDLE00";
		const spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			() => ({ kill: () => {}, exited: Promise.resolve(0) }),
			undefined,
			undefined,
			undefined,
			fn,
		);

		await spawner.spawnAgent(baseOpts("log me", { handleId }));

		const handleLogDir = join(dataDir, "logs", SESSION_ID);
		const logPath = join(handleLogDir, `${handleId}.jsonl`);
		const logLines = (await readFile(logPath, "utf-8"))
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l));
		const kinds = logLines.map((r) => r.kind);
		expect(kinds).toContain("perceive");
		expect(kinds).toContain("plan_end");
		expect(kinds).toContain("session_end");

		// Simulate the owner's act log that records this delegation, then resume
		// on a fresh spawner: the handle registers from the per-handle log.
		const ownerLogPath = join(handleLogDir, "owner.jsonl");
		await mkdir(handleLogDir, { recursive: true });
		const actEnvelope = (kind: string, data: Record<string, unknown>) =>
			`${JSON.stringify({ kind, timestamp: Date.now(), agent_id: "root", depth: 0, data })}\n`;
		await writeFile(
			ownerLogPath,
			actEnvelope("act_start", {
				agent_name: "llm-call",
				handle_id: handleId,
				child_id: handleId,
			}) +
				actEnvelope("act_end", {
					agent_name: "llm-call",
					handle_id: handleId,
					child_id: handleId,
					turns: 1,
				}),
		);

		const completed = await loadCompletedChildHandles({
			logPath: ownerLogPath,
			handleLogDir,
			ownerId: "root",
		});
		expect(completed.length).toBe(1);
		expect(completed[0]!.result.output).toBe("answer:log me");

		const freshSpawner = new AgentSpawner(bus, server.url, SESSION_ID);
		for (const { handleId: hid, result, agentName } of completed) {
			freshSpawner.registerCompletedHandle(hid, result, "root", {
				agentName,
				genomePath: "",
				caller: addr("root", 0),
				workDir: tempDir,
			});
		}
		const waited = await freshSpawner.waitAgent(handleId);
		expect(waited.output).toBe("answer:log me");
	});

	test("wait_agent on a non-blocking featherweight handle returns the cached result", async () => {
		const { fn } = recordingExecutor();
		const spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			() => ({ kill: () => {}, exited: Promise.resolve(0) }),
			undefined,
			undefined,
			undefined,
			fn,
		);

		const handleId = (await spawner.spawnAgent(
			baseOpts("background", { blocking: false }),
		)) as string;
		const result = await spawner.waitAgent(handleId);
		expect(result.output).toBe("answer:background");
	});

	test("a follow-up message_agent re-runs in-process with prior history present", async () => {
		const { fn, calls } = recordingExecutor();
		const handleId = "01FEATHERWEIGHTRERUN000000";
		const spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			() => ({ kill: () => {}, exited: Promise.resolve(0) }),
			undefined,
			undefined,
			undefined,
			fn,
		);

		await spawner.spawnAgent(baseOpts("first question", { handleId }));
		expect(calls[0]!.history).toBeUndefined();

		const followUp = await spawner.messageAgent(
			handleId,
			"refine your answer",
			addr("root", 0),
			true,
		);
		expect((followUp as ResultMessage).output).toBe("answer:refine your answer");
		// The re-run received the original request and response as prior history.
		const rerunHistory = calls[1]!.history;
		expect(rerunHistory).toBeDefined();
		expect(rerunHistory!.length).toBe(2);
	});

	test("a three-way featherweight fan-out all completes", async () => {
		const { fn } = recordingExecutor();
		const spawner = new AgentSpawner(
			bus,
			server.url,
			SESSION_ID,
			() => ({ kill: () => {}, exited: Promise.resolve(0) }),
			undefined,
			undefined,
			undefined,
			fn,
		);

		const results = (await Promise.all([
			spawner.spawnAgent(baseOpts("one", { handleId: "01FANOUT0000000000000000A" })),
			spawner.spawnAgent(baseOpts("two", { handleId: "01FANOUT0000000000000000B" })),
			spawner.spawnAgent(baseOpts("three", { handleId: "01FANOUT0000000000000000C" })),
		])) as ResultMessage[];

		expect(results.map((r) => r.output).sort()).toEqual([
			"answer:one",
			"answer:three",
			"answer:two",
		]);
		expect(results.every((r) => r.success)).toBe(true);
	});
});

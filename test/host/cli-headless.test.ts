import { describe, expect, test } from "bun:test";
import { runHeadlessMode } from "../../src/host/cli-headless.ts";
import type { Message } from "../../src/llm/types.ts";

describe("runHeadlessMode", () => {
	test("runs the shared session runtime, prints output, and cleans up infra", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const submitted: string[] = [];
		let cleanupCount = 0;

		const result = await runHeadlessMode(
			{
				goal: "fix tests",
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				startBusInfrastructure: async () => ({
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
					cleanup: async () => {
						cleanupCount++;
					},
				}),
			},
			{
				createSessionId: () => "01HEADLESS",
				bootstrapRuntime: async (opts) => {
					expect(opts.sessionId).toBe("01HEADLESS");
					return {
						controller: {
							runGoal: async (goal: string) => {
								submitted.push(goal);
								return {
									sessionId: "01HEADLESS",
									output: "done",
									success: true,
									stumbles: 0,
									turns: 2,
									timedOut: false,
								};
							},
						},
					};
				},
				writeStdout: (line) => {
					stdout.push(line);
				},
				writeStderr: (line) => {
					stderr.push(line);
				},
			},
		);

		expect(submitted).toEqual(["fix tests"]);
		expect(stdout).toEqual(["done"]);
		expect(stderr).toEqual(["Session: 01HEADLESS"]);
		expect(cleanupCount).toBe(1);
		expect(result).toEqual({
			sessionId: "01HEADLESS",
			output: "done",
			success: true,
			stumbles: 0,
			turns: 2,
			timedOut: false,
		});
	});

	test("forwards resume state into the shared runtime bootstrap", async () => {
		const history: Message[] = [{ role: "user", content: [{ kind: "text", text: "resume me" }] }];

		await runHeadlessMode(
			{
				goal: "continue",
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				sessionId: "01RESUME",
				initialHistory: history,
				initialSelectionRequest: {
					kind: "model",
					model: {
						providerId: "openrouter",
						modelId: "anthropic/claude-sonnet-4.5",
					},
				},
				completedHandles: [
					{
						handleId: "h1",
						ownerId: "root",
						result: {
							kind: "result",
							handle_id: "h1",
							output: "done",
							success: true,
							stumbles: 0,
							turns: 1,
							timed_out: false,
						},
					},
				],
				startBusInfrastructure: async () => ({
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
					cleanup: async () => {},
				}),
			},
			{
				createSessionId: () => "01UNUSED",
				bootstrapRuntime: async (opts) => {
					expect(opts.sessionId).toBe("01RESUME");
					expect(opts.initialHistory).toEqual(history);
					expect(opts.initialSelectionRequest).toEqual({
						kind: "model",
						model: {
							providerId: "openrouter",
							modelId: "anthropic/claude-sonnet-4.5",
						},
					});
					expect(opts.completedHandles?.map((handle) => handle.handleId)).toEqual(["h1"]);
					return {
						controller: {
							runGoal: async () => ({
								sessionId: "01RESUME",
								output: "done",
								success: true,
								stumbles: 0,
								turns: 1,
								timedOut: false,
							}),
						},
					};
				},
				writeStdout: () => {},
				writeStderr: () => {},
			},
		);
	});

	test("passes atifPath and evalMode into the shared runtime bootstrap", async () => {
		await runHeadlessMode(
			{
				goal: "benchmark task",
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				atifPath: "/tmp/trajectory.json",
				evalMode: true,
				startBusInfrastructure: async () => ({
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
					cleanup: async () => {},
				}),
			},
			{
				createSessionId: () => "01ATIF",
				bootstrapRuntime: async (opts) => {
					expect(opts.atifPath).toBe("/tmp/trajectory.json");
					expect(opts.evalMode).toBe(true);
					return {
						controller: {
							runGoal: async () => ({
								sessionId: "01ATIF",
								output: "done",
								success: true,
								stumbles: 0,
								turns: 1,
								timedOut: false,
							}),
						},
					};
				},
				writeStdout: () => {},
				writeStderr: () => {},
			},
		);
	});

	test("cleans up infra and rethrows when the run fails", async () => {
		let cleanupCount = 0;

		await expect(
			runHeadlessMode(
				{
					goal: "boom",
					genomePath: "/tmp/genome",
					projectDataDir: "/tmp/project",
					rootDir: "/tmp/root",
					startBusInfrastructure: async () => ({
						spawner: { id: "spawner" } as any,
						genome: { id: "genome" } as any,
						cleanup: async () => {
							cleanupCount++;
						},
					}),
				},
				{
					createSessionId: () => "01FAIL",
					bootstrapRuntime: async () => ({
						controller: {
							runGoal: async () => {
								throw new Error("run failed");
							},
						},
					}),
					writeStdout: () => {},
					writeStderr: () => {},
				},
			),
		).rejects.toThrow("run failed");

		expect(cleanupCount).toBe(1);
	});

	test("fails clearly when the shared runtime controller cannot run headless goals", async () => {
		let cleanupCount = 0;

		await expect(
			runHeadlessMode(
				{
					goal: "boom",
					genomePath: "/tmp/genome",
					projectDataDir: "/tmp/project",
					rootDir: "/tmp/root",
					startBusInfrastructure: async () => ({
						spawner: { id: "spawner" } as any,
						genome: { id: "genome" } as any,
						cleanup: async () => {
							cleanupCount++;
						},
					}),
				},
				{
					createSessionId: () => "01FAIL",
					bootstrapRuntime: async () => ({
						controller: {} as any,
					}),
					writeStdout: () => {},
					writeStderr: () => {},
				},
			),
		).rejects.toThrow("Shared session runtime does not expose runGoal()");

		expect(cleanupCount).toBe(1);
	});
});

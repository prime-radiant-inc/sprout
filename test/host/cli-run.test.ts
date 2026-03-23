import { describe, expect, test } from "bun:test";
import { runCli } from "../../src/host/cli-run.ts";

describe("runCli", () => {
	test("dispatches headless resume commands through the shared resume state", async () => {
		const infos: string[] = [];
		let captured:
			| {
					sessionId?: string;
					initialHistoryLength?: number;
			  }
			| undefined;

		await runCli(
			{
				kind: "headless",
				sessionId: "01RESUME",
				goal: "continue",
				genomePath: "/tmp/genome",
			},
			{
				loadDotenv: () => {},
				resolveProjectDir: async () => "/tmp/project",
				loadResumeState: async () => ({
					sessionId: "01RESUME",
					history: [{ role: "user", content: [{ kind: "text", text: "old goal" }] }],
					events: [],
					selectionRequest: {
						kind: "tier",
						tier: "fast",
					},
					completedHandles: [
						{
							handleId: "h1",
							ownerId: "root",
							agentName: "worker",
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
				}),
				runHeadlessMode: async (opts) => {
					captured = {
						sessionId: opts.sessionId,
						initialHistoryLength: opts.initialHistory?.length,
					};
					return {
						sessionId: opts.sessionId ?? "missing",
						output: "done",
						success: true,
						stumbles: 0,
						turns: 1,
						timedOut: false,
					};
				},
				logError: (line) => {
					infos.push(line);
				},
			},
		);

		expect(captured).toEqual({
			sessionId: "01RESUME",
			initialHistoryLength: 1,
		});
		expect(infos).toEqual([]);
	});

	test("prints a clear error and exits non-zero when a resumed headless session is missing", async () => {
		const errors: string[] = [];
		const priorExitCode = process.exitCode;
		process.exitCode = 0;

		try {
			await runCli(
				{
					kind: "headless",
					sessionId: "01MISSING",
					goal: "continue",
					genomePath: "/tmp/genome",
				},
				{
					loadDotenv: () => {},
					resolveProjectDir: async () => "/tmp/project",
					loadResumeState: async () => undefined,
					runHeadlessMode: async () => {
						throw new Error("should not run");
					},
					logError: (line) => {
						errors.push(line);
					},
				},
			);

			expect(errors).toEqual(["Session not found: 01MISSING"]);
			expect(process.exitCode ?? 0).toBe(1);
		} finally {
			process.exitCode = priorExitCode ?? 0;
		}
	});

	test("cleans up bus infrastructure when interactive bootstrap fails", async () => {
		let cleanupCount = 0;

		await expect(
			runCli(
				{
					kind: "interactive",
					genomePath: "/tmp/genome",
				},
				{
					loadDotenv: () => {},
					resolveProjectDir: async () => "/tmp/project",
					startBusInfrastructure: async () => ({
						server: {} as any,
						bus: {} as any,
						spawner: {} as any,
						genome: {} as any,
						cleanup: async () => {
							cleanupCount++;
						},
					}),
					bootstrapRuntime: async () => {
						throw new Error("bootstrap failed");
					},
				},
			),
		).rejects.toThrow("bootstrap failed");

		expect(cleanupCount).toBe(1);
	});

	test("does not print env-key warnings before shared runtime bootstrap", async () => {
		const errors: string[] = [];
		const savedEnv = {
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			GEMINI_API_KEY: process.env.GEMINI_API_KEY,
			GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
		};
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.OPENAI_API_KEY;
		delete process.env.GEMINI_API_KEY;
		delete process.env.GOOGLE_API_KEY;

		try {
			await runCli(
				{
					kind: "headless",
					goal: "continue",
					genomePath: "/tmp/genome",
				},
				{
					loadDotenv: () => {},
					resolveProjectDir: async () => "/tmp/project",
					runHeadlessMode: async () => ({
						sessionId: "01HEADLESS",
						output: "done",
						success: true,
						stumbles: 0,
						turns: 1,
						timedOut: false,
					}),
					logError: (line) => {
						errors.push(line);
					},
				},
			);
		} finally {
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		expect(errors).toEqual([]);
	});
});

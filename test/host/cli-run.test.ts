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
});

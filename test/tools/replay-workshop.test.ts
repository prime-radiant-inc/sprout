import { describe, expect, test } from "bun:test";
import { type ReplayWorkshopCliDeps, runReplayWorkshopCli } from "../../tools/replay-workshop.ts";

function createIo() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		io: {
			out: (line: string) => {
				stdout.push(line);
			},
			err: (line: string) => {
				stderr.push(line);
			},
		},
	};
}

describe("replay workshop CLI", () => {
	test("list prints one summary per turn", async () => {
		const { io, stdout, stderr } = createIo();
		const deps: ReplayWorkshopCliDeps = {
			loadDotenv: async () => {},
			listReplayTurns: async () => [
				{
					turn: 3,
					depth: 1,
					agentId: "child",
					provider: "openai",
					model: "gpt-5.4",
					finishReason: "stop",
					inputTokens: 200,
					outputTokens: 40,
				},
			],
			showReplayTurn: async () => {
				throw new Error("unexpected");
			},
			replayTurn: async () => {
				throw new Error("unexpected");
			},
		};

		const exitCode = await runReplayWorkshopCli(["list", "/tmp/session.jsonl"], io, deps);

		expect(exitCode).toBe(0);
		expect(stderr).toEqual([]);
		expect(stdout).toEqual([
			"turn=3 depth=1 agent=child provider=openai model=gpt-5.4 finish=stop input=200 output=40",
		]);
	});

	test("show requires --turn", async () => {
		const { io, stderr } = createIo();
		const deps: ReplayWorkshopCliDeps = {
			loadDotenv: async () => {},
			listReplayTurns: async () => [],
			showReplayTurn: async () => {
				throw new Error("unexpected");
			},
			replayTurn: async () => {
				throw new Error("unexpected");
			},
		};

		const exitCode = await runReplayWorkshopCli(["show", "/tmp/session.jsonl"], io, deps);

		expect(exitCode).toBe(1);
		expect(stderr[0]).toContain("Usage:");
	});

	test("replay forwards overrides and prints JSON", async () => {
		const { io, stdout, stderr } = createIo();
		const deps: ReplayWorkshopCliDeps = {
			loadDotenv: async () => {},
			listReplayTurns: async () => [],
			showReplayTurn: async () => {
				throw new Error("unexpected");
			},
			replayTurn: async (_path, options) => ({
				request: {
					model: options.modelOverride ?? "gpt-5.4",
					provider: "openai",
					messages: [],
					tools: [],
				},
				response: {
					id: "replayed",
					model: "gpt-5-mini",
					provider: "openai",
					message: { role: "assistant", content: [] },
					finish_reason: { reason: "stop" },
					usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
				},
			}),
		};

		const exitCode = await runReplayWorkshopCli(
			[
				"replay",
				"/tmp/session.jsonl",
				"--turn",
				"4",
				"--system-prompt-prepend",
				"prepend",
				"--system-prompt-append",
				"append",
				"--model",
				"openai:gpt-5-mini",
			],
			io,
			deps,
		);

		expect(exitCode).toBe(0);
		expect(stderr).toEqual([]);
		expect(stdout).toHaveLength(1);
		expect(stdout[0]).toContain('"model": "openai:gpt-5-mini"');
		expect(stdout[0]).toContain('"id": "replayed"');
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentKind, type Message, type Request, type Response } from "../../src/llm/types.ts";
import type { ReplayTurnRecord } from "../../src/shared/replay.ts";
import {
	listReplayTurns,
	loadReplayLog,
	replayTurn,
	showReplayTurn,
} from "../../tools/replay-workshop-lib.ts";

function makeMessage(role: Message["role"], text: string): Message {
	return {
		role,
		content: [{ kind: ContentKind.TEXT, text }],
	};
}

function makeRecord(turn: number): ReplayTurnRecord {
	const request: Omit<Request, "signal"> = {
		model: "gpt-5.4",
		provider: "openai",
		messages: [makeMessage("system", "system prompt"), makeMessage("user", `goal ${turn}`)],
		tools: [
			{
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		],
	};

	const response: Response = {
		id: `resp-${turn}`,
		model: "gpt-5.4",
		provider: "openai",
		message: makeMessage("assistant", `answer ${turn}`),
		finish_reason: { reason: "stop" },
		usage: {
			input_tokens: 10 + turn,
			output_tokens: 5 + turn,
			total_tokens: 15 + turn * 2,
		},
	};

	return {
		schema_version: "sprout-replay-v1",
		timestamp: `2026-03-15T12:00:0${turn}.000Z`,
		session_id: "01REPLAY",
		agent_id: "leaf",
		depth: 2,
		turn,
		request_context: {
			system_prompt: "system prompt",
			history: [makeMessage("user", `goal ${turn}`)],
			agent_tools: request.tools ?? [],
			primitive_tools: [],
		},
		request,
		response,
	};
}

async function writeReplayLog(
	dir: string,
	name: string,
	lines: Array<ReplayTurnRecord | string>,
): Promise<string> {
	const replayPath = join(dir, `${name}.replay.jsonl`);
	await writeFile(
		replayPath,
		`${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
	);
	return replayPath;
}

describe("replay workshop library", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	test("loads replay records from an event log path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-workshop-lib-"));
		tempDirs.push(dir);

		const replayPath = await writeReplayLog(dir, "session", [makeRecord(1), makeRecord(2)]);

		const records = await loadReplayLog(replayPath.replace(".replay.jsonl", ".jsonl"));
		expect(records).toHaveLength(2);
		expect(records[0]).toEqual(makeRecord(1));
		expect(records[1]).toEqual(makeRecord(2));
	});

	test("rejects malformed JSONL with line context", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-workshop-lib-"));
		tempDirs.push(dir);

		const replayPath = await writeReplayLog(dir, "session", [makeRecord(1), "{bad json"]);

		await expect(loadReplayLog(replayPath)).rejects.toThrow(/line 2/i);
	});

	test("rejects unsupported schema versions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-workshop-lib-"));
		tempDirs.push(dir);

		const badRecord = JSON.stringify({ ...makeRecord(1), schema_version: "sprout-replay-v0" });
		const replayPath = await writeReplayLog(dir, "session", [badRecord]);

		await expect(loadReplayLog(replayPath)).rejects.toThrow(/unsupported replay schema version/i);
	});

	test("lists replay turn summaries", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-workshop-lib-"));
		tempDirs.push(dir);

		const replayPath = await writeReplayLog(dir, "session", [makeRecord(1), makeRecord(2)]);

		await expect(listReplayTurns(replayPath)).resolves.toEqual([
			{
				turn: 1,
				depth: 2,
				agentId: "leaf",
				provider: "openai",
				model: "gpt-5.4",
				finishReason: "stop",
				inputTokens: 11,
				outputTokens: 6,
			},
			{
				turn: 2,
				depth: 2,
				agentId: "leaf",
				provider: "openai",
				model: "gpt-5.4",
				finishReason: "stop",
				inputTokens: 12,
				outputTokens: 7,
			},
		]);
	});

	test("shows the exact replay record for one turn", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-workshop-lib-"));
		tempDirs.push(dir);

		const replayPath = await writeReplayLog(dir, "session", [makeRecord(1), makeRecord(2)]);

		await expect(showReplayTurn(replayPath, 2)).resolves.toEqual(makeRecord(2));
	});

	test("replays one turn with prompt and model overrides", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-workshop-lib-"));
		tempDirs.push(dir);

		const replayPath = await writeReplayLog(dir, "session", [makeRecord(1)]);
		const requests: Array<Omit<Request, "signal">> = [];
		const replayedResponse: Response = {
			id: "replayed",
			model: "gpt-5-mini",
			provider: "openrouter",
			message: makeMessage("assistant", "replayed answer"),
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
		};

		const result = await replayTurn(
			replayPath,
			{
				turn: 1,
				systemPromptPrepend: "prepend\n",
				systemPromptAppend: "\nappend",
				modelOverride: "openrouter:openai/gpt-5-mini",
			},
			{
				loadClient: async () => ({
					complete: async (request) => {
						const { signal: _signal, ...withoutSignal } = request;
						requests.push(withoutSignal);
						return replayedResponse;
					},
				}),
			},
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			model: "openai/gpt-5-mini",
			provider: "openrouter",
			messages: [
				makeMessage("system", "prepend\nsystem prompt\nappend"),
				makeMessage("user", "goal 1"),
			],
		});
		expect(result.request).toEqual(requests[0]!);
		expect(result.response).toEqual(replayedResponse);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayPathFromLogBase, resolveReplayPath } from "../../../src/host/replay/paths.ts";
import { createReplayRecorder } from "../../../src/host/replay/recorder.ts";
import type { ReplayTurnRecord } from "../../../src/host/replay/types.ts";
import { ContentKind, type Message, type Request, type Response } from "../../../src/llm/types.ts";

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
		messages: [makeMessage("system", "sys"), makeMessage("user", `goal ${turn}`)],
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
		agent_id: "root",
		depth: 0,
		turn,
		request_context: {
			system_prompt: "sys",
			history: [makeMessage("user", `goal ${turn}`)],
			agent_tools: request.tools ?? [],
			primitive_tools: [],
		},
		request,
		response,
	};
}

async function readLines(path: string): Promise<unknown[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("replay recorder", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	test("derives replay paths from existing agent event-log paths", () => {
		expect(replayPathFromLogBase("/tmp/logs/01ABC")).toBe("/tmp/logs/01ABC.replay.jsonl");
		expect(resolveReplayPath("/tmp/logs/01ABC.jsonl")).toBe("/tmp/logs/01ABC.replay.jsonl");
		expect(resolveReplayPath("/tmp/logs/01ABC.replay.jsonl")).toBe(
			"/tmp/logs/01ABC.replay.jsonl",
		);
	});

	test("appends one JSONL record per planning turn", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-recorder-"));
		tempDirs.push(dir);

		const recorder = createReplayRecorder({
			logBasePath: join(dir, "logs", "01ABC"),
		});

		await recorder.record(makeRecord(1));
		await recorder.record(makeRecord(2));
		await recorder.close();

		const replayPath = join(dir, "logs", "01ABC.replay.jsonl");
		const lines = await readLines(replayPath);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toEqual(makeRecord(1));
		expect(lines[1]).toEqual(makeRecord(2));
	});

	test("creates parent directories lazily before the first append", async () => {
		const dir = await mkdtemp(join(tmpdir(), "replay-recorder-"));
		tempDirs.push(dir);

		const recorder = createReplayRecorder({
			logBasePath: join(dir, "nested", "session", "child"),
		});

		await recorder.record(makeRecord(1));
		await recorder.close();

		const lines = await readLines(join(dir, "nested", "session", "child.replay.jsonl"));
		expect(lines).toHaveLength(1);
	});
});

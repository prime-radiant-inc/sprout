import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, Request, Response, StreamEvent } from "../../src/llm/types.ts";
import { ContentKind } from "../../src/llm/types.ts";
import { createAdapterVcr, createVcr } from "./vcr.ts";

function makeRequest(text: string): Request {
	return {
		model: "claude-sonnet-4-6",
		messages: [{ role: "user", content: [{ kind: ContentKind.TEXT, text }] }],
		provider: "anthropic",
	};
}

function makeResponse(text: string, id = "resp_1"): Response {
	return {
		id,
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		message: { role: "assistant", content: [{ kind: ContentKind.TEXT, text }] },
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
	};
}

describe("VCR", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("record mode captures calls and saves fixture", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		const fakeResponse = makeResponse("Hello from LLM");

		const { client, afterTest } = createVcr({
			fixtureDir,
			testName: "captures-calls",
			mode: "record",
			realClient: {
				complete: async (_req: Request) => fakeResponse,
				providers: () => ["anthropic"],
			},
		});

		const req = makeRequest("Say hello");
		const resp = await client.complete(req);

		expect(resp).toEqual(fakeResponse);

		await afterTest();

		// Verify fixture was saved
		const fixturePath = join(fixtureDir, "captures-calls.json");
		const raw = await readFile(fixturePath, "utf-8");
		const cassette = JSON.parse(raw);
		expect(cassette.recordings).toHaveLength(1);
		expect(cassette.recordings[0].request.messages[0].content[0].text).toBe("Say hello");
		expect(cassette.metadata.recordedAt).toBeDefined();
	});

	test("replay mode returns recorded responses sequentially", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		// First record
		const responses = [makeResponse("First", "r1"), makeResponse("Second", "r2")];
		let callIndex = 0;

		const { client: recorder, afterTest: saveRecording } = createVcr({
			fixtureDir,
			testName: "sequential-replay",
			mode: "record",
			realClient: {
				complete: async (_req: Request) => responses[callIndex++]!,
				providers: () => ["anthropic"],
			},
		});

		await recorder.complete(makeRequest("First question"));
		await recorder.complete(makeRequest("Second question"));
		await saveRecording();

		// Now replay
		const { client: replayer } = createVcr({
			fixtureDir,
			testName: "sequential-replay",
			mode: "replay",
		});

		const r1 = await replayer.complete(makeRequest("First question"));
		expect(r1.id).toBe("r1");

		const r2 = await replayer.complete(makeRequest("Second question"));
		expect(r2.id).toBe("r2");
	});

	test("replay mode throws when fixture is missing", () => {
		tempDir = join(tmpdir(), `vcr-nonexistent-${Date.now()}`);

		expect(() =>
			createVcr({
				fixtureDir: tempDir,
				testName: "no-such-fixture",
				mode: "replay",
			}),
		).toThrow(/fixture not found/i);
	});

	test("replay mode throws when recordings are exhausted", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		// Record one call
		const { client: recorder, afterTest: saveRecording } = createVcr({
			fixtureDir,
			testName: "exhausted",
			mode: "record",
			realClient: {
				complete: async () => makeResponse("Only one"),
				providers: () => ["anthropic"],
			},
		});
		await recorder.complete(makeRequest("Question"));
		await saveRecording();

		// Replay: first call works, second should throw
		const { client: replayer } = createVcr({
			fixtureDir,
			testName: "exhausted",
			mode: "replay",
		});
		await replayer.complete(makeRequest("Question"));
		await expect(replayer.complete(makeRequest("Extra"))).rejects.toThrow(/exhausted/i);
	});

	test("path substitution replaces real paths with placeholders on record", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");
		const workDir = join(tempDir, "my-work-dir");

		const responseWithPath = makeResponse(`I wrote to ${workDir}/hello.py`);

		const { client, afterTest } = createVcr({
			fixtureDir,
			testName: "path-sub-record",
			mode: "record",
			substitutions: { "{{WORK_DIR}}": workDir },
			realClient: {
				complete: async () => responseWithPath,
				providers: () => ["anthropic"],
			},
		});

		await client.complete(makeRequest(`Create a file in ${workDir}/hello.py`));
		await afterTest();

		// The fixture should contain placeholders, not real paths
		const fixturePath = join(fixtureDir, "path-sub-record.json");
		const raw = await readFile(fixturePath, "utf-8");
		expect(raw).toContain("{{WORK_DIR}}");
		expect(raw).not.toContain(workDir);
	});

	test("path substitution replaces placeholders with real paths on replay", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");
		const originalWorkDir = "/tmp/original-work-12345";
		const newWorkDir = "/tmp/new-work-67890";

		// Record with original path
		const { client: recorder, afterTest: saveRecording } = createVcr({
			fixtureDir,
			testName: "path-sub-replay",
			mode: "record",
			substitutions: { "{{WORK_DIR}}": originalWorkDir },
			realClient: {
				complete: async () => makeResponse(`File at ${originalWorkDir}/out.txt`),
				providers: () => ["anthropic"],
			},
		});
		await recorder.complete(makeRequest(`Write to ${originalWorkDir}/out.txt`));
		await saveRecording();

		// Replay with different path
		const { client: replayer } = createVcr({
			fixtureDir,
			testName: "path-sub-replay",
			mode: "replay",
			substitutions: { "{{WORK_DIR}}": newWorkDir },
		});

		const resp = await replayer.complete(makeRequest(`Write to ${newWorkDir}/out.txt`));
		const text = resp.message.content[0]!.text!;
		expect(text).toContain(newWorkDir);
		expect(text).not.toContain(originalWorkDir);
	});

	test("longer substitution paths are applied first to avoid partial matches", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");
		const base = "/tmp/sprout-e2e-ABC";
		const genomePath = `${base}/genome`;

		const { client, afterTest } = createVcr({
			fixtureDir,
			testName: "sub-order",
			mode: "record",
			substitutions: {
				"{{WORK_DIR}}": base,
				"{{GENOME_DIR}}": genomePath,
			},
			realClient: {
				complete: async () => makeResponse(`genome at ${genomePath} and work at ${base}`),
				providers: () => ["anthropic"],
			},
		});

		await client.complete(makeRequest("test"));
		await afterTest();

		const raw = await readFile(join(fixtureDir, "sub-order.json"), "utf-8");
		// genomePath is longer, should be substituted first
		expect(raw).toContain("{{GENOME_DIR}}");
		expect(raw).toContain("{{WORK_DIR}}");
		// The genome dir should NOT partially match as {{WORK_DIR}}/genome
		expect(raw).not.toContain("{{WORK_DIR}}/genome");
	});

	test("providers() returns configured provider list", () => {
		tempDir = join(tmpdir(), `vcr-providers-${Date.now()}`);

		// Record mode with real client
		const { client } = createVcr({
			fixtureDir: tempDir,
			testName: "providers-test",
			mode: "record",
			realClient: {
				complete: async () => makeResponse("unused"),
				providers: () => ["anthropic", "openai"],
			},
		});

		expect(client.providers()).toEqual(["anthropic", "openai"]);
	});

	test("providers() returns default list in replay mode", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		// Record first
		const { client: recorder, afterTest: save } = createVcr({
			fixtureDir,
			testName: "replay-providers",
			mode: "record",
			realClient: {
				complete: async () => makeResponse("ok"),
				providers: () => ["anthropic"],
			},
		});
		await recorder.complete(makeRequest("hi"));
		await save();

		// Replay — no real client, so providers comes from cassette metadata
		const { client: replayer } = createVcr({
			fixtureDir,
			testName: "replay-providers",
			mode: "replay",
		});

		expect(replayer.providers()).toEqual(["anthropic"]);
	});

	test("raw field is stripped from recorded responses", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		const responseWithRaw: Response = {
			...makeResponse("with raw"),
			raw: { secret_token: "sk-abc123", full_response: { nested: true } },
		};

		const { client, afterTest } = createVcr({
			fixtureDir,
			testName: "strip-raw",
			mode: "record",
			realClient: {
				complete: async () => responseWithRaw,
				providers: () => ["anthropic"],
			},
		});

		await client.complete(makeRequest("test"));
		await afterTest();

		const raw = await readFile(join(fixtureDir, "strip-raw.json"), "utf-8");
		expect(raw).not.toContain("sk-abc123");
		expect(raw).not.toContain("secret_token");
	});

	test("client VCR records and replays stream calls", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		const fakeEvents: StreamEvent[] = [
			{ type: "stream_start" },
			{ type: "text_delta", delta: "Hello" },
			{ type: "text_delta", delta: " world" },
			{ type: "finish", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
		];

		async function* fakeStream(): AsyncIterable<StreamEvent> {
			for (const event of fakeEvents) {
				yield event;
			}
		}

		const { client: recorder, afterTest: save } = createVcr({
			fixtureDir,
			testName: "stream-roundtrip",
			mode: "record",
			realClient: {
				complete: async () => makeResponse("unused"),
				stream: () => fakeStream(),
				providers: () => ["anthropic"],
			},
		});

		const recordedEvents: StreamEvent[] = [];
		for await (const event of recorder.stream(makeRequest("Say hello"))) {
			recordedEvents.push(event);
		}
		expect(recordedEvents).toHaveLength(4);
		await save();

		// Replay
		const { client: replayer } = createVcr({
			fixtureDir,
			testName: "stream-roundtrip",
			mode: "replay",
		});

		const replayedEvents: StreamEvent[] = [];
		for await (const event of replayer.stream(makeRequest("Say hello"))) {
			replayedEvents.push(event);
		}
		expect(replayedEvents).toEqual(recordedEvents);
	});

	test("client VCR interleaves complete and stream calls", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-test-"));
		const fixtureDir = join(tempDir, "fixtures");

		const fakeEvents: StreamEvent[] = [
			{ type: "stream_start" },
			{ type: "text_delta", delta: "Streamed" },
			{ type: "finish" },
		];

		async function* fakeStream(): AsyncIterable<StreamEvent> {
			for (const event of fakeEvents) {
				yield event;
			}
		}

		const { client: recorder, afterTest: save } = createVcr({
			fixtureDir,
			testName: "interleaved",
			mode: "record",
			realClient: {
				complete: async () => makeResponse("Completed"),
				stream: () => fakeStream(),
				providers: () => ["anthropic"],
			},
		});

		// Call order: complete, stream, complete
		await recorder.complete(makeRequest("First"));
		const events: StreamEvent[] = [];
		for await (const e of recorder.stream(makeRequest("Second"))) {
			events.push(e);
		}
		await recorder.complete(makeRequest("Third"));
		await save();

		// Replay should match the same order
		const { client: replayer } = createVcr({
			fixtureDir,
			testName: "interleaved",
			mode: "replay",
		});

		const r1 = await replayer.complete(makeRequest("First"));
		expect(r1.message.content[0]!.text).toBe("Completed");

		const replayedEvents: StreamEvent[] = [];
		for await (const e of replayer.stream(makeRequest("Second"))) {
			replayedEvents.push(e);
		}
		expect(replayedEvents).toHaveLength(3);

		const r3 = await replayer.complete(makeRequest("Third"));
		expect(r3.message.content[0]!.text).toBe("Completed");
	});
});

// Helper: create a fake adapter
function makeFakeAdapter(
	name: string,
	response: Response,
	streamEvents: StreamEvent[],
): ProviderAdapter {
	return {
		name,
		complete: async () => response,
		stream: async function* () {
			for (const event of streamEvents) {
				yield event;
			}
		},
	};
}

describe("Adapter VCR", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("records and replays adapter complete calls", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-adapter-"));
		const fixtureDir = join(tempDir, "fixtures");

		const fakeResponse = makeResponse("Adapter response");
		const realAdapter = makeFakeAdapter("anthropic", fakeResponse, []);

		// Record
		const { adapter: recorder, afterTest: save } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-complete",
			mode: "record",
			realAdapter,
		});
		expect(recorder.name).toBe("anthropic");

		const resp = await recorder.complete(makeRequest("Hi"));
		expect(resp).toEqual(fakeResponse);
		await save();

		// Replay
		const { adapter: replayer } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-complete",
			mode: "replay",
		});
		expect(replayer.name).toBe("anthropic");

		const replayed = await replayer.complete(makeRequest("Hi"));
		// raw is stripped, so compare without it
		expect(replayed.id).toBe(fakeResponse.id);
		expect(replayed.message).toEqual(fakeResponse.message);
	});

	test("records and replays adapter stream calls", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-adapter-"));
		const fixtureDir = join(tempDir, "fixtures");

		const streamEvents: StreamEvent[] = [
			{ type: "stream_start" },
			{ type: "text_delta", delta: "Hello" },
			{ type: "text_delta", delta: " from" },
			{ type: "text_delta", delta: " adapter" },
			{ type: "finish", usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } },
		];
		const realAdapter = makeFakeAdapter("openai", makeResponse("unused"), streamEvents);

		// Record
		const { adapter: recorder, afterTest: save } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-stream",
			mode: "record",
			realAdapter,
		});

		const recorded: StreamEvent[] = [];
		for await (const event of recorder.stream(makeRequest("Say hello"))) {
			recorded.push(event);
		}
		expect(recorded).toHaveLength(5);
		await save();

		// Replay
		const { adapter: replayer } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-stream",
			mode: "replay",
		});

		const replayed: StreamEvent[] = [];
		for await (const event of replayer.stream(makeRequest("Say hello"))) {
			replayed.push(event);
		}
		expect(replayed).toEqual(recorded);
	});

	test("adapter VCR interleaves complete and stream", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-adapter-"));
		const fixtureDir = join(tempDir, "fixtures");

		const streamEvents: StreamEvent[] = [
			{ type: "stream_start" },
			{ type: "text_delta", delta: "Streamed" },
			{ type: "finish" },
		];
		const realAdapter = makeFakeAdapter("gemini", makeResponse("Completed"), streamEvents);

		// Record: complete, stream
		const { adapter: recorder, afterTest: save } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-interleaved",
			mode: "record",
			realAdapter,
		});

		await recorder.complete(makeRequest("First"));
		const events: StreamEvent[] = [];
		for await (const e of recorder.stream(makeRequest("Second"))) {
			events.push(e);
		}
		await save();

		// Replay
		const { adapter: replayer } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-interleaved",
			mode: "replay",
		});

		const r1 = await replayer.complete(makeRequest("First"));
		expect(r1.message.content[0]!.text).toBe("Completed");

		const replayed: StreamEvent[] = [];
		for await (const e of replayer.stream(makeRequest("Second"))) {
			replayed.push(e);
		}
		expect(replayed).toHaveLength(3);
	});

	test("adapter VCR strips raw from recorded responses", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-adapter-"));
		const fixtureDir = join(tempDir, "fixtures");

		const responseWithRaw: Response = {
			...makeResponse("with raw"),
			raw: { secret: "do-not-record" },
		};
		const realAdapter = makeFakeAdapter("anthropic", responseWithRaw, []);

		const { adapter: recorder, afterTest: save } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-strip-raw",
			mode: "record",
			realAdapter,
		});

		await recorder.complete(makeRequest("test"));
		await save();

		const raw = await readFile(join(fixtureDir, "adapter-strip-raw.json"), "utf-8");
		expect(raw).not.toContain("do-not-record");
	});

	test("adapter replay throws when recordings exhausted", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "vcr-adapter-"));
		const fixtureDir = join(tempDir, "fixtures");

		const realAdapter = makeFakeAdapter("anthropic", makeResponse("one"), []);

		const { adapter: recorder, afterTest: save } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-exhausted",
			mode: "record",
			realAdapter,
		});
		await recorder.complete(makeRequest("test"));
		await save();

		const { adapter: replayer } = createAdapterVcr({
			fixtureDir,
			testName: "adapter-exhausted",
			mode: "replay",
		});
		await replayer.complete(makeRequest("test"));
		await expect(replayer.complete(makeRequest("extra"))).rejects.toThrow(/exhausted/i);
	});

	test("adapter replay throws on fixture missing", () => {
		tempDir = join(tmpdir(), `vcr-adapter-missing-${Date.now()}`);

		expect(() =>
			createAdapterVcr({
				fixtureDir: tempDir,
				testName: "missing",
				mode: "replay",
			}),
		).toThrow(/fixture not found/i);
	});

	test("off mode passes through to real adapter", async () => {
		tempDir = join(tmpdir(), `vcr-adapter-off-${Date.now()}`);

		const realAdapter = makeFakeAdapter("anthropic", makeResponse("passthrough"), [
			{ type: "stream_start" },
			{ type: "finish" },
		]);

		const { adapter } = createAdapterVcr({
			fixtureDir: tempDir,
			testName: "off-test",
			mode: "off",
			realAdapter,
		});

		const resp = await adapter.complete(makeRequest("test"));
		expect(resp.message.content[0]!.text).toBe("passthrough");

		const events: StreamEvent[] = [];
		for await (const e of adapter.stream(makeRequest("test"))) {
			events.push(e);
		}
		expect(events).toHaveLength(2);
	});
});

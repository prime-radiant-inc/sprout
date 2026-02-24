import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "../../src/llm/types.ts";
import { ContentKind } from "../../src/llm/types.ts";
import { createVcr } from "./vcr.ts";

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
		tempDir = join(tmpdir(), "vcr-nonexistent-" + Date.now());

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
		tempDir = join(tmpdir(), "vcr-providers-" + Date.now());

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
});

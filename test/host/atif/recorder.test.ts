import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtifRecorder } from "../../../src/host/atif/recorder.ts";
import type { PricingSnapshot } from "../../../src/host/pricing-cache.ts";
import type { SessionEvent } from "../../../src/kernel/types.ts";

const pricingSnapshot: PricingSnapshot = {
	source: "live",
	fetchedAt: "2026-03-14T12:00:00.000Z",
	upstreams: ["llm-prices"],
	table: [["gpt-4o", { input: 2.5, output: 10, cached_input: 1.25 }]],
};

function makeEvent(
	kind: SessionEvent["kind"],
	data: Record<string, unknown>,
	overrides: Partial<SessionEvent> = {},
): SessionEvent {
	return {
		kind,
		timestamp: Date.parse("2026-03-14T12:00:00.000Z"),
		agent_id: "root",
		depth: 0,
		data,
		...overrides,
	};
}

async function readJson(path: string) {
	return JSON.parse(await readFile(path, "utf-8"));
}

describe("createAtifRecorder", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
		tempDirs.length = 0;
	});

	test("writes a root trajectory with metadata immediately", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atif-recorder-"));
		tempDirs.push(dir);
		const path = join(dir, "trajectory.json");

		const recorder = await createAtifRecorder({
			outputPath: path,
			sessionId: "01ATIF",
			agentName: "sprout",
			agentVersion: "0.1.0",
			pricingSnapshot,
		});

		const json = await readJson(path);
		expect(json).toMatchObject({
			schema_version: "ATIF-v1.6",
			session_id: "01ATIF",
			agent: { name: "sprout", version: "0.1.0" },
			steps: [],
			final_metrics: { total_steps: 0 },
		});

		await recorder.close();
	});

	test("appends each mirrored event to trajectory.json and excludes llm_chunk", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atif-recorder-"));
		tempDirs.push(dir);
		const path = join(dir, "trajectory.json");

		const recorder = await createAtifRecorder({
			outputPath: path,
			sessionId: "01ATIF",
			agentName: "sprout",
			agentVersion: "0.1.0",
			pricingSnapshot,
		});

		recorder.recordEvent(makeEvent("perceive", { goal: "hello" }));
		recorder.recordEvent(makeEvent("llm_chunk", { text_delta: "..." }));
		recorder.recordEvent(
			makeEvent("llm_end", {
				model: "gpt-4o",
				provider: "openai",
				input_tokens: 100,
				output_tokens: 20,
				cache_read_tokens: 10,
			}),
		);
		await recorder.flush();

		const json = await readJson(path);
		expect(json.steps).toHaveLength(2);
		expect(json.steps[0]).toMatchObject({ source: "user", message: "hello" });
		expect(json.steps[1]).toMatchObject({ source: "system", message: "llm_end" });
		expect(json.final_metrics).toMatchObject({
			total_prompt_tokens: 100,
			total_completion_tokens: 20,
			total_cached_tokens: 10,
			total_steps: 2,
		});

		await recorder.close();
	});

	test("preserves child-agent events in timestamp order with identity metadata", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atif-recorder-"));
		tempDirs.push(dir);
		const path = join(dir, "trajectory.json");

		const recorder = await createAtifRecorder({
			outputPath: path,
			sessionId: "01ATIF",
			agentName: "sprout",
			agentVersion: "0.1.0",
			pricingSnapshot,
		});

		recorder.recordEvent(
			makeEvent("act_start", { agent_name: "editor", child_id: "child-1" }, { timestamp: 10 }),
		);
		recorder.recordEvent(
			makeEvent(
				"session_start",
				{ goal: "subtask" },
				{
					agent_id: "child-1",
					depth: 1,
					timestamp: 11,
				},
			),
		);
		await recorder.flush();

		const json = await readJson(path);
		expect(json.steps).toHaveLength(2);
		expect(json.steps[0].extra.sprout_event.agent_id).toBe("root");
		expect(json.steps[1].extra.sprout_event.agent_id).toBe("child-1");
		expect(json.steps[1].extra.sprout_event.depth).toBe(1);

		await recorder.close();
	});

	test("leaves a valid trajectory file on disk after fatal completion", async () => {
		const dir = await mkdtemp(join(tmpdir(), "atif-recorder-"));
		tempDirs.push(dir);
		const path = join(dir, "trajectory.json");

		const recorder = await createAtifRecorder({
			outputPath: path,
			sessionId: "01ATIF",
			agentName: "sprout",
			agentVersion: "0.1.0",
			pricingSnapshot,
		});

		recorder.recordEvent(makeEvent("error", { error: "boom" }));
		await recorder.close();

		const json = await readJson(path);
		expect(json.steps.at(-1)).toMatchObject({
			source: "system",
			message: "boom",
		});
	});
});

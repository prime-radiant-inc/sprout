import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildCollapseTranscript,
	collapseSessionToMemory,
	normalizeSegmentSummary,
	renderCollapseTranscript,
} from "../../src/core/session-collapse.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { ProviderModel, Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function event(
	kind: SessionEvent["kind"],
	timestamp: number,
	data: Record<string, unknown>,
	depth = 0,
	agent_id = depth === 0 ? "root" : "child",
): SessionEvent {
	return { kind, timestamp, agent_id, depth, data };
}

function makeResponse(text: string): Response {
	return {
		id: "mock",
		model: "test-model",
		provider: "anthropic",
		message: Msg.assistant(text),
		finish_reason: { reason: "stop" },
		usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
	};
}

function makeClientSequence(responses: string[]): Client {
	let index = 0;
	const modelsByProvider = new Map<string, ProviderModel[]>([
		["anthropic", [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" }]],
	]);
	return {
		providers: () => ["anthropic"],
		listModelsByProvider: async () => modelsByProvider,
		complete: async (_request: Request) => {
			const response = responses[index] ?? responses.at(-1) ?? "[]";
			index++;
			return makeResponse(response);
		},
	} as unknown as Client;
}

describe("session collapse transcript", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-session-collapse-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("builds deterministic root-only transcripts from session events", () => {
		const messages = buildCollapseTranscript([
			event("plan_end", 300, { text: "I will inspect package.json." }),
			event("perceive", 100, { goal: "Run tests" }),
			event("primitive_end", 400, {
				name: "exec_command",
				tool_result_message: Msg.toolResult("tool-1", "bun test passed"),
			}),
			event("plan_end", 250, { text: "child internal analysis" }, 1, "engineer"),
			event("act_end", 500, {
				agent_name: "engineer",
				tool_result_message: Msg.toolResult("delegate-1", "implemented feature"),
			}),
			event("session_end", 600, { output: "Done" }),
		]);

		expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
			"user:Run tests",
			"assistant:I will inspect package.json.",
			"assistant:bun test passed",
			"assistant:implemented feature",
			"assistant:Done",
		]);
		expect(messages.every((message) => message.timestamp >= 100)).toBe(true);
		expect(messages.some((message) => message.content === "child internal analysis")).toBe(false);
	});

	test("can include subagent events when explicitly requested", () => {
		const messages = buildCollapseTranscript(
			[
				event("perceive", 100, { goal: "Root goal" }),
				event("plan_end", 200, { text: "child detail" }, 1, "engineer"),
			],
			{ includeSubagents: true },
		);

		expect(messages.map((message) => message.agent_id)).toEqual(["root", "engineer"]);
	});

	test("renders absolute timestamps for summary prompts", () => {
		const rendered = renderCollapseTranscript([
			{
				role: "user",
				content: "Use <sqlite>",
				timestamp: Date.UTC(2026, 3, 26, 12, 0, 0),
				agent_id: "root",
				event_kind: "perceive",
			},
		]);

		expect(rendered).toContain('time="2026-04-26T12:00:00.000Z"');
		expect(rendered).toContain("Use &lt;sqlite&gt;");
	});

	test("normalizes JSON summary outputs", () => {
		expect(
			normalizeSegmentSummary({
				synopsis: "Built memory extraction",
				display_title: "Memory extraction",
				complexity: 9,
			}),
		).toEqual({
			summary: "Built memory extraction",
			title: "Memory extraction",
			complexity: 3,
		});
	});

	test("collapses a completed session into a segment and extracted memories", async () => {
		const genomeDir = join(tempDir, "genome");
		const rootDir = join(import.meta.dir, "../../root");
		const workDir = join(tempDir, "work");
		await mkdir(workDir, { recursive: true });
		await writeFile(join(workDir, "package.json"), JSON.stringify({ name: "sprout-memory" }));
		const genome = createTestGenome(genomeDir, rootDir);
		await genome.init();
		await genome.initFromRoot();
		const client = makeClientSequence([
			JSON.stringify({
				summary:
					"The user required Sprout memory work to use local embeddings and SQLite rather than Postgres.",
				title: "Local SQLite memory direction",
				complexity: 2,
			}),
			JSON.stringify([
				{
					text: "Sprout memory should use local embeddings and SQLite instead of Postgres.",
					tags: ["memory", "sqlite", "embeddings"],
					entities: [
						{ name: "Sprout", type: "PROJECT" },
						{ name: "SQLite", type: "TECHNOLOGY" },
					],
				},
			]),
		]);

		const result = await collapseSessionToMemory({
			events: [
				event("perceive", 100, {
					goal: "Implement MIRA memory with local embeddings and SQLite.",
				}),
				event("plan_end", 200, { text: "I will build the local memory path." }),
				event("session_end", 300, { output: "Implemented local SQLite memory foundation." }),
			],
			genome,
			client,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			sessionId: "session-collapse-1",
			cwd: workDir,
			now: 400,
		});

		expect(result).not.toBe("skipped");
		if (result === "skipped") return;
		expect(result.project).toMatchObject({ id: "sprout-memory", source: "package" });
		expect(result.extractedMemoryCount).toBe(1);
		const segment = genome.segments.all()[0]!;
		expect(segment.summary).toContain("local embeddings");
		expect(segment.project_id).toBe("sprout-memory");
		expect(segment.embedding?.status).toBe("ready");
		const memory = genome.memories.all()[0]!;
		expect(memory.content).toContain("SQLite instead of Postgres");
		expect(memory.source_segment_id).toBe(segment.id);
		expect(memory.source_session_id).toBe("session-collapse-1");
		expect(memory.project_ids).toContain("sprout-memory");
		expect(memory.embedding?.status).toBe("ready");
	});

	test("collapses only transcript events newer than the latest segment for continued sessions", async () => {
		const genomeDir = join(tempDir, "genome-continued");
		const rootDir = join(import.meta.dir, "../../root");
		const workDir = join(tempDir, "work-continued");
		await mkdir(workDir, { recursive: true });
		await writeFile(join(workDir, "package.json"), JSON.stringify({ name: "sprout-memory" }));
		const genome = createTestGenome(genomeDir, rootDir);
		await genome.init();
		await genome.initFromRoot();
		const client = makeClientSequence([
			JSON.stringify({
				summary: "First run summary.",
				title: "First run",
				complexity: 1,
			}),
			"[]",
			JSON.stringify({
				summary: "Second run summary.",
				title: "Second run",
				complexity: 2,
			}),
			"[]",
		]);
		const firstRunEvents = [
			event("perceive", 100, { goal: "Start memory work." }),
			event("session_end", 200, { output: "First run done." }),
		];
		const secondRunEvents = [
			event("perceive", 300, { goal: "Continue memory work." }),
			event("session_end", 400, { output: "Second run done." }),
		];

		const first = await collapseSessionToMemory({
			events: firstRunEvents,
			genome,
			client,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			sessionId: "session-collapse-continued",
			cwd: workDir,
			now: 500,
		});
		expect(first).not.toBe("skipped");

		const duplicate = await collapseSessionToMemory({
			events: firstRunEvents,
			genome,
			client,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			sessionId: "session-collapse-continued",
			cwd: workDir,
			now: 600,
		});
		expect(duplicate).toBe("skipped");

		const continued = await collapseSessionToMemory({
			events: [...firstRunEvents, ...secondRunEvents],
			genome,
			client,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			sessionId: "session-collapse-continued",
			cwd: workDir,
			now: 700,
		});

		expect(continued).not.toBe("skipped");
		expect(genome.segments.all().map((segment) => segment.summary)).toEqual([
			"First run summary.",
			"Second run summary.",
		]);
		expect(genome.segments.all()[1]?.started_at).toBe(300);
		expect(genome.segments.all()[1]?.message_count).toBe(2);
	});
});

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
import type { Genome } from "../../src/genome/genome.ts";
import type { SessionEvent } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { EmbeddingProvider } from "../../src/llm/embeddings.ts";
import type { ProviderModel, Request, Response } from "../../src/llm/types.ts";
import { Msg, messageText } from "../../src/llm/types.ts";
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

function embeddingProviderThatFailsOnCall(failCall: number): EmbeddingProvider {
	let callCount = 0;
	return {
		provider: "failing",
		model: "failing",
		dimensions: 768,
		embedBatch: async (texts) => {
			callCount++;
			if (callCount === failCall) throw new Error("embedding boom");
			return texts.map((text) => ({
				text,
				vector: Float32Array.from(unitVector()),
				provider: "failing",
				model: "failing",
				dimensions: 768,
			}));
		},
	};
}

function unitVector(): number[] {
	const vector = new Array<number>(768).fill(0);
	vector[0] = 1;
	return vector;
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
				success: true,
				tool_result_message: Msg.toolResult("tool-1", "SECRET_TOKEN=bun-test-passed"),
			}),
			event("plan_end", 250, { text: "child internal analysis" }, 1, "engineer"),
			event("act_end", 500, {
				agent_name: "engineer",
				success: true,
				tool_result_message: Msg.toolResult("delegate-1", "implemented feature with secret"),
			}),
			event("session_end", 600, { output: "Done" }),
		]);

		expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual([
			"user:Run tests",
			"assistant:I will inspect package.json.",
			"assistant:Tool exec_command completed successfully.",
			"assistant:Delegated agent engineer completed successfully.",
			"assistant:Done",
		]);
		expect(messages.map((message) => message.content).join("\n")).not.toContain("SECRET_TOKEN");
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

	test("grounds memory extraction only in user-authored transcript messages", async () => {
		const genomeDir = join(tempDir, "genome-user-grounded");
		const rootDir = join(import.meta.dir, "../../root");
		const workDir = join(tempDir, "work-user-grounded");
		await mkdir(workDir, { recursive: true });
		const genome = createTestGenome(genomeDir, rootDir);
		await genome.init();
		await genome.initFromRoot();
		const prompts: string[] = [];
		const client = {
			providers: () => ["anthropic"],
			listModelsByProvider: async () =>
				new Map<string, ProviderModel[]>([
					[
						"anthropic",
						[{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" }],
					],
				]),
			complete: async (request: Request) => {
				const prompt = request.messages[1];
				prompts.push(prompt ? messageText(prompt) : "");
				return makeResponse(
					prompts.length === 1
						? JSON.stringify({
								summary: "Collapsed session.",
								title: "Collapse",
								complexity: 1,
							})
						: "[]",
				);
			},
		} as unknown as Client;

		await collapseSessionToMemory({
			events: [
				event("perceive", 100, { goal: "User says Sprout memory must stay local." }),
				event("plan_end", 200, { text: "Assistant inferred a separate durable policy." }),
				event("session_end", 300, { output: "Assistant finished with implementation details." }),
			],
			genome,
			client,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			sessionId: "session-collapse-user-grounded",
			cwd: workDir,
			now: 400,
		});

		expect(prompts[1]).toContain("User says Sprout memory must stay local.");
		expect(prompts[1]).not.toContain("Assistant inferred a separate durable policy.");
		expect(prompts[1]).not.toContain("Assistant finished with implementation details.");
	});

	test("skips duplicate embedding work when extraction returns no drafts", async () => {
		const workDir = join(tempDir, "work-no-drafts");
		await mkdir(workDir, { recursive: true });
		const client = makeClientSequence([
			JSON.stringify({
				summary: "No durable memory was extracted.",
				title: "No memory",
				complexity: 1,
			}),
			"[]",
		]);
		let persistedMemoryCount: number | undefined;
		const genome = {
			segments: { all: () => [] },
			memories: { all: () => [] },
			loadSegmentSummaryPrompts: async () => ({
				system: "Summarize.",
				user: "{formatted_messages}",
			}),
			loadMemoryExtractionPrompts: async () => ({
				system: "Extract.",
				user: "{formatted_messages}",
			}),
			memoryEmbeddingProvider: async () => {
				throw new Error("embedding provider should not be loaded for empty drafts");
			},
			addSegmentWithMemories: async (_segment: unknown, memories: readonly unknown[]) => {
				persistedMemoryCount = memories.length;
			},
		} as unknown as Genome;

		const result = await collapseSessionToMemory({
			events: [
				event("perceive", 100, { goal: "Check whether anything should be remembered." }),
				event("session_end", 200, { output: "Nothing durable." }),
			],
			genome,
			client,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			sessionId: "session-collapse-no-drafts",
			cwd: workDir,
			now: 300,
		});

		expect(result).not.toBe("skipped");
		if (result === "skipped") return;
		expect(result.extractedMemoryCount).toBe(0);
		expect(persistedMemoryCount).toBe(0);
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

	test("does not persist segment marker when extraction fails", async () => {
		const genomeDir = join(tempDir, "genome-extraction-fail");
		const rootDir = join(import.meta.dir, "../../root");
		const workDir = join(tempDir, "work-extraction-fail");
		await mkdir(workDir, { recursive: true });
		const genome = createTestGenome(genomeDir, rootDir);
		await genome.init();
		await genome.initFromRoot();
		const client = makeClientSequence([
			JSON.stringify({
				summary: "Summary before extraction failure.",
				title: "Extraction failure",
				complexity: 1,
			}),
			"not json",
		]);

		await expect(
			collapseSessionToMemory({
				events: [
					event("perceive", 100, { goal: "Remember this." }),
					event("session_end", 200, { output: "Done." }),
				],
				genome,
				client,
				model: "claude-sonnet-4-6",
				provider: "anthropic",
				sessionId: "session-collapse-fail",
				cwd: workDir,
				now: 300,
			}),
		).rejects.toThrow();

		expect(genome.segments.all()).toHaveLength(0);
		expect(genome.memories.all()).toHaveLength(0);
	});

	test("does not persist partial collapse state when memory embedding fails", async () => {
		const genomeDir = join(tempDir, "genome-embedding-fail");
		const rootDir = join(import.meta.dir, "../../root");
		const workDir = join(tempDir, "work-embedding-fail");
		await mkdir(workDir, { recursive: true });
		const genome = createTestGenome(genomeDir, rootDir, {
			embeddingProvider: embeddingProviderThatFailsOnCall(3),
		});
		await genome.init();
		await genome.initFromRoot();
		const client = makeClientSequence([
			JSON.stringify({
				summary: "Summary before embedding failure.",
				title: "Embedding failure",
				complexity: 1,
			}),
			JSON.stringify([{ text: "Persist this extracted memory.", tags: ["memory"] }]),
		]);

		await expect(
			collapseSessionToMemory({
				events: [
					event("perceive", 100, { goal: "Remember this." }),
					event("session_end", 200, { output: "Done." }),
				],
				genome,
				client,
				model: "claude-sonnet-4-6",
				provider: "anthropic",
				sessionId: "session-collapse-embedding-fail",
				cwd: workDir,
				now: 300,
			}),
		).rejects.toThrow("embedding boom");

		expect(genome.segments.all()).toHaveLength(0);
		expect(genome.memories.all()).toHaveLength(0);
	});
});

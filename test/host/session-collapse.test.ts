import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildCollapseTranscript,
	collapseSessionToMemory,
	normalizeSegmentSummary,
	redactSensitiveTranscriptContent,
	renderCollapseTranscript,
} from "../../src/core/session-collapse.ts";
import type { Genome } from "../../src/genome/genome.ts";
import type { MemorySegment } from "../../src/genome/segments.ts";
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

function makeClientSequence(responses: string[], onRequest?: (request: Request) => void): Client {
	let index = 0;
	const modelsByProvider = new Map<string, ProviderModel[]>([
		["anthropic", [{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" }]],
	]);
	return {
		providers: () => ["anthropic"],
		listModelsByProvider: async () => modelsByProvider,
		complete: async (request: Request) => {
			onRequest?.(request);
			const response = responses[index] ?? responses.at(-1) ?? "[]";
			index++;
			return makeResponse(response);
		},
	} as unknown as Client;
}

const DEFAULT_MEMORY_MODELS = {
	summaryModel: { model: "claude-sonnet-4-6", provider: "anthropic" },
	extractionModel: { model: "claude-sonnet-4-6", provider: "anthropic" },
};

function memorySegment(
	fields: Partial<MemorySegment> & { id: string; summary: string },
): MemorySegment {
	return {
		session_id: "previous-session",
		title: "Previous segment",
		started_at: 0,
		ended_at: 0,
		created_at: 0,
		message_count: 1,
		project_id: "sprout",
		project_confidence: 1,
		complexity: 1,
		source: "session-collapse",
		...fields,
	};
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
			"assistant:Tool exec_command completed successfully.\nOutput: SECRET_TOKEN=[REDACTED_SECRET]",
			"assistant:Delegated agent engineer completed successfully.\nOutput: implemented feature with secret",
			"assistant:Done",
		]);
		expect(messages.map((message) => message.content).join("\n")).not.toContain("bun-test-passed");
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

	test("redacts common secret formats deterministically", () => {
		const redacted = redactSensitiveTranscriptContent(`OPENAI_API_KEY=sk-${"a".repeat(32)}
Authorization: Bearer eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}
AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF
github_token: ghp_${"d".repeat(36)}
GITHUB_TOKEN=ghp_${"e".repeat(36)}
-----BEGIN PRIVATE KEY-----
abc123
-----END PRIVATE KEY-----`);

		expect(redacted).toContain("OPENAI_API_KEY=[REDACTED_API_KEY]");
		expect(redacted).toContain("Bearer [REDACTED_TOKEN]");
		expect(redacted).toContain("AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]");
		expect(redacted).toContain("github_token: [REDACTED_GITHUB_TOKEN]");
		expect(redacted).toContain("GITHUB_TOKEN=[REDACTED_GITHUB_TOKEN]");
		expect(redacted).toContain("[REDACTED_PRIVATE_KEY]");
		expect(redacted).not.toContain(`sk-${"a".repeat(32)}`);
		expect(redacted).not.toContain(`ghp_${"d".repeat(36)}`);
		expect(redacted).not.toContain(`ghp_${"e".repeat(36)}`);
		expect(redacted).not.toContain("abc123");
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
			...DEFAULT_MEMORY_MODELS,
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

	test("uses separate configured models for summary and extraction calls", async () => {
		const workDir = join(tempDir, "work-purpose-models");
		await mkdir(workDir, { recursive: true });
		const requests: Request[] = [];
		const client = makeClientSequence(
			[
				JSON.stringify({
					summary: "Purpose-routed collapse summary.",
					title: "Purpose routing",
					complexity: 1,
				}),
				"[]",
			],
			(request) => requests.push(request),
		);
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
				throw new Error("empty extraction should not load embeddings");
			},
			addSegmentWithMemories: async (_segment: unknown, memories: readonly unknown[]) => memories,
		} as unknown as Genome;

		const result = await collapseSessionToMemory({
			events: [event("perceive", 100, { goal: "Route memory LLM calls by purpose." })],
			genome,
			client,
			summaryModel: { model: "summary-model", provider: "anthropic" },
			extractionModel: { model: "extract-model", provider: "openrouter" },
			sessionId: "session-collapse-purpose-models",
			cwd: workDir,
			now: 300,
		});

		expect(result).not.toBe("skipped");
		expect(
			requests.map((request) => ({ model: request.model, provider: request.provider })),
		).toEqual([
			{ model: "summary-model", provider: "anthropic" },
			{ model: "extract-model", provider: "openrouter" },
		]);
	});

	test("grounds memory extraction in user and root evidence", async () => {
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
				event("plan_end", 200, {
					text: "Root verified the memory implementation uses SQLite cache rebuilds.",
				}),
				event("primitive_end", 250, {
					name: "exec_command",
					success: true,
					tool_result_message: Msg.toolResult(
						"tool-1",
						"bun test confirmed local embedding writes are ready.",
					),
				}),
				event("act_end", 275, {
					agent_name: "engineer",
					goal: "check collapse evidence",
					success: true,
					tool_result_message: Msg.toolResult(
						"delegate-1",
						"Engineer found delegation outcomes include durable implementation facts.",
					),
				}),
				event("session_end", 300, {
					output: "Root finished with local SQLite implementation details.",
				}),
			],
			genome,
			client,
			...DEFAULT_MEMORY_MODELS,
			sessionId: "session-collapse-user-grounded",
			cwd: workDir,
			now: 400,
		});

		expect(prompts[1]).toContain("User says Sprout memory must stay local.");
		expect(prompts[1]).toContain("Root verified the memory implementation uses SQLite");
		expect(prompts[1]).toContain("bun test confirmed local embedding writes are ready.");
		expect(prompts[1]).toContain("check collapse evidence");
		expect(prompts[1]).toContain("delegation outcomes include durable implementation facts.");
		expect(prompts[1]).toContain("Root finished with local SQLite implementation details.");
	});

	test("passes previous segment summaries and current summary context to collapse prompts", async () => {
		const workDir = join(tempDir, "work-continuity");
		await mkdir(workDir, { recursive: true });
		const prompts: string[] = [];
		const client = makeClientSequence(
			[
				JSON.stringify({
					summary: "Current <summary> keeps SQLite continuity.",
					title: "Current continuity",
					complexity: 1,
				}),
				"[]",
			],
			(request) => {
				const prompt = request.messages[1];
				prompts.push(prompt ? messageText(prompt) : "");
			},
		);
		const previousSegments = [
			memorySegment({ id: "previous-0", summary: "Oldest excluded summary", ended_at: 10 }),
			memorySegment({ id: "previous-1", summary: "Summary one", ended_at: 20 }),
			memorySegment({ id: "previous-2", summary: "Summary two", ended_at: 30 }),
			memorySegment({ id: "previous-3", summary: "Summary three", ended_at: 40 }),
			memorySegment({ id: "previous-4", summary: "Summary four", ended_at: 50 }),
			memorySegment({ id: "previous-5", summary: "Summary <five>", ended_at: 60 }),
			memorySegment({
				id: "unrelated-project",
				summary: "Unrelated project summary",
				ended_at: 70,
				project_id: "unrelated",
			}),
		];
		const genome = {
			segments: { all: () => previousSegments },
			memories: { all: () => [] },
			loadSegmentSummaryPrompts: async () => ({
				system: "Summarize.",
				user: "<previous_segment_summaries>\n{previous_summaries}\n</previous_segment_summaries>\n{formatted_messages}",
			}),
			loadMemoryExtractionPrompts: async () => ({
				system: "Extract.",
				user: "<segment_summary_context>\n{segment_summary}\n</segment_summary_context>\n{formatted_messages}",
			}),
			memoryEmbeddingProvider: async () => {
				throw new Error("empty extraction should not load embeddings");
			},
			addSegmentWithMemories: async (_segment: unknown, memories: readonly unknown[]) => memories,
		} as unknown as Genome;

		const result = await collapseSessionToMemory({
			events: [
				event("perceive", 100, { goal: "Continue the SQLite memory implementation." }),
				event("session_end", 200, { output: "Continuity prompt wired." }),
			],
			genome,
			client,
			...DEFAULT_MEMORY_MODELS,
			sessionId: "session-collapse-continuity",
			cwd: workDir,
			project: { id: "sprout", name: "sprout", confidence: 1, source: "explicit" },
			now: 300,
		});

		expect(result).not.toBe("skipped");
		expect(prompts[0]).not.toContain("Oldest excluded summary");
		expect(prompts[0]).not.toContain("Unrelated project summary");
		expect(prompts[0]).toContain("- Summary one");
		expect(prompts[0]).toContain("- Summary two");
		expect(prompts[0]).toContain("- Summary three");
		expect(prompts[0]).toContain("- Summary four");
		expect(prompts[0]).toContain("- Summary &lt;five&gt;");
		expect(prompts[1]).toContain("Current &lt;summary&gt; keeps SQLite continuity.");
		expect(prompts[1]).toContain("Continue the SQLite memory implementation.");
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
				return memories;
			},
		} as unknown as Genome;

		const result = await collapseSessionToMemory({
			events: [
				event("perceive", 100, { goal: "Check whether anything should be remembered." }),
				event("session_end", 200, { output: "Nothing durable." }),
			],
			genome,
			client,
			...DEFAULT_MEMORY_MODELS,
			sessionId: "session-collapse-no-drafts",
			cwd: workDir,
			now: 300,
		});

		expect(result).not.toBe("skipped");
		if (result === "skipped") return;
		expect(result.extractedMemoryCount).toBe(0);
		expect(persistedMemoryCount).toBe(0);
	});

	test("redacts secrets before summary and extraction prompts", async () => {
		const workDir = join(tempDir, "work-redacted");
		await mkdir(workDir, { recursive: true });
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
								summary: "The user shared a redacted credential incident.",
								title: "Redacted credential",
								complexity: 1,
							})
						: "[]",
				);
			},
		} as unknown as Client;
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
				throw new Error("empty extraction should not load embeddings");
			},
			addSegmentWithMemories: async () => [],
		} as unknown as Genome;

		await collapseSessionToMemory({
			events: [
				event("perceive", 100, {
					goal: `Remember OPENAI_API_KEY=sk-${"a".repeat(32)} and Bearer eyJ${"a".repeat(
						20,
					)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`,
				}),
			],
			genome,
			client,
			...DEFAULT_MEMORY_MODELS,
			sessionId: "session-collapse-redacted",
			cwd: workDir,
			now: 300,
		});

		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) {
			expect(prompt).toContain("OPENAI_API_KEY=[REDACTED_API_KEY]");
			expect(prompt).toContain("Bearer [REDACTED_TOKEN]");
			expect(prompt).not.toContain(`sk-${"a".repeat(32)}`);
			expect(prompt).not.toContain(`eyJ${"a".repeat(20)}`);
		}
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
			...DEFAULT_MEMORY_MODELS,
			sessionId: "session-collapse-continued",
			cwd: workDir,
			now: 500,
		});
		expect(first).not.toBe("skipped");

		const duplicate = await collapseSessionToMemory({
			events: firstRunEvents,
			genome,
			client,
			...DEFAULT_MEMORY_MODELS,
			sessionId: "session-collapse-continued",
			cwd: workDir,
			now: 600,
		});
		expect(duplicate).toBe("skipped");

		const continued = await collapseSessionToMemory({
			events: [...firstRunEvents, ...secondRunEvents],
			genome,
			client,
			...DEFAULT_MEMORY_MODELS,
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
				...DEFAULT_MEMORY_MODELS,
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
				...DEFAULT_MEMORY_MODELS,
				sessionId: "session-collapse-embedding-fail",
				cwd: workDir,
				now: 300,
			}),
		).rejects.toThrow("embedding boom");

		expect(genome.segments.all()).toHaveLength(0);
		expect(genome.memories.all()).toHaveLength(0);
	});
});

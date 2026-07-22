import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome } from "../../src/genome/genome.ts";
import { recall, renderMemories, renderRoutingHints } from "../../src/genome/recall.ts";
import { surfaceMemories } from "../../src/genome/recall-pipeline.ts";
import { type AgentSpec, DEFAULT_CONSTRAINTS, type Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { EmbeddingProvider } from "../../src/llm/embeddings.ts";
import { ContentKind, type Request, type Response } from "../../src/llm/types.ts";
import { seedMemories } from "../helpers/genome-seed.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function makeSpec(name: string): AgentSpec {
	return {
		name,
		description: `Agent ${name}`,
		system_prompt: `You are ${name}.`,
		model: "fast",
		tools: [],
		agents: [],
		constraints: { ...DEFAULT_CONSTRAINTS },
		tags: [],
		version: 1,
	};
}

function makeMemory(id: string, content: string, tags: string[] = []): Memory {
	return {
		id,
		content,
		tags,
		source: "test",
		created: Date.now(),
		last_used: Date.now(),
		use_count: 0,
		confidence: 1.0,
	};
}

function createRecallEmbeddingProvider(): EmbeddingProvider {
	return {
		provider: "test-slot",
		model: "test-slot",
		dimensions: 768,
		embedBatch: async (texts, options = {}) =>
			texts.map((text) => {
				const vector = new Float32Array(768);
				vector[slotForText(text, options.kind ?? "document")] = 1;
				return {
					text,
					vector,
					provider: "test-slot",
					model: "test-slot",
					dimensions: 768,
				};
			}),
	};
}

function createSqliteExpansionProvider(): EmbeddingProvider {
	return {
		provider: "test-sqlite-expansion",
		model: "test-sqlite-expansion",
		dimensions: 768,
		embedBatch: async (texts, options = {}) =>
			texts.map((text) => {
				const vector = new Float32Array(768);
				const normalized = text.toLowerCase();
				const slot =
					normalized.includes("sqlite") && (options.kind ?? "document") === "query" ? 11 : 12;
				vector[normalized.includes("sqlite") ? 11 : slot] = 1;
				return {
					text,
					vector,
					provider: "test-sqlite-expansion",
					model: "test-sqlite-expansion",
					dimensions: 768,
				};
			}),
	};
}

function clientReturning(json: string): Client {
	return {
		complete: async (request: Request): Promise<Response> => ({
			id: "recall-subcortical-test",
			model: request.model,
			provider: request.provider ?? "test",
			message: { role: "assistant", content: [{ kind: ContentKind.TEXT, text: json }] },
			finish_reason: { reason: "stop" },
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		}),
	} as unknown as Client;
}

function slotForText(text: string, kind: "query" | "document"): number {
	const normalized = text.toLowerCase();
	if (kind === "query" && normalized === "testing framework") return 1;
	if (normalized.includes("dependency injection") || normalized.includes("provider override"))
		return 5;
	if (normalized.includes("pytest") || normalized.includes("testing fact")) return 0;
	if (normalized.includes("auth")) return 2;
	if (normalized.includes("unrelated")) return 3;
	return 4;
}

describe("recall", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-recall-"));
	});

	test("surfaceMemories returns immediately for zero limit", async () => {
		const genome = {
			memories: {
				all: () => {
					throw new Error("should not read memories");
				},
			},
			searchMemories: async () => {
				throw new Error("should not search memories");
			},
		} as unknown as Genome;

		const result = await surfaceMemories(genome, "sqlite", { limit: 0 });

		expect(result).toEqual({
			memories: [],
			rendered: "",
			stats: {
				similarityCount: 0,
				hubCount: 0,
				pinnedCount: 0,
				finalCount: 0,
			},
		});
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns all agents when genome has < 20 agents", async () => {
		const root = join(tempDir, "recall-small");
		const genome = new Genome(root);
		await genome.init();
		await genome.addAgent(makeSpec("agent-a"));
		await genome.addAgent(makeSpec("agent-b"));

		const result = await recall(genome, "find some code");

		expect(result.agents).toHaveLength(2);
		expect(result.agents.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);
	});

	test("returns matching memories by keyword", async () => {
		const root = join(tempDir, "recall-memories");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("m1", "this project uses pytest for testing"));
		await seedMemories(genome, makeMemory("m2", "the auth module is at src/auth"));

		const result = await recall(genome, "testing pytest");

		expect(result.memories).toHaveLength(1);
		expect(result.memories[0]!.id).toBe("m1");
	});

	test("ignores archived unembedded rows during indexed recall", async () => {
		const root = join(tempDir, "recall-archived-unembedded");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("active", "this project uses pytest for testing"));
		genome.memories.stage({
			...makeMemory("archived", "this project uses pytest for testing"),
			archived_at: 1234,
			embedding: undefined,
		});
		await genome.memories.save();

		const result = await recall(genome, "testing pytest");

		expect(result.memories.map((memory) => memory.id)).toEqual(["active"]);
	});

	test("surfaces semantic vector matches without keyword overlap", async () => {
		const root = join(tempDir, "recall-semantic");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("m1", "constructor accepts provider override"));

		const result = await recall(genome, "dependency injection");

		expect(result.memories.map((memory) => memory.id)).toEqual(["m1"]);
	});

	test("subcortical expansion surfaces memories that the original query misses", async () => {
		const root = join(tempDir, "recall-subcortical");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createSqliteExpansionProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("m-sqlite", "The MIRA port persists facts in SQLite."));

		const query = "what backing store should codemira style have?";
		const withoutExpansion = await recall(genome, query);
		const withExpansion = await recall(genome, query, {
			subcortical: {
				prompt: "expand recall",
				client: clientReturning(
					`{"expanded_query":"SQLite local database persistence facts","entities":[],"pinned_memory_ids":[]}`,
				),
				model: "fast-model",
				provider: "test",
			},
		});

		expect(withoutExpansion.memories).toHaveLength(0);
		expect(withExpansion.memories.map((memory) => memory.id)).toEqual(["m-sqlite"]);
	});

	test("recall returns corrected memories without surfacing superseded stale claims", async () => {
		const root = join(tempDir, "recall-superseded-correction");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(
			genome,
			makeMemory("stale-auth", "Streamlinear auth uses an Authorization token prefix."),
		);
		await seedMemories(
			genome,
			makeMemory(
				"corrected-auth",
				"Streamlinear auth sends a bare Authorization header without a token prefix.",
			),
		);
		const stale = genome.memories.getById("stale-auth")!;
		stale.superseded_by = "corrected-auth";
		stale.inbound_links = [
			{
				uuid: "corrected-auth",
				type: "supersedes",
				reasoning: "Corrected after source verification.",
				created_at: 123,
			},
		];
		await genome.saveMemoryMutation("genome: supersede stale streamlinear auth memory");

		const result = await recall(genome, "Streamlinear Authorization token prefix", {
			markUsed: false,
		});

		expect(result.memories.map((memory) => memory.id)).toEqual(["corrected-auth"]);
	});

	test("returns matching routing hints", async () => {
		const root = join(tempDir, "recall-routing");
		const genome = new Genome(root);
		await genome.init();
		await genome.addRoutingRule({
			id: "r1",
			condition: "Go project testing",
			preference: "test-runner-go",
			strength: 0.8,
			source: "test",
		});

		const result = await recall(genome, "run Go tests");

		expect(result.routing_hints).toHaveLength(1);
		expect(result.routing_hints[0]!.preference).toBe("test-runner-go");
	});

	test("marks used memories", async () => {
		const root = join(tempDir, "recall-mark");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("m1", "testing fact", []));

		const before = genome.memories.getById("m1")!.use_count;
		await recall(genome, "testing");
		const after = genome.memories.getById("m1")!.use_count;

		expect(after).toBe(before + 1);
	});

	test("can skip usage writes for eval/read-only recall", async () => {
		const root = join(tempDir, "recall-no-mark");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("m1", "testing fact", []));

		const before = genome.memories.getById("m1")!.use_count;
		await recall(genome, "testing", { markUsed: false });
		const after = genome.memories.getById("m1")!.use_count;

		expect(after).toBe(before);
	});

	test("returns empty memories and routing when none match", async () => {
		const root = join(tempDir, "recall-empty");
		const genome = createTestGenome(root, undefined, {
			embeddingProvider: createRecallEmbeddingProvider(),
		});
		await genome.init();
		await seedMemories(genome, makeMemory("m1", "unrelated topic"));

		const result = await recall(genome, "testing framework");

		expect(result.memories).toHaveLength(0);
		expect(result.routing_hints).toHaveLength(0);
	});
});

describe("renderMemories", () => {
	test("renders memories as XML block", () => {
		const memories: Memory[] = [
			makeMemory("m1", "this project uses pytest"),
			makeMemory("m2", "auth module at src/auth"),
		];
		const rendered = renderMemories(memories);
		expect(rendered).toContain("<memory_context>");
		expect(rendered).toContain("this project uses pytest");
		expect(rendered).toContain("auth module at src/auth");
		expect(rendered).toContain("</memory_context>");
	});

	test("returns empty string when no memories", () => {
		expect(renderMemories([])).toBe("");
	});
});

describe("renderRoutingHints", () => {
	test("renders routing hints as XML block", () => {
		const hints = [
			{
				id: "r1",
				condition: "Go testing",
				preference: "test-runner-go",
				strength: 0.8,
				source: "test",
			},
		];
		const rendered = renderRoutingHints(hints);
		expect(rendered).toContain("<routing_hints>");
		expect(rendered).toContain("Go testing");
		expect(rendered).toContain("test-runner-go");
		expect(rendered).toContain("</routing_hints>");
	});

	test("returns empty string when no hints", () => {
		expect(renderRoutingHints([])).toBe("");
	});
});

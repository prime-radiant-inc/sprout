import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { git } from "../../src/genome/genome.ts";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import { incorporateExtractedMemories } from "../../src/genome/memory-incorporation.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import { isActiveMemoryForRecall } from "../../src/genome/memory-lifecycle.ts";
import { memoryShortId } from "../../src/genome/memory-schema.ts";
import type { MemorySegment } from "../../src/genome/segments.ts";
import type { Memory, RelationshipType } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { EmbeddingProvider, EmbeddingVector } from "../../src/llm/embeddings.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "memory-a",
		content: overrides.content ?? "Sprout memory uses local SQLite.",
		tags: overrides.tags ?? ["memory"],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1,
		...overrides,
	};
}

function segment(overrides: Partial<MemorySegment> = {}): MemorySegment {
	return {
		id: overrides.id ?? "segment-a",
		session_id: overrides.session_id ?? "session-a",
		summary: overrides.summary ?? "The session corrected memory behavior.",
		title: overrides.title ?? "Memory correction",
		started_at: overrides.started_at ?? 100,
		ended_at: overrides.ended_at ?? 200,
		created_at: overrides.created_at ?? 200,
		message_count: overrides.message_count ?? 4,
		project_id: overrides.project_id ?? "sprout",
		project_confidence: overrides.project_confidence ?? 1,
		complexity: overrides.complexity ?? 2,
		source: "session-collapse",
		...overrides,
	};
}

function relationships(type: RelationshipType) {
	return async (input: {
		candidates: readonly { source_id: string; target_id: string; extraction_bond?: string }[];
	}) =>
		input.candidates.map((candidate) => ({
			source_id: candidate.source_id,
			target_id: candidate.target_id,
			relationship_type: type,
			reasoning: `Classified as ${type}.`,
			...(candidate.extraction_bond ? { extraction_bond: candidate.extraction_bond } : {}),
		}));
}

function clientReturning(json: string, onRequest?: (request: Request) => void): Client {
	return {
		providers: () => ["openrouter"],
		complete: async (request: Request): Promise<Response> => {
			onRequest?.(request);
			return {
				id: "memory-incorporation-test",
				model: request.model,
				provider: request.provider ?? "openrouter",
				message: Msg.assistant(json),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			};
		},
	} as unknown as Client;
}

const MODELS_BY_PROVIDER = new Map([
	["openrouter", [{ id: "relationship-model", label: "Relationship", source: "remote" as const }]],
]);

const RELATIONSHIP_RESOLVER_SETTINGS = createResolverSettings(
	[{ id: "openrouter", enabled: true }],
	{},
	{ relationship: { providerId: "openrouter", modelId: "relationship-model" } },
);

async function withGenome<T>(
	name: string,
	fn: (root: string) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), `sprout-${name}-`));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function readOptionalFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

describe("extracted memory incorporation", () => {
	test("atomically commits new memories with supersedes relationships and rebuilds the index", async () => {
		await withGenome("memory-incorporate-supersedes", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "stale-auth",
					content: "streamlinear uses Authorization: token header format.",
					created: 100,
				}),
			);

			const result = await genome.addExtractedMemoriesWithRelationships({
				segment: segment({ id: "segment-supersedes" }),
				memories: [
					memory({
						id: "corrected-auth",
						content: "streamlinear sends the bare Authorization header value, no token prefix.",
						created: 200,
					}),
				],
				explicitReferenceIds: [memoryShortId("stale-auth")],
				classifyRelationships: relationships("supersedes"),
				commitMessage: "genome: test supersedes incorporation",
				now: 1234,
			});

			expect(result.memories.map((item) => item.id)).toEqual(["corrected-auth"]);
			expect(result.candidates).toHaveLength(1);
			expect(result.relationships[0]).toMatchObject({
				source_id: "corrected-auth",
				target_id: "stale-auth",
				relationship_type: "supersedes",
			});
			expect(result.linksAdded).toBe(1);
			expect(genome.memories.getById("corrected-auth")?.outbound_links?.[0]).toMatchObject({
				uuid: "stale-auth",
				type: "supersedes",
				created_at: 1234,
			});
			expect(genome.memories.getById("stale-auth")?.superseded_by).toBe("corrected-auth");
			expect(genome.segments.getById("segment-supersedes")).toBeDefined();

			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats()).toMatchObject({ memoryCount: 2, segmentCount: 1, linkCount: 1 });
			} finally {
				index.close();
			}
		});
	});

	test("persists conflicts without deactivating either memory", async () => {
		await withGenome("memory-incorporate-conflicts", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "old-claim",
					content: "The project uses Postgres for memory.",
					created: 100,
				}),
			);

			await genome.addExtractedMemoriesWithRelationships({
				memories: [
					memory({
						id: "new-claim",
						content: "The project uses SQLite for memory.",
						created: 200,
					}),
				],
				explicitReferenceIds: [memoryShortId("old-claim")],
				classifyRelationships: relationships("conflicts"),
				commitMessage: "genome: test conflict incorporation",
			});

			const oldClaim = genome.memories.getById("old-claim");
			const newClaim = genome.memories.getById("new-claim");
			expect(oldClaim?.inbound_links?.[0]?.type).toBe("conflicts");
			expect(newClaim?.outbound_links?.[0]?.type).toBe("conflicts");
			expect(oldClaim?.superseded_by).toBeUndefined();
			expect(oldClaim ? isActiveMemoryForRecall(oldClaim) : false).toBe(true);
			expect(newClaim ? isActiveMemoryForRecall(newClaim) : false).toBe(true);
		});
	});

	test("commits without invoking the classifier when no candidates are found", async () => {
		await withGenome("memory-incorporate-no-candidates", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			let called = false;

			const result = await genome.addExtractedMemoriesWithRelationships({
				memories: [memory({ id: "standalone", content: "A standalone memory.", created: 200 })],
				classifyRelationships: async () => {
					called = true;
					return [];
				},
				commitMessage: "genome: test no candidate incorporation",
			});

			expect(called).toBe(false);
			expect(result.candidates).toEqual([]);
			expect(genome.memories.getById("standalone")).toBeDefined();
		});
	});

	test("rolls back segment, memories, links, and index when classification fails", async () => {
		await withGenome("memory-incorporate-classifier-fails", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "stale-memory",
					content: "The old memory is stale.",
					created: 100,
				}),
			);

			await expect(
				genome.addExtractedMemoriesWithRelationships({
					segment: segment({ id: "segment-rollback" }),
					memories: [
						memory({
							id: "new-memory",
							content: "The new memory corrects the stale one.",
							created: 200,
						}),
					],
					explicitReferenceIds: [memoryShortId("stale-memory")],
					classifyRelationships: async () => {
						throw new Error("classifier failed");
					},
					commitMessage: "genome: should roll back",
				}),
			).rejects.toThrow("classifier failed");

			expect(genome.memories.getById("new-memory")).toBeUndefined();
			expect(genome.memories.getById("stale-memory")?.inbound_links ?? []).toEqual([]);
			expect(genome.memories.getById("stale-memory")?.superseded_by).toBeUndefined();
			expect(genome.segments.getById("segment-rollback")).toBeUndefined();
			expect(await readOptionalFile(join(root, "memories", "memories.jsonl"))).not.toContain(
				"new-memory",
			);
			expect(await readOptionalFile(join(root, "memories", "segments.jsonl"))).not.toContain(
				"segment-rollback",
			);
			expect(await git(root, "status", "--porcelain")).toBe("");

			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats()).toMatchObject({ memoryCount: 1, segmentCount: 0, linkCount: 0 });
			} finally {
				index.close();
			}
		});
	});

	test("rolls back when embedding generation fails", async () => {
		await withGenome("memory-incorporate-embedding-fails", async (root) => {
			const brokenProvider: EmbeddingProvider = {
				provider: "broken",
				model: "broken",
				dimensions: 3,
				embedBatch: async (): Promise<EmbeddingVector[]> => {
					throw new Error("embedding failed");
				},
			};
			const genome = createTestGenome(root, undefined, { embeddingProvider: brokenProvider });
			await genome.init();

			await expect(
				genome.addExtractedMemoriesWithRelationships({
					segment: segment({ id: "segment-embedding-fail" }),
					memories: [memory({ id: "memory-embedding-fail", content: "will not persist" })],
					classifyRelationships: relationships("supersedes"),
					commitMessage: "genome: should not write",
				}),
			).rejects.toThrow("embedding failed");

			expect(genome.memories.getById("memory-embedding-fail")).toBeUndefined();
			expect(genome.segments.getById("segment-embedding-fail")).toBeUndefined();
			expect(await git(root, "status", "--porcelain")).toBe("");
		});
	});

	test("does not classify deduped-out memory proposals", async () => {
		await withGenome("memory-incorporate-dedup", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({ id: "existing", content: "Already known memory.", created: 100 }),
			);
			let called = false;

			const result = await genome.addExtractedMemoriesWithRelationships({
				memories: [memory({ id: "duplicate-proposal", content: "Already known memory." })],
				classifyRelationships: async () => {
					called = true;
					return [];
				},
				commitMessage: "genome: no duplicate write",
			});

			expect(called).toBe(false);
			expect(result.memories).toEqual([]);
			expect(genome.memories.getById("duplicate-proposal")).toBeUndefined();
		});
	});

	test("uses source evidence ids even when extracted text omits stale ids", async () => {
		await withGenome("memory-incorporate-source-evidence", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({
					id: "stale-token-prefix",
					content: "streamlinear uses Authorization: token.",
					created: 100,
				}),
			);
			await genome.addMemory(
				memory({
					id: "stale-token-header",
					content: "streamlinear sends Authorization: token headers.",
					created: 110,
				}),
			);

			const result = await genome.addExtractedMemoriesWithRelationships({
				memories: [
					memory({
						id: "bare-token-correction",
						content: "streamlinear sends the bare Authorization value.",
						created: 200,
					}),
				],
				explicitReferenceIds: [
					memoryShortId("stale-token-prefix"),
					memoryShortId("stale-token-header"),
				],
				classifyRelationships: relationships("supersedes"),
				commitMessage: "genome: test source evidence refs",
			});

			expect(result.candidates.map((candidate) => candidate.target_id).sort()).toEqual([
				"stale-token-header",
				"stale-token-prefix",
			]);
			expect(genome.memories.getById("stale-token-prefix")?.superseded_by).toBe(
				"bare-token-correction",
			);
			expect(genome.memories.getById("stale-token-header")?.superseded_by).toBe(
				"bare-token-correction",
			);
		});
	});

	test("wrapper resolves and uses the configured relationship model when candidates exist", async () => {
		await withGenome("memory-incorporate-wrapper-model", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({ id: "old-storage", content: "Sprout memory uses Postgres.", created: 100 }),
			);
			let captured: Request | undefined;

			const result = await incorporateExtractedMemories({
				genome,
				memories: [
					memory({
						id: "new-storage",
						content: "The durable memory backend is SQLite, replacing the older storage note.",
						created: 200,
					}),
				],
				explicitReferenceIds: [memoryShortId("old-storage")],
				client: clientReturning(
					'{"relationship_type":"supersedes","reasoning":"The newer memory replaces the storage claim."}',
					(request) => {
						captured = request;
					},
				),
				resolverSettings: RELATIONSHIP_RESOLVER_SETTINGS,
				modelsByProvider: MODELS_BY_PROVIDER,
				prompt: "relationship prompt",
				commitMessage: "genome: test wrapper model",
			});

			expect(result.relationships[0]?.relationship_type).toBe("supersedes");
			expect(captured?.provider).toBe("openrouter");
			expect(captured?.model).toBe("relationship-model");
			expect(captured?.metadata?.purpose).toBe("memory.relationship");
			expect(genome.memories.getById("old-storage")?.superseded_by).toBe("new-storage");
		});
	});

	test("wrapper does not resolve the relationship model when no candidates exist", async () => {
		await withGenome("memory-incorporate-wrapper-no-candidates", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			let called = false;

			const result = await incorporateExtractedMemories({
				genome,
				memories: [memory({ id: "standalone-wrapper", content: "Standalone wrapper memory." })],
				client: clientReturning("{}", () => {
					called = true;
				}),
				resolverSettings: createResolverSettings([{ id: "openrouter", enabled: true }]),
				modelsByProvider: MODELS_BY_PROVIDER,
				commitMessage: "genome: test wrapper no candidates",
			});

			expect(called).toBe(false);
			expect(result.relationships).toEqual([]);
			expect(genome.memories.getById("standalone-wrapper")).toBeDefined();
		});
	});

	test("wrapper rejects missing relationship model before saving when candidates exist", async () => {
		await withGenome("memory-incorporate-wrapper-missing-model", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({ id: "old-model", content: "Old memory has a claim.", created: 100 }),
			);

			await expect(
				incorporateExtractedMemories({
					genome,
					memories: [memory({ id: "new-model", content: "New memory corrects the claim." })],
					explicitReferenceIds: [memoryShortId("old-model")],
					client: clientReturning(
						'{"relationship_type":"supersedes","reasoning":"Should not be called."}',
					),
					resolverSettings: createResolverSettings([{ id: "openrouter", enabled: true }]),
					modelsByProvider: MODELS_BY_PROVIDER,
					commitMessage: "genome: should reject missing relationship model",
				}),
			).rejects.toThrow("No memory 'relationship' model is configured");

			expect(genome.memories.getById("new-model")).toBeUndefined();
			expect(genome.memories.getById("old-model")?.superseded_by).toBeUndefined();
		});
	});

	test("wrapper rejects invalid classifier JSON before saving when candidates exist", async () => {
		await withGenome("memory-incorporate-wrapper-invalid-json", async (root) => {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory(
				memory({ id: "old-json", content: "Old JSON memory.", created: 100 }),
			);

			await expect(
				incorporateExtractedMemories({
					genome,
					memories: [
						memory({
							id: "new-json",
							content: "A classifier response must be valid raw JSON before saving.",
						}),
					],
					explicitReferenceIds: [memoryShortId("old-json")],
					client: clientReturning("not json"),
					resolverSettings: RELATIONSHIP_RESOLVER_SETTINGS,
					modelsByProvider: MODELS_BY_PROVIDER,
					prompt: "relationship prompt",
					commitMessage: "genome: should reject invalid classifier JSON",
				}),
			).rejects.toThrow();

			expect(genome.memories.getById("new-json")).toBeUndefined();
			expect(genome.memories.getById("old-json")?.superseded_by).toBeUndefined();
		});
	});
});

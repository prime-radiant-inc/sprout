import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { loadRelationshipClassificationPrompt } from "../../src/genome/prompts.ts";
import {
	classifyAndPersistMemoryLinksWithSettings,
	classifyMemoryRelationship,
	classifyMemoryRelationshipWithSettings,
	normalizeRelationshipClassificationPayload,
	renderRelationshipClassificationUserPrompt,
} from "../../src/genome/relationship-classifier.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function memory(id: string, content: string, created: number): Memory {
	return {
		id,
		content,
		tags: [],
		source: "test",
		created,
		last_used: created,
		use_count: 0,
		confidence: 0.8,
	};
}

function clientReturning(json: string, onRequest?: (request: Request) => void): Client {
	return {
		providers: () => ["anthropic"],
		complete: async (request: Request): Promise<Response> => {
			onRequest?.(request);
			return {
				id: "relationship-test",
				model: request.model,
				provider: request.provider ?? "anthropic",
				message: Msg.assistant(json),
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			};
		},
	} as unknown as Client;
}

describe("relationship classifier", () => {
	test("loads the relationship prompt with worked examples", async () => {
		const prompt = await loadRelationshipClassificationPrompt(process.cwd(), "root");

		expect(prompt).toContain("WORKED EXAMPLES");
		expect(prompt).toContain("relationship_type");
		expect(prompt).toContain("supersedes");
	});

	test("renders per-pair prompt with candidate axes and extraction bond", () => {
		const prompt = renderRelationshipClassificationUserPrompt(
			memory("new", "Sprout uses SQLite now.", 200),
			memory("old", "The reference uses Postgres.", 100),
			{
				source_id: "new",
				target_id: "old",
				axes: ["vector", "entity"],
				score: 1.5,
				extraction_bond: "storage choice",
			},
		);

		expect(prompt).toContain("NEW MEMORY");
		expect(prompt).toContain("EXISTING MEMORY");
		expect(prompt).toContain('Extraction context: "storage choice"');
		expect(prompt).toContain("Candidate axes: vector, entity");
	});

	test("classifies a pair through the LLM client and normalizes JSON", async () => {
		let captured: Request | undefined;
		const result = await classifyMemoryRelationship({
			source: memory("new", "Sprout uses SQLite now.", 200),
			target: memory("old", "The reference uses Postgres.", 100),
			prompt: "classification prompt",
			client: clientReturning(
				'{"relationship_type":"supersedes","reasoning":"The newer memory replaces the older storage decision."}',
				(request) => {
					captured = request;
				},
			),
			model: "claude-haiku",
			provider: "anthropic",
		});

		expect(result).toMatchObject({
			source_id: "new",
			target_id: "old",
			relationship_type: "supersedes",
		});
		expect(captured?.temperature).toBe(0);
		expect(captured?.max_tokens).toBe(500);
	});

	test("settings wrapper resolves the relationship memory model", async () => {
		let captured: Request | undefined;
		await classifyMemoryRelationshipWithSettings({
			source: memory("new", "Sprout uses SQLite now.", 200),
			target: memory("old", "The reference uses Postgres.", 100),
			prompt: "classification prompt",
			client: clientReturning(
				'{"relationship_type":"supersedes","reasoning":"The newer memory replaces the older storage decision."}',
				(request) => {
					captured = request;
				},
			),
			resolverSettings: createResolverSettings(
				[{ id: "openrouter", enabled: true }],
				{},
				{ relationship: { providerId: "openrouter", modelId: "relationship-model" } },
			),
			modelsByProvider: new Map([
				["openrouter", [{ id: "relationship-model", label: "Relationship", source: "remote" }]],
			]),
		});

		expect(captured?.provider).toBe("openrouter");
		expect(captured?.model).toBe("relationship-model");
		expect(captured?.metadata?.purpose).toBe("memory.relationship");
	});

	test("configured relationship model is used by the discover-classify-persist path", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-link-classify-"));
		try {
			const genome = createTestGenome(root);
			await genome.init();
			await genome.addMemory({
				...memory("new", "Sprout memory uses SQLite and local embeddings.", 200),
				embedding: {
					provider: "test",
					model: "test",
					dimensions: 3,
					status: "ready",
					vector: [1, 0, 0],
				},
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			});
			await genome.addMemory({
				...memory("old", "The MIRA port stores long-term memory in SQLite.", 100),
				embedding: {
					provider: "test",
					model: "test",
					dimensions: 3,
					status: "ready",
					vector: [0.98, 0.02, 0],
				},
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			});

			let captured: Request | undefined;
			const result = await classifyAndPersistMemoryLinksWithSettings({
				genome,
				prompt: "classification prompt",
				client: clientReturning(
					'{"relationship_type":"refines","reasoning":"The newer memory adds local embedding detail."}',
					(request) => {
						captured = request;
					},
				),
				resolverSettings: createResolverSettings(
					[{ id: "openrouter", enabled: true }],
					{},
					{ relationship: { providerId: "openrouter", modelId: "relationship-model" } },
				),
				modelsByProvider: new Map([
					["openrouter", [{ id: "relationship-model", label: "Relationship", source: "remote" }]],
				]),
				discovery: { minVectorSimilarity: 0.95, minTfIdfSimilarity: 0.01 },
				now: 1234,
			});

			expect(result.candidates).toHaveLength(1);
			expect(result.relationships[0]?.relationship_type).toBe("refines");
			expect(result.added).toBe(1);
			expect(captured?.provider).toBe("openrouter");
			expect(captured?.model).toBe("relationship-model");
			expect(captured?.metadata?.purpose).toBe("memory.relationship");
			expect(genome.memories.getById("new")?.outbound_links?.[0]).toMatchObject({
				uuid: "old",
				type: "refines",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects invalid relationship types", () => {
		expect(() =>
			normalizeRelationshipClassificationPayload(
				'{"relationship_type":"similar","reasoning":"Bad type."}',
				"new",
				"old",
			),
		).toThrow(/Invalid relationship_type/);
	});
});

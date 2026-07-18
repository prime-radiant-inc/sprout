import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall } from "../../src/genome/recall.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { EmbeddingProvider } from "../../src/llm/embeddings.ts";
import { ContentKind, messageText, type Request, type Response } from "../../src/llm/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

const CASE_COUNT = 30;

function memory(index: number): Memory {
	const now = Date.now();
	return {
		id: `eval-memory-${index}`,
		content: `Durable recall eval fact token_${index} should be retrieved only after expansion.`,
		tags: ["eval"],
		source: "test",
		created: now + index,
		last_used: now + index,
		use_count: 0,
		confidence: 1,
	};
}

function evalEmbeddingProvider(): EmbeddingProvider {
	return {
		provider: "test-subcortical-eval",
		model: "test-subcortical-eval",
		dimensions: 768,
		embedBatch: async (texts, options = {}) =>
			texts.map((text) => {
				const vector = new Float32Array(768);
				const tokenIndex = tokenSlot(text);
				vector[tokenIndex ?? (options.kind === "query" ? 700 : 701)] = 1;
				return {
					text,
					vector,
					provider: "test-subcortical-eval",
					model: "test-subcortical-eval",
					dimensions: 768,
				};
			}),
	};
}

function evalClient(): Client {
	return {
		complete: async (request: Request): Promise<Response> => {
			const text = messageText(request.messages.at(-1)!);
			const match = /alias_(\d+)/.exec(text);
			if (!match?.[1]) throw new Error(`missing eval alias in request: ${text}`);
			const index = Number(match[1]);
			return {
				id: `eval-expansion-${index}`,
				model: request.model,
				provider: request.provider ?? "test",
				message: {
					role: "assistant",
					content: [
						{
							kind: ContentKind.TEXT,
							text: JSON.stringify({
								expanded_query: `token_${index}`,
								entities: [],
								pinned_memory_ids: [],
							}),
						},
					],
				},
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			};
		},
	} as unknown as Client;
}

describe("subcortical recall eval", () => {
	test("30-query side-by-side eval strictly improves known misses", async () => {
		const root = await mkdtemp(join(tmpdir(), "sprout-subcortical-eval-"));
		try {
			const genome = createTestGenome(root, undefined, {
				embeddingProvider: evalEmbeddingProvider(),
			});
			await genome.init();
			for (let index = 0; index < CASE_COUNT; index++) {
				await genome.addMemory(memory(index));
			}

			let baselineHits = 0;
			let expandedHits = 0;
			for (let index = 0; index < CASE_COUNT; index++) {
				const query = `obscurealias_${index}`;
				const expectedId = `eval-memory-${index}`;
				const baseline = await recall(genome, query, { limit: 1 });
				const expanded = await recall(genome, query, {
					limit: 1,
					subcortical: {
						prompt: "expand recall",
						client: evalClient(),
						model: "fast-model",
						provider: "test",
					},
				});
				if (baseline.memories.some((item) => item.id === expectedId)) baselineHits++;
				if (expanded.memories.some((item) => item.id === expectedId)) expandedHits++;
			}

			expect(baselineHits).toBe(0);
			expect(expandedHits).toBe(CASE_COUNT);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		// Generous timeout: this eval runs 60 real recall passes and is CPU-bound; the default
		// 5s is too tight on slower hardware and under parallel test load. It guards recall
		// quality, not speed.
	}, 60_000);
});

function tokenSlot(text: string): number | undefined {
	const match = /token_(\d+)/.exec(text);
	if (!match?.[1]) return undefined;
	return Number(match[1]);
}

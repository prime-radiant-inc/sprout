import { describe, expect, test } from "bun:test";
import { createResolverSettings } from "../../src/agents/model-resolver.ts";
import { loadRelationshipClassificationPrompt } from "../../src/genome/prompts.ts";
import {
	classifyMemoryRelationship,
	classifyMemoryRelationshipWithSettings,
	normalizeRelationshipClassificationPayload,
	renderRelationshipClassificationUserPrompt,
} from "../../src/genome/relationship-classifier.ts";
import type { Memory } from "../../src/kernel/types.ts";
import type { Client } from "../../src/llm/client.ts";
import type { Request, Response } from "../../src/llm/types.ts";
import { Msg } from "../../src/llm/types.ts";

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

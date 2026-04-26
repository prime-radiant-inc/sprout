import { describe, expect, test } from "bun:test";
import {
	expandedRecallQuery,
	normalizeSubcorticalRecallPayload,
	runSubcorticalPrepass,
} from "../../src/genome/subcortical.ts";
import type { Client } from "../../src/llm/client.ts";
import { ContentKind, messageText, type Request, type Response } from "../../src/llm/types.ts";

function clientReturning(json: string, onRequest?: (request: Request) => void): Client {
	return {
		complete: async (request: Request): Promise<Response> => {
			onRequest?.(request);
			return {
				id: "subcortical-test",
				model: request.model,
				provider: request.provider ?? "test",
				message: { role: "assistant", content: [{ kind: ContentKind.TEXT, text: json }] },
				finish_reason: { reason: "stop" },
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			};
		},
	} as unknown as Client;
}

describe("subcortical recall pre-pass", () => {
	test("normalizes strict query expansion JSON", () => {
		const expansion = normalizeSubcorticalRecallPayload(`\`\`\`json
{"expanded_query":"SQLite local memory database","entities":[{"name":"Sprout","type":"PROJECT"}],"pinned_memory_ids":["mem_12345678","memory-a"],"reasoning":"storage synonyms"}
\`\`\``);

		expect(expansion.expanded_query).toBe("SQLite local memory database");
		expect(expansion.entities).toEqual([{ name: "Sprout", type: "PROJECT" }]);
		expect(expansion.pinned_memory_ids).toEqual(["mem_12345678", "memory-a"]);
		expect(expandedRecallQuery("database choice", expansion)).toContain("PROJECT:Sprout");
	});

	test("runs cheap LLM pre-pass with additional context", async () => {
		let captured: Request | undefined;
		const expansion = await runSubcorticalPrepass({
			query: "what database for codemira style memory?",
			additionalContext: "Retain mem_12345678",
			prompt: "expand recall",
			client: clientReturning(
				`{"expanded_query":"SQLite local embeddings memory","entities":[],"pinned_memory_ids":["mem_12345678"]}`,
				(request) => {
					captured = request;
				},
			),
			model: "fast-model",
			provider: "test",
		});

		expect(captured?.max_tokens).toBe(350);
		expect(messageText(captured!.messages[1]!)).toContain("Retain mem_12345678");
		expect(expansion.pinned_memory_ids).toEqual(["mem_12345678"]);
	});

	test("fails loudly on invalid pre-pass output", () => {
		expect(() => normalizeSubcorticalRecallPayload(`{"entities":[]}`)).toThrow("expanded_query");
	});
});

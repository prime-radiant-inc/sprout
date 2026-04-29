import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MEMORY_EXTRACTION_MAX_TOKENS,
	extractMemoryDrafts,
	formatExtractionMessages,
	memoryFromDraft,
	normalizeExtractionPayload,
	parseExtractionJson,
	renderExtractionUserPrompt,
} from "../../src/genome/extraction.ts";
import type { Client } from "../../src/llm/client.ts";
import { type FinishReason, Msg, type Request, type Response } from "../../src/llm/types.ts";

function makeClient(
	json: string,
	onRequest?: (request: Request) => void,
	finishReason: FinishReason = { reason: "stop" },
): Client {
	return {
		complete: async (request: Request): Promise<Response> => {
			onRequest?.(request);
			return {
				id: "extract-test",
				model: "test",
				provider: "test",
				message: Msg.assistant(json),
				finish_reason: finishReason,
				usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
			};
		},
		providers: () => ["test"],
		listModelsByProvider: async () => new Map(),
	} as unknown as Client;
}

describe("memory extraction", () => {
	test("formats transcript messages with role and timestamp", () => {
		const formatted = formatExtractionMessages([
			{ role: "user", content: "Use SQLite <not Postgres>", timestamp: 1700000000000 },
		]);

		expect(formatted).toContain('role="user"');
		expect(formatted).toContain('time="2023-11-14T22:13:20.000Z"');
		expect(formatted).toContain("SQLite &lt;not Postgres&gt;");
	});

	test("formats epoch transcript timestamps", () => {
		const formatted = formatExtractionMessages([
			{ role: "assistant", content: "epoch memory", timestamp: 0 },
		]);

		expect(formatted).toContain('time="1970-01-01T00:00:00.000Z"');
	});

	test("renders the user prompt template", () => {
		const prompt = renderExtractionUserPrompt("Before\n{formatted_messages}\nAfter", [
			{ role: "user", content: "remember this" },
		]);

		expect(prompt).toContain("Before");
		expect(prompt).toContain("remember this");
		expect(prompt).toContain("After");
	});

	test("renders non-authoritative segment summary context", () => {
		const prompt = renderExtractionUserPrompt(
			"<segment_summary_context>\n{segment_summary}\n</segment_summary_context>\n{formatted_messages}",
			[{ role: "user", content: "Use SQLite" }],
			{ segmentSummary: "Current <summary> & decisions" },
		);
		const noSummaryPrompt = renderExtractionUserPrompt("{segment_summary}", []);

		expect(prompt).toContain("Current &lt;summary&gt; &amp; decisions");
		expect(prompt).toContain("Use SQLite");
		expect(noSummaryPrompt).toBe("(none)");
	});

	test("parses valid, wrapped, and repairable JSON", () => {
		expect(parseExtractionJson('[{"text":"alpha"}]')).toEqual([{ text: "alpha" }]);
		expect(parseExtractionJson('```json\n{"memories":[{"text":"beta"}]}\n```')).toEqual({
			memories: [{ text: "beta" }],
		});
		expect(parseExtractionJson('```JSON\n{"memories":[{"text":"upper"}]}\n```')).toEqual({
			memories: [{ text: "upper" }],
		});
		expect(parseExtractionJson('``` json\n{"memories":[{"text":"spaced"}]}\n```')).toEqual({
			memories: [{ text: "spaced" }],
		});
		expect(parseExtractionJson('```json {"memories":[{"text":"inline"}]} ```')).toEqual({
			memories: [{ text: "inline" }],
		});
		expect(parseExtractionJson('```json memory\n{"memories":[{"text":"metadata"}]}\n```')).toEqual({
			memories: [{ text: "metadata" }],
		});
		expect(parseExtractionJson('Here is the JSON:\n```json\n[{"text":"prose"}]\n```')).toEqual([
			{ text: "prose" },
		]);
		expect(parseExtractionJson('Here is the JSON:\n```json\n[{"text":"unterminated"}]\n')).toEqual([
			{ text: "unterminated" },
		]);
		expect(
			parseExtractionJson(
				'```ts\nexport {}\n```\nActual JSON:\n```json\n[{"text":"after code"}]\n',
			),
		).toEqual([{ text: "after code" }]);
		expect(parseExtractionJson('```\n[{"text":"plain"}]\n```')).toEqual([{ text: "plain" }]);
		expect(parseExtractionJson('```\n[{"text":"plain unterminated"}]\n')).toEqual([
			{ text: "plain unterminated" },
		]);
		expect(parseExtractionJson('Here is the JSON: [{"text":"unfenced prose"}]')).toEqual([
			{ text: "unfenced prose" },
		]);
		expect(
			parseExtractionJson(
				'Example: {"ignored":true}\nActual output: [{"text":"schema-ranked payload"}]',
			),
		).toEqual([{ text: "schema-ranked payload" }]);
		expect(
			parseExtractionJson(
				'Wrapper prose: {"memories":[{"text":"real wrapper"}],"examples":[{"text":"nested example"}]}',
			),
		).toEqual({ memories: [{ text: "real wrapper" }], examples: [{ text: "nested example" }] });
		expect(parseExtractionJson('Earlier: [{"text":"old"}]\nFinal: [{"text":"new"}]')).toEqual([
			{ text: "new" },
		]);
		expect(
			parseExtractionJson(
				'No fence:\n{"summary":"Uses {braces}, [brackets], and \\"quoted\\" text","title":"Nested punctuation"}',
			),
		).toEqual({
			summary: 'Uses {braces}, [brackets], and "quoted" text',
			title: "Nested punctuation",
		});
		expect(
			parseExtractionJson(
				'Example: {"summary":"wrong"}\n```json\n{"summary":"right","title":"JSON fence wins"}\n```',
			),
		).toEqual({ summary: "right", title: "JSON fence wins" });
		expect(parseExtractionJson('Noise [not json] then [{"text":"after bad bracket"}]')).toEqual([
			{ text: "after bad bracket" },
		]);
		expect(
			parseExtractionJson('Noise [unterminated aside before [{"text":"after open bracket"}]'),
		).toEqual([{ text: "after open bracket" }]);
		expect(parseExtractionJson("[{“text”: “gamma”,}]")).toEqual([{ text: "gamma" }]);
	});

	test("does not treat arbitrary fenced code as JSON", () => {
		expect(() => parseExtractionJson("```ts\nexport {}\n```")).toThrow();
		expect(() => parseExtractionJson('```ts\n{"text":"not authoritative"}\n```')).toThrow();
	});

	test("parses raw JSON before inspecting fenced snippets inside string values", () => {
		const embeddedSnippet = 'Use this example:\n```json\n{"not":"the payload"}\n```';
		const payload = JSON.stringify([{ text: embeddedSnippet }]);

		expect(parseExtractionJson(payload)).toEqual([{ text: embeddedSnippet }]);
	});

	test("normalizes arrays, wrapper objects, single objects, tags, entities, and dates", () => {
		const drafts = normalizeExtractionPayload({
			memories: [
				{
					text: "Sprout uses local embeddings",
					tags: ["sprout", 123, "memory"],
					entities: [{ name: "Sprout", type: "PROJECT" }],
					happens_at: "2026-04-26T00:00:00.000Z",
				},
			],
		});

		expect(drafts).toHaveLength(1);
		expect(drafts[0]!.tags).toEqual(["sprout", "memory"]);
		expect(drafts[0]!.entity_links).toEqual([
			{ uuid: "entity_project_sprout", name: "Sprout", type: "PROJECT" },
		]);
		expect(drafts[0]!.happens_at).toBe(Date.parse("2026-04-26T00:00:00.000Z"));
	});

	test("includes entity type in generated UUIDs", () => {
		const drafts = normalizeExtractionPayload({
			text: "Different typed entities can share names",
			entities: [
				{ name: "Sprout", type: "PROJECT" },
				{ name: "Sprout", type: "TECHNOLOGY" },
			],
		});

		expect(drafts[0]!.entity_links.map((entity) => entity.uuid)).toEqual([
			"entity_project_sprout",
			"entity_technology_sprout",
		]);
	});

	test("generates stable entity UUIDs and deduplicates repeated entities", () => {
		const [first] = normalizeExtractionPayload({
			text: "Sprout uses SQLite",
			entities: [
				{ name: "SQLite", type: "TECHNOLOGY" },
				{ name: "Sprout", type: "PROJECT" },
				{ name: "SQLite", type: "TECHNOLOGY" },
			],
		});
		const [second] = normalizeExtractionPayload({
			text: "Sprout uses SQLite",
			entities: [
				{ name: "Sprout", type: "PROJECT" },
				{ name: "SQLite", type: "TECHNOLOGY" },
			],
		});

		expect(first!.entity_links.map((entity) => entity.uuid).sort()).toEqual(
			second!.entity_links.map((entity) => entity.uuid).sort(),
		);
		expect(first!.entity_links).toHaveLength(2);
	});

	test("calls the client with system and rendered user prompts", async () => {
		let captured: Request | undefined;
		const drafts = await extractMemoryDrafts({
			client: makeClient('[{"text":"User prefers SQLite for MIRA memory"}]', (request) => {
				captured = request;
			}),
			model: "model",
			provider: "provider",
			prompts: {
				system: "system prompt",
				user: "<conversation>{formatted_messages}</conversation>",
			},
			messages: [{ role: "user", content: "Use SQLite" }],
		});

		expect(captured).toBeDefined();
		expect(captured!.messages[0]!.role).toBe("system");
		expect(captured!.messages[1]!.role).toBe("user");
		expect(captured!.messages[1]!.content[0]!.text).toContain("Use SQLite");
		expect(captured!.max_tokens).toBe(DEFAULT_MEMORY_EXTRACTION_MAX_TOKENS);
		expect(drafts[0]!.text).toBe("User prefers SQLite for MIRA memory");
	});

	test("allows callers to override the extraction output budget", async () => {
		let captured: Request | undefined;
		await extractMemoryDrafts({
			client: makeClient("[]", (request) => {
				captured = request;
			}),
			model: "model",
			provider: "provider",
			prompts: {
				system: "system prompt",
				user: "{formatted_messages}",
			},
			messages: [{ role: "user", content: "Use SQLite" }],
			maxTokens: 12_000,
		});

		expect(captured!.max_tokens).toBe(12_000);
	});

	test("fails explicitly before parsing truncated extraction responses", async () => {
		await expect(
			extractMemoryDrafts({
				client: makeClient('{"memories":[', undefined, { reason: "length", raw: "max_tokens" }),
				model: "extract-model",
				provider: "anthropic",
				prompts: {
					system: "system prompt",
					user: "{formatted_messages}",
				},
				messages: [{ role: "user", content: "Use SQLite" }],
			}),
		).rejects.toThrow(
			"Memory extraction response from anthropic/extract-model was truncated (finish_reason=length, raw=max_tokens)",
		);
	});

	test("builds Memory records from extraction drafts", () => {
		const memory = memoryFromDraft(
			{
				text: "Sprout stores MIRA memories in SQLite-backed JSONL",
				tags: ["memory"],
				entity_links: [{ uuid: "entity_sprout", name: "Sprout", type: "PROJECT" }],
			},
			{ id: "learn-1", source: "learn:extraction", now: 123 },
		);

		expect(memory.id).toBe("learn-1");
		expect(memory.content).toBe("Sprout stores MIRA memories in SQLite-backed JSONL");
		expect(memory.source).toBe("learn:extraction");
		expect(memory.project_ids).toBeUndefined();
	});
});

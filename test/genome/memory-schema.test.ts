import { describe, expect, test } from "bun:test";
import {
	MEMORY_SCHEMA_VERSION,
	memoryShortId,
	normalizeMemory,
} from "../../src/genome/memory-schema.ts";

describe("memory schema normalization", () => {
	test("normalizes legacy memory records to extended schema", () => {
		const normalized = normalizeMemory({
			id: "legacy-durable",
			content: "Sprout uses Bun tests.",
			tags: ["testing", "bun"],
			source: "manual",
			created: 1700000000000,
			last_used: 1700000100000,
			use_count: 4,
			confidence: 0.95,
		});

		expect(normalized.schema_version).toBe(MEMORY_SCHEMA_VERSION);
		expect(normalized.id).toBe("legacy-durable");
		expect(normalized.content).toBe("Sprout uses Bun tests.");
		expect(normalized.text).toBe("Sprout uses Bun tests.");
		expect(normalized.tags).toEqual(["testing", "bun"]);
		expect(normalized.short_id).toBe(memoryShortId("legacy-durable"));
		expect(normalized.project_ids).toEqual([]);
		expect(normalized.entity_links).toEqual([]);
		expect(normalized.outbound_links).toEqual([]);
		expect(normalized.inbound_links).toEqual([]);
		expect(normalized.annotations).toEqual([]);
		expect(normalized.access_count).toBe(4);
		expect(normalized.last_accessed_at).toBe(1700000100000);
	});

	test("preserves extended fields when present", () => {
		const normalized = normalizeMemory({
			id: "mem_abc12345",
			text: "Extended memory",
			content: "Extended memory",
			tags: ["extended"],
			source: "segment",
			created: 1700000000000,
			last_used: 1700000000000,
			use_count: 0,
			confidence: 0.7,
			project_ids: ["sprout"],
			entity_links: [{ uuid: "entity-1", type: "PROJECT", name: "Sprout" }],
			embedding: {
				provider: "local",
				model: "MongoDB/mdbr-leaf-ir",
				dimensions: 768,
				status: "ready",
				vector_id: "mem_abc12345",
			},
		});

		expect(normalized.short_id).toBe("mem_abc12345");
		expect(normalized.project_ids).toEqual(["sprout"]);
		expect(normalized.entity_links).toHaveLength(1);
		expect(normalized.embedding?.status).toBe("ready");
	});

	test("rejects records without memory text", () => {
		expect(() =>
			normalizeMemory({
				id: "missing-text",
				tags: [],
				source: "test",
			}),
		).toThrow("Memory 'missing-text' is missing content/text");
	});

	test("derives stable short ids from arbitrary ids", () => {
		const first = memoryShortId("learn-1700000000-abcdef");
		const second = memoryShortId("learn-1700000000-abcdeg");
		expect(first).toMatch(/^mem_[a-f0-9]{8}$/);
		expect(second).toMatch(/^mem_[a-f0-9]{8}$/);
		expect(second).not.toBe(first);
		expect(memoryShortId("mem_deadbeef")).toBe("mem_deadbeef");
		expect(memoryShortId("!!!")).toMatch(/^mem_[a-f0-9]{8}$/);
	});
});

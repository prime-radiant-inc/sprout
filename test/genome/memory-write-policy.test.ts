import { describe, expect, test } from "bun:test";
import { authorizeMemoryWrite } from "../../src/genome/memory-write-policy.ts";
import type { Memory } from "../../src/kernel/types.ts";

function memory(source: string): Memory {
	return {
		id: "memory-1",
		content: "manual memory",
		tags: [],
		source,
		created: 100,
		last_used: 100,
		use_count: 0,
		confidence: 1,
	};
}

describe("memory write policy", () => {
	test("additive writes require explicit caller instruction", () => {
		expect(authorizeMemoryWrite({ operation: "annotate" })).toMatchObject({
			allowed: false,
			reason: "memory write requires an explicit caller instruction",
		});
		expect(authorizeMemoryWrite({ operation: "annotate", explicitInstruction: true })).toEqual({
			allowed: true,
		});
	});

	test("archive requires explicit user confirmation", () => {
		expect(authorizeMemoryWrite({ operation: "archive", explicitInstruction: true })).toMatchObject(
			{
				allowed: false,
				reason: "archive requires explicit user confirmation",
			},
		);
		expect(
			authorizeMemoryWrite({
				operation: "archive",
				explicitInstruction: true,
				confirmed: true,
			}),
		).toEqual({ allowed: true });
	});

	test("manual memories are protected from destructive changes", () => {
		expect(
			authorizeMemoryWrite({
				operation: "archive",
				explicitInstruction: true,
				memory: memory("manual"),
			}),
		).toMatchObject({
			allowed: false,
			reason: "user-authored/manual memories require explicit confirmation",
		});
	});
});

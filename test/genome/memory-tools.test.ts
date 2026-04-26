import { describe, expect, test } from "bun:test";
import { primitivesForAgent } from "../../src/agents/plan.ts";
import {
	buildReadMemoryPrimitives,
	buildWriteMemoryPrimitives,
	type MemoryToolContext,
} from "../../src/genome/memory-tools.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import type { Memory } from "../../src/kernel/types.ts";

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? "memory-alpha",
		short_id: overrides.short_id ?? "mem_alpha00",
		content: overrides.content ?? "Sprout uses SQLite memory.",
		tags: overrides.tags ?? ["memory"],
		source: overrides.source ?? "test",
		created: overrides.created ?? 100,
		last_used: overrides.last_used ?? 100,
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1,
		...overrides,
	};
}

function makeContext(memories: Memory[] = [memory()]): MemoryToolContext {
	const segments = [
		{
			id: "segment-1",
			session_id: "session-1",
			summary: "Implemented memory tools.",
			title: "Memory tools",
			started_at: 100,
			ended_at: 200,
			created_at: 200,
			message_count: 2,
			project_id: "sprout",
			project_confidence: 0.9,
			complexity: 2,
			source: "session-collapse" as const,
		},
	];
	return {
		agentName: "archivist",
		sessionId: "session-test",
		genome: {
			searchMemories: async () => memories,
			memories: {
				all: () => memories,
				getById: (id) => memories.find((item) => item.id === id),
			},
			segments: {
				all: () => segments,
				getById: (id) => segments.find((segment) => segment.id === id),
			},
			addMemory: async (item) => {
				memories.push(item);
			},
			saveMemoryMutation: async () => {},
			recordMemoryMentions: async () => [],
		},
	};
}

async function runTool(ctx: MemoryToolContext, name: string, args: Record<string, unknown>) {
	const primitive = [...buildReadMemoryPrimitives(ctx), ...buildWriteMemoryPrimitives(ctx)].find(
		(item) => item.name === name,
	);
	if (!primitive) throw new Error(`missing primitive ${name}`);
	return primitive.execute(args, new LocalExecutionEnvironment(process.cwd()));
}

describe("memory tools", () => {
	test("memory.search returns deterministic summaries", async () => {
		const result = await runTool(makeContext(), "memory.search", { query: "sqlite", limit: 3 });

		expect(result.success).toBe(true);
		expect(JSON.parse(result.output)[0]).toMatchObject({
			id: "memory-alpha",
			short_id: "mem_alpha00",
		});
	});

	test("memory.get fetches by short id", async () => {
		const result = await runTool(makeContext(), "memory.get", { id: "mem_alpha00" });

		expect(JSON.parse(result.output)).toMatchObject({
			id: "memory-alpha",
			content: "Sprout uses SQLite memory.",
		});
	});

	test("memory.trace_links returns inbound and outbound links", async () => {
		const ctx = makeContext([
			memory({
				outbound_links: [
					{
						uuid: "memory-beta",
						type: "contextualizes",
						reasoning: "same feature",
						created_at: 100,
					},
				],
			}),
		]);

		const result = await runTool(ctx, "memory.trace_links", { id: "memory-alpha" });

		expect(JSON.parse(result.output).outbound_links[0].uuid).toBe("memory-beta");
	});

	test("memory.entity_query returns memories linked to an entity", async () => {
		const ctx = makeContext([
			memory({
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
		]);

		const result = await runTool(ctx, "memory.entity_query", { name: "Sprout", type: "PROJECT" });

		expect(JSON.parse(result.output)[0].id).toBe("memory-alpha");
	});

	test("memory.find_by_segment returns segment provenance", async () => {
		const ctx = makeContext([memory({ source_segment_id: "segment-1" })]);

		const result = await runTool(ctx, "memory.find_by_segment", { segment_id: "segment-1" });

		expect(JSON.parse(result.output).memories[0].id).toBe("memory-alpha");
	});

	test("authorized annotation persists with archivist audit source", async () => {
		const ctx = makeContext();
		const result = await runTool(ctx, "memory.annotate", {
			id: "memory-alpha",
			text: "Useful during memory debugging.",
			explicit_instruction: true,
		});

		expect(result.success).toBe(true);
		expect(ctx.genome.memories.all()[0]?.annotations?.[0]?.source).toBe("archivist:session-test");
	});

	test("unauthorized archive is blocked", async () => {
		const result = await runTool(makeContext(), "memory.archive", {
			id: "memory-alpha",
			reason: "stale",
			explicit_instruction: true,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("confirmation");
	});

	test("read-only specs cannot see write tools", () => {
		const ctx = makeContext();
		const primitiveNames = [
			...buildReadMemoryPrimitives(ctx),
			...buildWriteMemoryPrimitives(ctx),
		].map((primitive) => primitive.name);
		const tools = primitivesForAgent(["memory.search", "memory.get"], primitiveNames, "anthropic");

		expect(tools).toEqual(["memory.search", "memory.get"]);
		expect(tools).not.toContain("memory.archive");
	});
});

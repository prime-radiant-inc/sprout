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
		writeAuthorization: { additive: true },
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
			stageMemoryForMutation: async (item) => {
				memories.push(item);
				return item;
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
	test("memory_search returns deterministic summaries", async () => {
		const result = await runTool(makeContext(), "memory_search", { query: "sqlite", limit: 3 });

		expect(result.success).toBe(true);
		expect(JSON.parse(result.output)[0]).toMatchObject({
			id: "memory-alpha",
			short_id: "mem_alpha00",
		});
	});

	test("memory_get fetches by short id", async () => {
		const result = await runTool(makeContext(), "memory_get", { id: "mem_alpha00" });

		expect(JSON.parse(result.output)).toMatchObject({
			id: "memory-alpha",
			content: "Sprout uses SQLite memory.",
		});
	});

	test("memory_trace_links returns inbound and outbound links", async () => {
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

		const result = await runTool(ctx, "memory_trace_links", { id: "memory-alpha" });

		expect(JSON.parse(result.output).outbound_links[0].uuid).toBe("memory-beta");
	});

	test("memory_entity_query returns memories linked to an entity", async () => {
		const ctx = makeContext([
			memory({
				entity_links: [{ uuid: "entity_sprout", type: "PROJECT", name: "Sprout" }],
			}),
		]);

		const result = await runTool(ctx, "memory_entity_query", {
			name: "Sprout",
			type: "PROJECT",
		});

		expect(JSON.parse(result.output)[0].id).toBe("memory-alpha");
	});

	test("memory_entity_query excludes archived and superseded memories", async () => {
		const entity = { uuid: "entity_sprout", type: "PROJECT" as const, name: "Sprout" };
		const ctx = makeContext([
			memory({
				id: "active-memory",
				short_id: "mem_active",
				entity_links: [entity],
			}),
			memory({
				id: "archived-memory",
				short_id: "mem_archive",
				entity_links: [entity],
				archived_at: 123,
			}),
			memory({
				id: "superseded-memory",
				short_id: "mem_super",
				entity_links: [entity],
				superseded_by: "active-memory",
			}),
			memory({
				id: "inbound-superseded-memory",
				short_id: "mem_inbound",
				entity_links: [entity],
				inbound_links: [
					{
						uuid: "active-memory",
						type: "supersedes",
						reasoning: "replaced",
						created_at: 123,
					},
				],
			}),
		]);

		const result = await runTool(ctx, "memory_entity_query", {
			name: "Sprout",
			type: "PROJECT",
		});

		expect(JSON.parse(result.output).map((item: { id: string }) => item.id)).toEqual([
			"active-memory",
		]);
	});

	test("memory_entity_query schema advertises entity types", () => {
		const primitive = buildReadMemoryPrimitives(makeContext()).find(
			(item) => item.name === "memory_entity_query",
		)!;
		const properties = primitive.parameters.properties as Record<string, { enum?: string[] }>;

		expect(properties.type?.enum).toContain("PROJECT");
		expect(properties.type?.enum).toContain("TECHNOLOGY");
		expect(properties.type?.enum).not.toContain("refines");
	});

	test("memory_find_by_segment returns segment provenance", async () => {
		const ctx = makeContext([memory({ source_segment_id: "segment-1" })]);

		const result = await runTool(ctx, "memory_find_by_segment", { segment_id: "segment-1" });

		expect(JSON.parse(result.output).memories[0].id).toBe("memory-alpha");
	});

	test("authorized annotation persists with archivist audit source", async () => {
		const ctx = makeContext();
		const result = await runTool(ctx, "memory_annotate", {
			id: "memory-alpha",
			text: "Useful during memory debugging.",
			explicit_instruction: true,
		});

		expect(result.success).toBe(true);
		expect(ctx.genome.memories.all()[0]?.annotations?.[0]?.source).toBe("archivist:session-test");
	});

	test("untrusted contexts do not register mutating write primitives", () => {
		const ctx = { ...makeContext() };
		delete ctx.writeAuthorization;

		expect(buildWriteMemoryPrimitives(ctx)).toEqual([]);
		expect(buildReadMemoryPrimitives(ctx).map((item) => item.name)).toContain(
			"memory_synthesize_answer",
		);
	});

	test("trusted schemas do not expose authorization booleans", () => {
		const primitive = buildWriteMemoryPrimitives(makeContext()).find(
			(item) => item.name === "memory_annotate",
		)!;

		expect(primitive.parameters.properties).not.toHaveProperty("explicit_instruction");
		expect(primitive.parameters.properties).not.toHaveProperty("confirmed");
	});

	test("destructive primitives require destructive authorization", () => {
		const additiveTools = buildWriteMemoryPrimitives(makeContext()).map((item) => item.name);
		const destructiveTools = buildWriteMemoryPrimitives({
			...makeContext(),
			writeAuthorization: { destructive: true },
		}).map((item) => item.name);

		expect(additiveTools).toContain("memory_annotate");
		expect(additiveTools).toContain("memory_link");
		expect(additiveTools).not.toContain("memory_archive");
		expect(additiveTools).not.toContain("memory_consolidate");
		expect(destructiveTools).toContain("memory_archive");
		expect(destructiveTools).toContain("memory_consolidate");
	});

	test("write memory primitives are only built for archivist", () => {
		const ctx = makeContext();
		expect(buildWriteMemoryPrimitives({ ...ctx, agentName: "engineer" })).toEqual([]);
		expect(
			buildWriteMemoryPrimitives({ ...ctx, agentName: "archivist" }).map((item) => item.name),
		).toContain("memory_annotate");
	});

	test("memory_link persists valid relationship types", async () => {
		const ctx = makeContext([
			memory({ id: "memory-alpha", short_id: "mem_alpha00" }),
			memory({ id: "memory-beta", short_id: "mem_beta000" }),
		]);

		const result = await runTool(ctx, "memory_link", {
			from_id: "memory-alpha",
			to_id: "memory-beta",
			type: "refines",
			reasoning: "adds implementation detail",
			explicit_instruction: true,
		});

		expect(result.success).toBe(true);
		expect(ctx.genome.memories.all()[0]?.outbound_links?.[0]).toMatchObject({
			uuid: "memory-beta",
			type: "refines",
		});
		expect(ctx.genome.memories.all()[1]?.inbound_links?.[0]).toMatchObject({
			uuid: "memory-alpha",
			type: "refines",
		});
	});

	test("memory_link marks target superseded for supersedes relationships", async () => {
		const ctx = {
			...makeContext([
				memory({ id: "new-memory", short_id: "mem_new000" }),
				memory({ id: "old-memory", short_id: "mem_old000" }),
			]),
			writeAuthorization: { destructive: true },
		};

		const result = await runTool(ctx, "memory_link", {
			from_id: "new-memory",
			to_id: "old-memory",
			type: "supersedes",
			reasoning: "newer decision replaces the old one",
			explicit_instruction: true,
		});

		expect(result.success).toBe(true);
		expect(ctx.genome.memories.getById("old-memory")?.superseded_by).toBe("new-memory");
		expect(typeof ctx.genome.memories.getById("old-memory")?.updated_at).toBe("number");
	});

	test("memory_link requires destructive target authorization for supersedes", async () => {
		const ctx = makeContext([
			memory({ id: "new-memory", short_id: "mem_new000" }),
			memory({ id: "old-memory", short_id: "mem_old000" }),
		]);

		const result = await runTool(ctx, "memory_link", {
			from_id: "new-memory",
			to_id: "old-memory",
			type: "supersedes",
			reasoning: "newer decision replaces the old one",
			explicit_instruction: true,
			confirmed: true,
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("target memory supersession blocked");
		expect(ctx.genome.memories.getById("old-memory")?.superseded_by).toBeUndefined();
	});

	test("memory_consolidate stages merged memory and archives sources in one mutation", async () => {
		const ctx = {
			...makeContext([
				memory({ id: "old-a", short_id: "mem_olda00", content: "Sprout uses SQLite." }),
				memory({ id: "old-b", short_id: "mem_oldb00", content: "Sprout uses local SQLite." }),
			]),
			writeAuthorization: { destructive: true },
		};
		const commits: string[] = [];
		ctx.genome.saveMemoryMutation = async (message) => {
			commits.push(message);
		};

		const result = await runTool(ctx, "memory_consolidate", {
			source_ids: ["old-a", "old-b"],
			text: "Sprout uses local SQLite.",
		});

		expect(result.success).toBe(true);
		expect(commits).toHaveLength(1);
		const payload = JSON.parse(result.output);
		const consolidated = ctx.genome.memories.getById(payload.consolidated);
		expect(consolidated?.consolidates_memory_ids?.sort()).toEqual(["old-a", "old-b"]);
		expect(consolidated?.outbound_links?.map((link) => link.uuid).sort()).toEqual([
			"old-a",
			"old-b",
		]);
		expect(ctx.genome.memories.getById("old-a")?.superseded_by).toBe(payload.consolidated);
		expect(typeof ctx.genome.memories.getById("old-b")?.archived_at).toBe("number");
	});

	test("memory_link rejects null and unknown relationship types", async () => {
		const ctx = makeContext([
			memory({ id: "memory-alpha", short_id: "mem_alpha00" }),
			memory({ id: "memory-beta", short_id: "mem_beta000" }),
		]);

		const nullResult = await runTool(ctx, "memory_link", {
			from_id: "memory-alpha",
			to_id: "memory-beta",
			type: "null",
			reasoning: "no actionable relationship",
			explicit_instruction: true,
		});
		const unknownResult = await runTool(ctx, "memory_link", {
			from_id: "memory-alpha",
			to_id: "memory-beta",
			type: "adjacent",
			reasoning: "invalid relation",
			explicit_instruction: true,
		});

		expect(nullResult.success).toBe(false);
		expect(unknownResult.success).toBe(false);
		expect(ctx.genome.memories.all()[0]?.outbound_links).toBeUndefined();
	});

	test("read-only specs cannot see write tools", () => {
		const ctx = makeContext();
		const primitiveNames = [
			...buildReadMemoryPrimitives(ctx),
			...buildWriteMemoryPrimitives(ctx),
		].map((primitive) => primitive.name);
		const tools = primitivesForAgent(["memory_search", "memory_get"], primitiveNames, "anthropic");

		expect(tools).toEqual(["memory_search", "memory_get"]);
		expect(tools).not.toContain("memory_archive");
	});
});

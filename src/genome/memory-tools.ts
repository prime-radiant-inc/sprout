import type { Primitive } from "../kernel/primitives.ts";
import type {
	AnnotationEntry,
	EntityLinkEntry,
	Memory,
	MemoryLinkEntry,
	PrimitiveResult,
	RelationshipType,
} from "../kernel/types.ts";
import { traverseMemoryLinks } from "./linking.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";
import { memoryShortId } from "./memory-schema.ts";
import type {
	MemoryWriteAuthorization,
	MemoryWriteOperation,
} from "./memory-write-authorization.ts";
import { authorizeMemoryWrite } from "./memory-write-policy.ts";
import type { MemorySegment } from "./segments.ts";

export interface MemoryToolContext {
	genome: {
		searchMemories(query: string, limit?: number, minConfidence?: number): Promise<Memory[]>;
		memories: {
			all(): Memory[];
			getById(id: string): Memory | undefined;
		};
		segments: {
			all(): MemorySegment[];
			getById(id: string): MemorySegment | undefined;
		};
		addMemory(memory: Memory): Promise<void>;
		stageMemoryForMutation(memory: Memory): Promise<Memory>;
		saveMemoryMutation(commitMessage: string): Promise<void>;
		recordMemoryMentions(shortIds: string[]): Promise<string[]>;
	};
	agentName: string;
	sessionId: string;
	writeAuthorization?: MemoryWriteAuthorization;
}

const MANUAL_MEMORY_LINK_TYPES = [
	"corroborates",
	"conflicts",
	"supersedes",
	"refines",
	"precedes",
	"contextualizes",
	"exemplifies",
	"extraction_ref",
] as const satisfies readonly RelationshipType[];

const MANUAL_MEMORY_LINK_TYPE_SET = new Set<string>(MANUAL_MEMORY_LINK_TYPES);

const ENTITY_TYPES = [
	"PROJECT",
	"LIBRARY",
	"FILE_PATH",
	"COMMAND",
	"ERROR_TYPE",
	"TECHNOLOGY",
	"PERSON",
] as const satisfies readonly EntityLinkEntry["type"][];

export function buildReadMemoryPrimitives(ctx: MemoryToolContext): Primitive[] {
	return [
		memorySearchPrimitive(ctx),
		memoryGetPrimitive(ctx),
		memoryTraceLinksPrimitive(ctx),
		memoryEntityQueryPrimitive(ctx),
		memoryFindBySegmentPrimitive(ctx),
		memorySynthesizeAnswerPrimitive(ctx),
	];
}

export function buildWriteMemoryPrimitives(ctx: MemoryToolContext): Primitive[] {
	if (ctx.agentName !== "archivist") return [];
	const primitives: Primitive[] = [];
	if (operationAllowed(ctx, "annotate", false)) primitives.push(memoryAnnotatePrimitive(ctx));
	if (operationAllowed(ctx, "link", false) || operationAllowed(ctx, "supersede", true)) {
		primitives.push(memoryLinkPrimitive(ctx));
	}
	if (operationAllowed(ctx, "archive", true)) primitives.push(memoryArchivePrimitive(ctx));
	if (operationAllowed(ctx, "consolidate", true)) {
		primitives.push(memoryConsolidatePrimitive(ctx));
	}
	return primitives;
}

function memorySearchPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_search",
		description: "Search long-term memories using Sprout's deterministic hybrid memory index.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string" },
				limit: { type: "integer" },
			},
			required: ["query"],
		},
		async execute(args) {
			const query = stringArg(args.query);
			if (!query) return fail("query is required");
			const memories = await ctx.genome.searchMemories(query, intArg(args.limit, 5), 0.3);
			return ok(memories.map(memorySummary));
		},
	};
}

function memoryGetPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_get",
		description: "Fetch one memory by full id or mem_XXXXXXXX short id.",
		parameters: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		async execute(args) {
			const memory = findMemory(ctx, stringArg(args.id));
			return memory ? ok(memoryDetail(memory)) : fail("memory not found");
		},
	};
}

function memoryTraceLinksPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_trace_links",
		description: "Return inbound and outbound memory links for a memory.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string" },
				depth: { type: "integer" },
			},
			required: ["id"],
		},
		async execute(args) {
			const memory = findMemory(ctx, stringArg(args.id));
			if (!memory) return fail("memory not found");
			const related = traverseMemoryLinks(ctx.genome.memories.all(), memory.id, {
				depth: intArg(args.depth, 2),
			}).map((result) => ({
				...memorySummary(result.memory),
				distance: result.distance,
				via: result.via,
				type: result.type,
				score: result.score,
			}));
			return ok({
				id: memory.id,
				short_id: memory.short_id ?? memoryShortId(memory.id),
				outbound_links: memory.outbound_links ?? [],
				inbound_links: memory.inbound_links ?? [],
				related,
			});
		},
	};
}

function memoryEntityQueryPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_entity_query",
		description: "Find memories linked to an entity name and optional entity type.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string" },
				type: { type: "string", enum: ENTITY_TYPES },
			},
			required: ["name"],
		},
		async execute(args) {
			const name = stringArg(args.name)?.toLowerCase();
			const type = stringArg(args.type)?.toUpperCase();
			if (!name) return fail("name is required");
			const matches = ctx.genome.memories
				.all()
				.filter(
					(memory) =>
						isActiveMemoryForRecall(memory) &&
						(memory.entity_links ?? []).some(
							(entity) => entity.name.toLowerCase() === name && (!type || entity.type === type),
						),
				)
				.map(memorySummary);
			return ok(matches);
		},
	};
}

function memoryFindBySegmentPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_find_by_segment",
		description: "Find memories extracted from a collapsed session segment.",
		parameters: {
			type: "object",
			properties: { segment_id: { type: "string" } },
			required: ["segment_id"],
		},
		async execute(args) {
			const segmentId = stringArg(args.segment_id);
			if (!segmentId) return fail("segment_id is required");
			const segment = ctx.genome.segments.getById(segmentId);
			const memories = ctx.genome.memories
				.all()
				.filter((memory) => memory.source_segment_id === segmentId)
				.map(memorySummary);
			return ok({ segment, memories });
		},
	};
}

function memoryAnnotatePrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_annotate",
		description: "Archivist-only: add a non-destructive annotation to a memory.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string" },
				text: { type: "string" },
			},
			required: ["id", "text"],
		},
		async execute(args) {
			const memory = findMemory(ctx, stringArg(args.id));
			if (!memory) return fail("memory not found");
			const scoped = additiveScopeAllows(ctx, "annotate", [memory]);
			const auth = authorizeMemoryWrite({
				operation: "annotate",
				explicitInstruction: scoped,
				memory,
			});
			if (!auth.allowed) return fail(auth.reason ?? "memory write blocked");
			const annotation: AnnotationEntry = {
				text: stringArg(args.text) ?? "",
				created_at: Date.now(),
				source: archivistSource(ctx),
			};
			memory.annotations = [...(memory.annotations ?? []), annotation];
			await ctx.genome.saveMemoryMutation(`genome: annotate memory '${memory.id}'`);
			return ok({ annotated: memory.id, annotation });
		},
	};
}

function memoryArchivePrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_archive",
		description: "Archivist-only: archive a memory after explicit user confirmation.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string" },
				reason: { type: "string" },
			},
			required: ["id", "reason"],
		},
		async execute(args) {
			const memory = findMemory(ctx, stringArg(args.id));
			if (!memory) return fail("memory not found");
			const scoped = destructiveScopeAllows(ctx, "archive", [memory]);
			const auth = authorizeMemoryWrite({
				operation: "archive",
				explicitInstruction: scoped,
				confirmed: scoped,
				memory,
			});
			if (!auth.allowed) return fail(auth.reason ?? "memory write blocked");
			memory.archived_at = Date.now();
			memory.archived_reason = stringArg(args.reason) ?? "archived by archivist";
			await ctx.genome.saveMemoryMutation(`genome: archive memory '${memory.id}'`);
			return ok({ archived: memory.id, reason: memory.archived_reason });
		},
	};
}

function memoryLinkPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_link",
		description: "Archivist-only: add a typed relationship from one memory to another.",
		parameters: {
			type: "object",
			properties: {
				from_id: { type: "string" },
				to_id: { type: "string" },
				type: { type: "string" },
				reasoning: { type: "string" },
			},
			required: ["from_id", "to_id", "type", "reasoning"],
		},
		async execute(args) {
			const from = findMemory(ctx, stringArg(args.from_id));
			const to = findMemory(ctx, stringArg(args.to_id));
			if (!from || !to) return fail("source or target memory not found");
			if (from.id === to.id) return fail("cannot link a memory to itself");
			const relationshipType = stringArg(args.type)?.toLowerCase();
			if (!relationshipType || !MANUAL_MEMORY_LINK_TYPE_SET.has(relationshipType)) {
				return fail(
					`invalid relationship type: expected one of ${MANUAL_MEMORY_LINK_TYPES.join(", ")}`,
				);
			}
			const supersedes = relationshipType === "supersedes";
			const scoped = supersedes
				? destructiveScopeAllows(ctx, "supersede", [from, to])
				: additiveScopeAllows(ctx, "link", [from, to]);
			if (supersedes && !scoped) {
				return fail(
					"target memory supersession blocked: memory write outside trusted authorization scope",
				);
			}
			const auth = authorizeMemoryWrite({
				operation: supersedes ? "archive" : "link",
				explicitInstruction: scoped,
				confirmed: supersedes ? scoped : false,
				memory: from,
			});
			if (!auth.allowed) return fail(auth.reason ?? "memory write blocked");
			if (supersedes) {
				const targetAuth = authorizeMemoryWrite({
					operation: "archive",
					explicitInstruction: scoped,
					confirmed: scoped,
					memory: to,
				});
				if (!targetAuth.allowed) {
					return fail(`target memory supersession blocked: ${targetAuth.reason}`);
				}
			}
			const link: MemoryLinkEntry = {
				uuid: to.id,
				type: relationshipType as MemoryLinkEntry["type"],
				reasoning: stringArg(args.reasoning) ?? "",
				created_at: Date.now(),
			};
			let changed = false;
			if (!hasMemoryLink(from.outbound_links, link.uuid, link.type)) {
				from.outbound_links = [...(from.outbound_links ?? []), link];
				changed = true;
			}
			if (!hasMemoryLink(to.inbound_links, from.id, link.type)) {
				to.inbound_links = [...(to.inbound_links ?? []), { ...link, uuid: from.id }];
				changed = true;
			}
			if (supersedes) {
				if (to.superseded_by !== from.id) {
					to.superseded_by = from.id;
					to.updated_at = link.created_at;
					changed = true;
				}
			}
			if (changed) {
				await ctx.genome.saveMemoryMutation(`genome: link memories '${from.id}' '${to.id}'`);
			}
			return ok({ linked: from.id, target: to.id, type: link.type });
		},
	};
}

function memoryConsolidatePrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_consolidate",
		description:
			"Archivist-only: create a synthesized memory and archive sources after confirmation.",
		parameters: {
			type: "object",
			properties: {
				source_ids: { type: "array", items: { type: "string" } },
				text: { type: "string" },
			},
			required: ["source_ids", "text"],
		},
		async execute(args) {
			const sourceIds = stringArrayArg(args.source_ids);
			const sources = sourceIds.flatMap((id) => {
				const memory = findMemory(ctx, id);
				return memory ? [memory] : [];
			});
			if (sources.length !== sourceIds.length)
				return fail("one or more source memories were not found");
			if (sources.length < 2) return fail("consolidation requires at least two source memories");
			const text = stringArg(args.text);
			if (!text) return fail("text is required");
			const scoped = destructiveScopeAllows(ctx, "consolidate", sources);
			const auth = authorizeMemoryWrite({
				operation: "consolidate",
				explicitInstruction: scoped,
				confirmed: scoped,
				memory: sources[0],
			});
			if (!auth.allowed) return fail(auth.reason ?? "memory write blocked");
			const now = Date.now();
			const consolidated = await ctx.genome.stageMemoryForMutation({
				id: `archivist-consolidated-${now}`,
				content: text,
				text,
				tags: ["consolidated"],
				source: archivistSource(ctx),
				created: now,
				last_used: now,
				use_count: 0,
				confidence: 0.85,
				consolidates_memory_ids: sources.map((memory) => memory.id),
				outbound_links: sources.map((memory) => ({
					uuid: memory.id,
					type: "supersedes",
					reasoning: "consolidated by archivist",
					created_at: now,
				})),
			});
			for (const source of sources) {
				source.archived_at = now;
				source.archived_reason = "consolidated by archivist";
				source.superseded_by = consolidated.id;
				source.updated_at = now;
				source.inbound_links = [
					...(source.inbound_links ?? []),
					{
						uuid: consolidated.id,
						type: "supersedes",
						reasoning: "consolidated by archivist",
						created_at: now,
					},
				];
			}
			await ctx.genome.saveMemoryMutation(
				`genome: consolidate ${sources.length} memories into '${consolidated.id}'`,
			);
			return ok({ consolidated: consolidated.id, archived: sources.map((memory) => memory.id) });
		},
	};
}

function memorySynthesizeAnswerPrimitive(ctx: MemoryToolContext): Primitive {
	return {
		name: "memory_synthesize_answer",
		description: "Archivist-only: synthesize a cited answer from selected memories.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string" },
				memory_ids: { type: "array", items: { type: "string" } },
			},
			required: ["question", "memory_ids"],
		},
		async execute(args) {
			const memories = stringArrayArg(args.memory_ids).flatMap((id) => {
				const memory = findMemory(ctx, id);
				return memory ? [memory] : [];
			});
			const answer = memories
				.map((memory) => `[${memory.short_id ?? memoryShortId(memory.id)}] ${memory.content}`)
				.join("\n");
			return ok({ question: stringArg(args.question), answer, memory_count: memories.length });
		},
	};
}

function findMemory(ctx: MemoryToolContext, id: string | undefined): Memory | undefined {
	if (!id) return undefined;
	const normalized = id.toLowerCase();
	return ctx.genome.memories
		.all()
		.find(
			(memory) =>
				memory.id === id ||
				(memory.short_id ?? memoryShortId(memory.id)).toLowerCase() === normalized,
		);
}

function memorySummary(memory: Memory) {
	return {
		id: memory.id,
		short_id: memory.short_id ?? memoryShortId(memory.id),
		content: memory.content,
		tags: memory.tags,
		source: memory.source,
		confidence: memory.confidence,
	};
}

function memoryDetail(memory: Memory) {
	return {
		...memorySummary(memory),
		entity_links: memory.entity_links ?? [],
		outbound_links: memory.outbound_links ?? [],
		inbound_links: memory.inbound_links ?? [],
		annotations: memory.annotations ?? [],
		source_segment_id: memory.source_segment_id,
		source_session_id: memory.source_session_id,
	};
}

function ok(value: unknown): PrimitiveResult {
	return { output: JSON.stringify(value, null, 2), success: true };
}

function fail(error: string): PrimitiveResult {
	return { output: "", success: false, error };
}

function archivistSource(ctx: MemoryToolContext): string {
	return `archivist:${ctx.sessionId}`;
}

function trustedAdditiveWrite(ctx: MemoryToolContext): boolean {
	return ctx.writeAuthorization?.additive === true || ctx.writeAuthorization?.destructive === true;
}

function trustedDestructiveWrite(ctx: MemoryToolContext): boolean {
	return ctx.writeAuthorization?.destructive === true;
}

function additiveScopeAllows(
	ctx: MemoryToolContext,
	operation: MemoryWriteOperation,
	memories: readonly Memory[],
): boolean {
	if (!operationAllowed(ctx, operation, false)) return false;
	return memories.every((memory) => memoryAllowed(ctx, memory));
}

function destructiveScopeAllows(
	ctx: MemoryToolContext,
	operation: MemoryWriteOperation,
	memories: readonly Memory[],
): boolean {
	if (!operationAllowed(ctx, operation, true)) return false;
	return memories.every((memory) => memoryAllowed(ctx, memory));
}

function operationAllowed(
	ctx: MemoryToolContext,
	operation: MemoryWriteOperation,
	destructive: boolean,
): boolean {
	if (destructive ? !trustedDestructiveWrite(ctx) : !trustedAdditiveWrite(ctx)) return false;
	if (!ctx.writeAuthorization?.allowedMemoryIds?.length) return false;
	const operations = ctx.writeAuthorization?.allowedOperations;
	if (!operations || operations.length === 0) return false;
	return operations.includes(operation);
}

function memoryAllowed(ctx: MemoryToolContext, memory: Memory): boolean {
	const allowedIds = ctx.writeAuthorization?.allowedMemoryIds;
	if (!allowedIds || allowedIds.length === 0) return false;
	const normalized = new Set(allowedIds.map((id) => id.toLowerCase()));
	return (
		normalized.has(memory.id.toLowerCase()) ||
		normalized.has((memory.short_id ?? memoryShortId(memory.id)).toLowerCase())
	);
}

function hasMemoryLink(
	links: readonly MemoryLinkEntry[] | undefined,
	uuid: string,
	type: RelationshipType,
): boolean {
	return (links ?? []).some((link) => link.uuid === uuid && link.type === type);
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function intArg(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function stringArrayArg(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

import type { EntityAliasEntry, EntityLinkEntry, Memory } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText } from "../llm/types.ts";
import { trigramDiceSimilarity } from "./dedup.ts";
import type { Genome } from "./genome.ts";
import type { ProjectActivityRecord } from "./projects.ts";

export interface EntityOccurrence {
	uuid: string;
	type: EntityLinkEntry["type"];
	name: string;
	memory_ids: string[];
	count: number;
}

export interface EntityGcGroup {
	id: string;
	type: EntityLinkEntry["type"];
	canonical: EntityOccurrence;
	candidates: EntityOccurrence[];
	score: number;
}

export interface EntityGcDiscoveryOptions {
	fuzzyThreshold?: number;
	limit?: number;
}

export interface EntityGcDecision {
	action: "merge" | "reject";
	canonical?: {
		uuid: string;
		name: string;
	};
	aliases?: Array<{
		uuid: string;
		name: string;
	}>;
	reasoning: string;
}

export interface EntityGcReviewRequest {
	group: EntityGcGroup;
	prompt: string;
	client: Client;
	model: string;
	provider: string;
	maxTokens?: number;
}

export interface EntityGcApplyResult {
	updated_memory_ids: string[];
	archived_aliases: EntityAliasEntry[];
}

const DEFAULT_FUZZY_THRESHOLD = 0.78;
const ENTITY_GC_REJECT_PREFIX = "Entity GC rejected ";

export function discoverEntityGcGroups(
	memories: readonly Memory[],
	options: EntityGcDiscoveryOptions = {},
): EntityGcGroup[] {
	const occurrences = collectEntityOccurrences(memories);
	const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
	const groups: EntityGcGroup[] = [];
	const byType = new Map<EntityLinkEntry["type"], EntityOccurrence[]>();
	for (const occurrence of occurrences) {
		if (!byType.has(occurrence.type)) byType.set(occurrence.type, []);
		byType.get(occurrence.type)!.push(occurrence);
	}

	const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
	for (const [type, typedOccurrences] of byType) {
		const parent = new Map(
			typedOccurrences.map((entity) => [entityKey(entity), entityKey(entity)]),
		);
		const scoreByPair = new Map<string, number>();
		for (let leftIndex = 0; leftIndex < typedOccurrences.length; leftIndex++) {
			for (let rightIndex = leftIndex + 1; rightIndex < typedOccurrences.length; rightIndex++) {
				const left = typedOccurrences[leftIndex];
				const right = typedOccurrences[rightIndex];
				if (!left || !right) continue;
				const score = entitySimilarity(left.name, right.name);
				if (score >= fuzzyThreshold) {
					union(parent, entityKey(left), entityKey(right));
					scoreByPair.set(pairKey(entityKey(left), entityKey(right)), score);
				}
			}
		}

		const components = new Map<string, EntityOccurrence[]>();
		for (const occurrence of typedOccurrences) {
			const root = find(parent, entityKey(occurrence));
			if (!components.has(root)) components.set(root, []);
			components.get(root)!.push(occurrence);
		}

		for (const component of components.values()) {
			if (component.length < 2) continue;
			const canonical = chooseCanonical(component);
			const candidates = component.sort(
				(a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.uuid.localeCompare(b.uuid),
			);
			const id = `entity-gc-${type.toLowerCase()}-${slug(canonical.name)}`;
			if (hasRejectedEntityGcGroup(id, component, memoryById)) continue;
			groups.push({
				id,
				type,
				canonical,
				candidates,
				score: averagePairScore(component, scoreByPair),
			});
		}
	}

	return groups
		.sort(
			(a, b) =>
				b.score - a.score || b.candidates.length - a.candidates.length || a.id.localeCompare(b.id),
		)
		.slice(0, options.limit ?? groups.length);
}

export async function requestEntityGcDecision(
	request: EntityGcReviewRequest,
): Promise<EntityGcDecision> {
	const response = await request.client.complete({
		model: request.model,
		provider: request.provider,
		messages: [Msg.system(request.prompt), Msg.user(renderEntityGcReviewUserPrompt(request.group))],
		temperature: 0,
		max_tokens: request.maxTokens ?? 700,
	});
	return normalizeEntityGcDecisionPayload(request.group, messageText(response.message));
}

export function renderEntityGcReviewUserPrompt(group: EntityGcGroup): string {
	const candidates = group.candidates
		.map((entity) =>
			[
				`- uuid: ${entity.uuid}`,
				`  name: ${JSON.stringify(entity.name)}`,
				`  count: ${entity.count}`,
				`  memories: ${entity.memory_ids.join(", ")}`,
			].join("\n"),
		)
		.join("\n");
	return `Review these same-type entity names for alias consolidation. Merge only if the names refer to the same real project/library/file/command/error/technology/person.

Entity type: ${group.type}
Suggested canonical: ${group.canonical.uuid} (${JSON.stringify(group.canonical.name)})
Similarity score: ${group.score.toFixed(3)}

Candidates:
${candidates}

Return only JSON:
{"action":"merge","canonical":{"uuid":"${group.canonical.uuid}","name":${JSON.stringify(group.canonical.name)}},"aliases":[{"uuid":"alias_uuid","name":"Alias Name"}],"reasoning":"why these are aliases"}

or

{"action":"reject","reasoning":"why these should remain separate"}`;
}

export function normalizeEntityGcDecisionPayload(
	group: EntityGcGroup,
	text: string,
): EntityGcDecision {
	const parsed = parseJsonObject(text);
	const action = parsed.action;
	if (action !== "merge" && action !== "reject") {
		throw new Error("Entity GC decision must have action 'merge' or 'reject'");
	}
	const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";
	if (!reasoning) throw new Error("Entity GC decision missing reasoning");
	if (action === "reject") return { action, reasoning };

	const canonicalRecord = isRecord(parsed.canonical) ? parsed.canonical : {};
	const canonical = {
		uuid:
			typeof canonicalRecord.uuid === "string" && canonicalRecord.uuid.trim()
				? canonicalRecord.uuid.trim()
				: group.canonical.uuid,
		name:
			typeof canonicalRecord.name === "string" && canonicalRecord.name.trim()
				? canonicalRecord.name.trim()
				: group.canonical.name,
	};
	const candidateKeys = new Set(group.candidates.map((candidate) => candidate.uuid));
	const aliases = Array.isArray(parsed.aliases)
		? parsed.aliases
				.filter(isRecord)
				.map((alias) => ({
					uuid: typeof alias.uuid === "string" ? alias.uuid.trim() : "",
					name: typeof alias.name === "string" ? alias.name.trim() : "",
				}))
				.filter((alias) => alias.uuid && alias.name && candidateKeys.has(alias.uuid))
		: group.candidates
				.filter((candidate) => candidate.uuid !== canonical.uuid)
				.map((candidate) => ({ uuid: candidate.uuid, name: candidate.name }));
	if (aliases.length === 0) throw new Error("Entity GC merge decision has no aliases");
	return { action, canonical, aliases, reasoning };
}

export async function applyEntityGcDecision(
	genome: Genome,
	group: EntityGcGroup,
	decision: EntityGcDecision,
	options: { now?: number; source?: string } = {},
): Promise<EntityGcApplyResult> {
	if (decision.action === "reject") {
		return rejectEntityGcGroup(genome, group, decision.reasoning, options);
	}
	if (!decision.canonical || !decision.aliases?.length) {
		throw new Error("Entity GC merge decision missing canonical or aliases");
	}
	const now = options.now ?? Date.now();
	const aliasKeys = new Set(
		decision.aliases.map((alias) => entityKey({ ...alias, type: group.type })),
	);
	const updatedIds: string[] = [];
	const archivedAliases: EntityAliasEntry[] = [];

	for (const memory of genome.memories.all()) {
		if (memory.archived_at || !memory.entity_links?.length) continue;
		const aliasesInMemory = memory.entity_links.filter((entity) =>
			aliasKeys.has(entityKey(entity)),
		);
		if (aliasesInMemory.length === 0) continue;

		const canonicalLink = canonicalEntityLink(memory, group.type, decision.canonical);
		const aliasEntries = aliasesInMemory.map((entity) => ({
			uuid: entity.uuid,
			name: entity.name,
			archived_at: now,
			reason: decision.reasoning,
		}));
		canonicalLink.archived_aliases = mergeArchivedAliases(
			canonicalLink.archived_aliases ?? [],
			aliasEntries,
		);
		archivedAliases.push(...aliasEntries);

		const retained = memory.entity_links.filter(
			(entity) =>
				!aliasKeys.has(entityKey(entity)) &&
				entityKey(entity) !== entityKey({ ...decision.canonical!, type: group.type }),
		);
		memory.entity_links = [...retained, canonicalLink].sort(
			(a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
		);
		memory.updated_at = now;
		memory.annotations = [
			...(memory.annotations ?? []),
			{
				text: `Archived entity aliases into ${decision.canonical.name}: ${aliasEntries
					.map((alias) => alias.name)
					.join(", ")}`,
				created_at: now,
				source: options.source ?? "entity-gc",
			},
		];
		updatedIds.push(memory.id);
	}

	if (updatedIds.length > 0) {
		await genome.saveMemoryMutation(`genome: merge ${archivedAliases.length} entity aliases`);
	}
	return { updated_memory_ids: updatedIds, archived_aliases: archivedAliases };
}

async function rejectEntityGcGroup(
	genome: Genome,
	group: EntityGcGroup,
	reasoning: string,
	options: { now?: number; source?: string } = {},
): Promise<EntityGcApplyResult> {
	const now = options.now ?? Date.now();
	const candidateKeys = new Set(group.candidates.map(entityKey));
	const updatedIds: string[] = [];

	for (const memory of genome.memories.all()) {
		if (
			memory.archived_at ||
			!memory.entity_links?.some((entity) => candidateKeys.has(entityKey(entity)))
		) {
			continue;
		}
		const text = `${ENTITY_GC_REJECT_PREFIX}${group.id}: ${reasoning}`;
		if ((memory.annotations ?? []).some((annotation) => annotation.text === text)) continue;
		memory.annotations = [
			...(memory.annotations ?? []),
			{
				text,
				created_at: now,
				source: options.source ?? "entity-gc",
			},
		];
		memory.updated_at = now;
		updatedIds.push(memory.id);
	}

	if (updatedIds.length > 0) {
		await genome.saveMemoryMutation(`genome: reject entity GC group '${group.id}'`);
	}
	return { updated_memory_ids: updatedIds, archived_aliases: [] };
}

export function projectDueForEntityGc(
	project: ProjectActivityRecord,
	cadenceActiveDays = 30,
): boolean {
	const lastRun = project.last_entity_gc_active_day ?? 0;
	return project.cumulative_active_days - lastRun >= cadenceActiveDays;
}

function hasRejectedEntityGcGroup(
	groupId: string,
	occurrences: readonly EntityOccurrence[],
	memoryById: ReadonlyMap<string, Memory>,
): boolean {
	const marker = `${ENTITY_GC_REJECT_PREFIX}${groupId}:`;
	for (const occurrence of occurrences) {
		for (const memoryId of occurrence.memory_ids) {
			const memory = memoryById.get(memoryId);
			if (memory?.annotations?.some((annotation) => annotation.text.startsWith(marker))) {
				return true;
			}
		}
	}
	return false;
}

function collectEntityOccurrences(memories: readonly Memory[]): EntityOccurrence[] {
	const byKey = new Map<string, EntityOccurrence>();
	for (const memory of memories) {
		if (memory.archived_at) continue;
		for (const entity of memory.entity_links ?? []) {
			const key = entityKey(entity);
			const occurrence = byKey.get(key) ?? {
				uuid: entity.uuid,
				type: entity.type,
				name: entity.name,
				memory_ids: [],
				count: 0,
			};
			if (!occurrence.memory_ids.includes(memory.id)) occurrence.memory_ids.push(memory.id);
			occurrence.count++;
			byKey.set(key, occurrence);
		}
	}
	return [...byKey.values()];
}

function canonicalEntityLink(
	memory: Memory,
	type: EntityLinkEntry["type"],
	canonical: { uuid: string; name: string },
): EntityLinkEntry {
	const existing = (memory.entity_links ?? []).find(
		(entity) => entity.type === type && entity.uuid === canonical.uuid,
	);
	return {
		uuid: canonical.uuid,
		type,
		name: canonical.name,
		archived_aliases: existing?.archived_aliases ? [...existing.archived_aliases] : [],
	};
}

function mergeArchivedAliases(
	existing: readonly EntityAliasEntry[],
	incoming: readonly EntityAliasEntry[],
): EntityAliasEntry[] {
	const byKey = new Map(existing.map((alias) => [alias.uuid, alias]));
	for (const alias of incoming) {
		byKey.set(alias.uuid, alias);
	}
	return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function chooseCanonical(entities: readonly EntityOccurrence[]): EntityOccurrence {
	return [...entities].sort(
		(a, b) => b.count - a.count || a.name.length - b.name.length || a.name.localeCompare(b.name),
	)[0]!;
}

function averagePairScore(
	entities: readonly EntityOccurrence[],
	scoreByPair: Map<string, number>,
): number {
	let total = 0;
	let count = 0;
	for (let leftIndex = 0; leftIndex < entities.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex++) {
			const left = entities[leftIndex];
			const right = entities[rightIndex];
			if (!left || !right) continue;
			const score = scoreByPair.get(pairKey(entityKey(left), entityKey(right)));
			if (score === undefined) continue;
			total += score;
			count++;
		}
	}
	return count > 0 ? total / count : 0;
}

function entitySimilarity(left: string, right: string): number {
	const normalizedLeft = normalizeName(left);
	const normalizedRight = normalizeName(right);
	if (normalizedLeft === normalizedRight) return 1;
	const leftTokens = new Set(normalizedLeft.split(" ").filter(Boolean));
	const rightTokens = new Set(normalizedRight.split(" ").filter(Boolean));
	const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
	const tokenScore = overlap / Math.max(leftTokens.size, rightTokens.size, 1);
	return Math.max(tokenScore, trigramDiceSimilarity(normalizedLeft, normalizedRight));
}

function normalizeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function entityKey(entity: Pick<EntityLinkEntry, "type" | "uuid">): string {
	return `${entity.type}:${entity.uuid}`.toLowerCase();
}

function pairKey(left: string, right: string): string {
	return [left, right].sort().join("\0");
}

function union(parent: Map<string, string>, left: string, right: string): void {
	parent.set(find(parent, right), find(parent, left));
}

function find(parent: Map<string, string>, id: string): string {
	const current = parent.get(id);
	if (!current) throw new Error(`Unknown entity id '${id}'`);
	if (current === id) return current;
	const root = find(parent, current);
	parent.set(id, root);
	return root;
}

function parseJsonObject(text: string): Record<string, unknown> {
	const stripped = stripCodeFence(text.trim());
	const parsed = JSON.parse(repairJson(stripped));
	if (!isRecord(parsed)) throw new Error("Expected JSON object");
	return parsed;
}

function stripCodeFence(text: string): string {
	const match = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return match?.[1]?.trim() ?? text;
}

function repairJson(text: string): string {
	return text
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/,\s*([}\]])/g, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slug(value: string): string {
	return normalizeName(value).replace(/\s+/g, "-").slice(0, 64);
}

import type { EntityLinkEntry, Memory, RelationshipType } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText } from "../llm/types.ts";
import { ulid } from "../util/ulid.ts";
import { trigramDiceSimilarity } from "./dedup.ts";
import type { Genome } from "./genome.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";
import type { ProjectActivityRecord } from "./projects.ts";

export type ConsolidationClusterReason = "exact" | "fuzzy" | "vector" | "link";

export interface ConsolidationCluster {
	id: string;
	memory_ids: string[];
	memories: Memory[];
	reasons: ConsolidationClusterReason[];
	score: number;
	rejection_count: number;
	project_ids: string[];
}

export interface ConsolidationDiscoveryOptions {
	fuzzyThreshold?: number;
	vectorThreshold?: number;
	maxRejectionCount?: number;
	limit?: number;
}

export interface ConsolidationEntityDraft {
	name: string;
	type: EntityLinkEntry["type"];
	uuid?: string;
}

export interface ConsolidationMemoryDraft {
	text: string;
	tags?: string[];
	entities?: ConsolidationEntityDraft[];
	confidence?: number;
}

export interface ConsolidationDecision {
	action: "merge" | "reject";
	memory?: ConsolidationMemoryDraft;
	reasoning: string;
}

export interface MemoryConsolidationRequest {
	cluster: ConsolidationCluster;
	prompt: string;
	client: Client;
	model: string;
	provider: string;
	maxTokens?: number;
}

export interface ConsolidationMergeResult {
	consolidated: Memory;
	archived_ids: string[];
}

const DEFAULT_FUZZY_THRESHOLD = 0.82;
const DEFAULT_VECTOR_THRESHOLD = 0.9;
const DEFAULT_MAX_REJECTIONS = 2;
const CONSOLIDATION_LINK_TYPES = new Set<RelationshipType>([
	"corroborates",
	"supersedes",
	"refines",
	"exemplifies",
]);

export function discoverConsolidationClusters(
	memories: readonly Memory[],
	options: ConsolidationDiscoveryOptions = {},
): ConsolidationCluster[] {
	const active = memories.filter(isActiveMemoryForRecall);
	const parent = new Map(active.map((memory) => [memory.id, memory.id]));
	const edges = new Map<string, { reasons: Set<ConsolidationClusterReason>; score: number }>();
	const byId = new Map(active.map((memory) => [memory.id, memory]));
	const fuzzyThreshold = options.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
	const vectorThreshold = options.vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD;

	for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
			const left = active[leftIndex];
			const right = active[rightIndex];
			if (!left || !right) continue;

			const exact = normalizeContent(left.content) === normalizeContent(right.content);
			if (exact) addEdge(parent, edges, left.id, right.id, "exact", 1);

			const fuzzyScore = trigramDiceSimilarity(left.content, right.content);
			if (fuzzyScore >= fuzzyThreshold) {
				addEdge(parent, edges, left.id, right.id, "fuzzy", fuzzyScore);
			}

			const vectorScore = vectorSimilarity(left, right);
			if (vectorScore !== undefined && vectorScore >= vectorThreshold) {
				addEdge(parent, edges, left.id, right.id, "vector", vectorScore);
			}
		}
	}

	for (const memory of active) {
		for (const link of memory.outbound_links ?? []) {
			if (!CONSOLIDATION_LINK_TYPES.has(link.type)) continue;
			if (!byId.has(link.uuid)) continue;
			addEdge(parent, edges, memory.id, link.uuid, "link", 0.86);
		}
	}

	const components = new Map<string, Memory[]>();
	for (const memory of active) {
		const root = find(parent, memory.id);
		if (!components.has(root)) components.set(root, []);
		components.get(root)!.push(memory);
	}

	const clusters: ConsolidationCluster[] = [];
	for (const component of components.values()) {
		if (component.length < 2) continue;
		component.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
		const maxRejections = Math.max(
			...component.map((memory) => memory.consolidation_rejection_count ?? 0),
		);
		if (maxRejections >= (options.maxRejectionCount ?? DEFAULT_MAX_REJECTIONS)) continue;

		const componentEdges = componentEdgeRecords(component, edges);
		const reasons = new Set<ConsolidationClusterReason>();
		let score = 0;
		for (const edge of componentEdges) {
			score += edge.score;
			for (const reason of edge.reasons) reasons.add(reason);
		}
		clusters.push({
			id: `cluster-${component.map((memory) => memory.id).join("-")}`,
			memory_ids: component.map((memory) => memory.id),
			memories: component,
			reasons: [...reasons].sort(),
			score: componentEdges.length > 0 ? score / componentEdges.length : 0,
			rejection_count: component.reduce(
				(sum, memory) => sum + (memory.consolidation_rejection_count ?? 0),
				0,
			),
			project_ids: unionStrings(component.flatMap((memory) => memory.project_ids ?? [])),
		});
	}

	return clusters
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.memory_ids.length - a.memory_ids.length ||
				a.memory_ids[0]!.localeCompare(b.memory_ids[0]!),
		)
		.slice(0, options.limit ?? clusters.length);
}

export function estimateDuplicateRate(memories: readonly Memory[], fuzzyThreshold = 0.86): number {
	const active = memories.filter(isActiveMemoryForRecall);
	if (active.length === 0) return 0;
	const duplicateIds = new Set<string>();
	for (let leftIndex = 0; leftIndex < active.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex++) {
			const left = active[leftIndex];
			const right = active[rightIndex];
			if (!left || !right) continue;
			if (isDuplicatePair(left, right, fuzzyThreshold)) {
				duplicateIds.add(right.id);
			}
		}
	}
	return duplicateIds.size / active.length;
}

export function estimateDuplicateRateAfterConsolidation(
	memories: readonly Memory[],
	clusters: readonly ConsolidationCluster[],
	fuzzyThreshold = 0.86,
): number {
	const removedIds = new Set<string>();
	for (const cluster of clusters) {
		for (const id of cluster.memory_ids.slice(1)) {
			removedIds.add(id);
		}
	}
	const survivors = memories.filter((memory) => !removedIds.has(memory.id));
	return estimateDuplicateRate(survivors, fuzzyThreshold);
}

export async function requestConsolidationDecision(
	request: MemoryConsolidationRequest,
): Promise<ConsolidationDecision> {
	const response = await request.client.complete({
		model: request.model,
		provider: request.provider,
		messages: [
			Msg.system(request.prompt),
			Msg.user(renderMemoryConsolidationUserPrompt(request.cluster)),
		],
		temperature: 0,
		max_tokens: request.maxTokens ?? 900,
	});
	return normalizeConsolidationDecisionPayload(messageText(response.message));
}

export function renderMemoryConsolidationUserPrompt(cluster: ConsolidationCluster): string {
	const memories = cluster.memories
		.map((memory, index) =>
			[
				`MEMORY ${index + 1}`,
				`id: ${memory.id}`,
				`created: ${new Date(memory.created).toISOString()}`,
				`confidence: ${memory.confidence}`,
				`tags: ${memory.tags.join(", ")}`,
				`projects: ${(memory.project_ids ?? []).join(", ")}`,
				`text: ${JSON.stringify(memory.content)}`,
			].join("\n"),
		)
		.join("\n\n");
	return `Review this duplicate/supersession memory cluster. Merge only if one consolidated memory would preserve all durable facts without losing nuance. Reject if the memories should remain separate.

Cluster reasons: ${cluster.reasons.join(", ")}
Average score: ${cluster.score.toFixed(3)}
Prior rejection count: ${cluster.rejection_count}

${memories}

Return only JSON:
{"action":"merge","memory":{"text":"single consolidated durable memory","tags":["tag"],"entities":[{"name":"Sprout","type":"PROJECT"}],"confidence":0.9},"reasoning":"why this merge is safe"}

or

{"action":"reject","reasoning":"why these memories should remain separate"}`;
}

export function normalizeConsolidationDecisionPayload(text: string): ConsolidationDecision {
	const parsed = parseJsonObject(text);
	const action = parsed.action;
	if (action !== "merge" && action !== "reject") {
		throw new Error("Consolidation decision must have action 'merge' or 'reject'");
	}
	const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";
	if (!reasoning) throw new Error("Consolidation decision missing reasoning");
	if (action === "reject") return { action, reasoning };

	if (!isRecord(parsed.memory)) {
		throw new Error("Merge consolidation decision missing memory object");
	}
	const textValue = typeof parsed.memory.text === "string" ? parsed.memory.text.trim() : "";
	if (!textValue) throw new Error("Merge consolidation decision missing memory.text");
	const tags = Array.isArray(parsed.memory.tags)
		? parsed.memory.tags.filter((tag): tag is string => typeof tag === "string")
		: [];
	const entities = Array.isArray(parsed.memory.entities)
		? parsed.memory.entities
				.filter(isRecord)
				.map((entity) => ({
					name: String(entity.name ?? "").trim(),
					type: entity.type as EntityLinkEntry["type"],
					...(typeof entity.uuid === "string" ? { uuid: entity.uuid } : {}),
				}))
				.filter((entity) => entity.name && isEntityType(entity.type))
		: [];
	const confidence =
		typeof parsed.memory.confidence === "number" && Number.isFinite(parsed.memory.confidence)
			? Math.max(0, Math.min(1, parsed.memory.confidence))
			: undefined;
	return {
		action,
		reasoning,
		memory: {
			text: textValue,
			tags,
			...(entities.length > 0 ? { entities } : {}),
			...(confidence !== undefined ? { confidence } : {}),
		},
	};
}

export async function applyConsolidationMerge(
	genome: Genome,
	cluster: Pick<ConsolidationCluster, "memory_ids">,
	draft: ConsolidationMemoryDraft,
	options: { now?: number; source?: string; id?: string; reasoning?: string } = {},
): Promise<ConsolidationMergeResult> {
	const now = options.now ?? Date.now();
	const sources = cluster.memory_ids.map((id) => {
		const memory = genome.memories.getById(id);
		if (!memory) throw new Error(`Cannot consolidate missing memory '${id}'`);
		if (memory.archived_at) throw new Error(`Cannot consolidate archived memory '${id}'`);
		return memory;
	});
	if (sources.length < 2) throw new Error("Consolidation merge requires at least two memories");

	const consolidatedId = options.id ?? `memory-consolidated-${ulid().toLowerCase()}`;
	const reasoning = options.reasoning ?? "memory consolidation";
	const consolidated: Memory = {
		id: consolidatedId,
		content: draft.text,
		tags: unionStrings([...(draft.tags ?? []), ...sources.flatMap((memory) => memory.tags)]),
		source: options.source ?? "memory-consolidation",
		created: now,
		last_used: Math.max(...sources.map((memory) => memory.last_used ?? memory.created)),
		use_count: sources.reduce((sum, memory) => sum + (memory.use_count ?? 0), 0),
		confidence:
			draft.confidence ??
			Math.max(...sources.map((memory) => memory.effective_importance ?? memory.confidence)),
		created_at: now,
		updated_at: now,
		consolidates_memory_ids: sources.map((memory) => memory.id),
		project_ids: unionStrings(sources.flatMap((memory) => memory.project_ids ?? [])),
		entity_links: draft.entities
			? draft.entities.map((entity) => ({
					uuid: entity.uuid ?? entityUuid(entity.type, entity.name),
					type: entity.type,
					name: entity.name,
				}))
			: unionEntities(sources.flatMap((memory) => memory.entity_links ?? [])),
		outbound_links: sources.map((memory) => ({
			uuid: memory.id,
			type: "supersedes" as const,
			reasoning,
			created_at: now,
		})),
		annotations: [
			{
				text: reasoning,
				created_at: now,
				source: options.source ?? "memory-consolidation",
				archived_source_ids: sources.map((memory) => memory.id),
				source_segment_ids: unionStrings(
					sources.flatMap((memory) => (memory.source_segment_id ? [memory.source_segment_id] : [])),
				),
			},
		],
	};

	const saved = await genome.stageMemoryForMutation(consolidated);

	for (const memory of sources) {
		memory.archived_at = now;
		memory.archived_reason = `consolidated into ${consolidatedId}`;
		memory.superseded_by = consolidatedId;
		memory.updated_at = now;
		memory.inbound_links = [
			...(memory.inbound_links ?? []),
			{ uuid: consolidatedId, type: "supersedes", reasoning, created_at: now },
		];
	}
	await genome.saveMemoryMutation(
		`genome: consolidate ${sources.length} memories into '${consolidatedId}'`,
	);

	return { consolidated: saved, archived_ids: sources.map((memory) => memory.id) };
}

export async function rejectConsolidationCluster(
	genome: Genome,
	cluster: Pick<ConsolidationCluster, "id" | "memory_ids">,
	reason: string,
	options: { now?: number; source?: string } = {},
): Promise<string[]> {
	const now = options.now ?? Date.now();
	const updated: string[] = [];
	const markerText = `Rejected consolidation cluster ${cluster.id}: ${reason}`;
	for (const id of cluster.memory_ids) {
		const memory = genome.memories.getById(id);
		if (!memory || memory.archived_at) continue;
		if ((memory.annotations ?? []).some((annotation) => annotation.text === markerText)) {
			continue;
		}
		memory.consolidation_rejection_count = (memory.consolidation_rejection_count ?? 0) + 1;
		memory.updated_at = now;
		memory.annotations = [
			...(memory.annotations ?? []),
			{
				text: markerText,
				created_at: now,
				source: options.source ?? "memory-consolidation",
			},
		];
		updated.push(id);
	}
	if (updated.length > 0) {
		await genome.saveMemoryMutation(`genome: reject memory consolidation cluster '${cluster.id}'`);
	}
	return updated;
}

export function projectDueForConsolidation(
	project: ProjectActivityRecord,
	cadenceActiveDays = 14,
): boolean {
	const lastRun = project.last_consolidated_active_day ?? 0;
	return project.cumulative_active_days - lastRun >= cadenceActiveDays;
}

function addEdge(
	parent: Map<string, string>,
	edges: Map<string, { reasons: Set<ConsolidationClusterReason>; score: number }>,
	leftId: string,
	rightId: string,
	reason: ConsolidationClusterReason,
	score: number,
): void {
	union(parent, leftId, rightId);
	const key = pairKey(leftId, rightId);
	const existing = edges.get(key);
	if (existing) {
		existing.reasons.add(reason);
		existing.score = Math.max(existing.score, score);
		return;
	}
	edges.set(key, { reasons: new Set([reason]), score });
}

function componentEdgeRecords(
	memories: readonly Memory[],
	edges: Map<string, { reasons: Set<ConsolidationClusterReason>; score: number }>,
): Array<{ reasons: Set<ConsolidationClusterReason>; score: number }> {
	const records: Array<{ reasons: Set<ConsolidationClusterReason>; score: number }> = [];
	for (let leftIndex = 0; leftIndex < memories.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < memories.length; rightIndex++) {
			const left = memories[leftIndex];
			const right = memories[rightIndex];
			if (!left || !right) continue;
			const record = edges.get(pairKey(left.id, right.id));
			if (record) records.push(record);
		}
	}
	return records;
}

function isDuplicatePair(left: Memory, right: Memory, fuzzyThreshold: number): boolean {
	if (normalizeContent(left.content) === normalizeContent(right.content)) return true;
	return trigramDiceSimilarity(left.content, right.content) >= fuzzyThreshold;
}

function vectorSimilarity(left: Memory, right: Memory): number | undefined {
	const leftVector = left.embedding?.status === "ready" ? left.embedding.vector : undefined;
	const rightVector = right.embedding?.status === "ready" ? right.embedding.vector : undefined;
	if (!leftVector || !rightVector) return undefined;
	if (leftVector.length !== rightVector.length) {
		throw new Error(`Memory embedding dimensions differ: ${left.id} vs ${right.id}`);
	}
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < leftVector.length; index++) {
		const a = leftVector[index] ?? 0;
		const b = rightVector[index] ?? 0;
		dot += a * b;
		leftMagnitude += a * a;
		rightMagnitude += b * b;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function union(parent: Map<string, string>, leftId: string, rightId: string): void {
	parent.set(find(parent, rightId), find(parent, leftId));
}

function find(parent: Map<string, string>, id: string): string {
	const current = parent.get(id);
	if (!current) throw new Error(`Unknown memory id '${id}'`);
	if (current === id) return current;
	const root = find(parent, current);
	parent.set(id, root);
	return root;
}

function pairKey(leftId: string, rightId: string): string {
	return [leftId, rightId].sort().join("\0");
}

function normalizeContent(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
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

function isEntityType(value: unknown): value is EntityLinkEntry["type"] {
	return (
		value === "PROJECT" ||
		value === "LIBRARY" ||
		value === "FILE_PATH" ||
		value === "COMMAND" ||
		value === "ERROR_TYPE" ||
		value === "TECHNOLOGY" ||
		value === "PERSON"
	);
}

function entityUuid(type: EntityLinkEntry["type"], name: string): string {
	return `entity_${type.toLowerCase()}_${name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/(^_|_$)/g, "")}`;
}

function unionStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))].sort();
}

function unionEntities(entities: readonly EntityLinkEntry[]): EntityLinkEntry[] {
	const byKey = new Map<string, EntityLinkEntry>();
	for (const entity of entities) {
		byKey.set(`${entity.type}:${entity.uuid}`.toLowerCase(), entity);
	}
	return [...byKey.values()].sort(
		(a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
	);
}

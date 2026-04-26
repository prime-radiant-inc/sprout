import type { Memory, MemoryLinkEntry, RelationshipType } from "../kernel/types.ts";
import type { Genome } from "./genome.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";

export type LinkCandidateAxis = "vector" | "entity" | "tfidf";

export interface LinkCandidate {
	source_id: string;
	target_id: string;
	axes: LinkCandidateAxis[];
	score: number;
	extraction_bond?: string;
}

export interface ClassifiedMemoryRelationship {
	source_id: string;
	target_id: string;
	relationship_type: RelationshipType;
	reasoning: string;
	extraction_bond?: string;
}

export interface LinkDiscoveryOptions {
	minVectorSimilarity?: number;
	minEntityScore?: number;
	minTfIdfSimilarity?: number;
	limit?: number;
}

export interface LinkTraversalResult {
	memory: Memory;
	distance: number;
	via: string;
	type: RelationshipType;
	score: number;
}

const DEFAULT_MIN_VECTOR_SIMILARITY = 0.72;
const DEFAULT_MIN_ENTITY_SCORE = 0.34;
const DEFAULT_MIN_TFIDF_SIMILARITY = 0.18;
const DEFAULT_LIMIT = 50;

const RELATIONSHIP_WEIGHTS: Record<RelationshipType, number> = {
	conflicts: 1.1,
	supersedes: 1,
	refines: 0.9,
	corroborates: 0.8,
	contextualizes: 0.75,
	exemplifies: 0.7,
	precedes: 0.65,
	extraction_ref: 0.5,
	null: 0,
};

export function discoverLinkCandidates(
	memories: readonly Memory[],
	options: LinkDiscoveryOptions = {},
): LinkCandidate[] {
	const active = memories.filter(isActiveMemoryForRecall);
	const candidates = new Map<string, LinkCandidate>();
	const minVectorSimilarity = options.minVectorSimilarity ?? DEFAULT_MIN_VECTOR_SIMILARITY;
	const minEntityScore = options.minEntityScore ?? DEFAULT_MIN_ENTITY_SCORE;
	const minTfIdfSimilarity = options.minTfIdfSimilarity ?? DEFAULT_MIN_TFIDF_SIMILARITY;

	forEachMemoryPair(active, (left, right) => {
		const vectorScore = vectorSimilarity(left, right);
		if (vectorScore !== undefined && vectorScore >= minVectorSimilarity) {
			addCandidate(candidates, left, right, "vector", vectorScore);
		}

		const entityScore = entityOverlapScore(left, right);
		if (entityScore >= minEntityScore) {
			addCandidate(candidates, left, right, "entity", entityScore);
		}
	});

	for (const { left, right, score } of tfidfPairs(active)) {
		if (score >= minTfIdfSimilarity) {
			addCandidate(candidates, left, right, "tfidf", score);
		}
	}

	return [...candidates.values()]
		.sort((a, b) => b.score - a.score || a.source_id.localeCompare(b.source_id))
		.slice(0, options.limit ?? DEFAULT_LIMIT);
}

export async function persistMemoryLinks(
	genome: Genome,
	relationships: readonly ClassifiedMemoryRelationship[],
	options: { source?: string; now?: number } = {},
): Promise<number> {
	const memories = genome.memories.all();
	const byId = new Map(memories.map((memory) => [memory.id, memory]));
	const now = options.now ?? Date.now();
	let added = 0;
	let changed = false;

	for (const relationship of relationships) {
		if (relationship.relationship_type === "null") continue;
		const source = byId.get(relationship.source_id);
		const target = byId.get(relationship.target_id);
		if (!source || !target) {
			throw new Error(
				`Cannot link missing memories: ${relationship.source_id} -> ${relationship.target_id}`,
			);
		}
		const outbound: MemoryLinkEntry = {
			uuid: target.id,
			type: relationship.relationship_type,
			reasoning: relationship.reasoning,
			created_at: now,
			...(relationship.extraction_bond ? { extraction_bond: relationship.extraction_bond } : {}),
		};
		if (!hasLink(source.outbound_links, outbound.uuid, outbound.type)) {
			source.outbound_links = [...(source.outbound_links ?? []), outbound];
			added++;
			changed = true;
		}

		const inbound: MemoryLinkEntry = { ...outbound, uuid: source.id };
		if (!hasLink(target.inbound_links, inbound.uuid, inbound.type)) {
			target.inbound_links = [...(target.inbound_links ?? []), inbound];
			changed = true;
		}
		if (relationship.relationship_type === "supersedes" && target.superseded_by !== source.id) {
			target.superseded_by = source.id;
			changed = true;
		}
	}

	if (changed) {
		await genome.saveMemoryMutation(
			added > 0
				? `genome: link ${added} memory relationship${added === 1 ? "" : "s"}`
				: "genome: repair memory link metadata",
		);
	}
	return added;
}

export async function healMemoryLinks(genome: Genome): Promise<number> {
	const memories = genome.memories.all();
	const validIds = new Set(memories.map((memory) => memory.id));
	let removed = 0;

	for (const memory of memories) {
		const outbound = memory.outbound_links ?? [];
		const inbound = memory.inbound_links ?? [];
		const healedOutbound = outbound.filter((link) => validIds.has(link.uuid));
		const healedInbound = inbound.filter((link) => validIds.has(link.uuid));
		removed += outbound.length - healedOutbound.length;
		removed += inbound.length - healedInbound.length;
		if (healedOutbound.length !== outbound.length) memory.outbound_links = healedOutbound;
		if (healedInbound.length !== inbound.length) memory.inbound_links = healedInbound;
		if (memory.superseded_by && !validIds.has(memory.superseded_by)) {
			memory.superseded_by = undefined;
			removed++;
		}
	}

	if (removed > 0) {
		await genome.saveMemoryMutation(`genome: heal ${removed} dead memory link refs`);
	}
	return removed;
}

export function traverseMemoryLinks(
	memories: readonly Memory[],
	startId: string,
	options: { depth?: number; limit?: number } = {},
): LinkTraversalResult[] {
	const byId = new Map(
		memories.filter(isActiveMemoryForRecall).map((memory) => [memory.id, memory]),
	);
	const start = byId.get(startId);
	if (!start) return [];

	const maxDepth = options.depth ?? 2;
	const visited = new Set([start.id]);
	const queue: Array<{ memory: Memory; distance: number; via: string; type: RelationshipType }> = [
		{ memory: start, distance: 0, via: start.id, type: "null" },
	];
	const results: LinkTraversalResult[] = [];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.distance >= maxDepth) continue;

		for (const link of allLinks(current.memory)) {
			const linked = byId.get(link.uuid);
			if (!linked || visited.has(linked.id)) continue;
			visited.add(linked.id);
			const distance = current.distance + 1;
			const result = {
				memory: linked,
				distance,
				via: current.memory.id,
				type: link.type,
				score: traversalScore(link.type, linked, distance),
			};
			results.push(result);
			queue.push({ memory: linked, distance, via: current.memory.id, type: link.type });
		}
	}

	return results
		.sort(
			(a, b) =>
				b.score - a.score || a.distance - b.distance || a.memory.id.localeCompare(b.memory.id),
		)
		.slice(0, options.limit ?? DEFAULT_LIMIT);
}

function forEachMemoryPair(
	memories: readonly Memory[],
	callback: (left: Memory, right: Memory) => void,
): void {
	for (let leftIndex = 0; leftIndex < memories.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < memories.length; rightIndex++) {
			const left = memories[leftIndex];
			const right = memories[rightIndex];
			if (left && right) callback(left, right);
		}
	}
}

function addCandidate(
	candidates: Map<string, LinkCandidate>,
	left: Memory,
	right: Memory,
	axis: LinkCandidateAxis,
	score: number,
): void {
	const [source, target] = orderPair(left, right);
	const key = pairKey(source.id, target.id);
	const existing = candidates.get(key);
	if (existing) {
		if (!existing.axes.includes(axis)) existing.axes.push(axis);
		existing.score = Math.min(existing.score + score, 3);
		return;
	}
	candidates.set(key, {
		source_id: source.id,
		target_id: target.id,
		axes: [axis],
		score,
		extraction_bond: sharedBond(source, target),
	});
}

function orderPair(left: Memory, right: Memory): [Memory, Memory] {
	if (left.created !== right.created)
		return left.created > right.created ? [left, right] : [right, left];
	return left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left];
}

function pairKey(leftId: string, rightId: string): string {
	return [leftId, rightId].sort().join("\0");
}

function vectorSimilarity(left: Memory, right: Memory): number | undefined {
	const leftVector = memoryVector(left);
	const rightVector = memoryVector(right);
	if (!leftVector || !rightVector) return undefined;
	if (leftVector.length !== rightVector.length) {
		throw new Error(`Memory embedding dimensions differ: ${left.id} vs ${right.id}`);
	}
	return cosineSimilarity(leftVector, rightVector);
}

function memoryVector(memory: Memory): number[] | undefined {
	if (!memory.embedding) return undefined;
	if (memory.embedding.status !== "ready") return undefined;
	if (!memory.embedding.vector || memory.embedding.vector.length === 0) {
		throw new Error(`Memory '${memory.id}' has ready embedding metadata without a vector`);
	}
	return memory.embedding.vector;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const a = left[index] ?? 0;
		const b = right[index] ?? 0;
		dot += a * b;
		leftMagnitude += a * a;
		rightMagnitude += b * b;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function entityOverlapScore(left: Memory, right: Memory): number {
	const leftEntities = entityKeys(left);
	const rightEntities = entityKeys(right);
	if (leftEntities.size === 0 || rightEntities.size === 0) return 0;
	const shared = [...leftEntities].filter((entity) => rightEntities.has(entity)).length;
	return shared / Math.max(leftEntities.size, rightEntities.size);
}

function entityKeys(memory: Memory): Set<string> {
	return new Set(
		(memory.entity_links ?? []).map((entity) =>
			`${entity.type}:${entity.uuid}:${entity.name}`.toLowerCase(),
		),
	);
}

function tfidfPairs(
	memories: readonly Memory[],
): Array<{ left: Memory; right: Memory; score: number }> {
	const tokenSets = new Map(memories.map((memory) => [memory.id, tokens(memory)]));
	const documentFrequency = new Map<string, number>();
	for (const tokenSet of tokenSets.values()) {
		for (const token of tokenSet) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}

	const vectors = new Map<string, Map<string, number>>();
	for (const memory of memories) {
		const counts = termCounts(tokenSets.get(memory.id) ?? []);
		const vector = new Map<string, number>();
		for (const [token, count] of counts) {
			const df = documentFrequency.get(token) ?? 1;
			vector.set(token, count * Math.log((memories.length + 1) / df));
		}
		vectors.set(memory.id, vector);
	}

	const pairs: Array<{ left: Memory; right: Memory; score: number }> = [];
	forEachMemoryPair(memories, (left, right) => {
		pairs.push({
			left,
			right,
			score: sparseCosine(vectors.get(left.id) ?? new Map(), vectors.get(right.id) ?? new Map()),
		});
	});
	return pairs;
}

function tokens(memory: Memory): string[] {
	return `${memory.content} ${memory.tags.join(" ")}`
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function termCounts(tokens: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) {
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return counts;
}

function sparseCosine(left: Map<string, number>, right: Map<string, number>): number {
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (const value of left.values()) {
		leftMagnitude += value * value;
	}
	for (const [token, value] of right) {
		rightMagnitude += value * value;
		dot += (left.get(token) ?? 0) * value;
	}
	if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
	return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function sharedBond(left: Memory, right: Memory): string | undefined {
	const sharedEntities = [...entityKeys(left)].filter((entity) => entityKeys(right).has(entity));
	if (sharedEntities[0]) {
		return sharedEntities[0].split(":").at(-1)?.slice(0, 40);
	}
	const sharedTokens = tokens(left).filter((token) => tokens(right).includes(token));
	return sharedTokens.slice(0, 3).join(" ") || undefined;
}

function hasLink(
	links: readonly MemoryLinkEntry[] | undefined,
	uuid: string,
	type: RelationshipType,
): boolean {
	return (links ?? []).some((link) => link.uuid === uuid && link.type === type);
}

function allLinks(memory: Memory): MemoryLinkEntry[] {
	return [...(memory.outbound_links ?? []), ...(memory.inbound_links ?? [])].filter(
		(link) => link.type !== "null",
	);
}

function traversalScore(type: RelationshipType, memory: Memory, distance: number): number {
	const importance = memory.effective_importance ?? memory.importance_score ?? memory.confidence;
	return (RELATIONSHIP_WEIGHTS[type] ?? 0) * importance * (1 / distance);
}

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"that",
	"with",
	"from",
	"this",
	"when",
	"then",
	"into",
	"uses",
	"use",
	"user",
	"memory",
]);

import type { EntityLinkEntry, Memory } from "../kernel/types.ts";
import {
	applyConsolidationMerge,
	type ConsolidationCluster,
	type ConsolidationDecision,
	type ConsolidationMemoryDraft,
	discoverConsolidationClusters,
	projectDueForConsolidation,
	rejectConsolidationCluster,
} from "./consolidation.ts";
import {
	applyEntityGcDecision,
	discoverEntityGcGroups,
	type EntityGcDecision,
	type EntityGcGroup,
	projectDueForEntityGc,
} from "./entity-gc.ts";
import type { Genome } from "./genome.ts";

export interface MemoryMaintenanceOptions {
	includeConsolidation?: boolean;
	includeEntityGc?: boolean;
	limit?: number;
}

export interface MemoryMaintenancePlan {
	consolidationClusters: ConsolidationCluster[];
	entityGcGroups: EntityGcGroup[];
}

export type MaintenanceConsolidationDecision = { cluster_id: string } & ConsolidationDecision;
export type MaintenanceEntityGcDecision = { group_id: string } & EntityGcDecision;

export interface MemoryMaintenanceDecisionFile {
	consolidations?: MaintenanceConsolidationDecision[];
	entity_gc?: MaintenanceEntityGcDecision[];
}

export interface MemoryMaintenanceApplyResult {
	consolidation: {
		merged: number;
		rejected: number;
		archived_memory_ids: string[];
	};
	entity_gc: {
		merged: number;
		rejected: number;
		updated_memory_ids: string[];
		archived_alias_count: number;
	};
}

export function discoverMemoryMaintenancePlan(
	genome: Genome,
	options: MemoryMaintenanceOptions = {},
): MemoryMaintenancePlan {
	const includeConsolidation = options.includeConsolidation ?? true;
	const includeEntityGc = options.includeEntityGc ?? true;
	const memories = genome.memories.all();
	const projects = genome.projects.all();
	const consolidationProjectIds = new Set(
		projects.filter((project) => projectDueForConsolidation(project)).map((project) => project.id),
	);
	const entityGcProjectIds = new Set(
		projects.filter((project) => projectDueForEntityGc(project)).map((project) => project.id),
	);
	return {
		consolidationClusters: includeConsolidation
			? discoverConsolidationClusters(filterMemoriesByProjects(memories, consolidationProjectIds), {
					limit: options.limit,
				})
			: [],
		entityGcGroups: includeEntityGc
			? discoverEntityGcGroups(filterMemoriesByProjects(memories, entityGcProjectIds), {
					limit: options.limit,
				})
			: [],
	};
}

export async function applyMemoryMaintenanceDecisions(
	genome: Genome,
	plan: MemoryMaintenancePlan,
	decisions: MemoryMaintenanceDecisionFile,
): Promise<MemoryMaintenanceApplyResult> {
	const clusterById = new Map(plan.consolidationClusters.map((cluster) => [cluster.id, cluster]));
	const groupById = new Map(plan.entityGcGroups.map((group) => [group.id, group]));
	const memoryById = new Map(genome.memories.all().map((memory) => [memory.id, memory]));
	const consolidatedProjectIds = new Set<string>();
	const entityGcProjectIds = new Set<string>();
	const result: MemoryMaintenanceApplyResult = {
		consolidation: { merged: 0, rejected: 0, archived_memory_ids: [] },
		entity_gc: { merged: 0, rejected: 0, updated_memory_ids: [], archived_alias_count: 0 },
	};

	for (const decision of decisions.consolidations ?? []) {
		const cluster = clusterById.get(decision.cluster_id);
		if (!cluster) throw new Error(`Unknown consolidation cluster '${decision.cluster_id}'`);
		for (const projectId of cluster.project_ids) consolidatedProjectIds.add(projectId);
		if (decision.action === "merge") {
			if (!decision.memory) {
				throw new Error(`Merge decision for '${decision.cluster_id}' is missing memory`);
			}
			const merge = await applyConsolidationMerge(genome, cluster, decision.memory, {
				reasoning: decision.reasoning,
				source: "memory-maintenance",
			});
			result.consolidation.merged++;
			result.consolidation.archived_memory_ids.push(...merge.archived_ids);
		} else {
			await rejectConsolidationCluster(genome, cluster, decision.reasoning, {
				source: "memory-maintenance",
			});
			result.consolidation.rejected++;
		}
	}

	for (const decision of decisions.entity_gc ?? []) {
		const group = groupById.get(decision.group_id);
		if (!group) throw new Error(`Unknown entity GC group '${decision.group_id}'`);
		for (const projectId of entityGcGroupProjectIds(group, memoryById)) {
			entityGcProjectIds.add(projectId);
		}
		const applied = await applyEntityGcDecision(genome, group, decision, {
			source: "memory-maintenance",
		});
		if (decision.action === "merge") {
			result.entity_gc.merged++;
			result.entity_gc.updated_memory_ids.push(...applied.updated_memory_ids);
			result.entity_gc.archived_alias_count += applied.archived_aliases.length;
		} else {
			result.entity_gc.rejected++;
		}
	}

	result.consolidation.archived_memory_ids = sortedUnique(result.consolidation.archived_memory_ids);
	result.entity_gc.updated_memory_ids = sortedUnique(result.entity_gc.updated_memory_ids);
	for (const projectId of consolidatedProjectIds) genome.projects.markConsolidated(projectId);
	for (const projectId of entityGcProjectIds) genome.projects.markEntityGc(projectId);
	if (consolidatedProjectIds.size > 0 || entityGcProjectIds.size > 0) {
		await genome.projects.save();
	}
	return result;
}

function filterMemoriesByProjects(
	memories: readonly Memory[],
	projectIds: ReadonlySet<string>,
): Memory[] {
	if (projectIds.size === 0) return [];
	return memories.filter((memory) => (memory.project_ids ?? []).some((id) => projectIds.has(id)));
}

function entityGcGroupProjectIds(
	group: EntityGcGroup,
	memoryById: ReadonlyMap<string, Memory>,
): string[] {
	return sortedUnique(
		group.candidates.flatMap((candidate) =>
			candidate.memory_ids.flatMap((memoryId) => memoryById.get(memoryId)?.project_ids ?? []),
		),
	);
}

export function parseMemoryMaintenanceDecisionFile(text: string): MemoryMaintenanceDecisionFile {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed)) throw new Error("Maintenance decision file must be a JSON object");
	return {
		...(parsed.consolidations !== undefined
			? { consolidations: parseConsolidationDecisions(parsed.consolidations) }
			: {}),
		...(parsed.entity_gc !== undefined
			? { entity_gc: parseEntityGcDecisions(parsed.entity_gc) }
			: {}),
	};
}

export function renderMemoryMaintenancePlan(plan: MemoryMaintenancePlan): string {
	const lines = [
		"Memory maintenance dry run",
		`Consolidation clusters: ${plan.consolidationClusters.length}`,
	];
	for (const cluster of plan.consolidationClusters) {
		lines.push(
			`  - ${cluster.id} score=${cluster.score.toFixed(3)} memories=${cluster.memory_ids.join(", ")}`,
		);
	}
	lines.push(`Entity GC groups: ${plan.entityGcGroups.length}`);
	for (const group of plan.entityGcGroups) {
		lines.push(
			`  - ${group.id} score=${group.score.toFixed(3)} canonical=${group.canonical.name} candidates=${group.candidates
				.map((candidate) => candidate.name)
				.join(", ")}`,
		);
	}
	return lines.join("\n");
}

function parseConsolidationDecisions(value: unknown): MaintenanceConsolidationDecision[] {
	if (!Array.isArray(value)) throw new Error("consolidations must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`consolidations[${index}] must be an object`);
		const clusterId = requiredString(item.cluster_id, `consolidations[${index}].cluster_id`);
		const reasoning = requiredString(item.reasoning, `consolidations[${index}].reasoning`);
		if (item.action === "reject") return { cluster_id: clusterId, action: "reject", reasoning };
		if (item.action !== "merge") {
			throw new Error(`consolidations[${index}].action must be 'merge' or 'reject'`);
		}
		return {
			cluster_id: clusterId,
			action: "merge",
			reasoning,
			memory: parseConsolidationMemoryDraft(item.memory, `consolidations[${index}].memory`),
		};
	});
}

function parseConsolidationMemoryDraft(value: unknown, path: string): ConsolidationMemoryDraft {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	const text = requiredString(value.text, `${path}.text`);
	const tags = optionalStringArray(value.tags, `${path}.tags`);
	const entities = value.entities === undefined ? undefined : parseEntities(value.entities, path);
	const confidence =
		value.confidence === undefined
			? undefined
			: finiteNumber(value.confidence, `${path}.confidence`);
	return {
		text,
		...(tags ? { tags } : {}),
		...(entities ? { entities } : {}),
		...(confidence !== undefined ? { confidence } : {}),
	};
}

function parseEntityGcDecisions(value: unknown): MaintenanceEntityGcDecision[] {
	if (!Array.isArray(value)) throw new Error("entity_gc must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`entity_gc[${index}] must be an object`);
		const groupId = requiredString(item.group_id, `entity_gc[${index}].group_id`);
		const reasoning = requiredString(item.reasoning, `entity_gc[${index}].reasoning`);
		if (item.action === "reject") return { group_id: groupId, action: "reject", reasoning };
		if (item.action !== "merge") {
			throw new Error(`entity_gc[${index}].action must be 'merge' or 'reject'`);
		}
		return {
			group_id: groupId,
			action: "merge",
			reasoning,
			canonical: parseEntityIdentity(item.canonical, `entity_gc[${index}].canonical`),
			aliases: parseEntityAliases(item.aliases, `entity_gc[${index}].aliases`),
		};
	});
}

function parseEntityIdentity(value: unknown, path: string): { uuid: string; name: string } {
	if (!isRecord(value)) throw new Error(`${path} must be an object`);
	return {
		uuid: requiredString(value.uuid, `${path}.uuid`),
		name: requiredString(value.name, `${path}.name`),
	};
}

function parseEntityAliases(value: unknown, path: string): Array<{ uuid: string; name: string }> {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	const aliases = value.map((item, index) => parseEntityIdentity(item, `${path}[${index}]`));
	if (aliases.length === 0) throw new Error(`${path} must contain at least one alias`);
	return aliases;
}

function parseEntities(
	value: unknown,
	path: string,
): Array<{ name: string; type: EntityLinkEntry["type"]; uuid?: string }> {
	if (!Array.isArray(value)) throw new Error(`${path}.entities must be an array`);
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`${path}.entities[${index}] must be an object`);
		const type = item.type;
		if (!isEntityType(type)) throw new Error(`${path}.entities[${index}].type is invalid`);
		return {
			name: requiredString(item.name, `${path}.entities[${index}].name`),
			type,
			...(item.uuid !== undefined
				? { uuid: requiredString(item.uuid, `${path}.entities[${index}].uuid`) }
				: {}),
		};
	});
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
	return value.map((item, index) => requiredString(item, `${path}[${index}]`));
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must be a finite number`);
	}
	return value;
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a string`);
	return value.trim();
}

function sortedUnique(values: string[]): string[] {
	return [...new Set(values)].sort();
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

import type { ResolverSettings } from "../agents/model-resolver.ts";
import type { EntityLinkEntry, Memory } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import type { ProviderModel } from "../llm/types.ts";
import {
	applyConsolidationMerge,
	type ConsolidationCluster,
	type ConsolidationDecision,
	type ConsolidationMemoryDraft,
	discoverConsolidationClusters,
	projectDueForConsolidation,
	rejectConsolidationCluster,
	requestConsolidationDecisionWithSettings,
} from "./consolidation.ts";
import {
	applyEntityGcDecision,
	discoverEntityGcGroups,
	type EntityGcDecision,
	type EntityGcGroup,
	projectDueForEntityGc,
	requestEntityGcDecisionWithSettings,
} from "./entity-gc.ts";
import type { Genome } from "./genome.ts";
import { isEntityType } from "./memory-schema.ts";
import { isProtectedManualMemory } from "./memory-write-policy.ts";
import type { ProjectActivityRecord } from "./projects.ts";

const GLOBAL_MAINTENANCE_PROJECT_ID = "__global__";
const GLOBAL_MAINTENANCE_PROJECT_NAME = "Global memories";

export interface MemoryMaintenanceOptions {
	includeConsolidation?: boolean;
	includeEntityGc?: boolean;
	limit?: number;
}

export interface MemoryMaintenancePlan {
	consolidationClusters: ConsolidationCluster[];
	entityGcGroups: EntityGcGroup[];
}

export type MaintenanceConsolidationDecision = {
	cluster_id: string;
	confirmed_memory_ids?: string[];
} & ConsolidationDecision;
export type MaintenanceEntityGcDecision = { group_id: string } & EntityGcDecision;

export interface MemoryMaintenanceDecisionFile {
	consolidations?: MaintenanceConsolidationDecision[];
	entity_gc?: MaintenanceEntityGcDecision[];
}

export interface MemoryMaintenanceReviewSettingsRequest {
	plan: MemoryMaintenancePlan;
	client: Client;
	resolverSettings: ResolverSettings;
	modelsByProvider: Map<string, ProviderModel[]>;
	consolidationPrompt: string;
	entityGcPrompt: string;
	consolidationMaxTokens?: number;
	entityGcMaxTokens?: number;
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

type ValidatedMaintenanceConsolidation =
	| {
			decision: MaintenanceConsolidationDecision & {
				action: "merge";
				memory: ConsolidationMemoryDraft;
			};
			cluster: ConsolidationCluster;
	  }
	| {
			decision: MaintenanceConsolidationDecision & { action: "reject" };
			cluster: ConsolidationCluster;
	  };

export function discoverMemoryMaintenancePlan(
	genome: Genome,
	options: MemoryMaintenanceOptions = {},
): MemoryMaintenancePlan {
	const includeConsolidation = options.includeConsolidation ?? true;
	const includeEntityGc = options.includeEntityGc ?? true;
	const memories = genome.memories.all();
	const projects = genome.projects.all();
	const globalProject = globalMaintenanceProject(projects);
	const consolidationProjectIds = new Set(
		projects.filter((project) => projectDueForConsolidation(project)).map((project) => project.id),
	);
	const entityGcProjectIds = new Set(
		projects.filter((project) => projectDueForEntityGc(project)).map((project) => project.id),
	);
	const unscopedMemories = memories.filter((memory) => (memory.project_ids ?? []).length === 0);
	const consolidationMemories = [
		...filterMemoriesByProjects(memories, consolidationProjectIds),
		...(globalProject && projectDueForConsolidation(globalProject) ? unscopedMemories : []),
	];
	const entityGcMemories = [
		...filterMemoriesByProjects(memories, entityGcProjectIds),
		...(globalProject && projectDueForEntityGc(globalProject) ? unscopedMemories : []),
	];
	return {
		consolidationClusters: includeConsolidation
			? discoverConsolidationClusters(consolidationMemories, { limit: options.limit })
			: [],
		entityGcGroups: includeEntityGc
			? discoverEntityGcGroups(entityGcMemories, { limit: options.limit })
			: [],
	};
}

export async function reviewMemoryMaintenancePlanWithSettings(
	request: MemoryMaintenanceReviewSettingsRequest,
): Promise<MemoryMaintenanceDecisionFile> {
	const consolidations: MaintenanceConsolidationDecision[] = [];
	for (const cluster of request.plan.consolidationClusters) {
		const decision = await requestConsolidationDecisionWithSettings({
			cluster,
			prompt: request.consolidationPrompt,
			client: request.client,
			resolverSettings: request.resolverSettings,
			modelsByProvider: request.modelsByProvider,
			maxTokens: request.consolidationMaxTokens,
		});
		consolidations.push({
			cluster_id: cluster.id,
			...decision,
		});
	}

	const entityGc: MaintenanceEntityGcDecision[] = [];
	for (const group of request.plan.entityGcGroups) {
		const decision = await requestEntityGcDecisionWithSettings({
			group,
			prompt: request.entityGcPrompt,
			client: request.client,
			resolverSettings: request.resolverSettings,
			modelsByProvider: request.modelsByProvider,
			maxTokens: request.entityGcMaxTokens,
		});
		entityGc.push({
			group_id: group.id,
			...decision,
		});
	}

	return {
		consolidations,
		entity_gc: entityGc,
	};
}

export async function applyMemoryMaintenanceDecisions(
	genome: Genome,
	plan: MemoryMaintenancePlan,
	decisions: MemoryMaintenanceDecisionFile,
): Promise<MemoryMaintenanceApplyResult> {
	return genome.applyMemoryAndProjectActivityMutation(
		"genome: apply memory maintenance decisions",
		async () => {
			const memoryById = new Map(genome.memories.all().map((memory) => [memory.id, memory]));
			const validated = validateMemoryMaintenanceDecisions(plan, decisions, memoryById);
			const consolidatedProjectIds = new Set<string>();
			const entityGcProjectIds = new Set<string>();
			const result: MemoryMaintenanceApplyResult = {
				consolidation: { merged: 0, rejected: 0, archived_memory_ids: [] },
				entity_gc: { merged: 0, rejected: 0, updated_memory_ids: [], archived_alias_count: 0 },
			};

			for (const { decision, cluster } of validated.consolidations) {
				for (const projectId of maintenanceProjectIds(cluster.project_ids)) {
					consolidatedProjectIds.add(projectId);
				}
				if (decision.action === "merge") {
					const merge = await applyConsolidationMerge(genome, cluster, decision.memory, {
						reasoning: decision.reasoning,
						source: "memory-maintenance",
						commit: false,
					});
					result.consolidation.merged++;
					result.consolidation.archived_memory_ids.push(...merge.archived_ids);
				} else {
					await rejectConsolidationCluster(genome, cluster, decision.reasoning, {
						source: "memory-maintenance",
						commit: false,
					});
					result.consolidation.rejected++;
				}
			}

			for (const { decision, group } of validated.entityGc) {
				const applied = await applyEntityGcDecision(genome, group, decision, {
					source: "memory-maintenance",
					commit: false,
				});
				const changed = applied.updated_memory_ids.length > 0;
				if (!changed) continue;
				for (const projectId of maintenanceProjectIds(entityGcGroupProjectIds(group, memoryById))) {
					entityGcProjectIds.add(projectId);
				}
				if (decision.action === "merge") {
					result.entity_gc.merged++;
					result.entity_gc.updated_memory_ids.push(...applied.updated_memory_ids);
					result.entity_gc.archived_alias_count += applied.archived_aliases.length;
				} else {
					result.entity_gc.rejected++;
				}
			}

			result.consolidation.archived_memory_ids = sortedUnique(
				result.consolidation.archived_memory_ids,
			);
			result.entity_gc.updated_memory_ids = sortedUnique(result.entity_gc.updated_memory_ids);
			ensureGlobalMaintenanceRecord(genome, consolidatedProjectIds, entityGcProjectIds);
			for (const projectId of consolidatedProjectIds) genome.projects.markConsolidated(projectId);
			for (const projectId of entityGcProjectIds) genome.projects.markEntityGc(projectId);
			return result;
		},
	);
}

function validateMemoryMaintenanceDecisions(
	plan: MemoryMaintenancePlan,
	decisions: MemoryMaintenanceDecisionFile,
	memoryById: ReadonlyMap<string, Memory>,
): {
	consolidations: ValidatedMaintenanceConsolidation[];
	entityGc: Array<{ decision: MaintenanceEntityGcDecision; group: EntityGcGroup }>;
} {
	const clusterById = new Map(plan.consolidationClusters.map((cluster) => [cluster.id, cluster]));
	const groupById = new Map(plan.entityGcGroups.map((group) => [group.id, group]));
	const consolidations: ValidatedMaintenanceConsolidation[] = [];
	const entityGc: Array<{ decision: MaintenanceEntityGcDecision; group: EntityGcGroup }> = [];
	const consolidationMergeMemoryIds = new Set<string>();

	for (const decision of decisions.consolidations ?? []) {
		const cluster = clusterById.get(decision.cluster_id);
		if (!cluster) throw new Error(`Unknown consolidation cluster '${decision.cluster_id}'`);
		if (decision.action === "merge") {
			if (!decision.memory) {
				throw new Error(`Merge decision for '${decision.cluster_id}' is missing memory`);
			}
			validateConsolidationMergeDecision(
				cluster,
				decision,
				memoryById,
				consolidationMergeMemoryIds,
			);
			consolidations.push({
				decision: { ...decision, action: "merge", memory: decision.memory },
				cluster,
			});
		} else {
			consolidations.push({ decision: { ...decision, action: "reject" }, cluster });
		}
	}

	for (const decision of decisions.entity_gc ?? []) {
		const group = groupById.get(decision.group_id);
		if (!group) throw new Error(`Unknown entity GC group '${decision.group_id}'`);
		if (decision.action === "merge" && (!decision.canonical || !decision.aliases?.length)) {
			throw new Error(`Merge decision for '${decision.group_id}' is missing canonical or aliases`);
		}
		if (decision.action === "merge") validateEntityGcMergeDecision(group, decision);
		entityGc.push({ decision, group });
	}

	return { consolidations, entityGc };
}

function validateConsolidationMergeDecision(
	cluster: ConsolidationCluster,
	decision: MaintenanceConsolidationDecision,
	memoryById: ReadonlyMap<string, Memory>,
	seenMergedMemoryIds: Set<string>,
): void {
	if (cluster.memory_ids.length < 2) {
		throw new Error(`Consolidation cluster '${cluster.id}' has fewer than two memories`);
	}
	const confirmedMemoryIds = new Set(decision.confirmed_memory_ids ?? []);
	for (const memoryId of cluster.memory_ids) {
		const memory = memoryById.get(memoryId);
		if (!memory) throw new Error(`Cannot consolidate missing memory '${memoryId}'`);
		if (memory.archived_at) throw new Error(`Cannot consolidate archived memory '${memoryId}'`);
		if (isProtectedManualMemory(memory) && !confirmedMemoryIds.has(memoryId)) {
			throw new Error(
				`Cannot consolidate manual memory '${memoryId}' without explicit confirmation`,
			);
		}
		if (seenMergedMemoryIds.has(memoryId)) {
			throw new Error(`Memory '${memoryId}' appears in multiple consolidation merge decisions`);
		}
		seenMergedMemoryIds.add(memoryId);
	}
}

function validateEntityGcMergeDecision(
	group: EntityGcGroup,
	decision: MaintenanceEntityGcDecision,
): void {
	if (decision.action !== "merge" || !decision.canonical || !decision.aliases?.length) return;
	const candidateUuids = new Set(group.candidates.map((candidate) => candidate.uuid));
	if (!candidateUuids.has(decision.canonical.uuid)) {
		throw new Error(
			`Entity GC merge decision canonical '${decision.canonical.uuid}' is not in group`,
		);
	}
	for (const alias of decision.aliases) {
		if (alias.uuid === decision.canonical.uuid) {
			throw new Error(`Entity GC merge decision alias '${alias.uuid}' matches canonical`);
		}
		if (!candidateUuids.has(alias.uuid)) {
			throw new Error(`Entity GC merge decision alias '${alias.uuid}' is not in group`);
		}
	}
}

function maintenanceProjectIds(projectIds: readonly string[]): string[] {
	return projectIds.length > 0 ? [...projectIds] : [GLOBAL_MAINTENANCE_PROJECT_ID];
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

function globalMaintenanceProject(
	projects: readonly ProjectActivityRecord[],
): ProjectActivityRecord | undefined {
	const existing = projects.find((project) => project.id === GLOBAL_MAINTENANCE_PROJECT_ID);
	const activeDays = Math.max(
		existing?.cumulative_active_days ?? 0,
		totalProjectActiveDays(projects),
	);
	if (activeDays <= 0) return existing;
	return {
		id: GLOBAL_MAINTENANCE_PROJECT_ID,
		name: GLOBAL_MAINTENANCE_PROJECT_NAME,
		cumulative_active_days: activeDays,
		...(existing?.last_consolidated_active_day !== undefined
			? { last_consolidated_active_day: existing.last_consolidated_active_day }
			: {}),
		...(existing?.last_entity_gc_active_day !== undefined
			? { last_entity_gc_active_day: existing.last_entity_gc_active_day }
			: {}),
	};
}

function totalProjectActiveDays(projects: readonly ProjectActivityRecord[]): number {
	return projects
		.filter((project) => project.id !== GLOBAL_MAINTENANCE_PROJECT_ID)
		.reduce((sum, project) => sum + project.cumulative_active_days, 0);
}

function ensureGlobalMaintenanceRecord(
	genome: Genome,
	consolidatedProjectIds: ReadonlySet<string>,
	entityGcProjectIds: ReadonlySet<string>,
): void {
	if (
		!consolidatedProjectIds.has(GLOBAL_MAINTENANCE_PROJECT_ID) &&
		!entityGcProjectIds.has(GLOBAL_MAINTENANCE_PROJECT_ID)
	) {
		return;
	}
	const globalProject = globalMaintenanceProject(genome.projects.all()) ?? {
		id: GLOBAL_MAINTENANCE_PROJECT_ID,
		name: GLOBAL_MAINTENANCE_PROJECT_NAME,
		cumulative_active_days: 1,
	};
	genome.projects.upsertMaintenanceRecord(globalProject);
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
			...parseConfirmedMemoryIds(item, `consolidations[${index}]`),
			memory: parseConsolidationMemoryDraft(item.memory, `consolidations[${index}].memory`),
		};
	});
}

function parseConfirmedMemoryIds(
	item: Record<string, unknown>,
	path: string,
): { confirmed_memory_ids?: string[] } {
	const confirmed = optionalStringArray(item.confirmed_memory_ids, `${path}.confirmed_memory_ids`);
	return confirmed ? { confirmed_memory_ids: confirmed } : {};
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
	if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
		throw new Error(`${path}.confidence must be between 0 and 1`);
	}
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

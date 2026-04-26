import type { Genome } from "./genome.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ProjectActivityStore } from "./projects.ts";
import type { SegmentStore } from "./segments.ts";

const READ_ONLY_ERROR = "read-only genome";

const MUTATING_GENOME_METHODS = new Set([
	"init",
	"addAgent",
	"updateAgent",
	"removeAgent",
	"addRoutingRule",
	"removeRoutingRule",
	"addMemory",
	"stageMemoryForMutation",
	"saveMemoryMutation",
	"addSegment",
	"addSegmentWithMemories",
	"markMemoriesUsed",
	"recordProjectActivity",
	"saveProjectActivityMutation",
	"recomputeMemoryScores",
	"recordMemoryMentions",
	"pruneMemories",
	"pruneUnusedRoutingRules",
	"rollback",
	"rollbackCommit",
	"initFromRoot",
	"syncRoot",
	"saveAgentTool",
	"saveAgentFile",
	"savePostscript",
]);

const MUTATING_MEMORY_METHODS = new Set([
	"add",
	"stage",
	"markUsed",
	"markMentioned",
	"save",
	"mergeLatestFromDisk",
	"pruneByConfidence",
]);
const MUTATING_SEGMENT_METHODS = new Set(["add", "stage", "save"]);
const MUTATING_PROJECT_METHODS = new Set([
	"recordActiveDay",
	"markConsolidated",
	"markEntityGc",
	"upsertMaintenanceRecord",
	"mergeLatestFromDisk",
	"save",
]);

export function createReadOnlyGenome(genome: Genome): Genome {
	return new Proxy(genome, {
		get(target, property, receiver) {
			if (property === "memories") {
				return createReadOnlyStore(
					Reflect.get(target, property, receiver) as MemoryStore,
					MUTATING_MEMORY_METHODS,
				);
			}
			if (property === "segments") {
				return createReadOnlyStore(
					Reflect.get(target, property, receiver) as SegmentStore,
					MUTATING_SEGMENT_METHODS,
				);
			}
			if (property === "projects") {
				return createReadOnlyStore(
					Reflect.get(target, property, receiver) as ProjectActivityStore,
					MUTATING_PROJECT_METHODS,
				);
			}

			const value = Reflect.get(target, property, receiver);
			if (property === "searchMemories") {
				const readOnlySearch = Reflect.get(target, "searchMemoriesReadOnly", receiver);
				return typeof readOnlySearch === "function" ? readOnlySearch.bind(target) : value;
			}
			if (typeof property === "string" && MUTATING_GENOME_METHODS.has(property)) {
				return async () => Promise.reject(new Error(READ_ONLY_ERROR));
			}
			if (typeof value === "function") {
				return value.bind(target);
			}
			return value;
		},
	}) as Genome;
}

function createReadOnlyStore<T extends object>(store: T, mutatingMethods: Set<string>): T {
	return new Proxy(store, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof property === "string" && mutatingMethods.has(property)) {
				return () => {
					throw new Error(READ_ONLY_ERROR);
				};
			}
			if (typeof value === "function") {
				return value.bind(target);
			}
			return value;
		},
	}) as T;
}

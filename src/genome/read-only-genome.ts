import type { Genome } from "./genome.ts";
import type { MemoryStore } from "./memory-store.ts";

const READ_ONLY_ERROR = "read-only genome";

const MUTATING_GENOME_METHODS = new Set([
	"init",
	"addAgent",
	"updateAgent",
	"removeAgent",
	"addRoutingRule",
	"removeRoutingRule",
	"addMemory",
	"markMemoriesUsed",
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

const MUTATING_MEMORY_METHODS = new Set(["add", "markUsed", "save", "pruneByConfidence"]);

export function createReadOnlyGenome(genome: Genome): Genome {
	return new Proxy(genome, {
		get(target, property, receiver) {
			if (property === "memories") {
				return createReadOnlyMemoryStore(Reflect.get(target, property, receiver) as MemoryStore);
			}

			const value = Reflect.get(target, property, receiver);
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

function createReadOnlyMemoryStore(memories: MemoryStore): MemoryStore {
	return new Proxy(memories, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof property === "string" && MUTATING_MEMORY_METHODS.has(property)) {
				return () => {
					throw new Error(READ_ONLY_ERROR);
				};
			}
			if (typeof value === "function") {
				return value.bind(target);
			}
			return value;
		},
	}) as MemoryStore;
}

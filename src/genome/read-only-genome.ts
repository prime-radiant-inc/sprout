import type { Genome } from "./genome.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { ProjectActivityStore } from "./projects.ts";
import type { SegmentStore } from "./segments.ts";

const READ_ONLY_ERROR = "read-only genome";

/**
 * The enumerated READ surface (allowlist). Anything not listed here fails
 * closed: the blocklist this replaced rotted once — six later-phase mutators
 * slipped through and a "read-only" genome committed writes to git. With the
 * allowlist, a new mutator is blocked the day it is added; a new read method
 * shows up as a loud "read-only genome" error in tests and gets enumerated
 * deliberately.
 */
const READABLE_GENOME_METHODS = new Set([
	"constructor",
	"agentCount",
	"agentDir",
	"allAgents",
	"allPrograms",
	"allRoutingRules",
	"generation",
	"getAgent",
	"getProgram",
	"getRootAgent",
	"isOverlay",
	"lastCommitHash",
	"listAgentFiles",
	"loadAgentPostscript",
	"loadAgentTools",
	"loadAgentToolsWithRoot",
	"loadFromDisk",
	"loadMemoryExtractionPrompts",
	"loadPostscripts",
	"loadRelationshipClassificationPrompt",
	"loadRoot",
	"loadSegmentSummaryPrompts",
	"loadSubcorticalRecallPrompt",
	"matchRoutingRules",
	"memoryEmbeddingProvider",
	"overlayAgents",
	"refreshIfDiskChanged",
	"searchMemories",
	"searchMemoriesReadOnly",
]);

const READABLE_MEMORY_METHODS = new Set([
	"constructor",
	"all",
	"getById",
	"effectiveConfidence",
	"search",
	"load",
]);
const READABLE_SEGMENT_METHODS = new Set(["constructor", "all", "getById", "load"]);
const READABLE_PROJECT_METHODS = new Set(["constructor", "all", "getById", "load"]);

export function createReadOnlyGenome(genome: Genome): Genome {
	return new Proxy(genome, {
		get(target, property, receiver) {
			if (property === "memories") {
				return createReadOnlyStore(
					Reflect.get(target, property, receiver) as MemoryStore,
					READABLE_MEMORY_METHODS,
				);
			}
			if (property === "segments") {
				return createReadOnlyStore(
					Reflect.get(target, property, receiver) as SegmentStore,
					READABLE_SEGMENT_METHODS,
				);
			}
			if (property === "projects") {
				return createReadOnlyStore(
					Reflect.get(target, property, receiver) as ProjectActivityStore,
					READABLE_PROJECT_METHODS,
				);
			}

			const value = Reflect.get(target, property, receiver);
			if (property === "searchMemories") {
				const readOnlySearch = Reflect.get(target, "searchMemoriesReadOnly", receiver);
				return typeof readOnlySearch === "function" ? readOnlySearch.bind(target) : value;
			}
			if (typeof value === "function") {
				if (typeof property !== "string" || !READABLE_GENOME_METHODS.has(property)) {
					return () => {
						throw new Error(READ_ONLY_ERROR);
					};
				}
				return value.bind(target);
			}
			return value;
		},
	}) as Genome;
}

function createReadOnlyStore<T extends object>(store: T, readableMethods: Set<string>): T {
	return new Proxy(store, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value === "function") {
				if (typeof property !== "string" || !readableMethods.has(property)) {
					return () => {
						throw new Error(READ_ONLY_ERROR);
					};
				}
				return value.bind(target);
			}
			return value;
		},
	}) as T;
}

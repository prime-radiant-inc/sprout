import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
	findRootToolsDir,
	loadRootAgents,
	readRootDir,
	resolveRootToolsDir,
} from "../agents/loader.ts";
import {
	parseAgentMarkdown,
	serializeAgentMarkdown,
	validateAgentSpec,
} from "../agents/markdown-loader.ts";
import type { AgentSpec, Memory, RoutingRule } from "../kernel/types.ts";
import type { EmbeddingProvider } from "../llm/embeddings.ts";
import { getToolDisplayName } from "../shared/tool-display.ts";
import { filterDuplicateMemories } from "./dedup.ts";
import { acquireDirectoryLock } from "./file-lock.ts";
import { sanitizeGitEnv } from "./git-env.ts";
import {
	ensureMemoryIndexFresh,
	memoryIndexPath,
	rebuildMemoryIndexFromJsonl,
	requireMemoryIndexFresh,
} from "./index-builder.ts";
import {
	applyMemoryLinks,
	type ClassifiedMemoryRelationship,
	discoverLinkCandidatesForNewMemories,
	type LinkCandidate,
	type LinkDiscoveryOptions,
} from "./linking.ts";
import { attachReadyMemoryEmbedding } from "./memory-embedding.ts";
import { MemoryIndex } from "./memory-index.ts";
import { isActiveMemoryForRecall } from "./memory-lifecycle.ts";
import { memoryShortId } from "./memory-schema.ts";
import { MemoryStore } from "./memory-store.ts";
import {
	type Program,
	parseProgramMarkdown,
	serializeProgramMarkdown,
	validateProgram,
} from "./program.ts";
import { type DetectedProject, ProjectActivityStore } from "./projects.ts";
import {
	loadMemoryExtractionPrompts,
	loadRelationshipClassificationPrompt,
	loadSegmentSummaryPrompts,
	loadSubcorticalRecallPrompt,
	type PromptSet,
} from "./prompts.ts";
import { buildManifestFromSpecs, loadManifest, saveManifest } from "./root-manifest.ts";
import {
	applyMemoryScores,
	markMemoryAccessActivity,
	stampMemoryActivitySnapshots,
} from "./scoring.ts";
import { attachReadySegmentEmbedding, type MemorySegment, SegmentStore } from "./segments.ts";

export interface SyncRootResult {
	added: string[];
	conflicts: string[];
	/** Root-shipped programs new since the last sync. */
	addedPrograms: string[];
	/** Programs where root changed AND the genome has an overlay (overlay wins). */
	programConflicts: string[];
}

export interface GenomeOptions {
	embeddingProvider?: EmbeddingProvider;
}

export interface ExtractedMemoryRelationshipClassificationInput {
	candidates: readonly LinkCandidate[];
	memoriesById: ReadonlyMap<string, Memory>;
}

export interface AddExtractedMemoriesWithRelationshipsInput {
	segment?: MemorySegment;
	memories: Memory[];
	explicitReferenceIds?: readonly string[];
	classifyRelationships: (
		input: ExtractedMemoryRelationshipClassificationInput,
	) => Promise<readonly ClassifiedMemoryRelationship[]>;
	commitMessage?: string;
	source?: string;
	now?: number;
	discovery?: LinkDiscoveryOptions;
}

export interface AddExtractedMemoriesWithRelationshipsResult {
	segment?: MemorySegment;
	memories: Memory[];
	candidates: LinkCandidate[];
	relationships: ClassifiedMemoryRelationship[];
	linksAdded: number;
}

export interface MemoryLogCompactionResult {
	beforeCount: number;
	afterCount: number;
	removedIds: string[];
}

export interface MemoryLogCompactionDueResult {
	due: boolean;
	result?: MemoryLogCompactionResult;
}

export { sanitizeGitEnv } from "./git-env.ts";

const MEMORY_LOG_COMPACTION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Run a git command in the given directory, returning trimmed stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		env: sanitizeGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
	}
	return stdout.trim();
}

const DIRS = [
	"agents",
	"memories",
	"routing",
	"embeddings",
	"metrics",
	"logs",
	"postscripts",
	"prompts",
	"programs",
	".cache",
] as const;

export class Genome {
	private readonly rootPath: string;
	private readonly rootDir?: string;
	private embeddingProvider?: EmbeddingProvider;
	private readonly agents = new Map<string, AgentSpec>();
	private readonly rootAgents = new Map<string, AgentSpec>();
	private readonly programs = new Map<string, Program>();
	private readonly rootPrograms = new Map<string, Program>();
	readonly memories: MemoryStore;
	readonly segments: SegmentStore;
	readonly projects: ProjectActivityStore;
	private routingRules: RoutingRule[] = [];
	private _generation = 0;
	private _knownAgentFiles: Set<string> = new Set();

	constructor(rootPath: string, rootDir?: string, options: GenomeOptions = {}) {
		this.rootPath = rootPath;
		this.rootDir = rootDir;
		this.embeddingProvider = options.embeddingProvider;
		this.memories = new MemoryStore(join(rootPath, "memories", "memories.jsonl"));
		this.segments = new SegmentStore(join(rootPath, "memories", "segments.jsonl"));
		this.projects = new ProjectActivityStore(join(rootPath, "memories", "projects.jsonl"));
	}

	get generation(): number {
		return this._generation;
	}

	/** Initialize the genome directory with subdirectories and a git repo. */
	async init(): Promise<void> {
		// Create all directories
		for (const dir of DIRS) {
			await mkdir(join(this.rootPath, dir), { recursive: true });
		}

		// Check if git repo exists
		let hasGit = false;
		try {
			await git(this.rootPath, "rev-parse", "--git-dir");
			hasGit = true;
		} catch {
			// No git repo yet
		}

		if (!hasGit) {
			await git(this.rootPath, "init");
			await git(this.rootPath, "config", "user.name", "sprout");
			await git(this.rootPath, "config", "user.email", "sprout@local");

			// Create empty routing rules file
			await writeFile(join(this.rootPath, "routing", "rules.yaml"), stringify([]));

			// Create .gitignore to exclude ephemeral data
			await writeFile(join(this.rootPath, ".gitignore"), "logs/\nprojects/\n.cache/\n");

			await git(this.rootPath, "add", ".");
			await git(this.rootPath, "commit", "-m", "genome: initialize");
		}
	}

	/** Load root agents and root programs from the rootDir. No-op if rootDir was not set. */
	async loadRoot(): Promise<void> {
		if (!this.rootDir) return;
		const specs = await loadRootAgents(this.rootDir);
		this.rootAgents.clear();
		for (const spec of specs) {
			this.rootAgents.set(spec.name, spec);
		}
		const { programs } = await readRootProgramsDir(this.rootDir);
		this.rootPrograms.clear();
		for (const program of programs) {
			this.rootPrograms.set(program.name, program);
		}
	}

	// --- Agent CRUD ---

	/** Number of agents in the genome (overlay + root, deduplicated). */
	agentCount(): number {
		let rootOnly = 0;
		for (const name of this.rootAgents.keys()) {
			if (!this.agents.has(name)) rootOnly++;
		}
		return this.agents.size + rootOnly;
	}

	/** Return a copy of all agent specs (root + overlay merged, overlay wins). */
	allAgents(): AgentSpec[] {
		const merged = new Map<string, AgentSpec>(this.rootAgents);
		for (const [name, spec] of this.agents) {
			merged.set(name, spec);
		}
		return [...merged.values()];
	}

	/** Look up an agent by name. Checks overlay first, then root. */
	getAgent(name: string): AgentSpec | undefined {
		return this.agents.get(name) ?? this.rootAgents.get(name);
	}

	/** Look up an agent in root only (ignoring overlay). */
	getRootAgent(name: string): AgentSpec | undefined {
		return this.rootAgents.get(name);
	}

	// --- Programs (sap spec §7) ---

	/** Look up a loaded, validated program by name. Checks overlay first, then root. */
	getProgram(name: string): Program | undefined {
		return this.programs.get(name) ?? this.rootPrograms.get(name);
	}

	/** Return a copy of all loaded, validated programs (root + overlay merged, overlay wins). */
	allPrograms(): Program[] {
		const merged = new Map<string, Program>(this.rootPrograms);
		for (const [name, program] of this.programs) {
			merged.set(name, program);
		}
		return [...merged.values()];
	}

	/**
	 * Add a fabricated/repaired program to the genome: run the SAME lexical
	 * import/require scan programs face at load (so a body carrying an import
	 * never becomes runnable), then write markdown to programs/, commit, and
	 * load it into the live library. This is a genome (evolvable) write — it is
	 * reachable only through the gated Learn adoption path (mutation-gate.ts).
	 */
	async addProgram(program: Program): Promise<void> {
		const check = validateProgram(program);
		if (!check.ok) {
			throw new Error(`Cannot add program '${program.name}': ${check.reason}`);
		}
		const programsDir = join(this.rootPath, "programs");
		await mkdir(programsDir, { recursive: true });
		const mdPath = join(programsDir, `${program.name}.md`);
		await writeFile(mdPath, serializeProgramMarkdown(program));
		await git(this.rootPath, "add", mdPath);
		await git(this.rootPath, "commit", "-m", `genome: add program '${program.name}'`);
		this.programs.set(program.name, program);
		this._generation++;
	}

	/**
	 * Remove an overlay program: delete its markdown file, commit, and drop it
	 * from the library. Only overlay programs can be removed — root-only programs
	 * are immutable (mirroring removeAgent). If the overlay shadowed a root
	 * program, the root version re-appears.
	 */
	async removeProgram(name: string): Promise<void> {
		if (!this.programs.has(name)) {
			if (this.rootPrograms.has(name)) {
				throw new Error(`Cannot remove program '${name}': it is a root program (not in overlay)`);
			}
			throw new Error(`Cannot remove program '${name}': not found`);
		}
		const mdPath = join(this.rootPath, "programs", `${name}.md`);
		await rm(mdPath);
		await git(this.rootPath, "add", mdPath);
		await git(this.rootPath, "commit", "-m", `genome: remove program '${name}'`);
		this.programs.delete(name);
		this._generation++;
	}

	/** Returns true if the agent exists in the genome's overlay (modified or genome-created). */
	isOverlay(name: string): boolean {
		return this.agents.has(name);
	}

	/** Returns only genome-modified or genome-created agents (the overlay). */
	overlayAgents(): AgentSpec[] {
		return [...this.agents.values()];
	}

	/** Add a new agent spec, writing markdown to disk and committing.
	 *  If an agent with the same name exists in root or overlay, bumps version above the highest. */
	async addAgent(spec: AgentSpec): Promise<void> {
		validateAgentSpec(spec);
		const rootVersion = this.rootAgents.get(spec.name)?.version ?? 0;
		const overlayVersion = this.agents.get(spec.name)?.version ?? 0;
		const baseVersion = Math.max(rootVersion, overlayVersion);
		const saved = baseVersion > 0 ? { ...spec, version: baseVersion + 1 } : spec;
		const mdPath = join(this.rootPath, "agents", `${saved.name}.md`);
		await writeFile(mdPath, serializeAgentMarkdown(saved));
		await git(this.rootPath, "add", mdPath);
		await git(this.rootPath, "commit", "-m", `genome: add agent '${saved.name}'`);
		this.agents.set(saved.name, saved);
		this._generation++;
	}

	/** Update an existing agent, bumping its version. Promotes root agents to overlay on first mutation. */
	async updateAgent(spec: AgentSpec): Promise<void> {
		validateAgentSpec(spec);
		const existing = this.agents.get(spec.name) ?? this.rootAgents.get(spec.name);
		if (!existing) {
			throw new Error(`Cannot update agent '${spec.name}': not found`);
		}
		const nextVersion = existing.version + 1;
		const updated = { ...spec, version: nextVersion };
		const mdPath = join(this.rootPath, "agents", `${spec.name}.md`);
		await writeFile(mdPath, serializeAgentMarkdown(updated));
		await git(this.rootPath, "add", mdPath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: update agent '${spec.name}' to v${nextVersion}`,
		);
		this.agents.set(spec.name, updated);
		this._generation++;
	}

	/**
	 * Remove an overlay agent, deleting its markdown file and committing.
	 * Only overlay agents can be removed — root-only agents are immutable.
	 * If the overlay shadowed a root agent, the root version re-appears.
	 */
	async removeAgent(name: string): Promise<void> {
		if (!this.agents.has(name)) {
			if (this.rootAgents.has(name)) {
				throw new Error(`Cannot remove agent '${name}': it is a root agent (not in overlay)`);
			}
			throw new Error(`Cannot remove agent '${name}': not found`);
		}
		const mdPath = join(this.rootPath, "agents", `${name}.md`);
		await rm(mdPath);
		await git(this.rootPath, "add", mdPath);
		await git(this.rootPath, "commit", "-m", `genome: remove agent '${name}'`);
		this.agents.delete(name);
		this._generation++;
	}

	// --- Routing rules ---

	/** Return a copy of all routing rules. */
	allRoutingRules(): RoutingRule[] {
		return [...this.routingRules];
	}

	/** Find routing rules matching the query by keyword, sorted by strength descending. */
	matchRoutingRules(query: string): RoutingRule[] {
		const tokens = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 0);
		if (tokens.length === 0) return [];

		return this.routingRules
			.filter((rule) => {
				const condition = rule.condition.toLowerCase();
				return tokens.some((token) => condition.includes(token));
			})
			.sort((a, b) => b.strength - a.strength);
	}

	/** Add a routing rule, saving to YAML and committing. */
	async addRoutingRule(rule: RoutingRule): Promise<void> {
		this.routingRules.push(rule);
		await this.saveRoutingRules();
		await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
		await git(this.rootPath, "commit", "-m", `genome: add routing rule '${rule.id}'`);
	}

	/** Remove a routing rule by id, saving to YAML and committing. */
	async removeRoutingRule(id: string): Promise<void> {
		this.routingRules = this.routingRules.filter((r) => r.id !== id);
		await this.saveRoutingRules();
		await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
		await git(this.rootPath, "commit", "-m", `genome: remove routing rule '${id}'`);
	}

	private async saveRoutingRules(): Promise<void> {
		await writeFile(join(this.rootPath, "routing", "rules.yaml"), stringify(this.routingRules));
	}

	// --- Memory CRUD (delegates to MemoryStore) ---

	/** Add a memory, committing the JSONL file. */
	async addMemory(memory: Memory): Promise<void> {
		stampMemoryActivitySnapshots(memory, this.projects.all());
		const embeddedMemory = await attachReadyMemoryEmbedding(
			memory,
			await this.getEmbeddingProvider(),
		);
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		await this.withMemoryWriteLock(() =>
			this.runCommittedFileMutation({
				paths: [memoriesPath],
				mutate: async () => {
					await this.memories.load();
					assertCanStageMemoryBatch(this.memories.all(), [embeddedMemory]);
					this.memories.stage(embeddedMemory);
					await this.memories.save();
				},
				commitMessage: () => `genome: add memory '${embeddedMemory.id}'`,
				onNoChanges: "commit",
				rebuildIndex: true,
				reloadAfterRestore: () => this.memories.load(),
			}),
		);
	}

	/** Add multiple memories in a single commit. */
	async addMemories(memories: Memory[], commitMessage: string): Promise<void> {
		if (memories.length === 0) return;
		const provider = await this.getEmbeddingProvider();
		const embeddedMemories: Memory[] = [];
		for (const memory of memories) {
			stampMemoryActivitySnapshots(memory, this.projects.all());
			embeddedMemories.push(await attachReadyMemoryEmbedding(memory, provider));
		}
		await this.withMemoryWriteLock(async () => {
			await this.memories.load();
			const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
			await this.runCommittedFileMutation({
				paths: [memoriesPath],
				mutate: async () => {
					assertCanStageMemoryBatch(this.memories.all(), embeddedMemories);
					for (const memory of embeddedMemories) {
						this.memories.stage(memory);
					}
					await this.memories.mergeLatestFromDisk();
					await this.memories.save();
				},
				commitMessage: () => commitMessage,
				onNoChanges: "throw",
				rebuildIndex: true,
				reloadAfterRestore: () => this.memories.load(),
			});
		});
	}

	/** Stage a new memory for callers that commit it together with other memory mutations. */
	async stageMemoryForMutation(memory: Memory): Promise<Memory> {
		stampMemoryActivitySnapshots(memory, this.projects.all());
		const embeddedMemory = await attachReadyMemoryEmbedding(
			memory,
			await this.getEmbeddingProvider(),
		);
		return this.memories.stage(embeddedMemory);
	}

	/** Persist memory metadata mutations, committing JSONL and rebuilding the derived index. */
	async saveMemoryMutation(commitMessage: string): Promise<void> {
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		await this.withMemoryWriteLock(() =>
			this.runCommittedFileMutation({
				paths: [memoriesPath],
				mutate: async () => {
					await this.memories.mergeLatestFromDisk();
					await this.memories.save();
				},
				commitMessage: () => commitMessage,
				onNoChanges: "throw",
				rebuildIndex: true,
				reloadAfterRestore: () => this.memories.load(),
			}),
		);
	}

	/** Add a collapsed session segment, committing the JSONL file. */
	async addSegment(segment: MemorySegment): Promise<void> {
		const embeddedSegment = await attachReadySegmentEmbedding(
			segment,
			await this.getEmbeddingProvider(),
		);
		const segmentsPath = join(this.rootPath, "memories", "segments.jsonl");
		await this.withMemoryWriteLock(() =>
			this.runCommittedFileMutation({
				paths: [segmentsPath],
				mutate: async () => {
					await this.segments.load();
					this.segments.stage(embeddedSegment);
					await this.segments.save();
				},
				commitMessage: () => `genome: add memory segment '${embeddedSegment.id}'`,
				onNoChanges: "commit",
				rebuildIndex: true,
				reloadAfterRestore: () => this.segments.load(),
			}),
		);
	}

	/** Add a collapsed segment and extracted memories in one verified genome mutation. */
	async addSegmentWithMemories(segment: MemorySegment, memories: Memory[]): Promise<Memory[]> {
		const provider = await this.getEmbeddingProvider();
		const embeddedSegment = await attachReadySegmentEmbedding(segment, provider);
		const embeddedMemories: Memory[] = [];
		for (const memory of memories) {
			stampMemoryActivitySnapshots(memory, this.projects.all());
			embeddedMemories.push(await attachReadyMemoryEmbedding(memory, provider));
		}

		const segmentsPath = join(this.rootPath, "memories", "segments.jsonl");
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		return this.withMemoryWriteLock(async () => {
			await this.segments.load();
			await this.memories.load();
			const memoriesToStage = await filterDuplicateMemories(embeddedMemories, this.memories.all());
			this.assertCanAddSegmentWithMemories(embeddedSegment, memoriesToStage);
			const filesToAdd = memoriesToStage.length > 0 ? [segmentsPath, memoriesPath] : [segmentsPath];
			return this.runCommittedFileMutation({
				paths: filesToAdd,
				mutate: async () => {
					this.segments.stage(embeddedSegment);
					const savedMemories: Memory[] = [];
					for (const memory of memoriesToStage) {
						savedMemories.push(this.memories.stage(memory));
					}
					if (memoriesToStage.length > 0) await this.memories.mergeLatestFromDisk();
					await this.segments.save();
					if (memoriesToStage.length > 0) await this.memories.save();
					return savedMemories;
				},
				commitMessage: () =>
					`genome: add memory segment '${embeddedSegment.id}' with ${memoriesToStage.length} memories`,
				onNoChanges: "commit",
				rebuildIndex: true,
				reloadAfterRestore: async () => {
					await this.segments.load();
					await this.memories.load();
				},
			});
		});
	}

	/** Add extracted memories and resolve their relationships in one atomic genome mutation. */
	async addExtractedMemoriesWithRelationships(
		input: AddExtractedMemoriesWithRelationshipsInput,
	): Promise<AddExtractedMemoriesWithRelationshipsResult> {
		const provider = await this.getEmbeddingProvider();
		const embeddedSegment = input.segment
			? await attachReadySegmentEmbedding(input.segment, provider)
			: undefined;
		const embeddedMemories: Memory[] = [];
		for (const memory of input.memories) {
			const memoryWithSegment =
				embeddedSegment && !memory.source_segment_id
					? { ...memory, source_segment_id: embeddedSegment.id }
					: memory;
			stampMemoryActivitySnapshots(memoryWithSegment, this.projects.all());
			embeddedMemories.push(await attachReadyMemoryEmbedding(memoryWithSegment, provider));
		}

		const segmentsPath = join(this.rootPath, "memories", "segments.jsonl");
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		return this.withMemoryWriteLock(async () => {
			await this.segments.load();
			await this.memories.load();
			const memoriesToStage = await filterDuplicateMemories(embeddedMemories, this.memories.all());
			if (!embeddedSegment && memoriesToStage.length === 0) {
				return {
					memories: [],
					candidates: [],
					relationships: [],
					linksAdded: 0,
				};
			}

			if (embeddedSegment) this.assertCanAddSegmentWithMemories(embeddedSegment, memoriesToStage);
			else assertCanStageMemoryBatch(this.memories.all(), memoriesToStage);

			const filesToAdd = embeddedSegment
				? [segmentsPath, ...(memoriesToStage.length > 0 ? [memoriesPath] : [])]
				: [memoriesPath];
			return this.runCommittedFileMutation({
				paths: filesToAdd,
				mutate: async () => {
					const savedMemories: Memory[] = [];
					if (embeddedSegment) {
						this.segments.stage(embeddedSegment);
					}
					for (const memory of memoriesToStage) {
						savedMemories.push(this.memories.stage(memory));
					}

					const explicitReferencesByNewMemoryId = explicitReferenceMapForNewMemories(
						savedMemories,
						input.explicitReferenceIds ?? [],
					);
					const candidates = discoverLinkCandidatesForNewMemories({
						memories: this.memories.all(),
						newMemoryIds: new Set(savedMemories.map((memory) => memory.id)),
						...(explicitReferencesByNewMemoryId ? { explicitReferencesByNewMemoryId } : {}),
						options: input.discovery,
					});
					const relationships =
						candidates.length > 0
							? [
									...(await input.classifyRelationships({
										candidates,
										memoriesById: new Map(this.memories.all().map((memory) => [memory.id, memory])),
									})),
								]
							: [];
					const { added: linksAdded } = applyMemoryLinks(this.memories.all(), relationships, {
						now: input.now,
					});

					if (embeddedSegment) await this.segments.save();
					if (memoriesToStage.length > 0) await this.memories.save();
					return {
						...(embeddedSegment ? { segment: embeddedSegment } : {}),
						memories: savedMemories,
						candidates,
						relationships,
						linksAdded,
					};
				},
				commitMessage: (result) =>
					input.commitMessage ??
					`genome: incorporate ${result.memories.length} extracted memor${
						result.memories.length === 1 ? "y" : "ies"
					}`,
				onNoChanges: "commit",
				rebuildIndex: true,
				reloadAfterRestore: async () => {
					await this.segments.load();
					await this.memories.load();
				},
			});
		});
	}

	private assertCanAddSegmentWithMemories(
		segment: MemorySegment,
		memories: readonly Memory[],
	): void {
		if (this.segments.getById(segment.id)) {
			throw new Error(`Memory segment with id '${segment.id}' already exists`);
		}
		const existingMemories = this.memories.all();
		const existingMemoryIds = new Set(existingMemories.map((memory) => memory.id));
		const existingShortIds = new Set(
			existingMemories.map((memory) => (memory.short_id ?? memoryShortId(memory.id)).toLowerCase()),
		);
		const newMemoryIds = new Set<string>();
		const newShortIds = new Set<string>();

		for (const memory of memories) {
			if (existingMemoryIds.has(memory.id) || newMemoryIds.has(memory.id)) {
				throw new Error(`Memory with id '${memory.id}' already exists`);
			}
			const shortId = (memory.short_id ?? memoryShortId(memory.id)).toLowerCase();
			if (existingShortIds.has(shortId) || newShortIds.has(shortId)) {
				throw new Error(`Memory short id collision '${shortId}' for '${memory.id}'`);
			}
			newMemoryIds.add(memory.id);
			newShortIds.add(shortId);
		}
	}

	private async getEmbeddingProvider(): Promise<EmbeddingProvider> {
		if (!this.embeddingProvider) {
			const { LocalEmbeddingProvider } = await import("../llm/embeddings.ts");
			this.embeddingProvider = new LocalEmbeddingProvider();
		}
		return this.embeddingProvider;
	}

	async memoryEmbeddingProvider(): Promise<EmbeddingProvider> {
		return this.getEmbeddingProvider();
	}

	/** Search memories through the derived hybrid index using local query embeddings. */
	async searchMemories(query: string, limit = 5, minConfidence = 0.3): Promise<Memory[]> {
		return this.searchMemoriesWithIndexPolicy(query, limit, minConfidence, true);
	}

	/** Search memories without mutating the derived index; used by read-only/eval genomes. */
	async searchMemoriesReadOnly(query: string, limit = 5, minConfidence = 0.3): Promise<Memory[]> {
		return this.searchMemoriesWithIndexPolicy(query, limit, minConfidence, false);
	}

	private async searchMemoriesWithIndexPolicy(
		query: string,
		limit: number,
		minConfidence: number,
		allowIndexRebuild: boolean,
	): Promise<Memory[]> {
		const normalizedQuery = query.trim();
		if (!normalizedQuery) return [];

		if (allowIndexRebuild) {
			await ensureMemoryIndexFresh(this.rootPath);
		} else {
			await requireMemoryIndexFresh(this.rootPath);
		}
		await this.memories.load();
		const candidates = this.memories.all().filter((memory) => {
			return (
				isActiveMemoryForRecall(memory) && this.effectiveMemoryConfidence(memory) >= minConfidence
			);
		});
		if (candidates.length === 0) return [];
		const candidateIds = new Set(candidates.map((memory) => memory.id));

		const embeddingProvider = await this.getEmbeddingProvider();
		const [queryEmbedding] = await embeddingProvider.embedBatch([normalizedQuery], {
			kind: "query",
		});
		if (!queryEmbedding) {
			throw new Error(
				`Embedding provider '${embeddingProvider.provider}' returned no query vector`,
			);
		}

		const index = MemoryIndex.openReadOnly(memoryIndexPath(this.rootPath));
		try {
			const ranked = index.searchHybrid(normalizedQuery, queryEmbedding.vector, limit * 2, {
				candidateIds,
			});
			const memories: Memory[] = [];
			for (const result of ranked) {
				const memory = this.memories.getById(result.id);
				if (!memory || memory.archived_at) continue;
				if (this.effectiveMemoryConfidence(memory) < minConfidence) continue;
				memories.push(memory);
				if (memories.length >= limit) break;
			}
			return memories;
		} finally {
			index.close();
		}
	}

	/** Mark memories as used by id, saving to disk. No git commit — this is operational metadata. */
	async markMemoriesUsed(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.withMemoryWriteLock(async () => {
			await this.memories.load();
			for (const id of ids) {
				this.memories.markUsed(id);
				const memory = this.memories.getById(id);
				if (memory) markMemoryAccessActivity(memory, this.projects.all());
			}
			await this.memories.save();
			await rebuildMemoryIndexFromJsonl(this.rootPath, { assumeMemoryWriteLock: true });
		});
	}

	async recordProjectActivity(project: DetectedProject, date = new Date()): Promise<boolean> {
		const activity = this.projects.recordActiveDay(project, date);
		return activity?.changed === true;
	}

	async saveProjectActivityMutation(commitMessage: string): Promise<void> {
		await this.withMemoryWriteLock(() => {
			const projectsPath = join(this.rootPath, "memories", "projects.jsonl");
			return this.runCommittedFileMutation({
				paths: [projectsPath],
				mutate: async () => {
					await this.projects.mergeLatestFromDisk();
					await this.projects.save();
				},
				commitMessage: () => commitMessage,
				onNoChanges: "skip",
				rebuildIndex: false,
				reloadAfterRestore: () => this.projects.load(),
			});
		});
	}

	/**
	 * Run memory and project-activity edits under one lock and commit both JSONL
	 * files together. If either save, index rebuild, or git commit fails, both
	 * files and the derived memory index are restored to their pre-mutation state.
	 */
	async applyMemoryAndProjectActivityMutation<T>(
		commitMessage: string,
		mutate: () => Promise<T>,
	): Promise<T> {
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		const projectsPath = join(this.rootPath, "memories", "projects.jsonl");
		const paths = [memoriesPath, projectsPath];
		return this.withMemoryWriteLock(() =>
			this.runCommittedFileMutation({
				paths,
				mutate: async () => {
					const result = await mutate();
					await this.memories.mergeLatestFromDisk();
					await this.projects.mergeLatestFromDisk();
					await this.memories.save();
					await this.projects.save();
					return result;
				},
				commitMessage: () => commitMessage,
				onNoChanges: "skip",
				rebuildIndex: { onlyIfChanged: memoriesPath },
				reloadAfterRestore: async () => {
					await this.memories.load();
					await this.projects.load();
				},
			}),
		);
	}

	async recomputeMemoryScores(options: { now?: number; minImportance?: number } = {}): Promise<{
		updated: string[];
		archived: string[];
	}> {
		const result = applyMemoryScores(this.memories.all(), this.projects.all(), options);
		if (result.archived.length > 0) {
			await this.saveMemoryMutation(
				`genome: archive ${result.archived.length} low-importance memories`,
			);
		} else if (result.updated.length > 0) {
			await this.saveMemoryMutation("genome: update memory importance scores");
		}
		return result;
	}

	/** Track assistant-visible memory citations by short id. */
	async recordMemoryMentions(shortIds: string[]): Promise<string[]> {
		if (shortIds.length === 0) return [];
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		return this.withMemoryWriteLock(async () => {
			await this.memories.load();
			const mentioned = this.memories.markMentioned(shortIds);
			if (mentioned.length === 0) return [];
			await this.runCommittedFileMutation({
				paths: [memoriesPath],
				mutate: () => this.memories.save(),
				commitMessage: () => "genome: record memory mentions",
				onNoChanges: "skip",
				rebuildIndex: true,
				reloadAfterRestore: () => this.memories.load(),
			});
			return mentioned;
		});
	}

	/**
	 * Retire a memory: archive it (the memory lifecycle's retirement idiom —
	 * physical removal happens later via compactMemoryLog) and commit. This is a
	 * genome (evolvable) write reachable only through the gated Learn adoption
	 * path (retire_memory in learn-process.ts).
	 */
	async retireMemory(id: string, reason: string): Promise<void> {
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		await this.withMemoryWriteLock(async () => {
			await this.memories.load();
			const memory = this.memories.getById(id);
			if (!memory) {
				throw new Error(`Cannot retire memory '${id}': not found`);
			}
			if (memory.archived_at !== undefined) return;
			const now = Date.now();
			memory.archived_at = now;
			memory.archived_reason = reason;
			memory.updated_at = now;
			await this.runCommittedFileMutation({
				paths: [memoriesPath],
				mutate: () => this.memories.save(),
				commitMessage: () => `genome: retire memory '${id}'`,
				onNoChanges: "commit",
				rebuildIndex: true,
				reloadAfterRestore: () => this.memories.load(),
			});
		});
	}

	private async withMemoryWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const lockDir = join(this.rootPath, ".cache", "memory-write.lock");
		await mkdir(join(this.rootPath, ".cache"), { recursive: true });
		const release = await acquireDirectoryLock(lockDir);
		try {
			return await fn();
		} finally {
			await release();
		}
	}

	/**
	 * The genome's commit-or-restore envelope shared by every JSONL mutation:
	 * snapshot the files, run the staged mutation, `git add`, optionally guard
	 * on a clean status, rebuild the derived memory index, and commit. If
	 * anything fails before the commit lands, the files are restored, the add
	 * is reset, and the in-memory stores reload. Callers hold the memory write
	 * lock and do any pure staging/validation before entering the envelope.
	 */
	private async runCommittedFileMutation<T>(input: {
		/** Files the mutation touches — snapshotted, added, and restored as a unit. */
		paths: readonly string[];
		/** Stage and save the mutation. Its return value is the mutation's result. */
		mutate: () => Promise<T>;
		/** Commit message, derived from the mutation result. */
		commitMessage: (result: T) => string;
		/**
		 * How to treat a clean `git status` after add: "commit" doesn't check,
		 * "throw" fails the mutation, "skip" returns the result without a commit.
		 */
		onNoChanges: "commit" | "throw" | "skip";
		/**
		 * Rebuild the derived memory index before committing. `true` always
		 * rebuilds; `{ onlyIfChanged }` rebuilds when that file has staged
		 * changes; `false` skips it entirely — including on restore, for
		 * mutations whose files are not in the index.
		 */
		rebuildIndex: boolean | { onlyIfChanged: string };
		/** Reload the in-memory stores after a failed, restored mutation. */
		reloadAfterRestore: () => Promise<void>;
	}): Promise<T> {
		const snapshots = await snapshotTextFiles(input.paths);
		let committed = false;
		try {
			const result = await input.mutate();
			await git(this.rootPath, "add", ...input.paths);
			if (input.onNoChanges !== "commit") {
				const status = await git(this.rootPath, "status", "--porcelain", "--", ...input.paths);
				if (!status.trim()) {
					if (input.onNoChanges === "throw") {
						throw new Error("memory mutation produced no changes");
					}
					committed = true;
					return result;
				}
			}
			if (input.rebuildIndex === true) {
				await rebuildMemoryIndexFromJsonl(this.rootPath, { assumeMemoryWriteLock: true });
			} else if (input.rebuildIndex !== false) {
				const indexStatus = await git(
					this.rootPath,
					"status",
					"--porcelain",
					"--",
					input.rebuildIndex.onlyIfChanged,
				);
				if (indexStatus.trim()) {
					await rebuildMemoryIndexFromJsonl(this.rootPath, { assumeMemoryWriteLock: true });
				}
			}
			await git(this.rootPath, "commit", "-m", input.commitMessage(result));
			committed = true;
			return result;
		} catch (error) {
			if (!committed) {
				if (input.rebuildIndex === false) {
					await restoreTextFiles(snapshots);
					await git(this.rootPath, "reset", "--", ...input.paths);
				} else {
					await restoreUncommittedMemoryMutation(this.rootPath, snapshots, input.paths);
				}
				await input.reloadAfterRestore();
			}
			throw error;
		}
	}

	private effectiveMemoryConfidence(memory: Memory): number {
		return this.memories.effectiveConfidence(memory);
	}

	// --- Pruning ---

	/** Remove memories whose effective confidence is below the threshold. */
	async pruneMemories(minConfidence = 0.2): Promise<string[]> {
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		return this.withMemoryWriteLock(async () => {
			await this.memories.load();
			const pruned = this.memories.pruneByConfidence(minConfidence);
			if (pruned.length > 0) {
				removeLinksReferencingMemoryIds(this.memories.all(), new Set(pruned), Date.now());
				await this.runCommittedFileMutation({
					paths: [memoriesPath],
					mutate: () => this.memories.save(),
					commitMessage: () => `genome: prune ${pruned.length} low-confidence memories`,
					onNoChanges: "skip",
					rebuildIndex: true,
					reloadAfterRestore: () => this.memories.load(),
				});
			}
			return pruned;
		});
	}

	/** Physically remove archived/superseded memories from JSONL after their audit trail is in git. */
	async compactMemoryLog(): Promise<MemoryLogCompactionResult> {
		const memoriesPath = join(this.rootPath, "memories", "memories.jsonl");
		return this.withMemoryWriteLock(async () => {
			await this.memories.load();
			const beforeCount = this.memories.all().length;
			const removedIds = this.memories.removeArchivedOrSuperseded();
			if (removedIds.length === 0) {
				return { beforeCount, afterCount: beforeCount, removedIds: [] };
			}

			removeLinksReferencingMemoryIds(this.memories.all(), new Set(removedIds), Date.now());
			return this.runCommittedFileMutation({
				paths: [memoriesPath],
				mutate: async () => {
					await this.memories.save();
					return { beforeCount, afterCount: this.memories.all().length, removedIds };
				},
				commitMessage: () => `genome: compact ${removedIds.length} inactive memories`,
				onNoChanges: "skip",
				rebuildIndex: true,
				reloadAfterRestore: () => this.memories.load(),
			});
		});
	}

	/** Opportunistic weekly memory-log compaction check after session memory maintenance. */
	async compactMemoryLogIfDue(now = Date.now()): Promise<MemoryLogCompactionDueResult> {
		const statePath = join(this.rootPath, ".cache", "memory-compaction-state.json");
		const lastCheckedAt = await readLastMemoryCompactionCheck(statePath);
		if (lastCheckedAt !== undefined && now - lastCheckedAt < MEMORY_LOG_COMPACTION_INTERVAL_MS) {
			return { due: false };
		}
		const result = await this.compactMemoryLog();
		await mkdir(join(this.rootPath, ".cache"), { recursive: true });
		await writeFile(
			statePath,
			`${JSON.stringify(
				{
					lastCheckedAt: now,
					lastRemovedCount: result.removedIds.length,
				},
				null,
				"\t",
			)}\n`,
		);
		return { due: true, result };
	}

	/** Remove routing rules that have never been triggered (not in the used set). */
	async pruneUnusedRoutingRules(usedRuleIds: Set<string>): Promise<string[]> {
		const removed: string[] = [];
		this.routingRules = this.routingRules.filter((r) => {
			if (!usedRuleIds.has(r.id)) {
				removed.push(r.id);
				return false;
			}
			return true;
		});
		if (removed.length > 0) {
			await this.saveRoutingRules();
			await git(this.rootPath, "add", join(this.rootPath, "routing", "rules.yaml"));
			await git(
				this.rootPath,
				"commit",
				"-m",
				`genome: prune ${removed.length} unused routing rules`,
			);
		}
		return removed;
	}

	// --- Rollback ---

	/** Return the SHA of the current HEAD commit. */
	async lastCommitHash(): Promise<string> {
		return git(this.rootPath, "rev-parse", "HEAD");
	}

	/** Rollback the last genome mutation (git revert HEAD), then re-sync in-memory state. */
	async rollback(): Promise<void> {
		await git(this.rootPath, "revert", "--no-edit", "HEAD");
		await this.loadFromDisk();
	}

	/** Rollback a specific commit by hash, then re-sync in-memory state. */
	async rollbackCommit(commitHash: string): Promise<void> {
		await git(this.rootPath, "revert", "--no-edit", commitHash);
		await this.loadFromDisk();
	}

	// --- Load and Bootstrap ---

	/**
	 * Check if the agents directory has new .md files since the last load.
	 * Single readdir() call — no file content is read.
	 * Returns true if new files were found and the genome was reloaded.
	 */
	async refreshIfDiskChanged(): Promise<boolean> {
		const agentsDir = join(this.rootPath, "agents");
		let files: string[];
		try {
			files = (await readdir(agentsDir)).filter((f) => f.endsWith(".md"));
		} catch {
			return false;
		}
		const hasNew = files.some((f) => !this._knownAgentFiles.has(f));
		if (!hasNew) return false;
		await this.loadFromDisk();
		return true;
	}

	/** Load agents, memories, and routing rules from an existing genome directory. */
	async loadFromDisk(): Promise<void> {
		// Clear overlay agents before loading so stale entries don't survive reloads
		this.agents.clear();

		// Genome agents are stored flat in agents/ (one .md per agent, no nesting).
		const agentsDir = join(this.rootPath, "agents");
		let files: string[];
		try {
			files = await readdir(agentsDir);
		} catch {
			files = [];
		}
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		for (const file of mdFiles) {
			const filePath = join(agentsDir, file);
			const content = await readFile(filePath, "utf-8");
			// Validate at LOAD too (F2): agents/ is git-editable outside mutation
			// paths, so a hand-committed hybrid code-mode spec granting exec must be
			// caught here. Non-fatal per spec — log + skip the offending spec rather
			// than failing the whole genome load (matching existing tolerance).
			try {
				const spec = parseAgentMarkdown(content, filePath);
				validateAgentSpec(spec);
				this.agents.set(spec.name, spec);
			} catch (err) {
				console.warn(
					`genome: skipping invalid agent spec ${filePath}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}
		this._knownAgentFiles = new Set(mdFiles);

		// Load programs (sap spec §7). Each is parsed and passed the SAME lexical
		// import/require scan as cell source — at LOAD, because programs/ is
		// git-editable outside mutation paths and exempting them from the scan
		// would void the code-mode no-exec invariant. A program failing parse or
		// the scan is rejected loudly (log + skip) so it never loads as runnable.
		this.programs.clear();
		const programsDir = join(this.rootPath, "programs");
		let programFiles: string[];
		try {
			programFiles = (await readdir(programsDir)).filter((f) => f.endsWith(".md"));
		} catch {
			programFiles = [];
		}
		for (const file of programFiles) {
			const filePath = join(programsDir, file);
			const content = await readFile(filePath, "utf-8");
			try {
				const program = parseProgramMarkdown(content, filePath);
				const check = validateProgram(program);
				if (!check.ok) {
					throw new Error(check.reason);
				}
				this.programs.set(program.name, program);
			} catch (err) {
				console.warn(
					`genome: skipping invalid program ${filePath}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		// Load memories
		await this.memories.load();
		await this.segments.load();
		await this.projects.load();

		// Load routing rules
		const rulesPath = join(this.rootPath, "routing", "rules.yaml");
		try {
			const content = await readFile(rulesPath, "utf-8");
			const parsed = parse(content);
			this.routingRules = Array.isArray(parsed) ? parsed : [];
		} catch {
			this.routingRules = [];
		}

		// Load root agents for overlay resolution (no-op if rootDir not set)
		await this.loadRoot();
		this._generation++;
	}

	/** Initialize the genome from root agent specs. Builds manifest, loads root agents into memory. */
	async initFromRoot(): Promise<void> {
		if (!this.rootDir) {
			throw new Error("Cannot initFromRoot: rootDir not set");
		}
		if (this.rootAgents.size > 0) {
			throw new Error("Cannot initFromRoot: root agents already loaded");
		}
		const { specs, rawContentByName } = await readRootDir(this.rootDir);
		const rootProgramRead = await readRootProgramsDir(this.rootDir);

		// Populate rootAgents so getAgent/allAgents resolve from root
		for (const spec of specs) {
			this.rootAgents.set(spec.name, spec);
		}
		// Populate rootPrograms so getProgram/allPrograms resolve from root
		this.rootPrograms.clear();
		for (const program of rootProgramRead.programs) {
			this.rootPrograms.set(program.name, program);
		}

		// Build and save manifest (tracks root state for future syncRoot)
		const manifest = buildManifestFromSpecs(
			specs,
			rawContentByName,
			rootProgramEntries(rootProgramRead),
		);
		const manifestPath = join(this.rootPath, "bootstrap-manifest.json");
		await saveManifest(manifestPath, manifest);

		await git(this.rootPath, "add", manifestPath);
		await git(this.rootPath, "commit", "-m", "genome: initialize from root agents");
	}

	/**
	 * Sync root agents into an existing genome using manifest-aware comparison.
	 * With overlay design, unmodified agents auto-resolve from root.
	 * This method refreshes rootAgents, detects new root agents, detects
	 * conflicts (overlay + root both changed), and reconciles tools/agents
	 * when the root overlay exists.
	 */
	async syncRoot(): Promise<SyncRootResult> {
		if (!this.rootDir) {
			throw new Error("Cannot syncRoot: rootDir not set");
		}
		const manifestPath = join(this.rootPath, "bootstrap-manifest.json");
		const oldManifest = await loadManifest(manifestPath);
		const { specs, rawContentByName } = await readRootDir(this.rootDir);
		const rootProgramRead = await readRootProgramsDir(this.rootDir);
		const newManifest = buildManifestFromSpecs(
			specs,
			rawContentByName,
			rootProgramEntries(rootProgramRead),
		);

		// Refresh rootAgents from the already-read specs (avoids re-reading root dir)
		this.rootAgents.clear();
		for (const spec of specs) {
			this.rootAgents.set(spec.name, spec);
		}
		// Refresh rootPrograms the same way (unmodified programs auto-resolve from root)
		this.rootPrograms.clear();
		for (const program of rootProgramRead.programs) {
			this.rootPrograms.set(program.name, program);
		}

		const added: string[] = [];
		const conflicts: string[] = [];
		const addedPrograms: string[] = [];
		const programConflicts: string[] = [];

		for (const program of rootProgramRead.programs) {
			const oldEntry = oldManifest.programs?.[program.name];
			const newEntry = newManifest.programs?.[program.name];
			if (!newEntry) continue;
			if (!oldEntry) {
				addedPrograms.push(program.name);
			} else if (newEntry.hash !== oldEntry.hash && this.programs.has(program.name)) {
				// Root changed AND genome has an overlay program — conflict (overlay wins)
				programConflicts.push(program.name);
			}
			// All other cases: root auto-reflects (no overlay), or root unchanged.
		}

		for (const spec of specs) {
			const overlayAgent = this.agents.get(spec.name);
			const oldEntry = oldManifest.agents[spec.name];
			const newEntry = newManifest.agents[spec.name];
			if (!newEntry) continue;

			if (!oldEntry) {
				// New agent in root (not in previous manifest)
				added.push(spec.name);
			} else if (newEntry.hash !== oldEntry.hash && overlayAgent) {
				// Root changed AND genome has overlay — conflict
				conflicts.push(spec.name);
			}
			// All other cases: root auto-reflects (no overlay), or root unchanged.
		}

		// Reconcile root tools and agents only if genome has a root overlay
		const toolsAgentsMerged = this.agents.has("root")
			? await this.reconcileRootToolsAndAgents(
					specs,
					oldManifest.rootTools ?? [],
					oldManifest.rootAgents ?? [],
				)
			: false;

		// Detect whether manifest content changed (any hash differs or agents added/removed).
		// Use sorted keys for agents object since readdir order isn't deterministic.
		const manifestChanged =
			stableStringify(oldManifest.agents) !== stableStringify(newManifest.agents) ||
			stableStringify(oldManifest.programs ?? {}) !== stableStringify(newManifest.programs ?? {}) ||
			JSON.stringify(oldManifest.rootTools) !== JSON.stringify(newManifest.rootTools) ||
			JSON.stringify(oldManifest.rootAgents) !== JSON.stringify(newManifest.rootAgents);

		if (manifestChanged) {
			await saveManifest(manifestPath, newManifest);
		}

		const filesToStage: string[] = [];
		if (toolsAgentsMerged) {
			filesToStage.push(join(this.rootPath, "agents", "root.md"));
		}
		if (manifestChanged) {
			filesToStage.push(manifestPath);
		}

		const parts: string[] = [];
		if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
		if (addedPrograms.length > 0) parts.push(`added programs: ${addedPrograms.join(", ")}`);
		if (toolsAgentsMerged) parts.push("tools/agents merged");
		if (conflicts.length > 0) parts.push(`conflicts: ${conflicts.join(", ")}`);
		if (programConflicts.length > 0)
			parts.push(`program conflicts: ${programConflicts.join(", ")}`);

		if (filesToStage.length > 0) {
			await git(this.rootPath, "add", ...filesToStage);
			const commitMsg =
				parts.length > 0 ? `genome: sync root (${parts.join("; ")})` : "genome: sync root manifest";
			await git(this.rootPath, "commit", "-m", commitMsg);
		}

		return { added, conflicts, addedPrograms, programConflicts };
	}

	/**
	 * Reconcile root agent tools and agents with genome root.
	 * Adds entries root introduced, removes entries root dropped,
	 * and preserves genome-only entries that were never in root.
	 */
	private async reconcileRootToolsAndAgents(
		rootSpecs: AgentSpec[],
		oldRootTools: string[],
		oldRootAgents: string[],
	): Promise<boolean> {
		const rootSpecRoot = rootSpecs.find((s) => s.name === "root");
		const genomeRoot = this.agents.get("root");
		if (!rootSpecRoot || !genomeRoot) return false;

		const reconciledTools = this.reconcileList(genomeRoot.tools, rootSpecRoot.tools, oldRootTools);
		const reconciledAgents = this.reconcileList(
			genomeRoot.agents,
			rootSpecRoot.agents,
			oldRootAgents,
		);

		const toolsChanged = !arraysEqual(reconciledTools, genomeRoot.tools);
		const agentsChanged = !arraysEqual(reconciledAgents, genomeRoot.agents);
		if (!toolsChanged && !agentsChanged) return false;

		const updated = { ...genomeRoot, tools: reconciledTools, agents: reconciledAgents };
		const mdPath = join(this.rootPath, "agents", "root.md");
		await writeFile(mdPath, serializeAgentMarkdown(updated));
		this.agents.set("root", updated);
		return true;
	}

	/** 3-way merge a single list: keep genome entries still in root or never in root, add new root entries. */
	private reconcileList(genomeCurrent: string[], rootNew: string[], rootOld: string[]): string[] {
		const newSet = new Set(rootNew);
		const oldSet = new Set(rootOld);
		const genomeSet = new Set(genomeCurrent);
		const kept = genomeCurrent.filter((c) => newSet.has(c) || !oldSet.has(c));
		const toAdd = rootNew.filter((c) => !genomeSet.has(c));
		return [...kept, ...toAdd];
	}

	// --- Agent Workspace ---

	/** Return the path to an agent's workspace directory. */
	agentDir(agentName: string): string {
		return join(this.rootPath, "agents", agentName);
	}

	/** Save an executable tool script to an agent's workspace. */
	async saveAgentTool(agentName: string, opts: SaveAgentToolOptions): Promise<void> {
		assertWorkspaceFilename(opts.name);
		const interpreter = opts.interpreter ?? "bash";
		const toolDir = join(this.agentDir(agentName), "tools");
		await mkdir(toolDir, { recursive: true });

		const toolPath = join(toolDir, opts.name);
		const frontmatter = stringify({
			name: opts.name,
			...(opts.displayName ? { display_name: opts.displayName } : {}),
			description: opts.description,
			interpreter,
		});
		const content = `---\n${frontmatter}---\n${opts.script}`;
		await writeFile(toolPath, content, "utf-8");
		await chmod(toolPath, 0o755);

		await git(this.rootPath, "add", toolPath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: save tool '${opts.name}' for agent '${agentName}'`,
		);
	}

	/** Save a reference file to an agent's workspace. */
	async saveAgentFile(agentName: string, opts: SaveAgentFileOptions): Promise<void> {
		assertWorkspaceFilename(opts.name);
		const fileDir = join(this.agentDir(agentName), "files");
		await mkdir(fileDir, { recursive: true });

		const filePath = join(fileDir, opts.name);
		await writeFile(filePath, opts.content, "utf-8");

		await git(this.rootPath, "add", filePath);
		await git(
			this.rootPath,
			"commit",
			"-m",
			`genome: save file '${opts.name}' for agent '${agentName}'`,
		);
	}

	/** Load tool definitions from an agent's tools directory. */
	async loadAgentTools(agentName: string): Promise<AgentToolDefinition[]> {
		const toolDir = join(this.agentDir(agentName), "tools");
		return this.loadToolsFromDir(toolDir, "genome");
	}

	/** Load tools from both genome and root directories, genome overrides on name collision. */
	async loadAgentToolsWithRoot(
		agentName: string,
		rootDir: string,
		tree?: Map<string, import("../agents/loader.ts").AgentTreeEntry>,
	): Promise<AgentToolDefinition[]> {
		const genomeTools = await this.loadAgentTools(agentName);
		const rootToolDir = tree
			? resolveRootToolsDir(tree, rootDir, agentName)
			: await findRootToolsDir(rootDir, agentName);
		const rootTools = await this.loadToolsFromDir(rootToolDir, "root");
		const genomeNames = new Set(genomeTools.map((t) => t.name));
		return [...genomeTools, ...rootTools.filter((t) => !genomeNames.has(t.name))];
	}

	/** Read a tools directory and return AgentToolDefinition[] with the given provenance. */
	private async loadToolsFromDir(
		toolDir: string,
		provenance: "genome" | "root",
	): Promise<AgentToolDefinition[]> {
		let entries: string[];
		try {
			entries = await readdir(toolDir);
		} catch {
			return [];
		}

		const tools: AgentToolDefinition[] = [];
		for (const entry of entries) {
			const toolPath = join(toolDir, entry);
			const content = await readFile(toolPath, "utf-8");
			const parsed = parseToolFrontmatter(content);
			if (parsed) {
				tools.push({
					name: parsed.name,
					displayName: getToolDisplayName(parsed.name, parsed.displayName),
					description: parsed.description,
					interpreter: parsed.interpreter,
					scriptPath: toolPath,
					provenance,
				});
			}
		}
		return tools;
	}

	/** List files in an agent's files directory with name and size. */
	async listAgentFiles(agentName: string): Promise<AgentFileInfo[]> {
		const fileDir = join(this.agentDir(agentName), "files");
		let entries: string[];
		try {
			entries = await readdir(fileDir);
		} catch {
			return [];
		}

		const files: AgentFileInfo[] = [];
		for (const entry of entries) {
			const filePath = join(fileDir, entry);
			const s = await stat(filePath);
			if (s.isFile()) {
				files.push({ name: entry, size: s.size, path: filePath });
			}
		}
		return files;
	}

	// ── Postscripts ──────────────────────────────────────────────

	/**
	 * Load genome-level postscripts (global, orchestrator, observer, worker).
	 * Returns empty strings for missing files.
	 */
	async loadPostscripts(): Promise<{
		global: string;
		orchestrator: string;
		observer: string;
		worker: string;
	}> {
		const dir = join(this.rootPath, "postscripts");
		const read = async (name: string): Promise<string> => {
			try {
				const content = await readFile(join(dir, name), "utf-8");
				return content.trim();
			} catch {
				return "";
			}
		};
		const [global, orchestrator, observer, worker] = await Promise.all([
			read("global.md"),
			read("orchestrator.md"),
			read("observer.md"),
			read("worker.md"),
		]);
		return { global, orchestrator, observer, worker };
	}

	/**
	 * Load a per-agent postscript from postscripts/agents/{name}.md.
	 * Returns empty string if not found.
	 */
	async loadAgentPostscript(agentName: string): Promise<string> {
		try {
			const content = await readFile(
				join(this.rootPath, "postscripts", "agents", `${agentName}.md`),
				"utf-8",
			);
			return content.trim();
		} catch {
			return "";
		}
	}

	async loadMemoryExtractionPrompts(): Promise<PromptSet> {
		return loadMemoryExtractionPrompts(this.rootPath, this.rootDir);
	}

	async loadSegmentSummaryPrompts(): Promise<PromptSet> {
		return loadSegmentSummaryPrompts(this.rootPath, this.rootDir);
	}

	async loadRelationshipClassificationPrompt(): Promise<string> {
		return loadRelationshipClassificationPrompt(this.rootPath, this.rootDir);
	}

	async loadSubcorticalRecallPrompt(): Promise<string> {
		return loadSubcorticalRecallPrompt(this.rootPath, this.rootDir);
	}

	/**
	 * Save a postscript file and commit. Path is relative to postscripts/ dir.
	 * e.g. savePostscript("global.md", "...") or savePostscript("agents/reader.md", "...")
	 */
	async savePostscript(relativePath: string, content: string): Promise<void> {
		const fullPath = join(this.rootPath, "postscripts", relativePath);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content);
		await git(this.rootPath, "add", fullPath);
		await git(this.rootPath, "commit", "-m", `genome: save postscript ${relativePath}`);
	}
}

export interface SaveAgentToolOptions {
	name: string;
	displayName?: string;
	description: string;
	script: string;
	interpreter?: string;
}

export interface SaveAgentFileOptions {
	name: string;
	content: string;
}

export interface AgentToolDefinition {
	name: string;
	displayName?: string;
	description: string;
	interpreter: string;
	scriptPath: string;
	provenance: "genome" | "root";
}

export interface AgentFileInfo {
	name: string;
	size: number;
	path: string;
}

interface TextFileSnapshot {
	existed: boolean;
	content: string;
}

/**
 * Guard a model-authored workspace filename before it is joined into the
 * agent's tools/files directory: a name with a path separator or `..` segment
 * would escape the workspace and clobber a sibling agent's files or other
 * genome paths. The name must be a single, plain path component.
 */
function assertWorkspaceFilename(name: string): void {
	if (
		name.length === 0 ||
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".." ||
		name.startsWith("..")
	) {
		throw new Error(
			`invalid workspace name '${name}': must be a plain filename with no path separators or '..'`,
		);
	}
}

function assertCanStageMemoryBatch(
	existingMemories: readonly Memory[],
	newMemories: readonly Memory[],
): void {
	const ids = new Set(existingMemories.map((memory) => memory.id));
	const shortIds = new Map(
		existingMemories.map((memory) => [
			(memory.short_id ?? memoryShortId(memory.id)).toLowerCase(),
			memory.id,
		]),
	);
	for (const memory of newMemories) {
		if (ids.has(memory.id)) {
			throw new Error(`Memory with id '${memory.id}' already exists`);
		}
		ids.add(memory.id);
		const shortId = (memory.short_id ?? memoryShortId(memory.id)).toLowerCase();
		const collision = shortIds.get(shortId);
		if (collision) {
			throw new Error(
				`Memory short id collision '${shortId}' for '${memory.id}' and '${collision}'`,
			);
		}
		shortIds.set(shortId, memory.id);
	}
}

function explicitReferenceMapForNewMemories(
	memories: readonly Memory[],
	explicitReferenceIds: readonly string[],
): ReadonlyMap<string, readonly string[]> | undefined {
	if (memories.length === 0 || explicitReferenceIds.length === 0) return undefined;
	return new Map(memories.map((memory) => [memory.id, explicitReferenceIds]));
}

function removeLinksReferencingMemoryIds(
	memories: readonly Memory[],
	deletedIds: ReadonlySet<string>,
	now: number,
): void {
	for (const memory of memories) {
		let changed = false;
		const outboundLinks = memory.outbound_links ?? [];
		const inboundLinks = memory.inbound_links ?? [];
		const retainedOutbound = outboundLinks.filter((link) => !deletedIds.has(link.uuid));
		const retainedInbound = inboundLinks.filter((link) => !deletedIds.has(link.uuid));
		if (retainedOutbound.length !== outboundLinks.length) {
			memory.outbound_links = retainedOutbound;
			changed = true;
		}
		if (retainedInbound.length !== inboundLinks.length) {
			memory.inbound_links = retainedInbound;
			changed = true;
		}
		if (memory.superseded_by && deletedIds.has(memory.superseded_by)) {
			memory.superseded_by = undefined;
			changed = true;
		}
		if (changed) memory.updated_at = now;
	}
}

async function readLastMemoryCompactionCheck(path: string): Promise<number | undefined> {
	try {
		const raw = JSON.parse(await readFile(path, "utf-8")) as { lastCheckedAt?: unknown };
		return typeof raw.lastCheckedAt === "number" && Number.isFinite(raw.lastCheckedAt)
			? raw.lastCheckedAt
			: undefined;
	} catch {
		return undefined;
	}
}

async function snapshotTextFiles(paths: readonly string[]): Promise<Map<string, TextFileSnapshot>> {
	const snapshots = new Map<string, TextFileSnapshot>();
	for (const path of paths) {
		snapshots.set(path, await readTextFileSnapshot(path));
	}
	return snapshots;
}

async function restoreTextFiles(snapshots: ReadonlyMap<string, TextFileSnapshot>): Promise<void> {
	for (const [path, snapshot] of snapshots) {
		if (snapshot.existed) {
			await writeFile(path, snapshot.content);
		} else {
			await rm(path, { force: true });
		}
	}
}

async function restoreUncommittedMemoryMutation(
	rootPath: string,
	snapshots: ReadonlyMap<string, TextFileSnapshot>,
	paths: readonly string[],
): Promise<void> {
	await restoreTextFiles(snapshots);
	await git(rootPath, "reset", "--", ...paths);
	await rebuildMemoryIndexFromJsonl(rootPath, { assumeMemoryWriteLock: true });
}

async function readTextFileSnapshot(path: string): Promise<TextFileSnapshot> {
	try {
		return { existed: true, content: await readFile(path, "utf-8") };
	} catch (err) {
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return { existed: false, content: "" };
		}
		throw err;
	}
}

interface RootProgramsRead {
	programs: Program[];
	rawContentByName: Map<string, string>;
}

/**
 * Read root-shipped starter programs from <rootDir>/programs/*.md. Every
 * program passes the SAME parse + validateProgram (incl. the lexical
 * import/require scan) as genome-loaded programs — root shipping is not an
 * exemption from the code-mode no-exec invariant. An invalid program is
 * rejected loudly (warn + skip, matching agent-load tolerance) and excluded
 * from both the live library and the manifest.
 */
async function readRootProgramsDir(rootDir: string): Promise<RootProgramsRead> {
	const programsDir = join(rootDir, "programs");
	let files: string[];
	try {
		files = (await readdir(programsDir)).filter((f) => f.endsWith(".md"));
	} catch {
		return { programs: [], rawContentByName: new Map() };
	}

	const programs: Program[] = [];
	const rawContentByName = new Map<string, string>();
	for (const file of files) {
		const filePath = join(programsDir, file);
		const content = await readFile(filePath, "utf-8");
		try {
			const program = parseProgramMarkdown(content, filePath);
			const check = validateProgram(program);
			if (!check.ok) {
				throw new Error(check.reason);
			}
			programs.push(program);
			rawContentByName.set(program.name, content);
		} catch (err) {
			console.warn(
				`genome: skipping invalid root program ${filePath}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return { programs, rawContentByName };
}

/** Shape root program reads for buildManifestFromSpecs' program hash tracking. */
function rootProgramEntries(
	read: RootProgramsRead,
): Array<{ name: string; version: number; content: string }> {
	return read.programs.map((program) => ({
		name: program.name,
		version: program.version,
		content: read.rawContentByName.get(program.name) ?? "",
	}));
}

/**
 * Deterministic JSON for comparison: object keys are sorted recursively at
 * EVERY depth. (A replacer ARRAY would filter keys at every depth instead —
 * nested manifest entries would serialize as `{}` and hash-only changes would
 * compare equal.)
 */
export function stableStringify(obj: unknown): string {
	if (obj === null || typeof obj !== "object") return JSON.stringify(obj) ?? "null";
	if (Array.isArray(obj)) return `[${obj.map((v) => stableStringify(v)).join(",")}]`;
	const record = obj as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
	return `{${entries.join(",")}}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Parse YAML frontmatter from a tool file (delimited by ---). */
function parseToolFrontmatter(
	content: string,
): { name: string; displayName?: string; description: string; interpreter: string } | null {
	if (!content.startsWith("---\n")) return null;
	const endIdx = content.indexOf("\n---\n", 4);
	if (endIdx === -1) return null;

	const yamlStr = content.slice(4, endIdx);
	const parsed = parse(yamlStr);
	if (!parsed?.name || !parsed?.description) return null;

	return {
		name: parsed.name,
		displayName: typeof parsed.display_name === "string" ? parsed.display_name : undefined,
		description: parsed.description,
		interpreter: parsed.interpreter ?? "bash",
	};
}

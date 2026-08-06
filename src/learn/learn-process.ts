import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEventEmitter } from "../agents/events.ts";
import {
	createResolverSettings,
	type ResolvedModel,
	type ResolverSettings,
	resolveMemoryModel,
	resolveModel,
} from "../agents/model-resolver.ts";
import { filterDuplicateDrafts } from "../genome/dedup.ts";
import { extractMemoryDrafts, memoryFromDraft } from "../genome/extraction.ts";
import type { Genome } from "../genome/genome.ts";
import { incorporateExtractedMemories } from "../genome/memory-incorporation.ts";
import type { Program } from "../genome/program.ts";
import type { LearnSignal } from "../kernel/types.ts";
import { DEFAULT_CONSTRAINTS, validateAgentName } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import type { ProviderModel } from "../llm/types.ts";
import { Msg, messageText } from "../llm/types.ts";
import {
	learnSignalExtractionMessages,
	memoryReferenceIdsFromExtractionMessages,
} from "./extraction-evidence.ts";
import type { MetricsStore } from "./metrics-store.ts";
import type { MutationIntent } from "./mutation-gate.ts";
import {
	type CellObservation,
	curateAgents,
	curateMemories,
	curatePrograms,
	detectRecurringPatterns,
	detectRepairCandidates,
	proposeProgramFromCandidate,
} from "./quartermaster.ts";
import { shouldLearn } from "./should-learn.ts";

/**
 * Minimal interface for consuming learn signals from an Agent.
 * Implemented by LearnProcess (full pipeline) and BusLearnForwarder (bus relay).
 */
export interface LearnSink {
	push(signal: LearnSignal): void;
	recordAction(agentName: string): void;
}

export type LearnMutation =
	| { type: "update_agent"; agent_name: string; system_prompt: string }
	| {
			type: "create_agent";
			name: string;
			description: string;
			system_prompt: string;
			model: string;
			tools: string[];
			agents: string[];
			tags: string[];
	  }
	| { type: "create_routing_rule"; condition: string; preference: string; strength: number }
	| { type: "create_program"; program: Program }
	| { type: "retire_program"; program_name: string }
	| { type: "retire_agent"; agent_name: string }
	| { type: "retire_memory"; memory_id: string };

/**
 * A mutation's adoption INTENT (mutation-gate.ts): retirements are `curation`
 * (rot removal — adopt on non-regression), everything else is `improvement`
 * (must be significantly better). This is the single source of truth for the
 * classification; the gate reads it to pick the A/B acceptance direction.
 */
export function mutationIntent(mutation: LearnMutation): MutationIntent {
	switch (mutation.type) {
		case "retire_program":
		case "retire_agent":
		case "retire_memory":
			return "curation";
		default:
			return "improvement";
	}
}

/**
 * The verdict of the frozen adoption chokepoint (mutation-gate.ts) for one
 * proposed genome mutation. `adopt:false` means it failed the multi-run A/B
 * and/or the hidden canary suite and must NOT reach the genome.
 */
export interface MutationGateDecision {
	adopt: boolean;
	reason: string;
}

/**
 * The single adoption authority the Learn loop consults BEFORE any genome
 * mutation is applied. Production wires an implementation that snapshots the
 * genome, applies the candidate mutation to the snapshot, runs the N-run eval
 * arms + canary suite (evaluateMutationForAdoption in mutation-gate.ts), and
 * returns the verdict. Offline tests inject a deterministic gate. When no gate
 * is injected the loop takes the legacy direct-apply path for AGENT mutations
 * only — the quartermaster (fabrication/repair/curation) path never runs
 * ungated (see runQuartermaster).
 */
export interface MutationGate {
	evaluate(mutation: LearnMutation): Promise<MutationGateDecision>;
}

const MEMORY_EXTRACTION_MUTATION_TYPE = "memory_extraction";

/**
 * Apply a structured mutation's genome operations to the given genome. Shared
 * between the live adoption path (LearnProcess.applyMutation, which adds
 * bookkeeping) and the snapshot mutation gate (live-mutation-gate.ts, which
 * applies the candidate mutation to an isolated snapshot copy).
 */
export async function applyMutationToGenome(
	genome: Genome,
	mutation: LearnMutation,
): Promise<void> {
	switch (mutation.type) {
		case "update_agent": {
			const existing = genome.getAgent(mutation.agent_name);
			if (!existing) {
				throw new Error(`Cannot update agent '${mutation.agent_name}': not found`);
			}
			await genome.updateAgent({
				...existing,
				system_prompt: mutation.system_prompt,
			});
			break;
		}
		case "create_agent": {
			validateAgentName(mutation.name);
			await genome.addAgent({
				name: mutation.name,
				description: mutation.description,
				system_prompt: mutation.system_prompt,
				model: mutation.model,
				tools: mutation.tools,
				agents: mutation.agents,
				constraints: { ...DEFAULT_CONSTRAINTS, can_spawn: false },
				tags: mutation.tags,
				version: 1,
			});
			break;
		}
		case "create_routing_rule": {
			await genome.addRoutingRule({
				id: `learn-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				condition: mutation.condition,
				preference: mutation.preference,
				strength: mutation.strength,
				source: "learn",
			});
			break;
		}
		case "create_program": {
			await genome.addProgram(mutation.program);
			break;
		}
		case "retire_program": {
			await genome.removeProgram(mutation.program_name);
			break;
		}
		case "retire_agent": {
			await genome.removeAgent(mutation.agent_name);
			break;
		}
		case "retire_memory": {
			await genome.retireMemory(mutation.memory_id, "curator-retired");
			break;
		}
	}
}

export interface PendingEvaluation {
	agentName: string;
	mutationType: string;
	timestamp: number;
	commitHash: string;
	description?: string;
}

export interface LearnProcessOptions {
	genome: Genome;
	metrics: MetricsStore;
	events: AgentEventEmitter;
	client?: Client;
	pendingEvaluationsPath?: string;
	modelsByProvider?: Map<string, ProviderModel[]>;
	resolverSettings?: ResolverSettings;
	/**
	 * The frozen adoption chokepoint. When present, EVERY genome mutation (agent
	 * or quartermaster proposal) must pass it before `applyMutation`. When absent,
	 * agent mutations take the legacy direct-apply path and the quartermaster is
	 * inert (never adopts ungated).
	 */
	mutationGate?: MutationGate;
}

export interface EvaluationResult {
	verdict: "helpful" | "harmful" | "neutral";
	/** Positive = got worse (after - before), negative = got better. */
	delta: number;
	before_rate: number;
	after_rate: number;
}

export type ProcessResult = "applied" | "skipped" | "empty" | "error";

export class LearnProcess {
	private readonly genome: Genome;
	private readonly metrics: MetricsStore;
	private readonly events: AgentEventEmitter;
	private readonly client?: Client;
	private readonly reasonerModel?: ResolvedModel;
	private readonly extractionModel?: ResolvedModel;
	private readonly relationshipModel?: ResolvedModel;
	private readonly modelsByProvider?: Map<string, ProviderModel[]>;
	private readonly resolverSettings?: ResolverSettings;
	private readonly queue: LearnSignal[] = [];
	private readonly recentImprovements = new Set<string>();
	private readonly pendingEvaluationsPath?: string;
	private readonly mutationGate?: MutationGate;
	private _pendingEvaluations: PendingEvaluation[] = [];

	private processing = false;
	private stopRequested = false;
	private wakeResolve: (() => void) | null = null;

	constructor(options: LearnProcessOptions) {
		this.genome = options.genome;
		this.metrics = options.metrics;
		this.events = options.events;
		this.client = options.client;
		this.pendingEvaluationsPath = options.pendingEvaluationsPath;
		this.mutationGate = options.mutationGate;
		if (this.client) {
			const modelMap = options.modelsByProvider ?? new Map<string, ProviderModel[]>();
			for (const providerId of this.client.providers()) {
				if (!modelMap.has(providerId)) {
					modelMap.set(providerId, []);
				}
			}
			const resolverSettings =
				options.resolverSettings ??
				createResolverSettings(
					[...modelMap.keys()].map((providerId) => ({
						id: providerId,
						enabled: true,
					})),
				);
			this.modelsByProvider = modelMap;
			this.resolverSettings = resolverSettings;
			try {
				this.reasonerModel = resolveModel("best", resolverSettings, modelMap);
			} catch {
				this.reasonerModel = undefined;
			}
			// C8 (Jesse's ruling): a catalog that resolves a best model but not a
			// memory tier must not error every learn signal — the tier falls back
			// to the best available model. Only a catalog with nothing resolvable
			// leaves the models unset (extraction then fails loud per signal).
			try {
				this.extractionModel = resolveMemoryModel("extraction", resolverSettings, modelMap);
			} catch {
				this.extractionModel = this.reasonerModel;
			}
			try {
				this.relationshipModel = resolveMemoryModel("relationship", resolverSettings, modelMap);
			} catch {
				this.relationshipModel = this.reasonerModel;
			}
		}
	}

	/** Add a signal to the queue and record the stumble in metrics. */
	push(signal: LearnSignal): void {
		this.queue.push(signal);
		this.wake();
		this.metrics.recordStumble(signal.agent_name, signal.kind).catch((err) => {
			this.events.emit("warning", "learn", 0, {
				message: "Failed to persist stumble metric",
				error: String(err),
			});
		});
	}

	/** Record an action for stumble rate computation. */
	recordAction(agentName: string): void {
		this.metrics.recordAction(agentName).catch((err) => {
			this.events.emit("warning", "learn", 0, {
				message: "Failed to persist action metric",
				error: String(err),
			});
		});
	}

	/** Whether the frozen adoption chokepoint is wired (gated adoption active). */
	hasMutationGate(): boolean {
		return this.mutationGate !== undefined;
	}

	/** Return a copy of all pending evaluations. */
	pendingEvaluations(): PendingEvaluation[] {
		return [...this._pendingEvaluations];
	}

	/** Load pending evaluations from disk. */
	async loadPendingEvaluations(): Promise<void> {
		if (!this.pendingEvaluationsPath) return;
		try {
			const raw = await readFile(this.pendingEvaluationsPath, "utf-8");
			this._pendingEvaluations = JSON.parse(raw) as PendingEvaluation[];
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				this._pendingEvaluations = [];
				return;
			}
			throw err;
		}
	}

	/** Save pending evaluations to disk. */
	private async savePendingEvaluations(): Promise<void> {
		if (!this.pendingEvaluationsPath) return;
		await mkdir(dirname(this.pendingEvaluationsPath), { recursive: true });
		await writeFile(this.pendingEvaluationsPath, JSON.stringify(this._pendingEvaluations, null, 2));
	}

	/** Minimum number of post-improvement actions required before evaluating. */
	static readonly MIN_ACTIONS_FOR_EVALUATION = 5;

	/** Evaluate all pending improvements that have enough post-improvement data. */
	async evaluatePendingImprovements(): Promise<void> {
		const remaining: PendingEvaluation[] = [];

		for (const pending of this._pendingEvaluations) {
			const actionCount = await this.metrics.actionCountSince(pending.agentName, pending.timestamp);

			if (actionCount < LearnProcess.MIN_ACTIONS_FOR_EVALUATION) {
				remaining.push(pending);
				continue;
			}

			const result = await this.evaluateImprovement(pending.agentName, pending.timestamp);

			this.events.emit("learn_mutation", pending.agentName, 0, {
				mutation_type: "evaluation",
				verdict: result.verdict,
				delta: result.delta,
				description: pending.description,
			});

			if (result.verdict === "harmful") {
				await this.genome.rollbackCommit(pending.commitHash);
				this.events.emit("learn_mutation", pending.agentName, 0, {
					mutation_type: "rollback",
					commit_hash: pending.commitHash,
					description: pending.description,
				});
			}

			// All evaluated improvements (helpful, harmful, neutral) are removed from pending
		}

		this._pendingEvaluations = remaining;
		await this.savePendingEvaluations();
	}

	/**
	 * Evaluate whether an improvement helped by comparing stumble rates before and after.
	 *
	 * INTEGRATION POINT (sap spec §10, non-negotiable multi-run A/B): this
	 * single before/after delta is exactly the noise the multi-run A/B gate
	 * replaces — one sample per period cannot separate a real genome
	 * improvement from RLM variance. When the eval harness can run each arm N
	 * times (pinned eval-mode snapshots, same genome both arms), collect the
	 * per-run stumble rates into two `ArmResult`s and gate acceptance on
	 * `shouldAcceptMutation(treatment, baseline)` from ./multi-run-ab.ts instead
	 * of the `delta` threshold below.
	 *
	 * Phase 5 status: the frozen two-gate adoption decision now lives in
	 * `mutation-gate.ts` (evaluateMutationForAdoption) and is consulted BEFORE
	 * apply via `adoptMutation` whenever a `MutationGate` is wired — that is the
	 * sole path a mutation reaches the genome under integrity. This single-delta
	 * method survives only as the LEGACY post-hoc rollback safety net for the
	 * un-gated path (evaluatePendingImprovements); it is NOT the frozen gate.
	 */
	async evaluateImprovement(
		agentName: string,
		improvementTimestamp: number,
	): Promise<EvaluationResult> {
		// Use improvementTimestamp - 1 for before's end to avoid overlap:
		// stumbleRateForPeriod uses inclusive boundaries (since <= t <= until).
		const before = await this.metrics.stumbleRateForPeriod(agentName, 0, improvementTimestamp - 1);
		const after = await this.metrics.stumbleRateForPeriod(agentName, improvementTimestamp);

		const delta = after - before;

		let verdict: EvaluationResult["verdict"];
		if (delta > 0.05) {
			verdict = "harmful";
		} else if (delta < -0.05) {
			verdict = "helpful";
		} else {
			verdict = "neutral";
		}

		return { verdict, delta, before_rate: before, after_rate: after };
	}

	/** Return the number of signals waiting in the queue. */
	queueSize(): number {
		return this.queue.length;
	}

	/** Start background processing of the learn queue. */
	startBackground(): void {
		if (this.processing) return;
		this.processing = true;
		this.stopRequested = false;
		this.runBackgroundLoop();
	}

	/** Stop background processing. Drains remaining signals before returning. */
	async stopBackground(): Promise<void> {
		if (!this.processing) return;
		this.stopRequested = true;
		// Wake the loop if it's sleeping
		this.wake();
		// Wait for processing to finish
		while (this.processing) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	/** Wake the background loop to check the queue immediately. */
	private wake(): void {
		if (this.wakeResolve) {
			this.wakeResolve();
			this.wakeResolve = null;
		}
	}

	private async runBackgroundLoop(): Promise<void> {
		// Evaluate pending improvements from previous sessions before processing new signals
		try {
			await this.loadPendingEvaluations();
			await this.evaluatePendingImprovements();
		} catch (err) {
			this.events.emit("warning", "learn", 0, {
				message: "Failed to evaluate pending improvements on startup",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		while (!this.stopRequested) {
			if (this.queue.length > 0) {
				await this.processNext();
			} else {
				// Sleep until woken by push() or stopBackground()
				await new Promise<void>((resolve) => {
					this.wakeResolve = resolve;
				});
			}
		}
		// Drain remaining signals before exiting
		while (this.queue.length > 0) {
			await this.processNext();
		}
		this.processing = false;
	}

	/** Dequeue the next signal, check filtering, and process if it passes. */
	async processNext(): Promise<ProcessResult> {
		const signal = this.queue.shift();
		if (!signal) return "empty";

		const pass = await shouldLearn(signal, this.metrics, this.recentImprovements);
		if (!pass) return "skipped";

		return this.processSignal(signal);
	}

	/** Process a single signal: call LLM, apply mutation, emit events. */
	private async processSignal(signal: LearnSignal): Promise<ProcessResult> {
		if (!this.client) return "skipped";

		this.events.emit("learn_start", signal.agent_name, 0, {
			kind: signal.kind,
			goal: signal.goal,
		});

		try {
			const memoryApplied = await this.extractAndApplyLearnMemories(signal);
			const mutation = await this.reasonAboutImprovement(signal);
			let mutationApplied = false;
			if (mutation) {
				mutationApplied = await this.adoptMutation(mutation);
			}

			// Quartermaster fabrication/repair/curation — gated identically. Only
			// runs when a chokepoint is wired (it must never adopt ungated).
			const fabricated = await this.runQuartermaster();

			if (!memoryApplied && !mutationApplied && !fabricated) {
				this.events.emit("learn_end", signal.agent_name, 0, { result: "skipped" });
				return "skipped";
			}

			// Mark this agent+kind as recently addressed to prevent redundant improvements
			this.recentImprovements.add(`${signal.agent_name}:${signal.kind}`);

			// Label the cycle by what actually applied: the reasoned mutation, a
			// memory extraction, or (neither) a quartermaster adoption.
			this.events.emit("learn_end", signal.agent_name, 0, {
				result: "applied",
				mutation_type:
					mutation?.type ?? (memoryApplied ? MEMORY_EXTRACTION_MUTATION_TYPE : "quartermaster"),
				extracted_memories: memoryApplied,
			});
			return "applied";
		} catch (err) {
			this.events.emit("learn_end", signal.agent_name, 0, {
				result: "error",
				error: err instanceof Error ? err.message : String(err),
			});
			return "error";
		}
	}

	/**
	 * The SOLE gated adoption path (sap spec Phase 5). Route every proposed genome
	 * mutation through the frozen chokepoint before it touches the genome: apply
	 * ONLY on `adopt:true`. When no chokepoint is wired, AGENT mutations fall back
	 * to legacy direct-apply (the post-hoc single-delta evaluatePendingImprovements
	 * remains their rollback safety net); the quartermaster path never reaches
	 * here without a gate. Returns whether the mutation was applied.
	 */
	async adoptMutation(mutation: LearnMutation): Promise<boolean> {
		if (!this.mutationGate) {
			await this.applyMutation(mutation);
			return true;
		}
		const decision = await this.mutationGate.evaluate(mutation);
		this.events.emit("learn_mutation", "learn", 0, {
			mutation_type: "adoption_gate",
			proposed: mutation.type,
			adopt: decision.adopt,
			reason: decision.reason,
		});
		if (!decision.adopt) return false;
		await this.applyMutation(mutation);
		return true;
	}

	/**
	 * Derive `CellObservation[]` from the recorded cell_end events (spec §8): the
	 * redacted cell code, the program it invoked (if any), and whether it
	 * stumbled. This is the raw material the quartermaster reasons over.
	 */
	private cellObservations(): CellObservation[] {
		const observations: CellObservation[] = [];
		for (const event of this.events.collected()) {
			if (event.kind !== "cell_end") continue;
			const code = typeof event.data.code === "string" ? event.data.code : "";
			if (code === "") continue;
			const programs = event.data.programs as { name: string; version: number }[] | undefined;
			observations.push({
				code,
				program: programs && programs.length > 0 ? programs[0] : undefined,
				stumbled: event.data.success === false,
			});
		}
		return observations;
	}

	/**
	 * Wire the quartermaster (sap spec Phase 5): fabricate programs from recurring
	 * cell shapes, flag stumbling programs for retirement, and curate library rot
	 * — turning EACH proposal into a candidate mutation routed through the SAME
	 * chokepoint (`adoptMutation`) as any other mutation. Fabrication/repair/
	 * curation are ordinary gated mutations, never a bypass: this method is inert
	 * unless a chokepoint is wired. Returns whether any proposal was adopted.
	 */
	async runQuartermaster(): Promise<boolean> {
		if (!this.mutationGate) return false;
		const observations = this.cellObservations();
		let adopted = false;
		// Programs fabricated in THIS pass have zero window invocations, so the
		// curator (step 3) would immediately propose retiring them — and under the
		// non-regression curation verdict that retirement could adopt, undoing the
		// fabrication in the same cycle. Guard against that self-churn.
		const fabricatedThisPass = new Set<string>();

		// 1. Fabrication: recurring, non-program cell shapes → new programs.
		for (const candidate of detectRecurringPatterns(observations)) {
			if (this.genome.getProgram(candidate.proposedName)) continue;
			let program: Program;
			try {
				program = proposeProgramFromCandidate(candidate);
			} catch {
				// A redaction-scrubbed body may carry an import token; skip it. The
				// gate would reject it too, but never fabricating it is cheaper.
				continue;
			}
			if (await this.adoptMutation({ type: "create_program", program })) {
				adopted = true;
				fabricatedThisPass.add(program.name);
			}
		}

		// 2. Repair: programs stumbling at a high rate → propose retirement.
		for (const repair of detectRepairCandidates(observations)) {
			if (!this.genome.getProgram(repair.programName)) continue;
			if (await this.adoptMutation({ type: "retire_program", program_name: repair.programName }))
				adopted = true;
		}

		// 3. Curator: never-invoked programs + near-duplicates → retire. A
		// consolidation keeps the first target and retires the rest.
		for (const proposal of curatePrograms(this.genome.allPrograms(), observations)) {
			const targets =
				proposal.action === "consolidate" ? proposal.targets.slice(1) : proposal.targets;
			for (const name of targets) {
				if (fabricatedThisPass.has(name)) continue;
				if (!this.genome.getProgram(name)) continue;
				if (await this.adoptMutation({ type: "retire_program", program_name: name }))
					adopted = true;
			}
		}

		// 4. Agent curation: never-delegated overlay agents + near-duplicates →
		// retire. Scoped to the OVERLAY: root agents are immutable (removeAgent
		// rejects them) and only genome-evolved agents can rot. The usage signal
		// is the collected act_end delegation targets — the genome keeps no
		// per-agent use counter, so the event window is the honest signal.
		const delegated = this.delegatedAgentNames();
		for (const proposal of curateAgents(this.genome.overlayAgents(), {
			delegatedAgentNames: delegated,
		})) {
			const targets =
				proposal.action === "consolidate" ? proposal.targets.slice(1) : proposal.targets;
			for (const name of targets) {
				if (!this.genome.isOverlay(name)) continue;
				if (await this.adoptMutation({ type: "retire_agent", agent_name: name })) adopted = true;
			}
		}

		// 5. Memory curation: stale never-used low-confidence memories + content
		// near-duplicates → retire (archived, not deleted — the memory lifecycle's
		// retirement idiom, keeping the audit trail until log compaction).
		for (const proposal of curateMemories(this.genome.memories.all())) {
			const targets =
				proposal.action === "consolidate" ? proposal.targets.slice(1) : proposal.targets;
			for (const id of targets) {
				const memory = this.genome.memories.getById(id);
				if (!memory || memory.archived_at !== undefined) continue;
				if (await this.adoptMutation({ type: "retire_memory", memory_id: id })) adopted = true;
			}
		}

		return adopted;
	}

	/** Agent names seen as delegation targets in the collected act_end events. */
	private delegatedAgentNames(): Set<string> {
		const names = new Set<string>();
		for (const event of this.events.collected()) {
			if (event.kind !== "act_end") continue;
			if (typeof event.data.agent_name === "string") names.add(event.data.agent_name);
		}
		return names;
	}

	/** Ask the LLM to reason about what mutation to make given a stumble signal. */
	private async reasonAboutImprovement(signal: LearnSignal): Promise<LearnMutation | null> {
		if (!this.client || !this.reasonerModel) return null;

		// Gather genome context for the LLM
		const agents = this.genome.allAgents();
		const agentSummary = agents
			.map((a) => `- ${a.name}: ${a.description} (model: ${a.model})`)
			.join("\n");

		const memories = this.genome.memories.all();
		const memorySummary = memories.map((m) => `- [${m.tags.join(",")}] ${m.content}`).join("\n");

		const currentAgent = this.genome.getAgent(signal.agent_name);
		const currentAgentPrompt = currentAgent?.system_prompt;

		const prompt = `You are analyzing a recurring problem in an AI coding agent system.

## Current System State

Existing agents:
${agentSummary}

Recent memories:
${memorySummary || "(none)"}

${signal.agent_name}'s current system prompt:
${currentAgentPrompt || "(not found)"}

## Stumble Signal

A stumble signal has been detected:
- Agent: ${signal.agent_name}
- Kind: ${signal.kind}
- Goal: ${signal.goal}
- Output: ${signal.details.output}
- Success: ${signal.details.success}
- Stumbles: ${signal.details.stumbles}
- Turns used: ${signal.details.turns}

Factual memory extraction already runs separately from event-window evidence. Do not create memories here.

Based on this signal and the current system state, decide what non-memory improvement to make. Respond with ONLY a JSON object (no markdown, no explanation) matching one of these formats:

1. Update an agent's system prompt:
{"type": "update_agent", "agent_name": "...", "system_prompt": "..."}

2. Create a new specialized agent:
{"type": "create_agent", "name": "...", "description": "...", "system_prompt": "...", "model": "fast", "tools": ["..."], "agents": ["..."], "tags": ["..."]}

3. Create a routing rule (prefer an agent for certain tasks):
{"type": "create_routing_rule", "condition": "...", "preference": "...", "strength": 0.8}

4. Skip (no improvement needed):
{"type": "skip"}

Choose the most appropriate non-memory improvement. Use skip for factual learnings that do not require an agent, subagent, or routing-rule change.`;

		const response = await this.client.complete({
			model: this.reasonerModel.model,
			provider: this.reasonerModel.provider,
			messages: [Msg.user(prompt)],
			temperature: 0.3,
			max_tokens: 1024,
		});

		const text = messageText(response.message).trim();

		// Strip markdown code blocks if present
		let jsonText = text;
		const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (codeBlockMatch) {
			jsonText = codeBlockMatch[1]!.trim();
		}

		try {
			const parsed = JSON.parse(jsonText);
			if (parsed.type === "skip") return null;

			// Validate required fields for each mutation type
			if (parsed.type === "create_memory") {
				return null;
			} else if (parsed.type === "update_agent") {
				if (typeof parsed.agent_name !== "string") return null;
				if (typeof parsed.system_prompt !== "string") return null;
			} else if (parsed.type === "create_agent") {
				if (typeof parsed.name !== "string" || parsed.name.trim() === "") return null;
				if (typeof parsed.description !== "string" || parsed.description.trim() === "") return null;
				if (typeof parsed.system_prompt !== "string" || parsed.system_prompt.trim() === "")
					return null;
				if (typeof parsed.model !== "string" || parsed.model.trim() === "") return null;
				// Migrate old capabilities field into tools and agents
				if (!Array.isArray(parsed.tools)) {
					parsed.tools = Array.isArray(parsed.capabilities)
						? parsed.capabilities.filter((c: string) => !c.includes("/"))
						: [];
				}
				if (!Array.isArray(parsed.agents)) {
					parsed.agents = Array.isArray(parsed.capabilities)
						? parsed.capabilities.filter((c: string) => c.includes("/"))
						: [];
				}
				if (!Array.isArray(parsed.tags)) parsed.tags = [];
			} else if (parsed.type === "create_routing_rule") {
				if (typeof parsed.condition !== "string") return null;
				if (typeof parsed.preference !== "string") return null;
				if (typeof parsed.strength !== "number") return null;
			} else {
				return null; // unknown type
			}
			return parsed as LearnMutation;
		} catch {
			return null;
		}
	}

	/** Apply a structured mutation to the genome. */
	async applyMutation(mutation: LearnMutation): Promise<void> {
		const now = Date.now();

		await applyMutationToGenome(this.genome, mutation);

		const commitHash = await this.genome.lastCommitHash();

		// Determine which agent this mutation targets
		let agentName = "learn";
		let description: string = mutation.type;
		if (mutation.type === "update_agent") {
			agentName = mutation.agent_name;
			description = `Updated system prompt for ${mutation.agent_name}`;
		} else if (mutation.type === "create_agent") {
			agentName = mutation.name;
			description = `Created agent ${mutation.name}`;
		} else if (mutation.type === "create_routing_rule") {
			description = `Created routing rule: ${mutation.condition}`;
		} else if (mutation.type === "create_program") {
			agentName = mutation.program.name;
			description = `Created program ${mutation.program.name}`;
		} else if (mutation.type === "retire_program") {
			agentName = mutation.program_name;
			description = `Retired program ${mutation.program_name}`;
		} else if (mutation.type === "retire_agent") {
			agentName = mutation.agent_name;
			description = `Retired agent ${mutation.agent_name}`;
		} else if (mutation.type === "retire_memory") {
			description = `Retired memory ${mutation.memory_id}`;
		}

		// The legacy single-delta rollback ledger (evaluatePendingImprovements) is
		// valid ONLY for an un-gated AGENT mutation: the agent then acts under its
		// name so the post-hoc stumble-rate delta has data. Enqueue exactly that
		// and nothing else —
		//  - gated mutations already passed the frozen N-run A/B + canary gate; the
		//    noisy single delta must never override that verdict;
		//  - non-agent mutations (programs, routing rules, retirements) accrue no
		//    actions, so an entry could never reach the ≥5-action threshold and
		//    would pile up in the ledger forever.
		const evaluable =
			this.mutationGate === undefined &&
			(mutation.type === "update_agent" || mutation.type === "create_agent");
		if (evaluable) {
			this._pendingEvaluations.push({
				agentName,
				mutationType: mutation.type,
				timestamp: now,
				commitHash,
				description,
			});
			await this.savePendingEvaluations();
		}

		this.events.emit("learn_mutation", "learn", 0, { mutation_type: mutation.type });
	}

	private async extractAndApplyLearnMemories(signal: LearnSignal): Promise<boolean> {
		if (!this.client) return false;
		if (!this.extractionModel) {
			throw new Error("Learn memory extraction requires a configured memory 'extraction' model");
		}
		if (!this.relationshipModel) {
			throw new Error("Learn memory extraction requires a configured memory 'relationship' model");
		}

		const now = Date.now();
		const random = Math.random().toString(36).slice(2, 8);
		const messages = learnSignalExtractionMessages({
			signal,
			events: this.events.collected(),
		});
		if (messages.length === 0) return false;

		const prompts = await this.genome.loadMemoryExtractionPrompts();
		const drafts = await extractMemoryDrafts({
			client: this.client,
			model: this.extractionModel.model,
			provider: this.extractionModel.provider,
			prompts,
			messages,
		});
		if (drafts.length === 0) return false;
		const filtered = await filterDuplicateDrafts(drafts, this.genome.memories.all(), {
			embeddingProvider: await this.genome.memoryEmbeddingProvider(),
		});
		if (filtered.length === 0) return false;

		const memories = filtered.map((draft, index) =>
			memoryFromDraft(draft, {
				id: `learn-${now}-${random}-${index}`,
				source: "learn:extraction",
				now,
				confidence: 0.8,
			}),
		);
		const result = await incorporateExtractedMemories({
			genome: this.genome,
			memories,
			explicitReferenceIds: memoryReferenceIdsFromExtractionMessages(messages),
			client: this.client,
			resolverSettings: this.resolverSettings,
			modelsByProvider: this.modelsByProvider,
			commitMessage: `genome: extract ${filtered.length} learned memories`,
		});
		if (result.memories.length === 0) return false;

		// Memory extraction is not enqueued for post-hoc rollback: it has no agent
		// that accrues actions, so the single-delta ledger could never evaluate it
		// (an entry would accumulate forever). It is committed to the genome
		// directly; a rollback net for memory extraction, if ever needed, is a
		// separate mechanism, not this agent-stumble ledger.
		this.events.emit("learn_mutation", "learn", 0, {
			mutation_type: MEMORY_EXTRACTION_MUTATION_TYPE,
			extracted_count: result.memories.length,
		});
		return true;
	}
}

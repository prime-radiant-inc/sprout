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
	| { type: "create_routing_rule"; condition: string; preference: string; strength: number };

type ReasonedLearnMutation = LearnMutation;

const MEMORY_EXTRACTION_MUTATION_TYPE = "memory_extraction";

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
	providerIdOverride?: string;
	resolverSettings?: ResolverSettings;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: import("../host/logger.ts").Logger;
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
			try {
				this.extractionModel = resolveMemoryModel("extraction", resolverSettings, modelMap);
			} catch {
				this.extractionModel = undefined;
			}
			try {
				this.relationshipModel = resolveMemoryModel("relationship", resolverSettings, modelMap);
			} catch {
				this.relationshipModel = undefined;
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
	 * of the `delta` threshold below. Wiring it here requires the N-run harness
	 * (Phase 7 eval), which does not yet exist, so this stays a single-delta
	 * heuristic and the significance gate lives as a tested standalone module.
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
				await this.applyMutation(mutation);
				mutationApplied = true;
			}

			if (!memoryApplied && !mutationApplied) {
				this.events.emit("learn_end", signal.agent_name, 0, { result: "skipped" });
				return "skipped";
			}

			// Mark this agent+kind as recently addressed to prevent redundant improvements
			this.recentImprovements.add(`${signal.agent_name}:${signal.kind}`);

			this.events.emit("learn_end", signal.agent_name, 0, {
				result: "applied",
				mutation_type: mutation?.type ?? MEMORY_EXTRACTION_MUTATION_TYPE,
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

	/** Ask the LLM to reason about what mutation to make given a stumble signal. */
	private async reasonAboutImprovement(signal: LearnSignal): Promise<ReasonedLearnMutation | null> {
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
			return parsed as ReasonedLearnMutation;
		} catch {
			return null;
		}
	}

	/** Apply a structured mutation to the genome. */
	async applyMutation(mutation: LearnMutation): Promise<void> {
		const now = Date.now();
		const random = Math.random().toString(36).slice(2, 8);

		switch (mutation.type) {
			case "update_agent": {
				const existing = this.genome.getAgent(mutation.agent_name);
				if (!existing) {
					throw new Error(`Cannot update agent '${mutation.agent_name}': not found`);
				}
				await this.genome.updateAgent({
					...existing,
					system_prompt: mutation.system_prompt,
				});
				break;
			}
			case "create_agent": {
				validateAgentName(mutation.name);
				await this.genome.addAgent({
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
				await this.genome.addRoutingRule({
					id: `learn-rule-${now}-${random}`,
					condition: mutation.condition,
					preference: mutation.preference,
					strength: mutation.strength,
					source: "learn",
				});
				break;
			}
		}

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
		}

		this._pendingEvaluations.push({
			agentName,
			mutationType: mutation.type,
			timestamp: now,
			commitHash,
			description,
		});
		await this.savePendingEvaluations();

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

		const commitHash = await this.genome.lastCommitHash();
		this._pendingEvaluations.push({
			agentName: "learn",
			mutationType: MEMORY_EXTRACTION_MUTATION_TYPE,
			timestamp: now,
			commitHash,
			description: `Extracted ${result.memories.length} memories from learn signal`,
		});
		await this.savePendingEvaluations();
		this.events.emit("learn_mutation", "learn", 0, {
			mutation_type: MEMORY_EXTRACTION_MUTATION_TYPE,
			extracted_count: result.memories.length,
		});
		return true;
	}
}

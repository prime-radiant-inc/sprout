import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEventEmitter } from "../agents/events.ts";
import type { ResolvedModel } from "../agents/model-resolver.ts";
import { resolveModel } from "../agents/model-resolver.ts";
import type { Genome } from "../genome/genome.ts";
import type { LearnSignal } from "../kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../kernel/types.ts";
import type { Client } from "../llm/client.ts";
import { Msg, messageText } from "../llm/types.ts";
import type { MetricsStore } from "./metrics-store.ts";
import { shouldLearn } from "./should-learn.ts";

/** Tool primitives that form the kernel's interface — cannot be shadowed by Learn. */
const KERNEL_PRIMITIVE_NAMES = new Set([
	"read_file",
	"write_file",
	"edit_file",
	"apply_patch",
	"exec",
	"grep",
	"glob",
	"fetch",
]);

/** Core loop phases and the learn process itself — reserved by the kernel. */
const KERNEL_RESERVED_NAMES = new Set([
	"learn",
	"kernel",
	"perceive",
	"recall",
	"plan",
	"act",
	"verify",
]);

function validateAgentName(name: string): void {
	if (KERNEL_PRIMITIVE_NAMES.has(name)) {
		throw new Error(
			`Cannot create agent '${name}': name is a kernel primitive and cannot be shadowed`,
		);
	}
	if (KERNEL_RESERVED_NAMES.has(name)) {
		throw new Error(`Cannot create agent '${name}': name is reserved by the kernel`);
	}
}

export type LearnMutation =
	| { type: "create_memory"; content: string; tags: string[] }
	| { type: "update_agent"; agent_name: string; system_prompt: string }
	| {
			type: "create_agent";
			name: string;
			description: string;
			system_prompt: string;
			model: string;
			capabilities: string[];
			tags: string[];
	  }
	| { type: "create_routing_rule"; condition: string; preference: string; strength: number };

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
	private readonly resolvedModel?: ResolvedModel;
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
			this.resolvedModel = resolveModel("best", this.client.providers());
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
			const actionCount = await this.metrics.actionCountSince(
				pending.agentName,
				pending.timestamp,
			);

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

	/** Evaluate whether an improvement helped by comparing stumble rates before and after. */
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
			const mutation = await this.reasonAboutImprovement(signal);
			if (!mutation) {
				this.events.emit("learn_end", signal.agent_name, 0, { result: "skipped" });
				return "skipped";
			}

			await this.applyMutation(mutation);

			// Mark this agent+kind as recently addressed to prevent redundant improvements
			this.recentImprovements.add(`${signal.agent_name}:${signal.kind}`);

			this.events.emit("learn_end", signal.agent_name, 0, {
				result: "applied",
				mutation_type: mutation.type,
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
	private async reasonAboutImprovement(signal: LearnSignal): Promise<LearnMutation | null> {
		if (!this.client || !this.resolvedModel) return null;

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

Based on this signal and the current system state, decide what improvement to make. Respond with ONLY a JSON object (no markdown, no explanation) matching one of these formats:

1. Create a memory (learned fact):
{"type": "create_memory", "content": "...", "tags": ["...", "..."]}

2. Update an agent's system prompt:
{"type": "update_agent", "agent_name": "...", "system_prompt": "..."}

3. Create a new specialized agent:
{"type": "create_agent", "name": "...", "description": "...", "system_prompt": "...", "model": "fast", "capabilities": ["..."], "tags": ["..."]}

4. Create a routing rule (prefer an agent for certain tasks):
{"type": "create_routing_rule", "condition": "...", "preference": "...", "strength": 0.8}

5. Skip (no improvement needed):
{"type": "skip"}

Choose the most appropriate improvement. Prefer creating memories for factual learnings, updating agents for behavioral changes, and routing rules for delegation patterns.`;

		const response = await this.client.complete({
			model: this.resolvedModel.model,
			provider: this.resolvedModel.provider,
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
			if (
				parsed.type === "create_memory" ||
				parsed.type === "update_agent" ||
				parsed.type === "create_agent" ||
				parsed.type === "create_routing_rule"
			) {
				return parsed as LearnMutation;
			}
			return null;
		} catch {
			return null;
		}
	}

	/** Apply a structured mutation to the genome. */
	async applyMutation(mutation: LearnMutation): Promise<void> {
		const now = Date.now();
		const random = Math.random().toString(36).slice(2, 8);

		switch (mutation.type) {
			case "create_memory": {
				await this.genome.addMemory({
					id: `learn-${now}-${random}`,
					content: mutation.content,
					tags: mutation.tags,
					source: "learn",
					created: now,
					last_used: now,
					use_count: 0,
					confidence: 0.8,
				});
				break;
			}
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
					capabilities: mutation.capabilities,
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
		} else if (mutation.type === "create_memory") {
			description = `Created memory: ${mutation.content.slice(0, 80)}`;
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
}

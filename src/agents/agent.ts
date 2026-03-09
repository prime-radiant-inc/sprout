import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSpawner } from "../bus/spawner.ts";
import type { CallerIdentity, ResultMessage } from "../bus/types.ts";
import { compactHistory } from "../core/compaction.ts";
import type { Logger } from "../core/logger.ts";
import { NullLogger } from "../core/logger.ts";
import type { Genome } from "../genome/genome.ts";
import { recall } from "../genome/recall.ts";
import type { ExecutionEnvironment } from "../kernel/execution-env.ts";
import { checkPathConstraint, validateConstraints } from "../kernel/path-constraints.js";
import type { PrimitiveRegistry } from "../kernel/primitives.ts";
import { buildAgentToolPrimitives } from "../kernel/tool-loading.ts";
import { truncateToolOutput } from "../kernel/truncation.ts";
import {
	type ActResult,
	type AgentCommand,
	type AgentSpec,
	type Delegation,
	type EventKind,
	MAX_AGENT_DEPTH,
	type Memory,
	type RoutingRule,
} from "../kernel/types.ts";
import type { LearnSink } from "../learn/learn-process.ts";
import type { Client } from "../llm/client.ts";
import { type RetryOptions, retryLLMCall } from "../llm/retry.ts";
import type {
	Request as LLMRequest,
	Response as LLMResponse,
	Message,
	StreamEvent,
	ToolCall,
	ToolDefinition,
} from "../llm/types.ts";
import { Msg, messageText } from "../llm/types.ts";
import { ulid } from "../util/ulid.ts";
import { getContextWindowSize } from "./context-window.ts";
import { AgentEventEmitter } from "./events.ts";
import type { AgentTreeEntry, Preambles } from "./loader.ts";
import { findRootToolsDir, resolveRootToolsDir } from "./loader.ts";
import { generateMnemonicName } from "./mnemonic.ts";
import { defaultModelsByProvider, type ResolvedModel, resolveModel } from "./model-resolver.ts";
import type { Postscripts } from "./plan.ts";
import {
	buildDelegateTool,
	buildMessageAgentTool,
	buildSystemPrompt,
	buildWaitAgentTool,
	parsePlanResponse,
	primitivesForAgent,
	renderAgentsForPrompt,
	renderToolBoundaries,
	renderWorkspaceTools,
} from "./plan.ts";
import { resolveAgentDelegates } from "./resolver.ts";
import { evaluateCompaction } from "./run-loop-compaction.ts";
import { applyRetryAccounting, finalizeRunLoopResult } from "./run-loop-finalize.ts";
import { executePlanningTurn } from "./run-loop-planning.ts";
import { type CallRecord, verifyActResult, verifyPrimitiveResult } from "./verify.ts";

export interface AgentOptions {
	spec: AgentSpec;
	env: ExecutionEnvironment;
	client: Client;
	primitiveRegistry: PrimitiveRegistry;
	availableAgents: AgentSpec[];
	genome?: Genome;
	depth?: number;
	events?: AgentEventEmitter;
	sessionId?: string;
	learnProcess?: LearnSink;
	/** Base path for session log. Events written to ${logBasePath}.jsonl. Subagent logs go in ${logBasePath}/subagents/. */
	logBasePath?: string;
	/** Prior conversation history to prepend (for resume/continuation). */
	initialHistory?: Message[];
	/** Override the spec's model for this agent instance. */
	modelOverride?: string;
	/** Prompt preambles (global + role-specific) to prepend to system prompt. */
	preambles?: Preambles;
	/** AGENTS.md project documentation for top-level agent only. */
	projectDocs?: string;
	/** Genome postscript data (global + role, without agent-specific). */
	genomePostscripts?: { global: string; orchestrator: string; worker: string };
	/** Bus-based spawner for running subagents as separate processes. */
	spawner?: AgentSpawner;
	/** Path to the genome directory (required when using a spawner). */
	genomePath?: string;
	/** Per-project data directory (sessions, logs, memory). */
	projectDataDir?: string;
	/** Override the agent_id used for event emission (used by parent to assign unique child IDs). */
	agentId?: string;
	/** Pre-fetched model map for tier resolution. */
	modelsByProvider?: Map<string, string[]>;
	/** Structured logger for LLM call logging and diagnostics. */
	logger?: Logger;
	/** Path to root agent directory (for two-layer tool resolution). */
	rootDir?: string;
	/** Agent tree for path-based delegation resolution. */
	agentTree?: Map<string, AgentTreeEntry>;
	/** Bare child names for this agent in the tree (from the tree entry's children array). */
	agentTreeChildren?: string[];
	/** This agent's path in the tree (empty string for root). */
	agentTreeSelfPath?: string;
	/** Use streaming LLM calls and emit throttled llm_chunk events. */
	enableStreaming?: boolean;
	/** Override retry backoff settings for LLM calls (tests/tuning). */
	llmRetryOptions?: Omit<RetryOptions, "signal" | "onRetry">;
}

export interface AgentResult {
	output: string;
	success: boolean;
	stumbles: number;
	turns: number;
	timed_out: boolean;
}

export class Agent {
	readonly spec: AgentSpec;
	private readonly env: ExecutionEnvironment;
	private readonly client: Client;
	private readonly primitiveRegistry: PrimitiveRegistry;
	private readonly availableAgents: AgentSpec[];
	private readonly genome?: Genome;
	private readonly depth: number;
	private readonly events: AgentEventEmitter;
	private readonly sessionId: string;
	private readonly learnProcess?: LearnSink;
	private readonly resolved: ResolvedModel;
	private agentTools: ToolDefinition[];
	private readonly primitiveTools: ToolDefinition[];
	private readonly logBasePath?: string;
	private readonly preambles?: Preambles;
	private readonly projectDocs?: string;
	private readonly genomePostscripts?: { global: string; orchestrator: string; worker: string };
	private readonly spawner?: AgentSpawner;
	private readonly genomePath?: string;
	private readonly projectDataDir?: string;
	private readonly agentId?: string;
	private readonly initialHistory?: Message[];
	private readonly rootDir?: string;
	private readonly agentTree?: Map<string, AgentTreeEntry>;
	private readonly agentTreeChildren?: string[];
	private readonly agentTreeSelfPath?: string;
	private readonly enableStreaming: boolean;
	private readonly llmRetryOptions?: Omit<RetryOptions, "signal" | "onRetry">;
	private readonly logger: Logger;
	private history: Message[] = [];
	private systemPrompt?: string;
	private signal?: AbortSignal;
	private logWriteChain: Promise<void> = Promise.resolve();
	private steeringQueue: string[] = [];
	private compactionRequested = false;
	private turnsSinceCompaction = Infinity;
	private lastGenomeGeneration = 0;
	private lastDelegateNames: Set<string> = new Set();
	private readonly usedMnemonicNames = new Set<string>();

	constructor(options: AgentOptions) {
		this.spec = options.spec;
		this.env = options.env;
		this.client = options.client;
		this.primitiveRegistry = options.primitiveRegistry;
		this.availableAgents = options.availableAgents;
		this.genome = options.genome;
		this.depth = options.depth ?? 0;
		this.events = options.events ?? new AgentEventEmitter();
		this.sessionId = options.sessionId ?? ulid();
		this.learnProcess = options.learnProcess;
		this.logBasePath = options.logBasePath;
		this.preambles = options.preambles;
		this.projectDocs = options.projectDocs;
		this.genomePostscripts = options.genomePostscripts;
		this.spawner = options.spawner;
		this.genomePath = options.genomePath;
		this.projectDataDir = options.projectDataDir;
		this.agentId = options.agentId;
		this.rootDir = options.rootDir;
		this.agentTree = options.agentTree;
		this.agentTreeChildren = options.agentTreeChildren;
		this.agentTreeSelfPath = options.agentTreeSelfPath;
		this.enableStreaming = options.enableStreaming ?? false;
		this.llmRetryOptions = options.llmRetryOptions;
		this.initialHistory = options.initialHistory ? [...options.initialHistory] : undefined;
		this.logger = (options.logger ?? new NullLogger()).child({
			component: "agent",
			agentId: this.agentId ?? this.spec.name,
			sessionId: this.sessionId,
			depth: this.depth,
		});

		// Root is depth 0. The deepest allowed child is MAX_AGENT_DEPTH.
		if (this.depth > MAX_AGENT_DEPTH) {
			throw new Error(
				`Agent '${this.spec.name}' exceeds global max depth: depth=${this.depth}, limit=${MAX_AGENT_DEPTH}`,
			);
		}

		// Validate that path constraints are compatible with tools
		validateConstraints(this.spec.name, this.spec.tools, this.spec.constraints);

		// Resolve model and provider
		const modelMap = options.modelsByProvider ?? defaultModelsByProvider(this.client.providers());
		this.resolved = resolveModel(options.modelOverride ?? this.spec.model, modelMap);

		// Build delegate tool (single tool for all agent delegations)
		this.agentTools = [];

		if (this.spec.constraints.can_spawn) {
			const delegatableAgents = this.getDelegatableAgents();

			if (delegatableAgents.length > 0) {
				this.agentTools.push(buildDelegateTool(delegatableAgents));
				if (this.spawner) {
					this.agentTools.push(buildWaitAgentTool());
					this.agentTools.push(buildMessageAgentTool());
				}
			}

			this.lastDelegateNames = new Set(delegatableAgents.map((a) => a.name));
		}

		if (this.genome) {
			this.lastGenomeGeneration = this.genome.generation;
		}

		// Build primitive tool list (provider-aligned).
		// Agents that delegate don't get primitives — primitives live on subagents only.
		this.primitiveTools = [];
		if (this.agentTools.length === 0) {
			const filteredPrimitiveNames = primitivesForAgent(
				this.spec.tools,
				this.primitiveRegistry.names(),
				this.resolved.provider,
			);

			for (const name of filteredPrimitiveNames) {
				const prim = this.primitiveRegistry.get(name);
				if (prim) {
					this.primitiveTools.push({
						name: prim.name,
						description: prim.description,
						parameters: prim.parameters,
					});
				}
			}
		}

		// Safety: an agent with zero tools will hallucinate — never allow this silently.
		// If genome exists, workspace tools may load later in run(), so defer the check.
		if (this.agentTools.length === 0 && this.primitiveTools.length === 0 && !this.genome) {
			throw new Error(
				`Agent '${this.spec.name}' has zero tools: no primitives (tools: [${this.spec.tools.join(", ")}]) ` +
					`and no delegatable agents (agents: [${this.spec.agents.join(", ")}], can_spawn: ${this.spec.constraints.can_spawn}). ` +
					`This would cause the LLM to hallucinate tool calls. Check the agent spec and ensure ` +
					`agent refs resolve (path-style refs like "utility/reader" require the agent tree).`,
			);
		}
	}

	/** Returns the resolved model and provider for this agent. */
	get resolvedModel(): ResolvedModel {
		return this.resolved;
	}

	/** Returns all tools this agent can use (agent tools + primitive tools) */
	resolvedTools(): ToolDefinition[] {
		return [...this.agentTools, ...this.primitiveTools];
	}

	/** Returns a shallow copy of the current conversation history. */
	currentHistory(): Message[] {
		return [...this.history];
	}

	/** Inject a steering message into the agent loop for the next iteration. */
	steer(text: string): void {
		this.steeringQueue.push(text);
	}

	/** Request compaction on the next iteration (for manual /compact command). */
	requestCompaction(): void {
		this.compactionRequested = true;
	}

	/** Return and clear all queued steering messages. */
	private drainSteering(): string[] {
		const queued = this.steeringQueue.splice(0);
		return queued;
	}

	/** Emit an event and append it to the log file if logging is enabled. */
	private emitAndLog(
		kind: EventKind,
		agentId: string,
		depth: number,
		data: Record<string, unknown>,
	): void {
		this.events.emit(kind, agentId, depth, data);
		if (this.logBasePath) {
			const event = { kind, timestamp: Date.now(), agent_id: agentId, depth, data };
			const line = `${JSON.stringify(event)}\n`;
			this.logWriteChain = this.logWriteChain
				.then(() => appendFile(`${this.logBasePath}.jsonl`, line))
				.catch(() => {});
		}
	}

	/** Wait for all pending log writes to complete. */
	private async flushLog(): Promise<void> {
		await this.logWriteChain;
	}

	/** Minimum interval between llm_chunk emissions (milliseconds). */
	private static readonly LLM_CHUNK_THROTTLE_MS = 500;

	/** Complete an LLM request using streaming, emitting throttled llm_chunk events. */
	private async completeWithStreaming(
		request: LLMRequest,
		agentId: string,
		llmStartTime: number,
		signal?: AbortSignal,
	): Promise<LLMResponse> {
		let chunkCount = 0;
		let lastChunkTime = -Infinity;

		// Helper: race iterator.next() against the abort signal so we don't
		// block on a slow/hanging stream when the caller wants to cancel.
		const abortError = () => new DOMException("Aborted", "AbortError");
		const nextOrAbort = (
			iter: AsyncIterator<StreamEvent>,
			sig?: AbortSignal,
		): Promise<IteratorResult<StreamEvent>> => {
			if (!sig) return iter.next();
			if (sig.aborted) return Promise.reject(abortError());
			return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
				const onAbort = () => reject(abortError());
				sig.addEventListener("abort", onAbort, { once: true });
				iter.next().then(
					(val) => {
						sig.removeEventListener("abort", onAbort);
						resolve(val);
					},
					(err) => {
						sig.removeEventListener("abort", onAbort);
						reject(err);
					},
				);
			});
		};

		const iterator = this.client.stream(request)[Symbol.asyncIterator]();
		try {
			let result = await nextOrAbort(iterator, signal);
			while (!result.done) {
				const event = result.value;
				if (
					event.type === "text_delta" ||
					event.type === "tool_call_delta" ||
					event.type === "reasoning_delta"
				) {
					chunkCount++;
					const now = performance.now();
					const elapsed = now - llmStartTime;
					if (now - lastChunkTime >= Agent.LLM_CHUNK_THROTTLE_MS) {
						this.emitAndLog("llm_chunk", agentId, this.depth, {
							chunks_so_far: chunkCount,
							elapsed_ms: Math.round(elapsed),
						});
						lastChunkTime = now;
					}
				}
				if (event.type === "error") {
					throw event.error ?? new Error("Stream error");
				}
				if (event.type === "finish") {
					if (!event.response) {
						throw new Error("Stream finished but response was missing");
					}
					return event.response;
				}
				result = await nextOrAbort(iterator, signal);
			}
		} finally {
			// Ensure the underlying HTTP stream is closed even if we break out
			// of the loop early (e.g., on abort or error).  When the signal is
			// already aborted the generator might be stuck on an unresolvable
			// internal await, so fire-and-forget to avoid hanging.
			if (signal?.aborted) {
				void iterator.return?.();
			} else {
				await iterator.return?.();
			}
		}

		// Should not reach here — finish event should always be emitted
		throw new Error("Stream ended without a finish event");
	}

	/** Get the current list of agents this agent can delegate to, preferring tree or genome over static snapshot. */
	private getDelegatableAgents(): AgentSpec[] {
		if (this.agentTree) {
			const resolved = resolveAgentDelegates(
				this.agentTree,
				this.spec.name,
				this.agentTreeSelfPath ?? "",
				this.agentTreeChildren ?? [],
				this.spec.agents,
			);
			return resolved.map((d) => this.resolveGenomeDelegateSpec(d.spec));
		}
		const agents: AgentSpec[] = [];
		const source = this.genome ? this.genome.allAgents() : this.availableAgents;
		for (const ref of this.spec.agents) {
			if (ref === this.spec.name) continue;
			// Match on exact name first, then try leaf name for path-style refs (e.g. "utility/reader" → "reader")
			const agentSpec =
				source.find((a) => a.name === ref) ??
				(ref.includes("/") ? source.find((a) => a.name === ref.split("/").pop()) : undefined);
			if (agentSpec) agents.push(agentSpec);
		}
		return agents;
	}

	/**
	 * Check if the genome has new agents and refresh delegation tools if so.
	 * Returns info about newly added agents, or null if nothing changed.
	 */
	private async refreshDelegationList(): Promise<Array<{
		name: string;
		description: string;
	}> | null> {
		if (!this.genome || !this.spec.constraints.can_spawn) return null;
		await this.genome.refreshIfDiskChanged();
		if (this.genome.generation === this.lastGenomeGeneration) return null;
		this.lastGenomeGeneration = this.genome.generation;

		// Sync new genome agents into the shared agent tree so all agents
		// (including siblings) see them via the shared Map reference.
		if (this.agentTree) {
			for (const spec of this.genome.allAgents()) {
				if (!this.agentTree.has(spec.name)) {
					this.agentTree.set(spec.name, {
						spec,
						path: spec.name,
						children: [],
						// diskPath is empty because these agents were created at
						// runtime by the fabricator and have no on-disk directory.
						diskPath: "",
					});
					// Only the root agent (selfPath === "") adds new children
					// directly.  Non-root agents discover new delegates through
					// getDelegatableAgents() which re-resolves against the
					// updated tree, so they don't need manual child insertion.
					if (this.agentTreeSelfPath === "" && this.agentTreeChildren) {
						this.agentTreeChildren.push(spec.name);
					}
				}
			}
		}

		// Re-resolve delegates with updated tree/genome
		const newDelegates = this.getDelegatableAgents();
		const newNames = new Set(newDelegates.map((a) => a.name));

		// Diff: find genuinely new agents
		const added = newDelegates.filter((a) => !this.lastDelegateNames.has(a.name));
		if (added.length === 0) {
			this.lastDelegateNames = newNames;
			return null;
		}

		// Rebuild agent tools with updated delegate list
		this.agentTools = [buildDelegateTool(newDelegates)];
		if (this.spawner) {
			this.agentTools.push(buildWaitAgentTool());
			this.agentTools.push(buildMessageAgentTool());
		}

		// If this agent previously had no delegates, it was given primitive
		// tools (the constructor rule: "agents that delegate don't get
		// primitives").  Now that it has delegation tools, clear primitives
		// to preserve that invariant.
		if (this.primitiveTools.length > 0) {
			this.primitiveTools.length = 0;
		}

		this.lastDelegateNames = newNames;
		return added.map((a) => ({ name: a.name, description: a.description }));
	}

	private resolveGenomeDelegateSpec(spec: AgentSpec): AgentSpec {
		if (!this.genome) return spec;
		return this.genome.getAgent(spec.name) ?? spec;
	}

	/**
	 * Resolve a delegation target against this agent's effective allowlist.
	 *
	 * Effective allowlist:
	 * - Tree mode: auto-discovered children + explicit spec.agents refs
	 * - Non-tree mode: explicit spec.agents refs
	 */
	private resolveDelegationTarget(agentName: string): {
		spec?: AgentSpec;
		treePath?: string;
		allowedNames: string[];
	} {
		const allowedNames = new Set<string>();

		if (this.agentTree) {
			const resolved = resolveAgentDelegates(
				this.agentTree,
				this.spec.name,
				this.agentTreeSelfPath ?? "",
				this.agentTreeChildren ?? [],
				this.spec.agents,
			);

			let match: { spec: AgentSpec; path: string } | undefined;
			for (const delegate of resolved) {
				allowedNames.add(delegate.spec.name);
				allowedNames.add(delegate.path);
				if (agentName === delegate.spec.name || agentName === delegate.path) {
					match = delegate;
				}
			}

			return {
				spec: match ? this.resolveGenomeDelegateSpec(match.spec) : undefined,
				treePath: match?.path,
				allowedNames: [...allowedNames].sort(),
			};
		}

		const source = this.genome ? this.genome.allAgents() : this.availableAgents;
		let match: AgentSpec | undefined;
		for (const ref of this.spec.agents) {
			if (ref === this.spec.name) continue;
			const agentSpec =
				source.find((a) => a.name === ref) ??
				(ref.includes("/") ? source.find((a) => a.name === ref.split("/").pop()) : undefined);
			if (!agentSpec) continue;

			allowedNames.add(ref);
			allowedNames.add(agentSpec.name);
			if (agentName === ref || agentName === agentSpec.name) {
				match = agentSpec;
			}
		}

		return { spec: match, allowedNames: [...allowedNames].sort() };
	}

	private buildDelegationDeniedError(agentName: string, allowedNames: string[]): string {
		const allowed = allowedNames.length > 0 ? allowedNames.join(", ") : "(none)";
		return `Agent '${agentName}' is not delegatable by '${this.spec.name}'. Allowed delegates: ${allowed}`;
	}

	private buildDepthLimitError(agentName: string): string {
		return `Delegation to '${agentName}' would exceed global max depth: child_depth=${this.depth + 1}, limit=${MAX_AGENT_DEPTH}`;
	}

	/** Execute a single delegation to a subagent. Returns the tool result message and stumble count. */
	private async executeDelegation(
		delegation: Delegation,
		agentId: string,
	): Promise<{ toolResultMsg: Message; stumbles: number; output?: string }> {
		const childId = ulid();

		// Generate mnemonic name for this child agent
		const mnemonicName = await generateMnemonicName(
			this.client,
			this.resolved.model,
			this.resolved.provider,
			{
				agentName: delegation.agent_name,
				goal: delegation.goal,
				description: delegation.description,
				usedNames: [...this.usedMnemonicNames],
			},
			this.signal,
		);
		if (mnemonicName) this.usedMnemonicNames.add(mnemonicName);

		this.emitAndLog("act_start", agentId, this.depth, {
			agent_name: delegation.agent_name,
			goal: delegation.goal,
			...(delegation.description ? { description: delegation.description } : {}),
			child_id: childId,
			...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
		});

		const descData = delegation.description ? { description: delegation.description } : {};
		const target = this.resolveDelegationTarget(delegation.agent_name);
		const subagentSpec = target.spec;
		const treeEntry =
			target.treePath && this.agentTree ? this.agentTree.get(target.treePath) : undefined;

		if (!subagentSpec) {
			const errorMsg = this.buildDelegationDeniedError(delegation.agent_name, target.allowedNames);
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				child_id: childId,
				...descData,
				tool_result_message: toolResultMsg,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
			});
			return { toolResultMsg, stumbles: 1 };
		}

		if (this.depth + 1 > MAX_AGENT_DEPTH) {
			const errorMsg = this.buildDepthLimitError(delegation.agent_name);
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				child_id: childId,
				...descData,
				tool_result_message: toolResultMsg,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
			});
			return { toolResultMsg, stumbles: 1 };
		}

		try {
			let subGoal = delegation.goal;
			if (delegation.hints && delegation.hints.length > 0) {
				subGoal += `\n\nHints:\n${delegation.hints.map((h) => `- ${h}`).join("\n")}`;
			}

			const subLogBasePath = this.logBasePath
				? `${this.logBasePath}/subagents/${ulid()}`
				: undefined;

			// Resolve the subagent's tree context (selfPath and children)
			let subTreeSelfPath: string | undefined;
			let subTreeChildren: string[] | undefined;
			if (treeEntry) {
				subTreeSelfPath = treeEntry.path;
				subTreeChildren = treeEntry.children;
			}

			const subagent = new Agent({
				spec: subagentSpec,
				env: this.env,
				client: this.client,
				primitiveRegistry: this.primitiveRegistry,
				availableAgents: this.genome ? this.genome.allAgents() : this.availableAgents,
				genome: this.genome,
				depth: this.depth + 1,
				events: this.events,
				sessionId: this.sessionId,
				learnProcess: this.learnProcess,
				logBasePath: subLogBasePath,
				preambles: this.preambles,
				genomePostscripts: this.genomePostscripts,
				agentId: childId,
				logger: this.logger,
				rootDir: this.rootDir,
				agentTree: this.agentTree,
				agentTreeChildren: subTreeChildren,
				agentTreeSelfPath: subTreeSelfPath,
				enableStreaming: this.enableStreaming,
			});

			const subResult = await subagent.run(subGoal, this.signal);

			const actResult: ActResult = {
				agent_name: delegation.agent_name,
				goal: delegation.goal,
				output: subResult.output,
				success: subResult.success,
				stumbles: subResult.stumbles,
				turns: subResult.turns,
				timed_out: subResult.timed_out,
			};

			const { verify, learnSignal } = verifyActResult(actResult, this.sessionId);

			this.emitAndLog("verify", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: verify.success,
				stumbled: verify.stumbled,
			});

			if (learnSignal) {
				this.emitAndLog("learn_signal", agentId, this.depth, {
					signal: learnSignal,
				});
				if (this.learnProcess && this.spec.constraints.can_learn) {
					this.learnProcess.push(learnSignal);
				}
			}

			const resultContent = truncateToolOutput(subResult.output, delegation.agent_name);
			const toolResultMsg = Msg.toolResult(delegation.call_id, resultContent);

			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: subResult.success,
				turns: subResult.turns,
				timed_out: subResult.timed_out,
				child_id: childId,
				...descData,
				tool_result_message: toolResultMsg,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
			});

			if (this.learnProcess) {
				this.learnProcess.recordAction(agentId);
			}

			return {
				toolResultMsg,
				stumbles: verify.stumbled ? 1 : 0,
				output: subResult.output,
			};
		} catch (err) {
			const errorMsg = `Subagent '${delegation.agent_name}' failed: ${String(err)}`;
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				child_id: childId,
				...descData,
				tool_result_message: toolResultMsg,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
			});
			return { toolResultMsg, stumbles: 1 };
		}
	}

	/**
	 * Execute a delegation via the bus-based spawner. Returns the tool result message and stumble count.
	 *
	 * For blocking spawns, calls verifyActResult() and pushes learn signals
	 * (parity with the in-process executeDelegation() path).
	 */
	private async executeSpawnerDelegation(
		delegation: Delegation,
		agentId: string,
	): Promise<{ toolResultMsg: Message; stumbles: number; output?: string }> {
		const handleId = ulid();
		const childId = ulid();
		const descData = delegation.description ? { description: delegation.description } : {};

		const mnemonicName = await generateMnemonicName(
			this.client,
			this.resolved.model,
			this.resolved.provider,
			{
				agentName: delegation.agent_name,
				goal: delegation.goal,
				description: delegation.description,
				usedNames: [...this.usedMnemonicNames],
			},
			this.signal,
		);
		if (mnemonicName) this.usedMnemonicNames.add(mnemonicName);

		this.emitAndLog("act_start", agentId, this.depth, {
			agent_name: delegation.agent_name,
			goal: delegation.goal,
			...descData,
			handle_id: handleId,
			child_id: childId,
			...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
		});
		const target = this.resolveDelegationTarget(delegation.agent_name);
		if (!target.spec) {
			const errorMsg = this.buildDelegationDeniedError(delegation.agent_name, target.allowedNames);
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				child_id: childId,
				...descData,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: 1 };
		}

		if (this.depth + 1 > MAX_AGENT_DEPTH) {
			const errorMsg = this.buildDepthLimitError(delegation.agent_name);
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				child_id: childId,
				...descData,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: 1 };
		}

		const caller: CallerIdentity = { agent_name: this.spec.name, depth: this.depth };
		const blocking = delegation.blocking !== false; // default true
		const shared = delegation.shared === true; // default false

		try {
			const result = await this.spawner!.spawnAgent({
				agentName: delegation.agent_name,
				genomePath: this.genomePath ?? "",
				projectDataDir: this.projectDataDir,
				caller,
				goal: delegation.goal,
				hints: delegation.hints,
				blocking,
				shared,
				workDir: this.env.working_directory(),
				handleId,
				agentId: childId,
				rootDir: this.rootDir,
				mnemonicName: mnemonicName ?? undefined,
			});

			if (!blocking) {
				// Non-blocking: result is a handle ID string
				const handleId = result as string;
				const toolResultMsg = Msg.toolResult(
					delegation.call_id,
					`Agent started. Handle: ${handleId}`,
				);
				this.emitAndLog("act_end", agentId, this.depth, {
					agent_name: delegation.agent_name,
					success: true,
					handle_id: handleId,
					child_id: childId,
					...descData,
					...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
					tool_result_message: toolResultMsg,
				});
				return { toolResultMsg, stumbles: 0, output: handleId };
			}

			// Blocking: result is a ResultMessage
			const resultMsg = result as ResultMessage;

			// Verify and generate learn signals (parity with in-process delegation)
			const actResult: ActResult = {
				agent_name: delegation.agent_name,
				goal: delegation.goal,
				output: resultMsg.output,
				success: resultMsg.success,
				stumbles: resultMsg.stumbles,
				turns: resultMsg.turns,
				timed_out: resultMsg.timed_out,
			};

			const { verify, learnSignal } = verifyActResult(actResult, this.sessionId);

			this.emitAndLog("verify", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: verify.success,
				stumbled: verify.stumbled,
			});

			if (learnSignal) {
				this.emitAndLog("learn_signal", agentId, this.depth, {
					signal: learnSignal,
				});
				if (this.learnProcess && this.spec.constraints.can_learn) {
					this.learnProcess.push(learnSignal);
				}
			}

			if (this.learnProcess) {
				this.learnProcess.recordAction(agentId);
			}

			const truncated = truncateToolOutput(resultMsg.output, delegation.agent_name);
			const content = `${truncated}\n\nHandle: ${resultMsg.handle_id}`;
			const toolResultMsg = Msg.toolResult(delegation.call_id, content);

			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: resultMsg.success,
				handle_id: resultMsg.handle_id,
				turns: resultMsg.turns,
				timed_out: resultMsg.timed_out,
				child_id: childId,
				...descData,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
				tool_result_message: toolResultMsg,
			});

			return {
				toolResultMsg,
				stumbles: verify.stumbled ? 1 : 0,
				output: resultMsg.output,
			};
		} catch (err) {
			const errorMsg = `Spawner delegation to '${delegation.agent_name}' failed: ${String(err)}`;
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				child_id: childId,
				...descData,
				...(mnemonicName ? { mnemonic_name: mnemonicName } : {}),
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: 1 };
		}
	}

	/** Execute an agent command (wait_agent, message_agent). Returns the tool result message. */
	private async executeAgentCommand(
		cmd: AgentCommand,
		agentId: string,
	): Promise<{ toolResultMsg: Message; stumbles: number; output?: string }> {
		if (!this.spawner) {
			const errorMsg = `${cmd.kind} requires a bus-based spawner, but none is available`;
			const toolResultMsg = Msg.toolResult(cmd.call_id, `Error: ${errorMsg}`, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: cmd.kind,
				success: false,
				error: errorMsg,
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: 1 };
		}

		const caller: CallerIdentity = { agent_name: this.spec.name, depth: this.depth };
		const handle = this.spawner.getHandle(cmd.handle);
		const childAgentId = handle?.agentId;
		const targetMnemonicName = handle?.mnemonicName;
		const targetAgentName = handle?.agentName;

		try {
			if (cmd.kind === "wait_agent") {
				const result = await this.spawner.waitAgent(cmd.handle, caller);
				const content = truncateToolOutput(result.output, "wait_agent");
				const toolResultMsg = Msg.toolResult(cmd.call_id, content);
				this.emitAndLog("act_end", agentId, this.depth, {
					agent_name: cmd.kind,
					success: result.success,
					child_id: childAgentId,
					...(targetMnemonicName ? { mnemonic_name: targetMnemonicName } : {}),
					...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
					tool_result_message: toolResultMsg,
				});
				return { toolResultMsg, stumbles: result.success ? 0 : 1, output: result.output };
			}

			// message_agent
			const blocking = cmd.blocking !== false; // default true
			const result = await this.spawner.messageAgent(cmd.handle, cmd.message, caller, blocking);

			if (!blocking || !result) {
				const toolResultMsg = Msg.toolResult(cmd.call_id, "Message sent.");
				this.emitAndLog("act_end", agentId, this.depth, {
					agent_name: cmd.kind,
					success: true,
					child_id: childAgentId,
					...(targetMnemonicName ? { mnemonic_name: targetMnemonicName } : {}),
					...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
					tool_result_message: toolResultMsg,
				});
				return { toolResultMsg, stumbles: 0 };
			}

			const content = truncateToolOutput(result.output, "message_agent");
			const toolResultMsg = Msg.toolResult(cmd.call_id, content);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: cmd.kind,
				success: result.success,
				child_id: childAgentId,
				...(targetMnemonicName ? { mnemonic_name: targetMnemonicName } : {}),
				...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: result.success ? 0 : 1, output: result.output };
		} catch (err) {
			const errorMsg = `${cmd.kind} failed: ${String(err)}`;
			const toolResultMsg = Msg.toolResult(cmd.call_id, `Error: ${errorMsg}`, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: cmd.kind,
				success: false,
				error: errorMsg,
				child_id: childAgentId,
				...(targetMnemonicName ? { mnemonic_name: targetMnemonicName } : {}),
				...(targetAgentName ? { target_agent_name: targetAgentName } : {}),
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: 1 };
		}
	}

	/** Run the agent loop with the given goal */
	async run(goal: string, signal?: AbortSignal): Promise<AgentResult> {
		const agentId = this.agentId ?? this.spec.name;
		this.signal = signal;

		// Ensure log directory exists
		if (this.logBasePath) {
			await mkdir(dirname(`${this.logBasePath}.jsonl`), { recursive: true });
		}

		// Emit session_start
		this.emitAndLog("session_start", agentId, this.depth, {
			goal,
			session_id: this.sessionId,
			model: this.resolved.model,
		});

		// Initialize history with optional prior messages and the goal
		this.history = [...(this.initialHistory ?? []), Msg.user(goal)];

		// Emit perceive
		this.emitAndLog("perceive", agentId, this.depth, { goal });

		// Recall: search genome for relevant context
		let recallContext: { memories?: Memory[]; routingHints?: RoutingRule[] } | undefined;
		if (this.genome) {
			const recallResult = await recall(this.genome, goal);
			recallContext = {
				memories: recallResult.memories,
				routingHints: recallResult.routing_hints,
			};
			this.emitAndLog("recall", agentId, this.depth, {
				agent_count: recallResult.agents.length,
				memory_count: recallResult.memories.length,
				routing_hint_count: recallResult.routing_hints.length,
			});
		}

		// Load workspace tools created by the quartermaster for this agent
		let wsToolDefs: import("../genome/genome.ts").AgentToolDefinition[] = [];
		if (this.genome) {
			wsToolDefs = this.rootDir
				? await this.genome.loadAgentToolsWithRoot(this.spec.name, this.rootDir, this.agentTree)
				: await this.genome.loadAgentTools(this.spec.name);
			if (wsToolDefs.length > 0) {
				const toolPrims = buildAgentToolPrimitives(wsToolDefs, {
					genome: this.genome,
					env: this.env,
					agentName: this.spec.name,
				});
				for (const prim of toolPrims) {
					this.primitiveRegistry.register(prim);
					this.primitiveTools.push({
						name: prim.name,
						description: prim.description,
						parameters: prim.parameters,
					});
				}
			}

			// Add both genome and root tool directories to PATH
			const genomeToolsDir = join(this.genome.agentDir(this.spec.name), "tools");
			this.env.addToPath?.(genomeToolsDir);
			if (this.rootDir) {
				const rootToolsDir = this.agentTree
					? resolveRootToolsDir(this.agentTree, this.rootDir, this.spec.name)
					: await findRootToolsDir(this.rootDir, this.spec.name);
				this.env.addToPath?.(rootToolsDir);
			}
		}

		// Safety: after all tool sources are resolved (primitives + agents + workspace tools),
		// an agent with zero tools would cause the LLM to hallucinate. Fail hard.
		if (this.agentTools.length === 0 && this.primitiveTools.length === 0) {
			throw new Error(
				`Agent '${this.spec.name}' has zero tools after full resolution (including workspace tools). ` +
					`Spec: tools=[${this.spec.tools.join(", ")}], agents=[${this.spec.agents.join(", ")}], ` +
					`can_spawn=${this.spec.constraints.can_spawn}. ` +
					`This would cause the LLM to hallucinate tool calls.`,
			);
		}

		// Load agent-specific postscript from genome
		let postscripts: Postscripts | undefined;
		if (this.genomePostscripts && this.genome) {
			const agentPostscript = await this.genome.loadAgentPostscript(this.spec.name);
			postscripts = { ...this.genomePostscripts, agent: agentPostscript };
		}

		// Build system prompt with recall context (memories and routing hints)
		this.systemPrompt = buildSystemPrompt({
			spec: this.spec,
			workDir: this.env.working_directory(),
			platform: this.env.platform(),
			osVersion: this.env.os_version(),
			recallContext,
			preambles: this.preambles,
			projectDocs: this.projectDocs,
			postscripts,
			rootDir: this.rootDir,
		});

		// Append available agent descriptions to system prompt
		if (this.spec.constraints.can_spawn) {
			const delegatableAgents = this.getDelegatableAgents();
			this.systemPrompt += renderAgentsForPrompt(delegatableAgents);
		}

		// Append workspace tools to system prompt (tools created by the quartermaster)
		if (wsToolDefs.length > 0) {
			this.systemPrompt += renderWorkspaceTools(wsToolDefs);
		}

		// Inject anti-hallucination guardrails based on actual tool availability
		this.systemPrompt += renderToolBoundaries(this.agentTools, this.primitiveTools);

		return this.runLoop(goal);
	}

	/** Continue a conversation by appending a new message and running the planning loop again. */
	async continue(message: string, signal?: AbortSignal): Promise<AgentResult> {
		if (!this.systemPrompt) {
			throw new Error("Cannot call continue() before run() has been called");
		}

		const agentId = this.agentId ?? this.spec.name;
		this.signal = signal;

		// Emit session_start (same as run() — so stats reset for the new session)
		this.emitAndLog("session_start", agentId, this.depth, {
			goal: message,
			session_id: this.sessionId,
			model: this.resolved.model,
		});

		// Append the new user message
		this.history.push(Msg.user(message));

		// Emit perceive for the new message
		this.emitAndLog("perceive", agentId, this.depth, { goal: message });

		return this.runLoop(message);
	}

	private async requestPlanResponse(opts: {
		request: LLMRequest;
		agentId: string;
		turn: number;
		signal: AbortSignal | undefined;
	}): Promise<{ response: LLMResponse; latencyMs: number } | "interrupted"> {
		const { request, agentId, turn, signal } = opts;
		const llmStartTime = performance.now();
		try {
			const completeFn = () => {
				if (this.enableStreaming) {
					return this.completeWithStreaming(request, agentId, llmStartTime, signal);
				}
				if (signal) {
					const completePromise = this.client.complete(request);
					let onAbort: () => void = () => {};
					const abortPromise = new Promise<never>((_, reject) => {
						if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
						onAbort = () => reject(new DOMException("Aborted", "AbortError"));
						signal.addEventListener("abort", onAbort, { once: true });
					});
					return Promise.race([completePromise, abortPromise]).finally(() => {
						signal.removeEventListener("abort", onAbort);
					});
				}
				return this.client.complete(request);
			};

			const response = await retryLLMCall(completeFn, {
				...this.llmRetryOptions,
				signal,
				onRetry: (error, attempt, delayMs) => {
					this.logger.warn("llm", "Retrying LLM call", {
						attempt,
						delayMs,
						error: error.message,
						model: this.resolved.model,
						provider: this.resolved.provider,
						turn,
					});
				},
			});
			return { response, latencyMs: Math.round(performance.now() - llmStartTime) };
		} catch (err) {
			const latencyMs = Math.round(performance.now() - llmStartTime);
			if (err instanceof DOMException && err.name === "AbortError") {
				this.emitAndLog("llm_end", agentId, this.depth, {
					model: this.resolved.model,
					provider: this.resolved.provider,
					input_tokens: 0,
					output_tokens: 0,
					latency_ms: latencyMs,
					finish_reason: "interrupted",
				});
				this.emitAndLog("plan_end", agentId, this.depth, {
					turn,
					finish_reason: "interrupted",
				});
				this.emitAndLog("interrupted", agentId, this.depth, {
					message: "Agent interrupted during LLM call",
					turns: turn,
				});
				return "interrupted";
			}
			this.emitAndLog("llm_end", agentId, this.depth, {
				model: this.resolved.model,
				provider: this.resolved.provider,
				input_tokens: 0,
				output_tokens: 0,
				latency_ms: latencyMs,
				finish_reason: "error",
			});
			this.emitAndLog("plan_end", agentId, this.depth, {
				turn,
				finish_reason: "error",
			});
			throw err;
		}
	}

	private async executeToolCalls(opts: {
		toolCalls: ToolCall[];
		agentId: string;
		goal: string;
		callHistory: CallRecord[];
	}): Promise<{ stumbles: number; output?: string }> {
		const { toolCalls, agentId, goal, callHistory } = opts;
		let stumbles = 0;
		let lastOutput: string | undefined;

		// Parse tool calls into delegations, agent commands, and primitive calls.
		// Include loaded agent names so legacy direct agent-name tool calls are
		// interpreted as delegations.
		const agentNameSource = this.genome ? this.genome.allAgents() : this.availableAgents;
		const knownAgentNames = new Set(agentNameSource.map((agent) => agent.name));
		const {
			delegations,
			agentCommands,
			errors: delegationErrors,
		} = parsePlanResponse(toolCalls, knownAgentNames);
		const delegationByCallId = new Map(delegations.map((d) => [d.call_id, d]));
		const agentCommandByCallId = new Map(agentCommands.map((c) => [c.call_id, c]));

		// Track call history for retry detection
		for (const call of toolCalls) {
			callHistory.push({ name: call.name, arguments: call.arguments });
		}

		// Execute all delegations concurrently, primitives sequentially.
		// Collect results keyed by call ID so we can add them to history in original order.
		const resultByCallId = new Map<string, Message>();

		// Handle malformed delegations — add error tool results so history stays valid
		for (const err of delegationErrors) {
			this.emitAndLog("error", agentId, this.depth, { error: err.error });
			resultByCallId.set(err.call_id, Msg.toolResult(err.call_id, `Error: ${err.error}`, true));
			stumbles++;
		}

		// Launch all delegations concurrently (spawner or in-process fallback)
		const executeDelegationFn = this.spawner
			? (d: Delegation) => this.executeSpawnerDelegation(d, agentId)
			: (d: Delegation) => this.executeDelegation(d, agentId);

		const delegationPromises = delegations.map((delegation) =>
			executeDelegationFn(delegation).then((dr) => {
				resultByCallId.set(delegation.call_id, dr.toolResultMsg);
				stumbles += dr.stumbles;
				if (dr.output !== undefined) lastOutput = dr.output;
			}),
		);
		await Promise.all(delegationPromises);

		// Handle agent commands (wait_agent, message_agent)
		for (const cmd of agentCommands) {
			const result = await this.executeAgentCommand(cmd, agentId);
			resultByCallId.set(cmd.call_id, result.toolResultMsg);
			if (result.stumbles > 0) stumbles += result.stumbles;
			if (result.output !== undefined) lastOutput = result.output;
		}

		// Execute primitives sequentially (they're fast, may depend on each other)
		for (const call of toolCalls) {
			if (
				delegationByCallId.has(call.id) ||
				agentCommandByCallId.has(call.id) ||
				resultByCallId.has(call.id)
			)
				continue;

			this.emitAndLog("primitive_start", agentId, this.depth, {
				name: call.name,
				args: call.arguments,
			});

			// Enforce write path constraints before execution
			const pathDenied = checkPathConstraint(
				call.name,
				call.arguments,
				this.spec.constraints,
				this.env.working_directory(),
			);
			if (pathDenied) {
				const content = `Error: ${pathDenied}`;
				const toolResultMsg = Msg.toolResult(call.id, content, true);
				resultByCallId.set(call.id, toolResultMsg);
				this.emitAndLog("primitive_end", agentId, this.depth, {
					name: call.name,
					success: false,
					stumbled: true,
					output: "",
					error: pathDenied,
					tool_result_message: toolResultMsg,
				});
				stumbles++;
				continue;
			}

			const result = await this.primitiveRegistry.execute(call.name, call.arguments, this.signal);

			// Verify primitive result
			const { stumbled, learnSignal: primSignal } = verifyPrimitiveResult(
				result,
				call.name,
				goal,
				this.sessionId,
			);

			const content = result.error ? `Error: ${result.error}\n${result.output}` : result.output;
			const toolResultMsg = Msg.toolResult(call.id, content, !result.success);

			this.emitAndLog("primitive_end", agentId, this.depth, {
				name: call.name,
				success: result.success,
				stumbled,
				output: result.output,
				error: result.error,
				tool_result_message: toolResultMsg,
			});

			if (stumbled) {
				stumbles++;
			}

			if (primSignal) {
				this.emitAndLog("learn_signal", agentId, this.depth, {
					signal: primSignal,
				});
				if (this.learnProcess && this.spec.constraints.can_learn) {
					this.learnProcess.push(primSignal);
				}
			}

			this.emitAndLog("verify", agentId, this.depth, {
				primitive: call.name,
				success: result.success,
				stumbled,
			});

			// Record action for stumble rate computation
			if (this.learnProcess) {
				this.learnProcess.recordAction(agentId);
			}

			resultByCallId.set(call.id, toolResultMsg);
			lastOutput = result.output;
		}

		// Add all tool results to history in original tool call order
		for (const call of toolCalls) {
			const msg = resultByCallId.get(call.id);
			if (msg) this.history.push(msg);
		}

		return { stumbles, output: lastOutput };
	}

	/** Core planning loop shared by run() and continue(). */
	private async runLoop(goal: string): Promise<AgentResult> {
		const agentId = this.agentId ?? this.spec.name;
		const systemPrompt = this.systemPrompt!;
		const externalSignal = this.signal;
		const startTime = performance.now();
		const callHistory: CallRecord[] = [];
		let stumbles = 0;
		let turns = 0;
		let lastOutput = "";
		let interrupted = false;
		let timedOut = false;

		const timeoutMs = this.spec.constraints.timeout_ms;
		let timeoutController: AbortController | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const resetInactivityTimer = () => {
			if (timeoutMs <= 0) return;
			clearTimeout(timeoutTimer);
			timeoutTimer = setTimeout(() => timeoutController?.abort(), timeoutMs);
		};

		if (timeoutMs > 0) {
			timeoutController = new AbortController();
			resetInactivityTimer();
		}

		// Combined signal: aborts if external signal OR inactivity timeout fires
		const signals: AbortSignal[] = [];
		if (externalSignal) signals.push(externalSignal);
		if (timeoutController) signals.push(timeoutController.signal);
		const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

		// Update this.signal so executeToolCalls picks up the combined signal
		if (signal) this.signal = signal;

		try {
			while (turns < this.spec.constraints.max_turns) {
				turns++;

				// Drain steering messages and inject as user messages
				const steered = this.drainSteering();
				for (const text of steered) {
					this.history.push(Msg.user(text));
					this.emitAndLog("steering", agentId, this.depth, { text });
				}

				// Refresh delegation list if genome has changed
				const newAgents = await this.refreshDelegationList();
				if (newAgents) {
					const descriptions = newAgents.map((a) => `- **${a.name}**: ${a.description}`).join("\n");
					const text = `New agents are now available for delegation:\n${descriptions}`;
					this.history.push(Msg.user(text));
					this.emitAndLog("steering", agentId, this.depth, { text });
				}

				// Check abort signal (timeout or external)
				if (signal?.aborted) {
					if (timeoutController?.signal.aborted) {
						this.emitAndLog("warning", agentId, this.depth, {
							message: `Agent timed out after ${timeoutMs}ms idle (total elapsed: ${Math.round(performance.now() - startTime)}ms, limit: ${timeoutMs}ms)`,
						});
						timedOut = true;
					} else {
						interrupted = true;
						this.emitAndLog("interrupted", agentId, this.depth, {
							message: "Agent interrupted by abort signal",
							turns,
						});
					}
					break;
				}

				// Plan: build request and call LLM
				const planningResult = await executePlanningTurn({
					turn: turns,
					agentId,
					depth: this.depth,
					systemPrompt,
					history: this.history,
					agentTools: this.agentTools,
					primitiveTools: this.primitiveTools,
					model: this.resolved.model,
					provider: this.resolved.provider,
					thinking: this.spec.thinking,
					signal,
					emit: this.emitAndLog.bind(this),
					requestPlanResponse: this.requestPlanResponse.bind(this),
					logger: this.logger,
				});
				if (planningResult.kind === "interrupted") {
					if (timeoutController?.signal.aborted) {
						this.emitAndLog("warning", agentId, this.depth, {
							message: `Agent timed out after ${timeoutMs}ms idle (total elapsed: ${Math.round(performance.now() - startTime)}ms, limit: ${timeoutMs}ms)`,
						});
						timedOut = true;
					} else {
						interrupted = true;
					}
					break;
				}
				const { response, assistantMessage, toolCalls } = planningResult;
				resetInactivityTimer();

				// If response was truncated (hit max_tokens), tool calls are likely incomplete.
				// Don't attempt to execute them — tell the LLM to break the task into smaller steps.
				if (response.finish_reason.reason === "length" && toolCalls.length > 0) {
					// Add error tool results for all truncated calls so history stays valid
					for (const call of toolCalls) {
						const toolResultMsg = Msg.toolResult(
							call.id,
							"Error: Your response was truncated (hit max_tokens limit). " +
								"Break your task into smaller steps — don't try to write large amounts of code in a single tool call argument.",
							true,
						);
						this.history.push(toolResultMsg);
						this.emitAndLog("primitive_end", agentId, this.depth, {
							name: call.name,
							success: false,
							stumbled: true,
							output: "",
							error: "Response truncated (max_tokens)",
							tool_result_message: toolResultMsg,
						});
					}
					this.emitAndLog("warning", agentId, this.depth, {
						message: "Response truncated (max_tokens). Asking agent to use smaller steps.",
					});
					stumbles++;
					continue;
				}

				// Natural completion: no tool calls means the agent is done
				if (toolCalls.length === 0) {
					lastOutput = messageText(assistantMessage);
					break;
				}

				const toolExecution = await this.executeToolCalls({
					toolCalls,
					agentId,
					goal,
					callHistory,
				});
				stumbles += toolExecution.stumbles;
				if (toolExecution.output !== undefined) {
					lastOutput = toolExecution.output;
				}
				resetInactivityTimer();

				// Compact history if context usage exceeds threshold or manually requested
				const compactionDecision = evaluateCompaction({
					turnsSinceCompaction: this.turnsSinceCompaction,
					compactionRequested: this.compactionRequested,
					inputTokens: response.usage?.input_tokens ?? 0,
					contextWindowSize: getContextWindowSize(this.resolved.model),
				});
				this.turnsSinceCompaction = compactionDecision.turnsSinceCompaction;
				this.compactionRequested = compactionDecision.compactionRequested;
				if (compactionDecision.shouldCompact) {
					try {
						const compactResult = await compactHistory({
							history: this.history,
							client: this.client,
							model: this.resolved.model,
							provider: this.resolved.provider,
							logPath: this.logBasePath ? `${this.logBasePath}.jsonl` : "",
						});
						this.emitAndLog("compaction", agentId, this.depth, {
							summary: compactResult.summary,
							beforeCount: compactResult.beforeCount,
							afterCount: compactResult.afterCount,
							logPath: this.logBasePath ? `${this.logBasePath}.jsonl` : undefined,
						});
					} catch (err) {
						this.emitAndLog("warning", agentId, this.depth, {
							message: `Compaction failed, continuing without: ${String(err)}`,
						});
					}
				}
			}

			clearTimeout(timeoutTimer);
			this.signal = externalSignal;

			const retryAccounting = applyRetryAccounting({
				callHistory,
				stumbles,
				goal,
				agentName: this.spec.name,
				turns,
				sessionId: this.sessionId,
			});
			stumbles = retryAccounting.stumbles;
			if (retryAccounting.learnSignal && this.learnProcess && this.spec.constraints.can_learn) {
				this.learnProcess.push(retryAccounting.learnSignal);
			}
		} catch (err) {
			// Emit session_end on unrecoverable errors so listeners are not left
			// stuck in a "running" state. The normal completion path below handles
			// the happy case and abort-via-break.
			this.emitAndLog("session_end", agentId, this.depth, {
				session_id: this.sessionId,
				success: false,
				stumbles,
				turns,
				timed_out: false,
				output: lastOutput,
			});
			await this.flushLog();
			throw err;
		}

		const finalization = finalizeRunLoopResult({
			turns,
			stumbles,
			maxTurns: this.spec.constraints.max_turns,
			timedOut,
			interrupted,
			output: lastOutput,
			sessionId: this.sessionId,
		});
		stumbles = finalization.stumbles;

		// Emit session_end
		this.emitAndLog("session_end", agentId, this.depth, finalization.sessionEndData);

		await this.flushLog();

		return finalization.agentResult;
	}
}

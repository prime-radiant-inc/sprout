import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Genome } from "../genome/genome.ts";
import { recall } from "../genome/recall.ts";
import type { ExecutionEnvironment } from "../kernel/execution-env.ts";
import type { PrimitiveRegistry } from "../kernel/primitives.ts";
import { truncateToolOutput } from "../kernel/truncation.ts";
import type {
	ActResult,
	AgentSpec,
	Delegation,
	EventKind,
	Memory,
	RoutingRule,
} from "../kernel/types.ts";
import type { LearnProcess } from "../learn/learn-process.ts";
import type { Client } from "../llm/client.ts";
import type { Response as LLMResponse, Message, ToolDefinition } from "../llm/types.ts";
import { Msg, messageReasoning, messageText, messageToolCalls } from "../llm/types.ts";
import { ulid } from "../util/ulid.ts";
import { getContextWindowSize } from "./context-window.ts";
import { AgentEventEmitter } from "./events.ts";
import { type ResolvedModel, resolveModel } from "./model-resolver.ts";
import {
	buildDelegateTool,
	buildPlanRequest,
	buildSystemPrompt,
	parsePlanResponse,
	primitivesForAgent,
	renderAgentsForPrompt,
} from "./plan.ts";
import {
	type CallRecord,
	detectRetries,
	verifyActResult,
	verifyPrimitiveResult,
} from "./verify.ts";

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
	learnProcess?: LearnProcess;
	/** Base path for session log. Events written to ${logBasePath}.jsonl. Subagent logs go in ${logBasePath}/subagents/. */
	logBasePath?: string;
	/** Prior conversation history to prepend (for resume/continuation). */
	initialHistory?: Message[];
	/** Override the spec's model for this agent instance. */
	modelOverride?: string;
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
	private readonly learnProcess?: LearnProcess;
	private readonly resolved: ResolvedModel;
	private readonly agentTools: ToolDefinition[];
	private readonly primitiveTools: ToolDefinition[];
	private readonly logBasePath?: string;
	private readonly initialHistory?: Message[];
	private signal?: AbortSignal;
	private logWriteChain: Promise<void> = Promise.resolve();
	private steeringQueue: string[] = [];

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
		this.initialHistory = options.initialHistory ? [...options.initialHistory] : undefined;

		// Validate depth: max_depth > 0 means the agent can only exist at depths < max_depth.
		// max_depth === 0 means "leaf agent, no sub-spawning" — no depth restriction on the agent itself.
		if (this.spec.constraints.max_depth > 0 && this.depth >= this.spec.constraints.max_depth) {
			throw new Error(
				`Agent '${this.spec.name}' exceeds max depth: depth=${this.depth}, max_depth=${this.spec.constraints.max_depth}`,
			);
		}

		// Resolve model and provider
		this.resolved = resolveModel(options.modelOverride ?? this.spec.model, this.client.providers());

		// Build delegate tool (single tool for all agent delegations)
		this.agentTools = [];

		if (this.spec.constraints.can_spawn) {
			const delegatableAgents: AgentSpec[] = [];
			for (const cap of this.spec.capabilities) {
				if (cap === this.spec.name) continue;
				const agentSpec = this.availableAgents.find((a) => a.name === cap);
				if (agentSpec) {
					delegatableAgents.push(agentSpec);
				}
			}
			if (delegatableAgents.length > 0) {
				this.agentTools.push(buildDelegateTool(delegatableAgents));
			}
		}

		// Build primitive tool list (provider-aligned).
		// Agents that delegate don't get primitives — primitives live on subagents only.
		this.primitiveTools = [];
		if (this.agentTools.length === 0) {
			const filteredPrimitiveNames = primitivesForAgent(
				this.spec.capabilities,
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
	}

	/** Returns the resolved model and provider for this agent. */
	get resolvedModel(): ResolvedModel {
		return this.resolved;
	}

	/** Returns all tools this agent can use (agent tools + primitive tools) */
	resolvedTools(): ToolDefinition[] {
		return [...this.agentTools, ...this.primitiveTools];
	}

	/** Inject a steering message into the agent loop for the next iteration. */
	steer(text: string): void {
		this.steeringQueue.push(text);
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

	/** Get the current list of agents this agent can delegate to, preferring genome over static snapshot. */
	private getDelegatableAgents(): AgentSpec[] {
		const agents: AgentSpec[] = [];
		const source = this.genome ? this.genome.allAgents() : this.availableAgents;
		for (const cap of this.spec.capabilities) {
			if (cap === this.spec.name) continue;
			const agentSpec = source.find((a) => a.name === cap);
			if (agentSpec) agents.push(agentSpec);
		}
		return agents;
	}

	/** Execute a single delegation to a subagent. Returns the tool result message and stumble count. */
	private async executeDelegation(
		delegation: Delegation,
		agentId: string,
	): Promise<{ toolResultMsg: Message; stumbles: number; output?: string }> {
		this.emitAndLog("act_start", agentId, this.depth, {
			agent_name: delegation.agent_name,
			goal: delegation.goal,
		});

		const subagentSpec =
			this.genome?.getAgent(delegation.agent_name) ??
			this.availableAgents.find((a) => a.name === delegation.agent_name);

		if (!subagentSpec) {
			const errorMsg = `Unknown agent: ${delegation.agent_name}`;
			const toolResultMsg = Msg.toolResult(delegation.call_id, errorMsg, true);
			this.emitAndLog("act_end", agentId, this.depth, {
				agent_name: delegation.agent_name,
				success: false,
				error: errorMsg,
				tool_result_message: toolResultMsg,
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
				tool_result_message: toolResultMsg,
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
				tool_result_message: toolResultMsg,
			});
			return { toolResultMsg, stumbles: 1 };
		}
	}

	/** Run the agent loop with the given goal */
	async run(goal: string, signal?: AbortSignal): Promise<AgentResult> {
		const agentId = this.spec.name;
		this.signal = signal;
		const startTime = performance.now();
		let stumbles = 0;
		let turns = 0;
		let lastOutput = "";

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
		const history: Message[] = [...(this.initialHistory ?? []), Msg.user(goal)];

		// Track tool calls for retry detection
		const callHistory: CallRecord[] = [];

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

		// Build system prompt with recall context (memories and routing hints)
		let systemPrompt = buildSystemPrompt(
			this.spec,
			this.env.working_directory(),
			this.env.platform(),
			this.env.os_version(),
			recallContext,
		);

		// Append available agent descriptions to system prompt
		if (this.spec.constraints.can_spawn) {
			const delegatableAgents = this.getDelegatableAgents();
			systemPrompt += renderAgentsForPrompt(delegatableAgents);
		}

		// Core loop
		while (turns < this.spec.constraints.max_turns) {
			turns++;

			// Drain steering messages and inject as user messages
			const steered = this.drainSteering();
			for (const text of steered) {
				history.push(Msg.user(text));
				this.emitAndLog("steering", agentId, this.depth, { text });
			}

			// Check timeout
			if (this.spec.constraints.timeout_ms > 0) {
				const elapsed = performance.now() - startTime;
				if (elapsed >= this.spec.constraints.timeout_ms) {
					this.emitAndLog("warning", agentId, this.depth, {
						message: `Agent timed out after ${Math.round(elapsed)}ms (limit: ${this.spec.constraints.timeout_ms}ms)`,
					});
					break;
				}
			}

			// Check abort signal
			if (signal?.aborted) {
				this.emitAndLog("interrupted", agentId, this.depth, {
					message: "Agent interrupted by abort signal",
					turns,
				});
				break;
			}

			// Plan: build request and call LLM
			this.emitAndLog("plan_start", agentId, this.depth, { turn: turns });

			const request = buildPlanRequest({
				systemPrompt,
				history,
				agentTools: this.agentTools,
				primitiveTools: this.primitiveTools,
				model: this.resolved.model,
				provider: this.resolved.provider,
			});

			let response: LLMResponse;
			try {
				if (signal) {
					const completePromise = this.client.complete(request);
					let onAbort: () => void = () => {};
					const abortPromise = new Promise<never>((_, reject) => {
						if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
						onAbort = () => reject(new DOMException("Aborted", "AbortError"));
						signal.addEventListener("abort", onAbort, { once: true });
					});
					try {
						response = await Promise.race([completePromise, abortPromise]);
					} finally {
						signal.removeEventListener("abort", onAbort);
					}
				} else {
					response = await this.client.complete(request);
				}
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					this.emitAndLog("interrupted", agentId, this.depth, {
						message: "Agent interrupted during LLM call",
						turns,
					});
					break;
				}
				throw err;
			}
			const assistantMessage = response.message;

			// Add assistant message to history
			history.push(assistantMessage);

			this.emitAndLog("plan_end", agentId, this.depth, {
				turn: turns,
				finish_reason: response.finish_reason.reason,
				usage: response.usage,
				text: messageText(assistantMessage),
				reasoning: messageReasoning(assistantMessage),
				assistant_message: assistantMessage,
				context_tokens: response.usage?.input_tokens ?? 0,
				context_window_size: getContextWindowSize(this.resolved.model),
			});

			// Check for tool calls
			const toolCalls = messageToolCalls(assistantMessage);

			// Natural completion: no tool calls means the agent is done
			if (toolCalls.length === 0) {
				lastOutput = messageText(assistantMessage);
				break;
			}

			// Parse tool calls into delegations and primitive calls
			const { delegations } = parsePlanResponse(toolCalls);
			const delegationByCallId = new Map(delegations.map((d) => [d.call_id, d]));

			// Track call history for retry detection
			for (const call of toolCalls) {
				callHistory.push({ name: call.name, arguments: call.arguments });
			}

			// Execute all delegations concurrently, primitives sequentially.
			// Collect results keyed by call ID so we can add them to history in original order.
			const resultByCallId = new Map<string, Message>();
			let delegationStumbles = 0;

			// Launch all delegations concurrently
			const delegationPromises = delegations.map((delegation) =>
				this.executeDelegation(delegation, agentId).then((dr) => {
					resultByCallId.set(delegation.call_id, dr.toolResultMsg);
					delegationStumbles += dr.stumbles;
					if (dr.output !== undefined) lastOutput = dr.output;
				}),
			);
			await Promise.all(delegationPromises);
			stumbles += delegationStumbles;

			// Execute primitives sequentially (they're fast, may depend on each other)
			for (const call of toolCalls) {
				if (delegationByCallId.has(call.id)) continue;

				this.emitAndLog("primitive_start", agentId, this.depth, {
					name: call.name,
					args: call.arguments,
				});

				const result = await this.primitiveRegistry.execute(call.name, call.arguments);

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
				if (msg) history.push(msg);
			}
		}

		// Detect retry stumbles from repeated identical tool calls
		const retryCount = detectRetries(callHistory);
		if (retryCount > 0) {
			stumbles += retryCount;
			if (this.learnProcess && this.spec.constraints.can_learn) {
				this.learnProcess.push({
					kind: "retry",
					goal,
					agent_name: agentId,
					details: {
						agent_name: agentId,
						goal,
						output: `${retryCount} retried tool calls detected`,
						success: true,
						stumbles: retryCount,
						turns,
						timed_out: false,
					},
					session_id: this.sessionId,
					timestamp: Date.now(),
				});
			}
		}

		// Check if we hit limits
		const hitTurnLimit = turns >= this.spec.constraints.max_turns;
		const timedOut =
			this.spec.constraints.timeout_ms > 0 &&
			performance.now() - startTime >= this.spec.constraints.timeout_ms;

		if (hitTurnLimit || timedOut) {
			stumbles++;
		}

		const success = !hitTurnLimit && !timedOut;

		// Emit session_end
		this.emitAndLog("session_end", agentId, this.depth, {
			session_id: this.sessionId,
			success,
			stumbles,
			turns,
			timed_out: timedOut,
			output: lastOutput,
		});

		await this.flushLog();

		return {
			output: lastOutput,
			success,
			stumbles,
			turns,
			timed_out: timedOut,
		};
	}
}

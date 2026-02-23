import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Genome } from "../genome/genome.ts";
import { recall } from "../genome/recall.ts";
import type { ExecutionEnvironment } from "../kernel/execution-env.ts";
import type { PrimitiveRegistry } from "../kernel/primitives.ts";
import { truncateToolOutput } from "../kernel/truncation.ts";
import type { ActResult, AgentSpec, EventKind, Memory, RoutingRule } from "../kernel/types.ts";
import type { LearnProcess } from "../learn/learn-process.ts";
import type { Client } from "../llm/client.ts";
import type { Message, ToolDefinition } from "../llm/types.ts";
import { Msg, messageReasoning, messageText, messageToolCalls } from "../llm/types.ts";
import { AgentEventEmitter } from "./events.ts";
import { type ResolvedModel, resolveModel } from "./model-resolver.ts";
import {
	agentAsTool,
	buildPlanRequest,
	buildSystemPrompt,
	parsePlanResponse,
	primitivesForAgent,
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
	private readonly agentNames: Set<string>;
	private readonly logBasePath?: string;
	private logWriteChain: Promise<void> = Promise.resolve();

	constructor(options: AgentOptions) {
		this.spec = options.spec;
		this.env = options.env;
		this.client = options.client;
		this.primitiveRegistry = options.primitiveRegistry;
		this.availableAgents = options.availableAgents;
		this.genome = options.genome;
		this.depth = options.depth ?? 0;
		this.events = options.events ?? new AgentEventEmitter();
		this.sessionId = options.sessionId ?? crypto.randomUUID();
		this.learnProcess = options.learnProcess;
		this.logBasePath = options.logBasePath;

		// Validate depth: max_depth > 0 means the agent can only exist at depths < max_depth.
		// max_depth === 0 means "leaf agent, no sub-spawning" — no depth restriction on the agent itself.
		if (this.spec.constraints.max_depth > 0 && this.depth >= this.spec.constraints.max_depth) {
			throw new Error(
				`Agent '${this.spec.name}' exceeds max depth: depth=${this.depth}, max_depth=${this.spec.constraints.max_depth}`,
			);
		}

		// Resolve model and provider
		this.resolved = resolveModel(this.spec.model, this.client.providers());

		// Build agent tool list (delegations to other agents)
		this.agentNames = new Set<string>();
		this.agentTools = [];

		if (this.spec.constraints.can_spawn) {
			for (const cap of this.spec.capabilities) {
				// Skip self-delegation
				if (cap === this.spec.name) continue;
				const agentSpec = this.availableAgents.find((a) => a.name === cap);
				if (agentSpec) {
					this.agentNames.add(agentSpec.name);
					this.agentTools.push(agentAsTool(agentSpec));
				}
			}
		}

		// Build primitive tool list (provider-aligned)
		const filteredPrimitiveNames = primitivesForAgent(
			this.spec.capabilities,
			this.primitiveRegistry.names(),
			this.resolved.provider,
		);

		this.primitiveTools = [];
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

	/** Returns all tools this agent can use (agent tools + primitive tools) */
	resolvedTools(): ToolDefinition[] {
		return [...this.agentTools, ...this.primitiveTools];
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

	/** Run the agent loop with the given goal */
	async run(goal: string): Promise<AgentResult> {
		const agentId = this.spec.name;
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
		});

		// Initialize history with the goal
		const history: Message[] = [Msg.user(goal)];

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
		const systemPrompt = buildSystemPrompt(
			this.spec,
			this.env.working_directory(),
			this.env.platform(),
			this.env.os_version(),
			recallContext,
		);

		// Core loop
		while (turns < this.spec.constraints.max_turns) {
			turns++;

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

			const response = await this.client.complete(request);
			const assistantMessage = response.message;

			// Add assistant message to history
			history.push(assistantMessage);

			this.emitAndLog("plan_end", agentId, this.depth, {
				turn: turns,
				finish_reason: response.finish_reason.reason,
				usage: response.usage,
				text: messageText(assistantMessage),
				reasoning: messageReasoning(assistantMessage),
			});

			// Check for tool calls
			const toolCalls = messageToolCalls(assistantMessage);

			// Natural completion: no tool calls means the agent is done
			if (toolCalls.length === 0) {
				lastOutput = messageText(assistantMessage);
				break;
			}

			// Parse tool calls into delegations and primitive calls
			const { delegations } = parsePlanResponse(toolCalls, this.agentNames);
			const delegationByCallId = new Map(delegations.map((d) => [d.call_id, d]));

			// Process each tool call in the order they appeared
			for (const call of toolCalls) {
				callHistory.push({ name: call.name, arguments: call.arguments });
				const delegation = delegationByCallId.get(call.id);

				if (delegation) {
					// Act: delegate to subagent
					this.emitAndLog("act_start", agentId, this.depth, {
						agent_name: delegation.agent_name,
						goal: delegation.goal,
					});

					const subagentSpec =
						this.genome?.getAgent(delegation.agent_name) ??
						this.availableAgents.find((a) => a.name === delegation.agent_name);

					if (!subagentSpec) {
						// Should not happen since we validated in constructor, but handle gracefully
						const errorMsg = `Unknown agent: ${delegation.agent_name}`;
						history.push(Msg.toolResult(call.id, errorMsg, true));
						stumbles++;
						this.emitAndLog("act_end", agentId, this.depth, {
							agent_name: delegation.agent_name,
							success: false,
							error: errorMsg,
						});
						continue;
					}

					try {
						// Build subagent goal, appending hints if present
						let subGoal = delegation.goal;
						if (delegation.hints && delegation.hints.length > 0) {
							subGoal += `\n\nHints:\n${delegation.hints.map((h) => `- ${h}`).join("\n")}`;
						}

						const subLogBasePath = this.logBasePath
							? `${this.logBasePath}/subagents/${crypto.randomUUID()}`
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

						const subResult = await subagent.run(subGoal);

						const actResult: ActResult = {
							agent_name: delegation.agent_name,
							goal: delegation.goal,
							output: subResult.output,
							success: subResult.success,
							stumbles: subResult.stumbles,
							turns: subResult.turns,
							timed_out: subResult.timed_out,
						};

						// Verify the act result
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

						if (verify.stumbled) {
							stumbles++;
						}

						// Add tool result to history
						const resultContent = truncateToolOutput(subResult.output, delegation.agent_name);
						history.push(Msg.toolResult(call.id, resultContent));
						lastOutput = subResult.output;

						this.emitAndLog("act_end", agentId, this.depth, {
							agent_name: delegation.agent_name,
							success: subResult.success,
							turns: subResult.turns,
							timed_out: subResult.timed_out,
						});

						// Record action for stumble rate computation
						if (this.learnProcess) {
							this.learnProcess.recordAction(agentId);
						}
					} catch (err) {
						const errorMsg = `Subagent '${delegation.agent_name}' failed: ${String(err)}`;
						history.push(Msg.toolResult(call.id, errorMsg, true));
						stumbles++;
						this.emitAndLog("act_end", agentId, this.depth, {
							agent_name: delegation.agent_name,
							success: false,
							error: errorMsg,
						});
					}
				} else {
					// Act: execute primitive
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

					this.emitAndLog("primitive_end", agentId, this.depth, {
						name: call.name,
						success: result.success,
						stumbled,
						output: result.output,
						error: result.error,
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

					// Add tool result to history
					const content = result.error ? `Error: ${result.error}\n${result.output}` : result.output;
					history.push(Msg.toolResult(call.id, content, !result.success));
					lastOutput = result.output;
				}
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

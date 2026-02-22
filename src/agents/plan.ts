import { renderMemories, renderRoutingHints } from "../genome/recall.ts";
import type { AgentSpec, Delegation, Memory, RoutingRule } from "../kernel/types.ts";
import type { Message, Request, ToolCall, ToolDefinition } from "../llm/types.ts";
import { Msg } from "../llm/types.ts";

/**
 * Convert an AgentSpec into a ToolDefinition the LLM can call.
 * When the LLM calls this tool, the loop interprets it as delegation to that agent.
 */
export function agentAsTool(spec: AgentSpec): ToolDefinition {
	return {
		name: spec.name,
		description: spec.description,
		parameters: {
			type: "object",
			properties: {
				goal: {
					type: "string",
					description: "What you want this agent to achieve",
				},
				hints: {
					type: "array",
					items: { type: "string" },
					description: "Optional context that might help",
				},
			},
			required: ["goal"],
		},
	};
}

/**
 * Filter and provider-align primitives for an agent based on its capabilities.
 *
 * Provider alignment:
 * - OpenAI agents get apply_patch instead of edit_file
 * - Anthropic/Gemini agents get edit_file instead of apply_patch
 */
export function primitivesForAgent(
	capabilities: string[],
	allPrimitiveNames: string[],
	provider: string,
): string[] {
	const available = new Set(allPrimitiveNames);
	const result: string[] = [];

	for (const cap of capabilities) {
		let resolved = cap;

		// Provider alignment: swap edit primitives based on provider
		if (provider === "openai" && cap === "edit_file") {
			resolved = "apply_patch";
		} else if ((provider === "anthropic" || provider === "gemini") && cap === "apply_patch") {
			resolved = "edit_file";
		}

		if (available.has(resolved)) {
			result.push(resolved);
		}
	}

	return result;
}

/**
 * Combine the agent's system prompt with environment context.
 */
export function buildSystemPrompt(
	spec: AgentSpec,
	workDir: string,
	platform: string,
	osVersion: string,
	recallContext?: { memories?: Memory[]; routingHints?: RoutingRule[] },
): string {
	const today = new Date().toISOString().slice(0, 10);
	let prompt = `${spec.system_prompt}

<environment>
Working directory: ${workDir}
Platform: ${platform}
OS version: ${osVersion}
Today's date: ${today}
</environment>`;

	if (recallContext?.memories && recallContext.memories.length > 0) {
		prompt += renderMemories(recallContext.memories);
	}
	if (recallContext?.routingHints && recallContext.routingHints.length > 0) {
		prompt += renderRoutingHints(recallContext.routingHints);
	}

	return prompt;
}

/**
 * Build the LLM Request for the Plan phase.
 */
export function buildPlanRequest(opts: {
	systemPrompt: string;
	history: Message[];
	agentTools: ToolDefinition[];
	primitiveTools: ToolDefinition[];
	model: string;
	provider: string;
	maxTokens?: number;
}): Request {
	return {
		model: opts.model,
		provider: opts.provider,
		messages: [Msg.system(opts.systemPrompt), ...opts.history],
		tools: [...opts.agentTools, ...opts.primitiveTools],
		tool_choice: "auto",
		max_tokens: opts.maxTokens ?? 4096,
	};
}

/**
 * Classify tool calls into agent delegations and primitive calls.
 */
export function parsePlanResponse(
	toolCalls: ToolCall[],
	agentNames: Set<string>,
): { delegations: Delegation[]; primitiveCalls: ToolCall[] } {
	const delegations: Delegation[] = [];
	const primitiveCalls: ToolCall[] = [];

	for (const call of toolCalls) {
		if (agentNames.has(call.name)) {
			const goal = call.arguments.goal;
			if (typeof goal !== "string" || goal.length === 0) {
				throw new Error(`Agent delegation to '${call.name}' missing required 'goal' argument`);
			}
			const hints = call.arguments.hints;
			delegations.push({
				call_id: call.id,
				agent_name: call.name,
				goal,
				hints: Array.isArray(hints) ? hints : undefined,
			});
		} else {
			primitiveCalls.push(call);
		}
	}

	return { delegations, primitiveCalls };
}

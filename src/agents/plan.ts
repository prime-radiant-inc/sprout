import type { AgentSpec, Delegation } from "../kernel/types.ts";
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
): string {
	const today = new Date().toISOString().slice(0, 10);
	return `${spec.system_prompt}

<environment>
Working directory: ${workDir}
Platform: ${platform}
OS version: ${osVersion}
Today's date: ${today}
</environment>`;
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
			delegations.push({
				agent_name: call.name,
				goal: call.arguments.goal as string,
				hints: call.arguments.hints as string[] | undefined,
			});
		} else {
			primitiveCalls.push(call);
		}
	}

	return { delegations, primitiveCalls };
}

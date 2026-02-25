import type { AgentFileInfo, AgentToolDefinition } from "../genome/genome.ts";
import { renderMemories, renderRoutingHints } from "../genome/recall.ts";
import type { AgentSpec, Delegation, Memory, RoutingRule } from "../kernel/types.ts";
import type { Message, Request, ToolCall, ToolDefinition } from "../llm/types.ts";
import { Msg } from "../llm/types.ts";

export const DELEGATE_TOOL_NAME = "delegate";

/**
 * Build a single "delegate" tool definition that the LLM uses to delegate to any agent.
 * Agent descriptions are listed in the system prompt; the tool accepts agent_name + goal + hints.
 * This keeps the tool list stable (preserving prompt cache) when agents are added/removed.
 */
export function buildDelegateTool(agents: AgentSpec[]): ToolDefinition {
	const agentEnum = agents.map((a) => a.name);
	return {
		name: DELEGATE_TOOL_NAME,
		description:
			"Delegate a task to a specialist agent. See the <agents> section in your instructions for available agents and their descriptions.",
		parameters: {
			type: "object",
			properties: {
				agent_name: {
					type: "string",
					description: "Name of the agent to delegate to",
					enum: agentEnum.length > 0 ? agentEnum : undefined,
				},
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
			required: ["agent_name", "goal"],
		},
	};
}

/**
 * Render available agents as an XML block for injection into the system prompt.
 */
export function renderAgentsForPrompt(agents: AgentSpec[]): string {
	if (agents.length === 0) return "";
	const entries = agents
		.map((a) => `  <agent name="${a.name}">${a.description}</agent>`)
		.join("\n");
	return `\n\n<agents>\n${entries}\n</agents>`;
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
	thinking?: boolean | { budget_tokens: number };
}): Request {
	const request: Request = {
		model: opts.model,
		provider: opts.provider,
		messages: [Msg.system(opts.systemPrompt), ...opts.history],
		tools: [...opts.agentTools, ...opts.primitiveTools],
		tool_choice: "auto",
		max_tokens: opts.maxTokens ?? 16384,
	};

	if (opts.thinking) {
		const budgetTokens = typeof opts.thinking === "object" ? opts.thinking.budget_tokens : 10000;
		request.provider_options = {
			anthropic: {
				thinking: { type: "enabled", budget_tokens: budgetTokens },
			},
		};
		// Anthropic requires max_tokens >= budget_tokens + some headroom
		if (request.max_tokens && request.max_tokens < budgetTokens + 4096) {
			request.max_tokens = budgetTokens + 4096;
		}
	}

	return request;
}

/** A delegation that failed validation (missing args, etc.) */
export interface DelegationError {
	call_id: string;
	error: string;
}

/**
 * Classify tool calls into agent delegations and primitive calls.
 * Delegations are identified by the "delegate" tool name.
 * If an agent name is used directly as a tool name, auto-corrects to a delegation.
 * Malformed delegations are returned as errors (never throws).
 */
export function parsePlanResponse(
	toolCalls: ToolCall[],
	agentNames?: Set<string>,
): {
	delegations: Delegation[];
	primitiveCalls: ToolCall[];
	errors: DelegationError[];
} {
	const delegations: Delegation[] = [];
	const primitiveCalls: ToolCall[] = [];
	const errors: DelegationError[] = [];

	for (const call of toolCalls) {
		// Auto-correct: LLM used agent name directly as tool name instead of delegate
		if (call.name !== DELEGATE_TOOL_NAME && agentNames?.has(call.name)) {
			const goal = call.arguments.goal ?? call.arguments.task ?? call.arguments.command;
			if (typeof goal === "string" && goal.length > 0) {
				delegations.push({
					call_id: call.id,
					agent_name: call.name,
					goal,
					hints: Array.isArray(call.arguments.hints) ? call.arguments.hints : undefined,
				});
			} else {
				errors.push({
					call_id: call.id,
					error: `Called agent '${call.name}' directly instead of using delegate tool. Use: delegate(agent_name="${call.name}", goal="...")`,
				});
			}
			continue;
		}

		if (call.name === DELEGATE_TOOL_NAME) {
			const agentName = call.arguments.agent_name;
			if (typeof agentName !== "string" || agentName.length === 0) {
				errors.push({
					call_id: call.id,
					error: "Delegation missing required 'agent_name' argument",
				});
				continue;
			}
			const goal = call.arguments.goal;
			if (typeof goal !== "string" || goal.length === 0) {
				errors.push({
					call_id: call.id,
					error: `Agent delegation to '${agentName}' missing required 'goal' argument`,
				});
				continue;
			}
			const hints = call.arguments.hints;
			delegations.push({
				call_id: call.id,
				agent_name: agentName,
				goal,
				hints: Array.isArray(hints) ? hints : undefined,
			});
		} else {
			primitiveCalls.push(call);
		}
	}

	return { delegations, primitiveCalls, errors };
}

// ---------------------------------------------------------------------------
// Workspace prompt sections
// ---------------------------------------------------------------------------

/** Format a byte count as a human-readable size string. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Render an XML block listing the agent's workspace files. */
export function renderWorkspaceFiles(files: AgentFileInfo[], filesDir: string): string {
	if (files.length === 0) return "";
	const entries = files.map((f) => `  - ${f.name}: ${formatSize(f.size)}`).join("\n");
	return `\n\n<agent_files>\n${entries}\n  These files are in your workspace at ${filesDir}. Use read_file to access them.\n</agent_files>`;
}

/** Render an XML block listing the agent's workspace tools. */
export function renderWorkspaceTools(tools: AgentToolDefinition[]): string {
	if (tools.length === 0) return "";
	const entries = tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n");
	return `\n\n<agent_tools>\n${entries}\n  These are tools you created. They are registered as primitives AND on your PATH for shell use.\n</agent_tools>`;
}

/** Return encouragement text for tool creation. */
export function renderWorkspaceEncouragement(): string {
	return `\n\nPrefer writing and saving tools over running ad-hoc commands. When you need to do something non-trivial, save a tool for it using save_tool — even if you'll only use it once this session. Tools persist across sessions and become part of your permanent capabilities. Your saved tools are on PATH and can be called directly from exec.`;
}

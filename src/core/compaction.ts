import type { Client } from "../llm/client.ts";
import type { Message } from "../llm/types.ts";
import { Msg, messageText } from "../llm/types.ts";

const COMPACTION_THRESHOLD = 0.8;
const PRESERVE_RECENT_TURNS = 6;

const COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

function summaryPrefix(logPath: string): string {
	return `Another language model started this task and produced a summary of its work.
Full conversation log available at: ${logPath} (grep for details if needed).
Use this summary to continue the work without duplicating effort:`;
}

/**
 * Returns true if context token usage is at or above the compaction threshold.
 */
export function shouldCompact(contextTokens: number, contextWindowSize: number): boolean {
	if (contextWindowSize <= 0) return false;
	return contextTokens / contextWindowSize >= COMPACTION_THRESHOLD;
}

/**
 * Compacts conversation history by summarizing older turns via an LLM call.
 * Mutates the history array in place: replaces it with [summary, ...recentTurns].
 */
export async function compactHistory(opts: {
	history: Message[];
	client: Client;
	model: string;
	provider: string;
	logPath: string;
	/**
	 * Bound value names in the agent's store scope. Older turns carry the
	 * delivered manifests (⟦name⟧ lines); compaction replaces them with an LLM
	 * summary, so the manifest is re-stated here or the agent loses its handles
	 * on still-bound values.
	 */
	scopeNames?: readonly string[];
}): Promise<{ summary: string; beforeCount: number; afterCount: number }> {
	const { history, client, model, provider, logPath, scopeNames } = opts;
	const beforeCount = history.length;

	if (beforeCount <= PRESERVE_RECENT_TURNS) {
		return { summary: "", beforeCount, afterCount: beforeCount };
	}

	// Ensure we don't split in the middle of a tool_call/tool_result pair
	let splitIndex = beforeCount - PRESERVE_RECENT_TURNS;
	while (splitIndex > 0 && history[splitIndex]?.role === "tool") {
		splitIndex--;
	}

	if (splitIndex <= 0) {
		return { summary: "", beforeCount, afterCount: beforeCount };
	}

	const olderTurns = history.slice(0, splitIndex);
	const recentTurns = history.slice(splitIndex);

	// Build summarization request: older turns + compaction prompt
	const summarizationMessages: Message[] = [...olderTurns, Msg.user(COMPACTION_PROMPT)];

	const response = await client.complete({
		model,
		provider,
		messages: summarizationMessages,
		tools: [],
	});

	const summary = messageText(response.message);
	const manifestSuffix =
		scopeNames && scopeNames.length > 0
			? `\n\nValues still bound in your store scope (reference with ⟦name⟧): ${scopeNames
					.map((name) => `⟦${name}⟧`)
					.join(", ")}`
			: "";
	const fullSummary = `${summaryPrefix(logPath)}\n\n${summary}${manifestSuffix}`;
	const summaryMessage = Msg.user(fullSummary);

	// Mutate history in place
	history.length = 0;
	history.push(summaryMessage, ...recentTurns);

	const afterCount = history.length;
	return { summary: fullSummary, beforeCount, afterCount };
}

import type { Client } from "@/llm/client.ts";
import { retryLLMCall } from "@/llm/retry.ts";
import { Msg, messageText } from "@/llm/types.ts";

export interface MnemonicContext {
	agentName: string;
	goal: string;
	description?: string;
	usedNames: string[];
}

/**
 * Generate a mnemonic codename for an agent using an LLM.
 * Returns a historical figure's surname relevant to the agent's task,
 * or null if generation fails.
 */
export async function generateMnemonicName(
	client: Client,
	model: string,
	provider: string,
	context: MnemonicContext,
	signal?: AbortSignal,
): Promise<string | null> {
	const usedList =
		context.usedNames.length > 0
			? `\nDo NOT use any of these already-taken names: ${context.usedNames.join(", ")}`
			: "";

	const systemPrompt = `You assign codenames to AI agents based on historical figures. Pick a real person from history whose work or expertise relates to the agent's task. Reply with ONLY the person's surname — one word, nothing else. Examples: "Turing", "Curie", "Gutenberg", "Champollion".${usedList}`;

	const userPrompt = `Agent type: "${context.agentName}"${context.description ? `\nDescription: "${context.description}"` : ""}\nTask: "${context.goal}"`;

	try {
		const response = await retryLLMCall(
			() =>
				client.complete({
					model,
					provider,
					messages: [Msg.system(systemPrompt), Msg.user(userPrompt)],
					max_tokens: 30,
					temperature: 0.9,
					tool_choice: "none",
					signal,
				}),
			{ maxRetries: 1, signal },
		);

		let name = messageText(response.message).trim();
		// Take first word only (safety against multi-word responses)
		name = name.split(/\s+/)[0] ?? "";
		// Remove any punctuation
		name = name.replace(/[^a-zA-Z\u00C0-\u024F'-]/g, "");

		if (!name) return null;

		// If name collides with usedNames, append a suffix
		if (context.usedNames.includes(name)) {
			let suffix = 2;
			while (context.usedNames.includes(`${name}-${suffix}`)) {
				suffix++;
			}
			name = `${name}-${suffix}`;
		}

		return name;
	} catch {
		return null;
	}
}

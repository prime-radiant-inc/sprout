import { loadEventLog, replayMessagesFromEvents } from "../kernel/event-replay.ts";
import type { Message } from "../llm/types.ts";

/**
 * Replay a JSONL event log to reconstruct the conversation history
 * for resuming a session. Only processes root-depth (depth === 0) events.
 */
export async function replayEventLog(logPath: string): Promise<Message[]> {
	const events = await loadEventLog(logPath);
	return replayMessagesFromEvents(events, "root");
}

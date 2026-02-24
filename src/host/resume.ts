import { readFile } from "node:fs/promises";
import type { SessionEvent } from "../kernel/types.ts";
import { type Message, Msg } from "../llm/types.ts";

/**
 * Replay a JSONL event log to reconstruct the conversation history
 * for resuming a session. Only processes root-depth (depth === 0) events.
 */
export async function replayEventLog(logPath: string): Promise<Message[]> {
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.trim() !== "");

	let history: Message[] = [];

	for (const line of lines) {
		let event: SessionEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.depth !== 0) continue;

		switch (event.kind) {
			case "perceive": {
				const goal = event.data.goal as string | undefined;
				if (goal) history.push(Msg.user(goal));
				break;
			}
			case "steering": {
				const text = event.data.text as string | undefined;
				if (text) history.push(Msg.user(text));
				break;
			}
			case "plan_end": {
				const msg = event.data.assistant_message as Message | undefined;
				if (msg) history.push(msg);
				break;
			}
			case "primitive_end": {
				const msg = event.data.tool_result_message as Message | undefined;
				if (msg) history.push(msg);
				break;
			}
			case "act_end": {
				const msg = event.data.tool_result_message as Message | undefined;
				if (msg) history.push(msg);
				break;
			}
			case "compaction": {
				const summary = event.data.summary as string | undefined;
				if (summary) {
					history = [Msg.user(summary)];
				}
				break;
			}
		}
	}

	return history;
}

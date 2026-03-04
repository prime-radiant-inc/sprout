import { readFile } from "node:fs/promises";
import { type Message, Msg } from "../llm/types.ts";
import type { SessionEvent } from "./types.ts";

export type ReplayDepthMode = "root" | "first_event_depth";

/** Parse JSONL session events, skipping malformed lines. */
export function parseEventLog(raw: string): SessionEvent[] {
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			try {
				return JSON.parse(line) as SessionEvent;
			} catch {
				return null;
			}
		})
		.filter((event): event is SessionEvent => event !== null);
}

/** Load and parse a JSONL event log; returns empty array when unreadable. */
export async function loadEventLog(logPath: string): Promise<SessionEvent[]> {
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return [];
	}
	return parseEventLog(raw);
}

/**
 * Reconstruct conversation history from a sequence of events.
 *
 * - "root": include only depth=0 events (session-level resume).
 * - "first_event_depth": include only events at the first parseable depth
 *   (per-handle logs where depth is absolute in the agent tree).
 */
export function replayMessagesFromEvents(
	events: SessionEvent[],
	depthMode: ReplayDepthMode,
): Message[] {
	let history: Message[] = [];
	let selectedDepth: number | undefined;

	for (const event of events) {
		if (depthMode === "root") {
			if (event.depth !== 0) continue;
		} else {
			if (selectedDepth === undefined) selectedDepth = event.depth;
			if (event.depth !== selectedDepth) continue;
		}

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
				if (summary) history = [Msg.user(summary)];
				break;
			}
		}
	}

	return history;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "../kernel/types.ts";
import { type Message, Msg } from "../llm/types.ts";

/** Info about a child agent spawned via the bus */
export interface ChildHandleInfo {
	handleId: string;
	agentName: string;
	completed: boolean;
}

/**
 * Scan a root agent's JSONL event log for act_end events at depth 0
 * that contain a handle_id field (spawner-delegated agents).
 * Returns info about each child handle found.
 */
export async function extractChildHandles(logPath: string): Promise<ChildHandleInfo[]> {
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return [];
	}

	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	const handles: ChildHandleInfo[] = [];

	for (const line of lines) {
		let event: SessionEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.kind !== "act_end" || event.depth !== 0) continue;

		const handleId = event.data.handle_id as string | undefined;
		if (!handleId) continue;

		const agentName = (event.data.agent_name as string) ?? "unknown";
		// Blocking spawns include `turns` in the act_end data; non-blocking do not.
		// If turns is present, the agent ran to completion before the act_end was emitted.
		const completed = event.data.turns != null;

		handles.push({ handleId, agentName, completed });
	}

	return handles;
}

/**
 * Check if a specific handle's per-handle log indicates the agent completed.
 * Looks for a "session_end" event in {handleLogDir}/{handleId}.jsonl.
 */
export async function checkHandleCompleted(
	handleLogDir: string,
	handleId: string,
): Promise<boolean> {
	const logPath = join(handleLogDir, `${handleId}.jsonl`);
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return false;
	}

	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.kind === "session_end") return true;
		} catch {}
	}

	return false;
}

/**
 * Replay a per-handle JSONL event log to reconstruct conversation history
 * for resuming an agent that crashed mid-run.
 *
 * Unlike replayEventLog() (which filters depth=0 for session-level resume),
 * this filters to the first event's depth — per-handle logs contain events
 * from one specific agent, but at its absolute depth in the agent tree.
 */
export async function replayHandleLog(logPath: string): Promise<Message[]> {
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return [];

	let agentDepth: number | undefined;
	let history: Message[] = [];

	for (const line of lines) {
		let event: SessionEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		// Determine the agent's depth from the first parseable event
		if (agentDepth === undefined) {
			agentDepth = event.depth;
		}
		if (event.depth !== agentDepth) continue;

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

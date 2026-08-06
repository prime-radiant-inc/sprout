import { readFile } from "node:fs/promises";
import { ContentKind, type Message, Msg, messageToolCalls } from "../llm/types.ts";
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
	const selected: SessionEvent[] = [];

	for (const event of events) {
		if (depthMode === "root") {
			if (event.depth !== 0) continue;
		} else {
			if (selectedDepth === undefined) selectedDepth = event.depth;
			if (event.depth !== selectedDepth) continue;
		}
		selected.push(event);

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
				// Cell-spawn act events have no matching tool_use in the transcript
				// (children reach the owner only through the cell tool result), so
				// replaying their tool_result would orphan it. Telemetry consumers
				// keep these events; only history reconstruction skips them.
				if (event.data.cell_spawn === true) break;
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

	synthesizeDanglingCallResults(history, selected);
	return history;
}

const CELL_TOOL_NAME = "cell";
const DELEGATE_TOOL_NAME = "delegate";

interface SpawnStatus {
	handleId: string;
	cellSpawn: boolean;
	/** act_end seen — the child's result is journaled in its per-handle log. */
	recoverable: boolean;
}

/**
 * Close dangling tool calls left by a process that died mid-call (sap spec §4).
 *
 * When the last assistant message contains tool_use blocks with no recorded
 * tool result, every provider rejects the transcript on resume. Each dangling
 * call gets a synthesized error tool-result that tells the truth: for cell and
 * delegate calls, children whose act_end was journaled are listed as
 * `recoverable` (their per-handle logs register at resume); spawns still in
 * flight are `died_with_owner` (children die with the owner via ppid
 * monitoring) — re-spawn, don't wait.
 */
function synthesizeDanglingCallResults(history: Message[], events: SessionEvent[]): void {
	let lastAssistantIdx = -1;
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i]!.role === "assistant") {
			lastAssistantIdx = i;
			break;
		}
	}
	if (lastAssistantIdx < 0) return;

	const calls = messageToolCalls(history[lastAssistantIdx]!);
	if (calls.length === 0) return;

	const answered = new Set<string>();
	for (const msg of history.slice(lastAssistantIdx + 1)) {
		for (const part of msg.content) {
			if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
				answered.add(part.tool_result.tool_call_id);
			}
		}
	}
	const dangling = calls.filter((call) => !answered.has(call.id));
	if (dangling.length === 0) return;

	// Learn spawn fates from act events after the last plan_end: act_start with
	// no act_end → in flight (died with the owner); act_end without a
	// tool_result_message → result journaled but never delivered (recoverable).
	// act_end WITH a tool_result_message already closed its call in history.
	let lastPlanEndIdx = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]!.kind === "plan_end") {
			lastPlanEndIdx = i;
			break;
		}
	}
	const statuses = new Map<string, SpawnStatus>();
	for (const event of events.slice(lastPlanEndIdx + 1)) {
		if (event.kind !== "act_start" && event.kind !== "act_end") continue;
		if (event.data.observer === true) continue;
		const handleId = event.data.handle_id as string | undefined;
		if (!handleId) continue;
		const status = statuses.get(handleId) ?? {
			handleId,
			cellSpawn: event.data.cell_spawn === true,
			recoverable: false,
		};
		if (event.kind === "act_end") {
			if (event.data.tool_result_message) {
				statuses.delete(handleId);
				continue;
			}
			status.recoverable = true;
		}
		statuses.set(handleId, status);
	}
	const cellStatuses = [...statuses.values()].filter((s) => s.cellSpawn);
	const delegateStatuses = [...statuses.values()].filter((s) => !s.cellSpawn);
	let delegateIdx = 0;

	for (const call of dangling) {
		let message: string;
		if (call.name === CELL_TOOL_NAME) {
			const lines = cellStatuses.map((s) =>
				s.recoverable
					? `- recoverable: ${s.handleId} — result journaled; its handle registers at resume`
					: `- died_with_owner: ${s.handleId} — still in flight when the process died; children die with their owner. Re-spawn, don't wait.`,
			);
			message = [
				"The process died while a cell was running.",
				lines.length > 0
					? `Child spawns from the cell:\n${lines.join("\n")}`
					: "No child spawns were recorded before the process died.",
			].join("\n");
		} else if (call.name === DELEGATE_TOOL_NAME) {
			const status = delegateStatuses[delegateIdx++];
			if (!status) {
				message =
					"The process died while this delegation was running; no spawn was recorded, so the child never started. Re-issue if still needed.";
			} else if (status.recoverable) {
				message = `The process died while this delegation was running. recoverable: ${status.handleId} — the child's result is journaled and its handle registers at resume.`;
			} else {
				message = `The process died while this delegation was running. died_with_owner: ${status.handleId} — the child was still in flight and died with its owner. Re-spawn, don't wait.`;
			}
		} else {
			message = "The process died while this call was executing; re-issue if still needed.";
		}
		history.push(Msg.toolResult(call.id, message, true));
	}
}

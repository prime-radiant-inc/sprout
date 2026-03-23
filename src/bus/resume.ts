import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEventLog, replayMessagesFromEvents } from "../kernel/event-replay.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import type { ResultMessage } from "./types.ts";

/** Info about a child agent spawned via the bus */
export interface ChildHandleInfo {
	handleId: string;
	agentName: string;
	agentId?: string;
	completed: boolean;
}

export interface CompletedChildHandleInfo {
	handleId: string;
	result: ResultMessage;
	ownerId: string;
	agentName: string;
	agentId?: string;
}

/**
 * Scan an agent's JSONL event log for act_start and act_end events
 * at that agent's own depth that contain a handle_id field (spawner-delegated agents).
 *
 * act_start events record the handle_id at delegation time, so in-flight
 * delegations (where the agent died before act_end) are still visible.
 * act_end events update completion status when present.
 */
export async function extractChildHandles(logPath: string): Promise<ChildHandleInfo[]> {
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return [];
	}

	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	const handleMap = new Map<string, ChildHandleInfo>();
	let agentDepth: number | undefined;

	for (const line of lines) {
		let event: SessionEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (agentDepth == null) {
			agentDepth = event.depth;
		}
		if (event.depth !== agentDepth) continue;

		if (event.kind === "act_start") {
			const handleId = event.data.handle_id as string | undefined;
			if (handleId) {
				handleMap.set(handleId, {
					handleId,
					agentName: (event.data.agent_name as string) ?? "unknown",
					agentId: event.data.child_id as string | undefined,
					completed: false,
				});
			}
		}

		if (event.kind === "act_end") {
			const handleId = event.data.handle_id as string | undefined;
			if (!handleId) continue;

			const existing = handleMap.get(handleId);
			if (existing) {
				existing.completed = event.data.turns != null;
				if (!existing.agentId) {
					existing.agentId = event.data.child_id as string | undefined;
				}
			} else {
				// act_end without act_start (shouldn't happen, but handle gracefully)
				handleMap.set(handleId, {
					handleId,
					agentName: (event.data.agent_name as string) ?? "unknown",
					agentId: event.data.child_id as string | undefined,
					completed: event.data.turns != null,
				});
			}
		}
	}

	return Array.from(handleMap.values());
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
	const events = await loadEventLog(logPath);
	return replayMessagesFromEvents(events, "first_event_depth");
}

/**
 * Read a per-handle JSONL log and extract a ResultMessage from the session_end event.
 * Returns null if the log doesn't exist or has no session_end event.
 */
export async function readHandleResult(
	handleLogDir: string,
	handleId: string,
): Promise<ResultMessage | null> {
	const logPath = join(handleLogDir, `${handleId}.jsonl`);
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return null;
	}

	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.kind === "session_end") {
				return {
					kind: "result",
					handle_id: handleId,
					output: (parsed.data.output as string) ?? "",
					success: parsed.data.success as boolean,
					stumbles: parsed.data.stumbles as number,
					turns: parsed.data.turns as number,
					timed_out: parsed.data.timed_out as boolean,
				};
			}
		} catch {}
	}

	return null;
}

export async function loadCompletedChildHandles(opts: {
	logPath: string;
	handleLogDir: string;
	ownerId: string;
}): Promise<CompletedChildHandleInfo[]> {
	const childHandles = await extractChildHandles(opts.logPath);
	if (childHandles.length === 0) {
		return [];
	}

	const completed = (
		await Promise.all(
			childHandles.map(async (handle) => {
				if (!handle.completed) {
					handle.completed = await checkHandleCompleted(opts.handleLogDir, handle.handleId);
				}
				if (!handle.completed) return null;

				const result = await readHandleResult(opts.handleLogDir, handle.handleId);
				if (!result) return null;

				return {
					handleId: handle.handleId,
					result,
					ownerId: opts.ownerId,
					agentName: handle.agentName,
					agentId: handle.agentId,
				} satisfies CompletedChildHandleInfo;
			}),
		)
	).filter((handle): handle is NonNullable<typeof handle> => handle !== null);

	return completed;
}

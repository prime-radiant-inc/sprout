import type { SessionEvent } from "@kernel/types.ts";
import { type AgentTreeNode, getDescendantIds } from "../hooks/useAgentTree.ts";

/** Extract the most informative single arg from a tool's args for compact display. */
function extractArgSummary(_toolName: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const path = args.path;
	const command = args.command;
	const pattern = args.pattern;
	if (typeof path === "string") return path;
	if (typeof command === "string") return command;
	if (typeof pattern === "string") return pattern;
	return "";
}

/** A single tool call summary for live peek display. */
export interface ToolCallSummary {
	name: string;
	args: string;
	success: boolean;
}

export interface GroupedEvent {
	event: SessionEvent;
	isFirstInGroup: boolean;
	isLastInGroup: boolean;
	durationMs: number | null;
	streamingText?: string;
	agentName?: string;
	/** Live peek summary for running delegations (legacy single-line). */
	livePeek?: string;
	/** Recent tool calls for running delegations (richer display). */
	livePeekTools?: ToolCallSummary[];
	/** Args from the matching primitive_start (primitive_end events don't carry args). */
	args?: Record<string, unknown>;
	/** Set when a delegation was still running at session_end (crash/abort). */
	abandoned?: boolean;
}

/** Event kinds that are never displayed. */
const INVISIBLE_KINDS = new Set([
	"context_update",
	"exit_hint",
	"session_start",
	"session_end",
	"recall",
	"verify",
	"learn_signal",
	"learn_end",
	"log",
	"llm_start",
	"llm_chunk",
	"llm_end",
]);

/** Event kinds that can be grouped with consecutive events of the same kind + agent. */
const GROUPABLE_KINDS = new Set(["plan_end", "perceive"]);

/**
 * Build a key for matching start/end event pairs for duration tracking.
 * Returns null if the event isn't a start/end pair we track.
 */
function durationKey(event: SessionEvent): string | null {
	const { kind, agent_id, data } = event;
	switch (kind) {
		case "plan_start":
		case "plan_end":
			return `${agent_id}:plan`;
		case "primitive_start":
		case "primitive_end":
			return `${agent_id}:primitive:${data.name}`;
		case "act_start":
		case "act_end":
			return `${agent_id}:act:${data.child_id ?? data.agent_name}`;
		default:
			return null;
	}
}

/** Build a flat agentId-to-agentName map from the agent tree. */
export function buildNameMap(node: AgentTreeNode): Map<string, string> {
	const map = new Map<string, string>();
	function walk(n: AgentTreeNode) {
		map.set(n.agentId, n.agentName);
		for (const child of n.children) walk(child);
	}
	walk(node);
	return map;
}

/**
 * Groups consecutive events from the same agent, inserting group boundaries
 * when the agent changes, event kind changes, a non-groupable event intervenes,
 * or >60 seconds pass between events.
 */
export function groupEvents(
	events: SessionEvent[],
	agentFilter?: string | null,
	tree?: AgentTreeNode,
): GroupedEvent[] {
	const allowedIds =
		agentFilter && tree ? getDescendantIds(tree, agentFilter) : null;
	const rootAgentId = tree?.agentId;
	const visibleMainAgentIds =
		!agentFilter && rootAgentId
			? new Set([rootAgentId, "session", "cli", "logger"])
			: null;
	const nameMap = tree ? buildNameMap(tree) : new Map<string, string>();
	const startTimes = new Map<string, number>();
	const streamBuffers = new Map<string, string>();
	const lastDeltaIdx = new Map<string, number>();
	const result: GroupedEvent[] = [];

	// Delegation merging: track child_ids for filtering child events from parent view
	const merging = !agentFilter; // only merge in parent (unfiltered) view
	const directChildIds = new Set<string>();
	const childPeek = new Map<string, string>(); // child_id -> latest activity summary
	const childPeekTools = new Map<string, ToolCallSummary[]>(); // child_id -> recent tool calls
	const pendingActStarts = new Map<string, number>(); // child_id -> index in result array
	const lastPrimitiveArgs = new Map<string, Record<string, unknown>>(); // agent_id:name -> args from primitive_start

	for (let i = 0; i < events.length; i++) {
		const event = events[i]!;

		// Duration tracking runs for all events (even filtered ones)
		// so that end events can find their start times.
		const key = durationKey(event);
		let durationMs: number | null = null;
		if (key) {
			const isEnd = event.kind.endsWith("_end");
			if (!isEnd) {
				startTimes.set(key, event.timestamp);
			} else {
				const startTime = startTimes.get(key);
				startTimes.delete(key);
				durationMs =
					startTime != null ? event.timestamp - startTime : null;
			}
		}

		// Track child_ids from act_start events with child_id
		if (
			merging &&
			event.kind === "act_start" &&
			typeof event.data.child_id === "string" &&
			(!rootAgentId || event.agent_id === rootAgentId)
		) {
			directChildIds.add(event.data.child_id);
		}

		// In parent view, filter out events from direct children (but update peek first)
		if (merging && directChildIds.has(event.agent_id)) {
			if (event.kind === "primitive_start") {
				// Store args from primitive_start so primitive_end can use them
				const name = String(event.data.name ?? "");
				if (event.data.args) {
					lastPrimitiveArgs.set(`${event.agent_id}:${name}`, event.data.args as Record<string, unknown>);
				}
			} else if (event.kind === "primitive_end") {
				const toolName = String(event.data.name ?? "");
				// Read args from the matching primitive_start (args is not on primitive_end events)
				const argsKey = `${event.agent_id}:${toolName}`;
				const args = lastPrimitiveArgs.get(argsKey);
				lastPrimitiveArgs.delete(argsKey);
				const argsStr = extractArgSummary(toolName, args);
				const success = Boolean(event.data.success);
				childPeek.set(event.agent_id, argsStr ? `${toolName} ${argsStr}` : toolName);
				// Accumulate recent tool calls (keep last 3)
				const tools = childPeekTools.get(event.agent_id) ?? [];
				tools.push({ name: toolName, args: argsStr, success });
				if (tools.length > 3) tools.shift();
				childPeekTools.set(event.agent_id, tools);
			} else if (event.kind === "plan_end" && typeof event.data.text === "string") {
				const text = event.data.text;
				childPeek.set(event.agent_id, text.length > 60 ? `${text.slice(0, 60)}...` : text);
			}
			continue;
		}

		// In the main (unfiltered) view, render only the root/session surface.
		// Child-agent events should be represented via delegation cards, not raw text.
		if (merging && visibleMainAgentIds && !visibleMainAgentIds.has(event.agent_id)) {
			continue;
		}

		// Accumulate streaming text for plan_delta events
		if (event.kind === "plan_delta") {
			const prev = streamBuffers.get(event.agent_id) ?? "";
			const text =
				typeof event.data.text === "string" ? event.data.text : "";
			streamBuffers.set(event.agent_id, prev + text);
		}
		if (event.kind === "plan_end" || event.kind === "plan_start") {
			streamBuffers.delete(event.agent_id);
			lastDeltaIdx.delete(event.agent_id);
		}

		// On session_end, mark any still-pending delegations as abandoned
		// so they don't show stale "running" cards after a crash.
		if (merging && event.kind === "session_end") {
			for (const [childId, idx] of pendingActStarts) {
				const entry = result[idx];
				if (entry) {
					const peek = childPeek.get(childId);
					const tools = childPeekTools.get(childId);
					result[idx] = {
						...entry,
						abandoned: true,
						...(peek ? { livePeek: peek } : {}),
						...(tools ? { livePeekTools: [...tools] } : {}),
					};
				}
			}
			pendingActStarts.clear();
		}

		// Apply agent filter (includes descendants)
		if (allowedIds && !allowedIds.has(event.agent_id)) continue;

		// Skip invisible events
		if (INVISIBLE_KINDS.has(event.kind)) continue;

		// Track args from primitive_start before skipping (primitive_end doesn't carry args)
		if (event.kind === "primitive_start") {
			const name = String(event.data.name ?? "");
			if (event.data.args) {
				lastPrimitiveArgs.set(`${event.agent_id}:${name}`, event.data.args as Record<string, unknown>);
			}
			continue;
		}

		// Skip plan_start (not displayed)
		if (event.kind === "plan_start") continue;

		// Delegation merging: handle act_start/act_end with child_id
		if (merging && typeof event.data.child_id === "string") {
			const childId = event.data.child_id;
			if (event.kind === "act_start") {
				const idx = result.length;
				pendingActStarts.set(childId, idx);
				result.push({
					event,
					durationMs,
					isFirstInGroup: true,
					isLastInGroup: true,
					agentName: nameMap.get(event.agent_id),
				});
				continue;
			}
			if (event.kind === "act_end") {
				const startIdx = pendingActStarts.get(childId);
				if (startIdx !== undefined) {
					// Replace the act_start entry with the act_end entry
					result[startIdx] = {
						event,
						durationMs,
						isFirstInGroup: true,
						isLastInGroup: true,
						agentName: nameMap.get(event.agent_id),
					};
					pendingActStarts.delete(childId);
					continue;
				}
			}
		}

		// Collapse plan_delta events: replace previous delta with latest accumulated text
		if (event.kind === "plan_delta") {
			const prevIdx = lastDeltaIdx.get(event.agent_id);
			const entry: GroupedEvent = {
				event,
				durationMs,
				isFirstInGroup: true,
				isLastInGroup: true,
				streamingText: streamBuffers.get(event.agent_id),
				agentName: nameMap.get(event.agent_id),
			};
			if (prevIdx !== undefined) {
				result[prevIdx] = entry;
			} else {
				lastDeltaIdx.set(event.agent_id, result.length);
				result.push(entry);
			}
			continue;
		}

		// Look up args from matching primitive_start for primitive_end events
		let args: Record<string, unknown> | undefined;
		if (event.kind === "primitive_end") {
			const argsKey = `${event.agent_id}:${String(event.data.name ?? "")}`;
			args = lastPrimitiveArgs.get(argsKey);
			lastPrimitiveArgs.delete(argsKey);
		}

		result.push({
			event,
			durationMs,
			isFirstInGroup: true,
			isLastInGroup: true,
			agentName: nameMap.get(event.agent_id),
			...(args ? { args } : {}),
		});
	}

	// Update live peek for still-pending (running) delegations
	for (const [childId, idx] of pendingActStarts) {
		const peek = childPeek.get(childId);
		const tools = childPeekTools.get(childId);
		if (peek || tools) {
			result[idx] = {
				...result[idx]!,
				...(peek ? { livePeek: peek } : {}),
				...(tools ? { livePeekTools: [...tools] } : {}),
			};
		}
	}

	// Apply grouping metadata.
	// Walk result and mark consecutive groupable events of the same kind + agent.
	for (let i = 0; i < result.length; i++) {
		const curr = result[i]!;
		if (!GROUPABLE_KINDS.has(curr.event.kind)) continue;

		const next = result[i + 1];
		if (!next) continue;
		if (next.event.kind !== curr.event.kind) continue;
		if (next.event.agent_id !== curr.event.agent_id) continue;
		if (next.event.timestamp - curr.event.timestamp > 60_000) continue;

		// They belong to the same group
		curr.isLastInGroup = false;
		next.isFirstInGroup = false;
	}

	return result;
}

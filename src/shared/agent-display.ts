import type { SessionEvent } from "../kernel/types.ts";
import type { ToolCallData } from "../llm/types.ts";

export interface AgentDisplayRef {
	agentName?: string;
	targetAgentName?: string;
	mnemonicName?: string;
	childId?: string;
	handleId?: string;
}

export type ActiveAgentWork =
	| {
			kind: "agent";
			agent: AgentDisplayRef;
	  }
	| {
			kind: "memory";
	  };

export function formatAgentDisplayName(ref: AgentDisplayRef): string {
	const role = cleanString(ref.targetAgentName) ?? cleanString(ref.agentName) ?? "agent";
	const mnemonic = cleanString(ref.mnemonicName);
	if (!mnemonic || mnemonic === role) return role;
	return `${mnemonic} · ${role}`;
}

export function formatActiveAgentWork(work: ActiveAgentWork): string {
	if (work.kind === "memory") return "Saving memory";
	return `Waiting on ${formatAgentDisplayName(work.agent)}`;
}

interface ActiveChildRecord extends AgentDisplayRef {
	startedAt: number;
	depth: number;
	commandCallId?: string;
}

export function deriveActiveAgentWork(
	events: readonly SessionEvent[],
	runStatus: "idle" | "running" | "interrupted",
): ActiveAgentWork | null {
	if (runStatus !== "running") return null;

	const handles = new Map<string, AgentDisplayRef>();
	const children = new Map<string, AgentDisplayRef>();
	const activeChildren = new Map<string, ActiveChildRecord>();
	const pendingCommands = new Map<string, ActiveChildRecord>();
	let rootRunning = false;
	let rootEnded = false;

	for (const event of events) {
		if (event.depth === 0 && event.kind === "session_start") {
			rootRunning = true;
			rootEnded = false;
			activeChildren.clear();
			pendingCommands.clear();
		}

		if (event.depth === 0 && (event.kind === "session_end" || event.kind === "interrupted")) {
			rootEnded = event.kind === "session_end";
			rootRunning = false;
			activeChildren.clear();
			pendingCommands.clear();
		}

		if (event.kind === "act_start") {
			const ref = refFromEventData(event.data);
			if (ref.handleId) handles.set(ref.handleId, ref);
			if (ref.childId) {
				children.set(ref.childId, ref);
				activeChildren.set(ref.childId, {
					...ref,
					startedAt: event.timestamp,
					depth: event.depth + 1,
				});
			}
		}

		if (event.kind === "act_end") {
			const ref = refFromEventData(event.data);
			if (ref.handleId) handles.set(ref.handleId, ref);
			if (ref.childId) {
				children.set(ref.childId, { ...children.get(ref.childId), ...ref });
				activeChildren.delete(ref.childId);
				removePendingCommandForChild(pendingCommands, ref.childId);
			}
			if (ref.agentName === "wait_agent" || ref.agentName === "message_agent") {
				removePendingCommandForChild(pendingCommands, ref.childId);
				removePendingCommandForToolCall(
					pendingCommands,
					toolCallIdFromResultMessage(event.data.tool_result_message),
				);
			}
		}

		if (event.kind === "plan_end") {
			for (const call of extractAgentCommandToolCalls(event.data.assistant_message)) {
				if (call.name === "message_agent" && call.blocking === false) continue;
				const ref = handles.get(call.handle) ?? { handleId: call.handle, agentName: call.name };
				const childKey = ref.childId ?? call.handle;
				pendingCommands.set(`${event.agent_id}:${call.id}`, {
					...ref,
					startedAt: event.timestamp,
					depth: event.depth + 1,
					childId: childKey,
					commandCallId: call.id,
				});
			}
		}

		if (event.kind === "session_start" && event.depth > 0) {
			const ref = children.get(event.agent_id) ?? {
				childId: event.agent_id,
				agentName: event.agent_id,
			};
			activeChildren.set(event.agent_id, {
				...ref,
				startedAt: event.timestamp,
				depth: event.depth,
			});
			removePendingCommandForChild(pendingCommands, event.agent_id);
		}

		if (event.kind === "session_end" && event.depth > 0) {
			activeChildren.delete(event.agent_id);
		}
	}

	const activeChild = latestByDepthAndStart([...activeChildren.values()]);
	if (activeChild) return { kind: "agent", agent: toAgentDisplayRef(activeChild) };

	const pending = latestByDepthAndStart([...pendingCommands.values()]);
	if (pending) return { kind: "agent", agent: toAgentDisplayRef(pending) };

	if (rootEnded && !rootRunning) return { kind: "memory" };
	return null;
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function refFromEventData(data: Record<string, unknown>): AgentDisplayRef {
	return {
		agentName: cleanString(data.agent_name),
		targetAgentName: cleanString(data.target_agent_name),
		mnemonicName: cleanString(data.mnemonic_name),
		childId: cleanString(data.child_id),
		handleId: cleanString(data.handle_id),
	};
}

function latestByDepthAndStart(records: ActiveChildRecord[]): ActiveChildRecord | null {
	return [...records].sort((a, b) => b.depth - a.depth || b.startedAt - a.startedAt)[0] ?? null;
}

function removePendingCommandForChild(
	pendingCommands: Map<string, ActiveChildRecord>,
	childId: string | undefined,
): void {
	if (!childId) return;
	for (const [key, value] of pendingCommands) {
		if (value.childId === childId) pendingCommands.delete(key);
	}
}

function removePendingCommandForToolCall(
	pendingCommands: Map<string, ActiveChildRecord>,
	toolCallId: string | undefined,
): void {
	if (!toolCallId) return;
	for (const [key, value] of pendingCommands) {
		if (value.commandCallId === toolCallId) pendingCommands.delete(key);
	}
}

function extractAgentCommandToolCalls(value: unknown): Array<{
	id: string;
	name: "wait_agent" | "message_agent";
	handle: string;
	blocking?: boolean;
}> {
	if (!value || typeof value !== "object") return [];
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];

	const calls: Array<{
		id: string;
		name: "wait_agent" | "message_agent";
		handle: string;
		blocking?: boolean;
	}> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const toolCall = (part as { tool_call?: ToolCallData }).tool_call;
		if (!toolCall) continue;
		if (toolCall.name !== "wait_agent" && toolCall.name !== "message_agent") continue;
		const args =
			typeof toolCall.arguments === "string"
				? safeParseArgs(toolCall.arguments)
				: toolCall.arguments;
		const handle = cleanString(args?.handle);
		if (!handle) continue;
		calls.push({
			id: toolCall.id,
			name: toolCall.name,
			handle,
			blocking: typeof args?.blocking === "boolean" ? args.blocking : undefined,
		});
	}
	return calls;
}

function toolCallIdFromResultMessage(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const directId = cleanString((value as { tool_call_id?: unknown }).tool_call_id);
	if (directId) return directId;

	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const toolResult = (part as { tool_result?: { tool_call_id?: unknown } }).tool_result;
		const nestedId = cleanString(toolResult?.tool_call_id);
		if (nestedId) return nestedId;
	}
	return undefined;
}

function safeParseArgs(value: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function toAgentDisplayRef(record: ActiveChildRecord): AgentDisplayRef {
	return {
		agentName: record.agentName,
		targetAgentName: record.targetAgentName,
		mnemonicName: record.mnemonicName,
		childId: record.childId,
		handleId: record.handleId,
	};
}

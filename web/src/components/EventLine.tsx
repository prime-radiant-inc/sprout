import type { SessionEvent } from "@kernel/types.ts";
import type { ToolCallSummary } from "./groupEvents.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { DelegationBlock } from "./DelegationBlock.tsx";
import { SystemMessage } from "./SystemMessage.tsx";
import { ToolCall } from "./ToolCall.tsx";
import { UserMessage } from "./UserMessage.tsx";

interface EventLineProps {
	event: SessionEvent;
	durationMs: number | null;
	streamingText?: string;
	isFirstInGroup?: boolean;
	agentName?: string;
	livePeek?: string;
	livePeekTools?: ToolCallSummary[];
	/** Args from matching primitive_start (primitive_end events don't carry args). */
	args?: Record<string, unknown>;
	/** Whether this delegation was abandoned (session ended without act_end). */
	abandoned?: boolean;
	onSelectAgent?: (agentId: string) => void;
}

/**
 * Dispatcher: maps a SessionEvent to the appropriate display component.
 * Returns null for events that should not be displayed.
 */
export function EventLine({ event, durationMs, streamingText, isFirstInGroup, agentName, livePeek, livePeekTools, args: groupedArgs, abandoned, onSelectAgent }: EventLineProps) {
	const { kind, data } = event;

	switch (kind) {
		case "perceive":
			return (
				<UserMessage
					text={String(data.goal ?? "")}
					isFirstInGroup={isFirstInGroup}
					timestamp={event.timestamp}
				/>
			);

		case "steering":
			return (
				<UserMessage
					text={String(data.text ?? "")}
					isSteering
					isFirstInGroup={isFirstInGroup}
					timestamp={event.timestamp}
				/>
			);

		case "plan_end": {
			const text = data.text ? String(data.text) : undefined;
			const reasoning = data.reasoning ? String(data.reasoning) : undefined;
			if (!text && !reasoning) return null;
			return (
				<AssistantMessage
					text={text}
					reasoning={reasoning}
					agentName={agentName}
					isFirstInGroup={isFirstInGroup}
					timestamp={event.timestamp}
				/>
			);
		}

		case "primitive_start":
			return null;

		case "primitive_end":
			return (
				<ToolCall
					toolName={data.name as string}
					success={Boolean(data.success)}
					args={groupedArgs ?? (data.args as Record<string, unknown>)}
					error={data.error ? String(data.error) : undefined}
					output={data.output ? String(data.output) : undefined}
					durationMs={durationMs}
				/>
			);

		case "act_start":
			return (
				<DelegationBlock
					agentName={data.agent_name as string}
					goal={data.goal as string}
					description={typeof data.description === "string" ? data.description : undefined}
					status={abandoned ? "failed" : "running"}
					livePeek={livePeek}
					livePeekTools={livePeekTools}
					onOpenThread={onSelectAgent && typeof data.child_id === "string" ? () => onSelectAgent(data.child_id as string) : undefined}
				/>
			);

		case "act_end":
			return (
				<DelegationBlock
					agentName={data.agent_name as string}
					goal={typeof data.goal === "string" ? data.goal : ""}
					description={typeof data.description === "string" ? data.description : undefined}
					status={data.success ? "completed" : "failed"}
					turns={typeof data.turns === "number" ? data.turns : undefined}
					durationMs={durationMs}
					onOpenThread={onSelectAgent && typeof data.child_id === "string" ? () => onSelectAgent(data.child_id as string) : undefined}
				/>
			);

		case "warning":
			return (
				<SystemMessage kind="warning" message={String(data.message)} />
			);

		case "error":
			return <SystemMessage kind="error" message={String(data.error)} />;

		case "compaction": {
			const header = `Context compacted: ${data.beforeCount} \u2192 ${data.afterCount} messages`;
			const summary = data.summary ? `\n${data.summary}` : "";
			return (
				<SystemMessage
					kind="compaction"
					message={`${header}${summary}`}
				/>
			);
		}

		case "interrupted":
			return (
				<SystemMessage
					kind="interrupted"
					message={String(data.message ?? "user interrupt")}
				/>
			);

		case "session_resume":
			return (
				<SystemMessage
					kind="session_resume"
					message={`Resumed session (${data.history_length ?? 0} messages of history)`}
				/>
			);

		case "session_clear":
			return (
				<SystemMessage
					kind="session_clear"
					message="New session started"
				/>
			);

		case "learn_start":
			return (
				<SystemMessage
					kind="learn_start"
					message="Learning from stumble..."
				/>
			);

		case "learn_mutation":
			return (
				<SystemMessage
					kind="learn_mutation"
					message={`Genome updated: ${data.mutation_type}`}
				/>
			);

		case "plan_delta":
			if (!streamingText) return null;
			return (
				<AssistantMessage
					text={streamingText}
					agentName={agentName}
					isFirstInGroup={isFirstInGroup}
					timestamp={event.timestamp}
				/>
			);

		// Skip these — not displayed in conversation
		case "session_start":
		case "session_end":
		case "plan_start":
		case "context_update":
		case "exit_hint":
		case "recall":
		case "verify":
		case "learn_signal":
		case "learn_end":
		case "log":
		case "task_update":
		case "llm_start":
		case "llm_chunk":
		case "llm_end":
			return null;

		default:
			// Exhaustiveness check: if a new EventKind is added, this line will error
			kind satisfies never;
			return null;
	}
}

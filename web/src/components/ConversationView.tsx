import { useMemo } from "react";
import type { SessionEvent } from "@kernel/types.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { EmptyState } from "./EmptyState.tsx";
import { EventErrorBoundary } from "./EventErrorBoundary.tsx";
import { EventLine } from "./EventLine.tsx";
import { groupEvents } from "./groupEvents.ts";
import { StreamingBanner } from "./StreamingBanner.tsx";
import styles from "./ConversationView.module.css";

interface ConversationViewProps {
	events: SessionEvent[];
	/** When set, only show events from this agent and its descendants. */
	agentFilter?: string | null;
	/** Agent tree for descendant resolution. */
	tree: AgentTreeNode;
	/** Navigate into a child agent's thread. */
	onSelectAgent?: (agentId: string) => void;
}

/** Scrollable list of rendered session events. */
export function ConversationView({
	events,
	agentFilter,
	tree,
	onSelectAgent,
}: ConversationViewProps) {
	const grouped = useMemo(
		() => groupEvents(events, agentFilter, tree),
		[events, agentFilter, tree],
	);

	const lastVisible = grouped[grouped.length - 1];
	const isStreaming = lastVisible?.event.kind === "plan_delta";
	const streamingAgentName = useMemo(() => {
		if (!isStreaming) return null;
		return lastVisible?.agentName ?? null;
	}, [isStreaming, lastVisible]);

	// Show empty state when no visible events exist
	if (grouped.length === 0 && !agentFilter) {
		return <EmptyState />;
	}

	return (
		<div className={styles.conversationView}>
			{grouped.map(({ event, durationMs, streamingText, isFirstInGroup, agentName, userName, livePeek, livePeekTools, args, abandoned }, i) => (
				<EventErrorBoundary key={`${event.agent_id}-${event.kind}-${event.timestamp}-${i}`} eventKind={event.kind}>
					<EventLine
						event={event}
						durationMs={durationMs}
						streamingText={streamingText}
						isFirstInGroup={isFirstInGroup}
						agentName={agentName}
						userName={userName}
						livePeek={livePeek}
						livePeekTools={livePeekTools}
						args={args}
						abandoned={abandoned}
						onSelectAgent={onSelectAgent}
					/>
				</EventErrorBoundary>
			))}
			{isStreaming && streamingAgentName && (
				<StreamingBanner agentName={streamingAgentName} />
			)}
		</div>
	);
}

import { useMemo } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import { EventLine } from "./EventLine.tsx";
import { buildNameMap, groupEvents } from "./groupEvents.ts";
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

	const isStreaming = events.length > 0 && events[events.length - 1]?.kind === "plan_delta";
	const streamingAgentName = useMemo(() => {
		if (!isStreaming) return null;
		const agentId = events[events.length - 1]!.agent_id;
		return buildNameMap(tree).get(agentId) ?? agentId;
	}, [isStreaming, events, tree]);

	return (
		<div className={styles.conversationView}>
			{grouped.map(({ event, durationMs, streamingText, isFirstInGroup, agentName }, i) => (
				<EventLine
					key={`${event.agent_id}-${event.kind}-${event.timestamp}-${i}`}
					event={event}
					durationMs={durationMs}
					streamingText={streamingText}
					isFirstInGroup={isFirstInGroup}
					agentName={agentName}
					onSelectAgent={onSelectAgent}
				/>
			))}
			{isStreaming && streamingAgentName && (
				<StreamingBanner agentName={streamingAgentName} />
			)}
		</div>
	);
}

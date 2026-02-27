import { useMemo } from "react";
import type { SessionEvent } from "../../../src/kernel/types.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { EventLine } from "./EventLine.tsx";
import { groupEvents } from "./groupEvents.ts";
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

	return (
		<div className={styles.conversationView}>
			{grouped.map(({ event, durationMs, streamingText, isFirstInGroup }, i) => (
				<EventLine
					key={i}
					event={event}
					durationMs={durationMs}
					streamingText={streamingText}
					isFirstInGroup={isFirstInGroup}
					onSelectAgent={onSelectAgent}
				/>
			))}
		</div>
	);
}

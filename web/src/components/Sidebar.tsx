import type { SessionEvent } from "../../../src/kernel/types.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import type { SessionStatus } from "../hooks/useEvents.ts";
import { AgentTree } from "./AgentTree.tsx";
import { SidebarSessionSummary } from "./SidebarSessionSummary.tsx";
import styles from "./Sidebar.module.css";

export interface SidebarProps {
	status: SessionStatus;
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	collapsed: boolean;
	onToggle: () => void;
	events: SessionEvent[];
}

/** Adaptive sidebar: shows agent tree while running, session summary while idle. */
export function Sidebar({
	status,
	tree,
	selectedAgent,
	onSelectAgent,
	collapsed,
	onToggle,
	events,
}: SidebarProps) {
	const showTree = status.status === "running" || status.status === "interrupted";

	return (
		<div className={styles.sidebar}>
			{showTree ? (
				<AgentTree
					tree={tree}
					selectedAgent={selectedAgent}
					onSelectAgent={onSelectAgent}
					onToggle={onToggle}
				/>
			) : (
				<SidebarSessionSummary status={status} events={events} />
			)}
		</div>
	);
}

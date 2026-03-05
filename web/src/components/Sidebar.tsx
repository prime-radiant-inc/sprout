import type { SessionEvent } from "@kernel/types.ts";
import type { AgentStats } from "../hooks/useAgentStats.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import type { SessionStatus } from "../hooks/useEvents.ts";
import type { Task } from "../hooks/useTaskList.ts";
import { AgentTree } from "./AgentTree.tsx";
import { SidebarSessionSummary } from "./SidebarSessionSummary.tsx";
import { SidebarTaskList } from "./SidebarTaskList.tsx";
import styles from "./Sidebar.module.css";

export interface SidebarProps {
	status: SessionStatus;
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	onToggle: () => void;
	events: SessionEvent[];
	agentStats?: Map<string, AgentStats>;
	tasks: Task[];
}

/** Adaptive sidebar: shows agent tree while running, session summary while idle. */
export function Sidebar({
	status,
	tree,
	selectedAgent,
	onSelectAgent,
	onToggle,
	events,
	agentStats,
	tasks,
}: SidebarProps) {
	const showTree = tree.children.length > 0 || status.status === "running" || status.status === "interrupted";

	return (
		<div className={styles.sidebar}>
			{showTree ? (
				<>
					<AgentTree
						tree={tree}
						selectedAgent={selectedAgent}
						onSelectAgent={onSelectAgent}
						onToggle={onToggle}
						agentStats={agentStats}
					/>
					<SidebarTaskList tasks={tasks} />
				</>
			) : (
				<SidebarSessionSummary status={status} events={events} />
			)}
		</div>
	);
}

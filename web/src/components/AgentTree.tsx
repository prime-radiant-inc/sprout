import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import styles from "./AgentTree.module.css";

interface AgentTreeProps {
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	onToggle?: () => void;
}

function truncateGoal(goal: string, maxLen = 60): string {
	if (goal.length <= maxLen) return goal;
	return `${goal.slice(0, maxLen - 1)}...`;
}

function statusIcon(status: AgentTreeNode["status"]): string {
	switch (status) {
		case "completed":
			return "\u2713";
		case "failed":
			return "\u2717";
		case "running":
			return "\u25CF"; // filled circle — CSS animates it
	}
}

const statusClasses: Record<AgentTreeNode["status"], string | undefined> = {
	completed: styles.statusCompleted,
	failed: styles.statusFailed,
	running: styles.statusRunning,
};

function TreeNode({
	node,
	selectedAgent,
	onSelectAgent,
}: {
	node: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
}) {
	const isSelected = selectedAgent === node.agentId;

	return (
		<li>
			<button
				type="button"
				className={`${styles.node} ${isSelected ? styles.selected : ""}`}
				data-agent-id={node.agentId}
				data-selected={isSelected ? "true" : undefined}
				data-status={node.status}
				onClick={() => onSelectAgent(node.agentId)}
			>
				<span className={statusClasses[node.status]}>
					{statusIcon(node.status)}
				</span>
				<span className={styles.agentName}>{node.agentName}</span>
				<span className={styles.goal}>{truncateGoal(node.goal)}</span>
			</button>
			{node.children.length > 0 && (
				<ul className={styles.children}>
					{node.children.map((child) => (
						<TreeNode
							key={child.agentId}
							node={child}
							selectedAgent={selectedAgent}
							onSelectAgent={onSelectAgent}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

/** Sidebar panel showing the agent tree with selection support. */
export function AgentTree({
	tree,
	selectedAgent,
	onSelectAgent,
	onToggle,
}: AgentTreeProps) {
	const allSelected = selectedAgent === null;

	return (
		<nav className={styles.agentTree}>
			<div className={styles.header}>
				<span className={styles.title}>Agents</span>
				{onToggle && (
					<button
						type="button"
						className={styles.toggle}
						data-action="toggle"
						onClick={onToggle}
					>
						{"\u00AB"}
					</button>
				)}
			</div>
			<button
				type="button"
				className={`${styles.allAgents} ${allSelected ? styles.selected : ""}`}
				data-agent-id="all"
				data-selected={allSelected ? "true" : undefined}
				onClick={() => onSelectAgent(null)}
			>
				All agents
			</button>
			<ul className={styles.treeRoot}>
				<TreeNode
					node={tree}
					selectedAgent={selectedAgent}
					onSelectAgent={onSelectAgent}
				/>
			</ul>
		</nav>
	);
}

import { useEffect, useState } from "react";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import styles from "./AgentTree.module.css";

interface AgentTreeProps {
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	onToggle?: () => void;
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
	defaultExpanded,
}: {
	node: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	defaultExpanded?: boolean;
}) {
	const hasChildren = node.children.length > 0;
	const isSelected = selectedAgent === node.agentId;
	const [expanded, setExpanded] = useState(defaultExpanded ?? true);

	// Auto-expand when a running child appears
	useEffect(() => {
		if (node.children.some((c) => c.status === "running")) {
			setExpanded(true);
		}
	}, [node.children]);

	return (
		<li>
			<div className={`${styles.nodeRow} ${isSelected ? styles.selected : ""}`}>
				{hasChildren ? (
					<button
						type="button"
						className={styles.disclosure}
						data-disclosure={expanded ? "open" : "closed"}
						onClick={() => setExpanded((prev) => !prev)}
						aria-label={expanded ? "Collapse" : "Expand"}
						aria-expanded={expanded}
					>
						{expanded ? "\u25BE" : "\u25B8"}
					</button>
				) : (
					<span className={styles.disclosureSpacer} />
				)}
				<button
					type="button"
					className={styles.node}
					data-agent-id={node.agentId}
					data-selected={isSelected ? "true" : undefined}
					data-status={node.status}
					onClick={() => onSelectAgent(node.agentId)}
				>
					<div className={styles.nodeHeader}>
						<span className={statusClasses[node.status]}>
							{statusIcon(node.status)}
						</span>
						<span className={styles.agentName}>{node.agentName}</span>
						{node.durationMs != null && node.status !== "running" && (
							<span className={styles.duration}>
								{(node.durationMs / 1000).toFixed(1)}s
							</span>
						)}
					</div>
					{node.goal && (
						<div className={styles.goal}>{node.goal}</div>
					)}
				</button>
			</div>
			{hasChildren && expanded && (
				<ul className={styles.children}>
					{node.children.map((child, idx) => (
						<TreeNode
							key={`${child.agentId}-${idx}`}
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
				className={`${styles.allAgents} ${allSelected ? styles.allSelected : ""}`}
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

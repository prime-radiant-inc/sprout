import { useEffect, useState } from "react";
import type { AgentStats } from "../hooks/useAgentStats.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { formatCompactNumber } from "../hooks/useTokenUsage.ts";
import styles from "./AgentTree.module.css";

interface AgentTreeProps {
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	onToggle?: () => void;
	agentStats?: Map<string, AgentStats>;
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

const stateLabels: Record<string, string> = {
	calling_llm: "Calling LLM",
	executing_tool: "Executing tool",
	delegating: "Delegating",
	idle: "Idle",
};

/** Returns true if this agent has meaningful stats to show. */
function hasActivity(stats: AgentStats): boolean {
	return stats.state !== "idle" || stats.inputTokens > 0 || stats.outputTokens > 0 || stats.currentTurn > 0;
}

function StatsLine({ stats }: { stats: AgentStats }) {
	if (!hasActivity(stats)) return null;

	return (
		<div className={styles.statsLine} data-agent-state={stats.state}>
			<span className={styles.stateLabel}>{stateLabels[stats.state] ?? stats.state}</span>
			{stats.currentTurn > 0 && (
				<span className={styles.statsTurn}>T{stats.currentTurn}</span>
			)}
			{(stats.inputTokens > 0 || stats.outputTokens > 0) && (
				<span className={styles.statsTokens}>
					{formatCompactNumber(stats.inputTokens)}/{formatCompactNumber(stats.outputTokens)}
				</span>
			)}
		</div>
	);
}

function TreeNode({
	node,
	selectedAgent,
	onSelectAgent,
	defaultExpanded,
	agentStats,
}: {
	node: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent: (agentId: string | null) => void;
	defaultExpanded?: boolean;
	agentStats?: Map<string, AgentStats>;
}) {
	const hasChildren = node.children.length > 0;
	const isSelected = selectedAgent === node.agentId;
	const [expanded, setExpanded] = useState(defaultExpanded ?? true);
	const stats = agentStats?.get(node.agentId);

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
					{(node.description || node.goal) && (
						<div className={styles.goal}>{node.description ?? node.goal}</div>
					)}
					{stats && <StatsLine stats={stats} />}
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
							agentStats={agentStats}
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
	agentStats,
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
					agentStats={agentStats}
				/>
			</ul>
		</nav>
	);
}

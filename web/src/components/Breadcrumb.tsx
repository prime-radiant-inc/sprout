import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import styles from "./Breadcrumb.module.css";

interface BreadcrumbProps {
	tree: AgentTreeNode;
	selectedAgent: string | null;
}

/**
 * Find the path from root to the node with the given agentId.
 * Returns the list of agent names along the path, or null if not found.
 */
function findPath(
	node: AgentTreeNode,
	targetId: string,
): string[] | null {
	if (node.agentId === targetId) {
		return [node.agentName];
	}
	for (const child of node.children) {
		const childPath = findPath(child, targetId);
		if (childPath) {
			return [node.agentName, ...childPath];
		}
	}
	return null;
}

/** Breadcrumb trail showing the path to the selected agent. */
export function Breadcrumb({ tree, selectedAgent }: BreadcrumbProps) {
	if (!selectedAgent) return null;

	const path = findPath(tree, selectedAgent);
	if (!path) return null;

	return (
		<nav className={styles.breadcrumb}>
			{path.map((name, i) => (
				<span key={name}>
					{i > 0 && (
						<span className={styles.separator}>{"\u203A"}</span>
					)}
					<span className={styles.segment}>{name}</span>
				</span>
			))}
		</nav>
	);
}

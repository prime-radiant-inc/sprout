import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import styles from "./Breadcrumb.module.css";

interface BreadcrumbProps {
	tree: AgentTreeNode;
	selectedAgent: string | null;
	onSelectAgent?: (agentId: string | null) => void;
}

interface PathSegment {
	name: string;
	agentId: string;
}

function findPath(node: AgentTreeNode, targetId: string): PathSegment[] | null {
	if (node.agentId === targetId) {
		return [{ name: node.agentName, agentId: node.agentId }];
	}
	for (const child of node.children) {
		const childPath = findPath(child, targetId);
		if (childPath) {
			return [{ name: node.agentName, agentId: node.agentId }, ...childPath];
		}
	}
	return null;
}

/** Breadcrumb trail showing the path to the selected agent. */
export function Breadcrumb({ tree, selectedAgent, onSelectAgent }: BreadcrumbProps) {
	if (!selectedAgent) return null;

	const path = findPath(tree, selectedAgent);
	if (!path) return null;

	return (
		<nav className={styles.breadcrumb}>
			{path.map((seg, i) => (
				<span key={seg.agentId}>
					{i > 0 && (
						<span className={styles.separator}>{"\u203A"}</span>
					)}
					<button
						type="button"
						className={styles.segment}
						onClick={() => onSelectAgent?.(i === 0 ? null : seg.agentId)}
					>
						{seg.name}
					</button>
				</span>
			))}
		</nav>
	);
}

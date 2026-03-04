import type { SessionEvent } from "@kernel/types.ts";
import { findNode } from "../hooks/useAgentTree.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { formatCompactNumber, useTokenUsage } from "../hooks/useTokenUsage.ts";
import { ConversationView } from "./ConversationView.tsx";
import styles from "./ThreadPanel.module.css";

const statusIcons: Record<AgentTreeNode["status"], string> = {
	completed: "\u2713",
	failed: "\u2717",
	running: "\u25CF",
};

const statusClasses: Record<AgentTreeNode["status"], string | undefined> = {
	completed: styles.statusCompleted,
	failed: styles.statusFailed,
	running: styles.statusRunning,
};

interface ThreadPanelProps {
	agentId: string;
	tree: AgentTreeNode;
	events: SessionEvent[];
	onClose: () => void;
	onSelectAgent: (agentId: string) => void;
}

export function ThreadPanel({ agentId, tree, events, onClose, onSelectAgent }: ThreadPanelProps) {
	const node = findNode(tree, agentId);
	const agentName = node?.agentName ?? agentId;
	const description = node?.description ?? "";
	const goal = node?.goal ?? "";
	const tokenUsage = useTokenUsage(events, tree, agentId);

	return (
		<div className={styles.panel} data-region="thread-panel">
			<div className={styles.header}>
				<div className={styles.headerInfo}>
					<div className={styles.nameRow}>
						{node && (
							<span className={statusClasses[node.status]} data-status={node.status}>
								{statusIcons[node.status]}
							</span>
						)}
						<span className={styles.agentName}>{agentName}</span>
						{tokenUsage && (
							<span className={styles.tokenUsage} data-testid="token-usage">
								{formatCompactNumber(tokenUsage.inputTokens)} in / {formatCompactNumber(tokenUsage.outputTokens)} out
							</span>
						)}
					</div>
					{(description || goal) && (
						<div className={styles.goal}>{description || goal}</div>
					)}
				</div>
				<button
					type="button"
					className={styles.close}
					data-action="close"
					onClick={onClose}
					aria-label="Close thread"
				>
					{"\u2715"}
				</button>
			</div>
			<div className={styles.body}>
				<ConversationView
					events={events}
					agentFilter={agentId}
					tree={tree}
					onSelectAgent={onSelectAgent}
				/>
			</div>
		</div>
	);
}

import type { SessionEvent } from "../../../src/kernel/types.ts";
import { findNode } from "../hooks/useAgentTree.ts";
import type { AgentTreeNode } from "../hooks/useAgentTree.ts";
import { ConversationView } from "./ConversationView.tsx";
import styles from "./ThreadPanel.module.css";

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
	const goal = node?.goal ?? "";

	return (
		<div className={styles.panel} data-region="thread-panel">
			<div className={styles.header}>
				<div className={styles.headerInfo}>
					<span className={styles.agentName}>{agentName}</span>
					<span className={styles.goal}>{goal}</span>
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

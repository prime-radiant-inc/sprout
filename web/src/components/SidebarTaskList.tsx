import type { Task } from "../hooks/useTaskList.ts";
import styles from "./SidebarTaskList.module.css";

interface SidebarTaskListProps {
	tasks: Task[];
}

const statusIcons: Record<Task["status"], string> = {
	new: "\u25CB",
	in_progress: "\u25CF",
	done: "\u2713",
	cancelled: "\u2715",
};

const statusClasses: Record<Task["status"], string> = {
	new: styles.statusNew ?? "",
	in_progress: styles.statusInProgress ?? "",
	done: styles.statusDone ?? "",
	cancelled: styles.statusCancelled ?? "",
};

export function SidebarTaskList({ tasks }: SidebarTaskListProps) {
	if (tasks.length === 0) return null;

	return (
		<div className={styles.taskList}>
			<span className={styles.header}>Tasks</span>
			<ul className={styles.list}>
				{tasks.map((task) => (
					<li key={task.id} className={styles.taskRow}>
						<span className={statusClasses[task.status]}>
							{statusIcons[task.status]}
						</span>
						<span className={styles.description}>{task.description}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

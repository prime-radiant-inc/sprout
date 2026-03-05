import { useEffect, useState } from "react";

export interface Task {
	id: string;
	description: string;
	status: "new" | "in_progress" | "done" | "cancelled";
	assigned_to: string | null;
}

interface UseTaskListResult {
	tasks: Task[];
}

export function useTaskList(isActive: boolean): UseTaskListResult {
	const [tasks, setTasks] = useState<Task[]>([]);

	useEffect(() => {
		if (!isActive) return;

		let cancelled = false;

		async function poll() {
			try {
				const res = await fetch("/api/tasks");
				if (!res.ok) return;
				const data = await res.json();
				if (!cancelled && Array.isArray(data.tasks)) {
					setTasks(data.tasks);
				}
			} catch {
				// Network error — ignore, will retry
			}
		}

		poll();
		const interval = setInterval(poll, 5000);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [isActive]);

	return { tasks };
}

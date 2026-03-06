import { useMemo } from "react";
import type { SessionEvent } from "@kernel/types.ts";

export interface Task {
	id: string;
	description: string;
	status: "new" | "in_progress" | "done" | "cancelled";
	assigned_to: string | null;
}

export function buildTaskList(events: SessionEvent[]): Task[] {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]!;
		if (event.kind === "task_update") {
			const tasks = event.data.tasks;
			if (Array.isArray(tasks)) {
				return tasks as Task[];
			}
		}
	}
	return [];
}

export function useTaskList(events: SessionEvent[]): { tasks: Task[] } {
	const tasks = useMemo(() => buildTaskList(events), [events]);
	return { tasks };
}

export interface Note {
	timestamp: number;
	text: string;
}

export type TaskStatus = "new" | "in_progress" | "done" | "cancelled";

export interface Task {
	id: string;
	description: string;
	initial_prompt: string;
	notes: Note[];
	status: TaskStatus;
	assigned_to: string | null;
}

export interface TaskFile {
	tasks: Task[];
	next_id: number;
}

export function createEmptyTaskFile(): TaskFile {
	return { tasks: [], next_id: 1 };
}

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type Task, type TaskFile, type TaskStatus, createEmptyTaskFile } from "./types.ts";

export class TaskStore {
	constructor(private readonly filePath: string) {}

	async load(): Promise<TaskFile> {
		try {
			const raw = await readFile(this.filePath, "utf-8");
			return JSON.parse(raw) as TaskFile;
		} catch (err: unknown) {
			if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
				return createEmptyTaskFile();
			}
			throw err;
		}
	}

	async save(data: TaskFile): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(data, null, 2) + "\n");
	}

	async create(
		description: string,
		initial_prompt?: string,
		assigned_to?: string,
	): Promise<Task> {
		const data = await this.load();
		const id = `task-${String(data.next_id).padStart(3, "0")}`;
		const task: Task = {
			id,
			description,
			initial_prompt: initial_prompt ?? "",
			notes: [],
			status: "new",
			assigned_to: assigned_to ?? null,
		};
		data.tasks.push(task);
		data.next_id++;
		await this.save(data);
		return task;
	}

	async list(statusFilter?: TaskStatus): Promise<Task[]> {
		const data = await this.load();
		if (statusFilter) {
			return data.tasks.filter((t) => t.status === statusFilter);
		}
		return data.tasks;
	}

	async get(id: string): Promise<Task> {
		const data = await this.load();
		const task = data.tasks.find((t) => t.id === id);
		if (!task) {
			throw new Error(`Task not found: ${id}`);
		}
		return task;
	}

	async update(
		id: string,
		fields: { status?: TaskStatus; assigned_to?: string | null; description?: string },
	): Promise<Task> {
		const data = await this.load();
		const task = data.tasks.find((t) => t.id === id);
		if (!task) {
			throw new Error(`Task not found: ${id}`);
		}
		if (fields.status !== undefined) task.status = fields.status;
		if (fields.assigned_to !== undefined) task.assigned_to = fields.assigned_to;
		if (fields.description !== undefined) task.description = fields.description;
		await this.save(data);
		return task;
	}

	async comment(id: string, text: string): Promise<Task> {
		const data = await this.load();
		const task = data.tasks.find((t) => t.id === id);
		if (!task) {
			throw new Error(`Task not found: ${id}`);
		}
		task.notes.push({ timestamp: Date.now(), text });
		await this.save(data);
		return task;
	}
}

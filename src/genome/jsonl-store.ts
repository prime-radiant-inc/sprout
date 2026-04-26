import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export class JsonlStore<T> {
	constructor(readonly path: string) {}

	async load(): Promise<T[]> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf-8");
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return [];
			}
			throw err;
		}

		const records: T[] = [];
		const lines = raw.split("\n");
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!;
			if (line.trim().length === 0) continue;
			try {
				records.push(JSON.parse(line) as T);
			} catch (err: unknown) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${basename(this.path)}:${index + 1}: invalid JSONL record: ${reason}`);
			}
		}
		return records;
	}

	async append(record: T): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(record)}\n`);
	}

	async rewrite(records: T[]): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		const content =
			records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
		await writeFile(tempPath, content);
		await rename(tempPath, this.path);
	}
}

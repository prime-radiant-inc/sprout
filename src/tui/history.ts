import { readFile, writeFile } from "node:fs/promises";

export class InputHistory {
	private entries: string[] = [];
	private cursor = -1;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	add(entry: string): void {
		this.entries.push(entry);
		this.cursor = -1; // reset to "after last"
	}

	previous(): string {
		if (this.entries.length === 0) return "";
		if (this.cursor === -1) {
			this.cursor = this.entries.length - 1;
		} else if (this.cursor > 0) {
			this.cursor--;
		}
		return this.entries[this.cursor]!;
	}

	next(): string {
		if (this.cursor === -1 || this.cursor >= this.entries.length - 1) {
			this.cursor = -1;
			return "";
		}
		this.cursor++;
		return this.entries[this.cursor]!;
	}

	/** Returns a copy of all history entries. */
	all(): string[] {
		return [...this.entries];
	}

	async save(): Promise<void> {
		// Escape newlines in entries so each entry is one line in the file
		const lines = this.entries.map((e) => e.replace(/\n/g, "\\n"));
		await writeFile(this.path, lines.join("\n") + "\n", "utf-8");
	}

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.path, "utf-8");
			this.entries = raw
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => line.replace(/\\n/g, "\n"));
			this.cursor = -1;
		} catch {
			// File doesn't exist yet, start empty
		}
	}
}

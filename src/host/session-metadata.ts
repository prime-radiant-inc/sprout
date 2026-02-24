import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionMetadataSnapshot {
	sessionId: string;
	agentSpec: string;
	model: string;
	status: "idle" | "running" | "interrupted";
	turns: number;
	contextTokens: number;
	contextWindowSize: number;
	createdAt: string;
	updatedAt: string;
}

interface SessionMetadataOptions {
	sessionId: string;
	agentSpec: string;
	model: string;
	sessionsDir: string;
}

export class SessionMetadata {
	private readonly sessionId: string;
	private readonly agentSpec: string;
	private readonly model: string;
	private readonly sessionsDir: string;
	private readonly createdAt: string;

	private status: SessionMetadataSnapshot["status"] = "idle";
	private turns = 0;
	private contextTokens = 0;
	private contextWindowSize = 0;

	constructor(options: SessionMetadataOptions) {
		this.sessionId = options.sessionId;
		this.agentSpec = options.agentSpec;
		this.model = options.model;
		this.sessionsDir = options.sessionsDir;
		this.createdAt = new Date().toISOString();
	}

	updateTurn(turns: number, contextTokens: number, contextWindowSize: number): void {
		this.turns = turns;
		this.contextTokens = contextTokens;
		this.contextWindowSize = contextWindowSize;
	}

	setStatus(status: SessionMetadataSnapshot["status"]): void {
		this.status = status;
	}

	async save(): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });

		const snapshot: SessionMetadataSnapshot = {
			sessionId: this.sessionId,
			agentSpec: this.agentSpec,
			model: this.model,
			status: this.status,
			turns: this.turns,
			contextTokens: this.contextTokens,
			contextWindowSize: this.contextWindowSize,
			createdAt: this.createdAt,
			updatedAt: new Date().toISOString(),
		};

		const filePath = join(this.sessionsDir, `${this.sessionId}.meta.json`);
		await writeFile(filePath, JSON.stringify(snapshot, null, "\t") + "\n");
	}

	/**
	 * Load metadata from disk if it exists.
	 * If the existing status is "running" (crashed session), sets it to "interrupted" and saves.
	 */
	async loadIfExists(metaPath: string): Promise<void> {
		try {
			const raw = await readFile(metaPath, "utf-8");
			const snapshot: SessionMetadataSnapshot = JSON.parse(raw);
			if (snapshot.status === "running") {
				this.status = "interrupted";
				await this.save();
			}
		} catch {
			// File doesn't exist or isn't valid JSON — nothing to recover
		}
	}
}

/** Read and parse a .meta.json file. */
export async function loadSessionMetadata(path: string): Promise<SessionMetadataSnapshot> {
	const raw = await readFile(path, "utf-8");
	return JSON.parse(raw) as SessionMetadataSnapshot;
}

/** Scan a directory for *.meta.json files and return snapshots sorted by filename (ULID order). */
export async function listSessions(sessionsDir: string): Promise<SessionMetadataSnapshot[]> {
	let entries: string[];
	try {
		entries = await readdir(sessionsDir);
	} catch {
		return [];
	}

	const metaFiles = entries.filter((f) => f.endsWith(".meta.json")).sort();

	const snapshots: SessionMetadataSnapshot[] = [];
	for (const file of metaFiles) {
		try {
			const snapshot = await loadSessionMetadata(join(sessionsDir, file));
			snapshots.push(snapshot);
		} catch {
			// Skip corrupted files
		}
	}
	return snapshots;
}

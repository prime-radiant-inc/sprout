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
		const snapshot = await loadSessionMetadata(join(sessionsDir, file));
		snapshots.push(snapshot);
	}
	return snapshots;
}

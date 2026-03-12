import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRef, SessionModelSelection } from "./settings/types.ts";

interface SessionMetadataBaseSnapshot {
	sessionId: string;
	agentSpec: string;
	status: "idle" | "running" | "interrupted";
	turns: number;
	contextTokens: number;
	contextWindowSize: number;
	createdAt: string;
	updatedAt: string;
}

export interface PersistedSessionMetadataSnapshot extends SessionMetadataBaseSnapshot {
	selection: SessionModelSelection;
	resolvedModel?: ModelRef;
}

export interface LegacySessionMetadataSnapshot extends SessionMetadataBaseSnapshot {
	model: string;
}

export type SessionMetadataSnapshot =
	| PersistedSessionMetadataSnapshot
	| LegacySessionMetadataSnapshot;

interface SessionMetadataOptions {
	sessionId: string;
	agentSpec: string;
	selection: SessionModelSelection;
	resolvedModel?: ModelRef;
	sessionsDir: string;
}

export class SessionMetadata {
	private readonly sessionId: string;
	private readonly agentSpec: string;
	private readonly sessionsDir: string;
	private readonly createdAt: string;

	private status: SessionMetadataSnapshot["status"] = "idle";
	private turns = 0;
	private contextTokens = 0;
	private contextWindowSize = 0;
	private selection: SessionModelSelection;
	private resolvedModel?: ModelRef;

	constructor(options: SessionMetadataOptions) {
		this.sessionId = options.sessionId;
		this.agentSpec = options.agentSpec;
		this.selection = options.selection;
		this.resolvedModel = options.resolvedModel;
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

	setSelection(selection: SessionModelSelection, resolvedModel?: ModelRef): void {
		this.selection = selection;
		this.resolvedModel = resolvedModel;
	}

	async save(): Promise<void> {
		await mkdir(this.sessionsDir, { recursive: true });

		const snapshot: PersistedSessionMetadataSnapshot = {
			sessionId: this.sessionId,
			agentSpec: this.agentSpec,
			selection: this.selection,
			resolvedModel: this.resolvedModel,
			status: this.status,
			turns: this.turns,
			contextTokens: this.contextTokens,
			contextWindowSize: this.contextWindowSize,
			createdAt: this.createdAt,
			updatedAt: new Date().toISOString(),
		};

		const filePath = join(this.sessionsDir, `${this.sessionId}.meta.json`);
		await writeFile(filePath, `${JSON.stringify(snapshot, null, "\t")}\n`);
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

export type SessionListEntry = SessionMetadataSnapshot & {
	/** Text of the first user goal submitted in this session. */
	firstPrompt?: string;
	/** Text of the last assistant response in this session. */
	lastMessage?: string;
};

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

/**
 * Load sessions with first-prompt and last-message summaries extracted from
 * the JSONL event logs.
 */
export async function loadSessionSummaries(
	sessionsDir: string,
	logsDir: string,
): Promise<SessionListEntry[]> {
	const sessions = await listSessions(sessionsDir);
	return Promise.all(
		sessions.map(async (session) => {
			const logPath = join(logsDir, `${session.sessionId}.jsonl`);
			const { firstPrompt, lastMessage } = await readSessionSummary(logPath);
			return { ...session, firstPrompt, lastMessage };
		}),
	);
}

async function readSessionSummary(
	logPath: string,
): Promise<{ firstPrompt?: string; lastMessage?: string }> {
	let raw: string;
	try {
		raw = await readFile(logPath, "utf-8");
	} catch {
		return {};
	}

	let firstPrompt: string | undefined;
	let lastMessage: string | undefined;

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.depth !== 0) continue;
			if (!firstPrompt && event.kind === "perceive" && event.data?.goal) {
				firstPrompt = event.data.goal as string;
			}
			if (event.kind === "plan_end" && event.data?.text) {
				lastMessage = event.data.text as string;
			}
		} catch {
			// skip malformed lines
		}
	}

	return { firstPrompt, lastMessage };
}

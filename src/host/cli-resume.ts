import { join } from "node:path";
import { checkHandleCompleted, extractChildHandles, readHandleResult } from "../bus/resume.ts";
import type { ResultMessage } from "../bus/types.ts";
import { loadEventLog } from "../kernel/event-replay.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { replayEventLog } from "./resume.ts";
import {
	listSessions,
	loadSessionMetadata,
	type SessionMetadataSnapshot,
} from "./session-metadata.ts";
import {
	resolveSessionSelectionRequest,
	type SessionSelectionContext,
	type SessionSelectionSnapshot,
} from "./session-selection.ts";
import { loadAllEventLogs } from "./session-state.ts";

export interface ResumeCommand {
	kind: "resume" | "resume-last";
	sessionId?: string;
}

export interface ResumeState {
	sessionId: string;
	history: Message[];
	events: SessionEvent[];
	selectionRequest?: SessionSelectionRequest;
	completedHandles?:
		| Array<{
				handleId: string;
				result: ResultMessage;
				ownerId: string;
		  }>
		| undefined;
}

interface ResumeDeps {
	listSessions: typeof listSessions;
	loadSessionMetadata: typeof loadSessionMetadata;
	replayEventLog: typeof replayEventLog;
	loadEventLog: typeof loadEventLog;
	extractChildHandles: typeof extractChildHandles;
	checkHandleCompleted: typeof checkHandleCompleted;
	readHandleResult: typeof readHandleResult;
	loadAllEventLogs: typeof loadAllEventLogs;
}

/**
 * Load resume state from an existing session log.
 *
 * Returns undefined only for `resume-last` when no sessions exist.
 */
export async function loadResumeState(
	opts: {
		command: ResumeCommand;
		projectDataDir: string;
		sessionsDir: string;
		onInfo?: (line: string) => void;
	},
	deps: Partial<ResumeDeps> = {},
): Promise<ResumeState | undefined> {
	const d: ResumeDeps = {
		listSessions: deps.listSessions ?? listSessions,
		loadSessionMetadata: deps.loadSessionMetadata ?? loadSessionMetadata,
		replayEventLog: deps.replayEventLog ?? replayEventLog,
		loadEventLog: deps.loadEventLog ?? loadEventLog,
		extractChildHandles: deps.extractChildHandles ?? extractChildHandles,
		checkHandleCompleted: deps.checkHandleCompleted ?? checkHandleCompleted,
		readHandleResult: deps.readHandleResult ?? readHandleResult,
		loadAllEventLogs: deps.loadAllEventLogs ?? loadAllEventLogs,
	};

	let sessionId: string;
	if (opts.command.kind === "resume-last") {
		const sessions = await d.listSessions(opts.sessionsDir);
		if (sessions.length === 0) return undefined;
		sessionId = sessions[sessions.length - 1]!.sessionId;
	} else {
		sessionId = opts.command.sessionId ?? "";
	}

	let selectionRequest: SessionSelectionRequest | undefined;
	try {
		const snapshot = await d.loadSessionMetadata(join(opts.sessionsDir, `${sessionId}.meta.json`));
		selectionRequest = metadataSnapshotToSelectionRequest(snapshot);
	} catch {}

	const logPath = join(opts.projectDataDir, "logs", `${sessionId}.jsonl`);
	const history = await d.replayEventLog(logPath);
	opts.onInfo?.(`Resumed session ${sessionId} with ${history.length} messages of history`);

	const childHandles = await d.extractChildHandles(logPath);
	let completedHandles: ResumeState["completedHandles"];
	if (childHandles.length > 0) {
		const handleLogDir = join(opts.projectDataDir, "logs", sessionId);
		const completed = (
			await Promise.all(
				childHandles.map(async (handle) => {
					if (!handle.completed) {
						handle.completed = await d.checkHandleCompleted(handleLogDir, handle.handleId);
					}
					if (!handle.completed) return null;

					const result = await d.readHandleResult(handleLogDir, handle.handleId);
					if (!result) return null;

					return { handleId: handle.handleId, result, ownerId: "root" as const };
				}),
			)
		).filter((handle): handle is NonNullable<typeof handle> => handle !== null);
		if (completed.length > 0) {
			completedHandles = completed;
		}
		const completedCount = childHandles.filter((h) => h.completed).length;
		const pendingCount = childHandles.length - completedCount;
		opts.onInfo?.(
			`  Child handles: ${childHandles.length} total, ${completedCount} completed, ${pendingCount} pending`,
		);
	}

	const sessionLogDir = join(opts.projectDataDir, "logs", sessionId);
	const events = await d.loadAllEventLogs(logPath, sessionLogDir);
	return {
		sessionId,
		history,
		events,
		selectionRequest,
		completedHandles,
	};
}

export function resolveResumeSelection(
	selection: SessionSelectionRequest,
	context: SessionSelectionContext,
): SessionSelectionSnapshot {
	return resolveSessionSelectionRequest(selection, context);
}

function metadataSnapshotToSelectionRequest(
	snapshot: SessionMetadataSnapshot,
): SessionSelectionRequest {
	return snapshot.selection;
}

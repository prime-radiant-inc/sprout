import { join } from "node:path";
import { extractChildHandles, loadCompletedChildHandles } from "../bus/resume.ts";
import type { ResultMessage } from "../bus/types.ts";
import { loadEventLog } from "../kernel/event-replay.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import type { SessionSelectionRequest } from "../shared/session-selection.ts";
import { replayEventLog } from "./resume.ts";
import { loadSessionMetadata, type SessionMetadataSnapshot } from "./session-metadata.ts";
import {
	resolveSessionSelectionRequest,
	type SessionSelectionContext,
	type SessionSelectionSnapshot,
} from "./session-selection.ts";
import { loadAllEventLogs } from "./session-state.ts";

export interface ResumeCommand {
	kind: "resume";
	sessionId: string;
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
				agentName: string;
				agentId?: string;
		  }>
		| undefined;
}

interface ResumeDeps {
	loadSessionMetadata: typeof loadSessionMetadata;
	replayEventLog: typeof replayEventLog;
	loadEventLog: typeof loadEventLog;
	extractChildHandles: typeof extractChildHandles;
	loadCompletedChildHandles: typeof loadCompletedChildHandles;
	loadAllEventLogs: typeof loadAllEventLogs;
}

/**
 * Load resume state from an existing session log.
 *
 * Returns undefined when the requested session cannot be loaded.
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
		loadSessionMetadata: deps.loadSessionMetadata ?? loadSessionMetadata,
		replayEventLog: deps.replayEventLog ?? replayEventLog,
		loadEventLog: deps.loadEventLog ?? loadEventLog,
		extractChildHandles: deps.extractChildHandles ?? extractChildHandles,
		loadCompletedChildHandles: deps.loadCompletedChildHandles ?? loadCompletedChildHandles,
		loadAllEventLogs: deps.loadAllEventLogs ?? loadAllEventLogs,
	};

	const sessionId = opts.command.sessionId;

	let selectionRequest: SessionSelectionRequest | undefined;
	try {
		const snapshot = await d.loadSessionMetadata(join(opts.sessionsDir, `${sessionId}.meta.json`));
		selectionRequest = metadataSnapshotToSelectionRequest(snapshot);
	} catch {}

	const logPath = join(opts.projectDataDir, "logs", `${sessionId}.jsonl`);
	const history = await d.replayEventLog(logPath);
	opts.onInfo?.(`Resumed session ${sessionId} with ${history.length} messages of history`);

	let completedHandles: ResumeState["completedHandles"];
	const completed = await d.loadCompletedChildHandles({
		logPath,
		handleLogDir: join(opts.projectDataDir, "logs", sessionId),
		ownerId: "root",
	});
	if (completed.length > 0) {
		completedHandles = completed;
	}
	const childHandles = await d.extractChildHandles(logPath);
	if (childHandles.length > 0) {
		const completedCount = completed.length;
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

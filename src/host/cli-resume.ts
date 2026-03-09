import { join } from "node:path";
import { checkHandleCompleted, extractChildHandles, readHandleResult } from "../bus/resume.ts";
import type { ResultMessage } from "../bus/types.ts";
import { loadEventLog } from "../kernel/event-replay.ts";
import type { SessionEvent } from "../kernel/types.ts";
import type { Message } from "../llm/types.ts";
import { replayEventLog } from "./resume.ts";
import { listSessions } from "./session-metadata.ts";
import { loadAllEventLogs } from "./session-state.ts";

export interface ResumeCommand {
	kind: "resume" | "resume-last";
	sessionId?: string;
}

export interface ResumeState {
	sessionId: string;
	history: Message[];
	events: SessionEvent[];
	completedHandles?:
		| Array<{
				handleId: string;
				result: ResultMessage;
				ownerId: string;
		  }>
		| undefined;
	usedMnemonicNames?: Set<string>;
}

interface ResumeDeps {
	listSessions: typeof listSessions;
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
	const usedMnemonicNames = extractUsedMnemonicNames(events);
	return {
		sessionId,
		history,
		events,
		completedHandles,
		usedMnemonicNames,
	};
}

/**
 * Extract all mnemonic names from act_start events in a session's event log.
 * Used during session resume to reconstruct the usedMnemonicNames set so that
 * new delegations avoid name collisions with agents from the prior session.
 */
export function extractUsedMnemonicNames(events: SessionEvent[]): Set<string> {
	const names = new Set<string>();
	for (const event of events) {
		if (event.kind === "act_start" && typeof event.data.mnemonic_name === "string") {
			names.add(event.data.mnemonic_name);
		}
	}
	return names;
}

// Bus topic builders and parser for the agent messaging system.
// Topics follow "session/{session_id}/..." namespace conventions.

export type ParsedAgentTopic = {
	session_id: string;
	handle_id: string;
	channel: string;
};

export type ParsedSessionTopic = {
	session_id: string;
	channel: string;
};

export type ParsedTopic = ParsedAgentTopic | ParsedSessionTopic;

// --- Builders ---

export function agentInbox(sessionId: string, handleId: string): string {
	return `session/${sessionId}/agent/${handleId}/inbox`;
}

export function agentEvents(sessionId: string, handleId: string): string {
	return `session/${sessionId}/agent/${handleId}/events`;
}

export function agentReady(sessionId: string, handleId: string): string {
	return `session/${sessionId}/agent/${handleId}/ready`;
}

export function agentResult(sessionId: string, handleId: string): string {
	return `session/${sessionId}/agent/${handleId}/result`;
}

export function commandsTopic(sessionId: string): string {
	return `session/${sessionId}/commands`;
}

export function genomeMutations(sessionId: string): string {
	return `session/${sessionId}/genome/mutations`;
}

export function genomeEvents(sessionId: string): string {
	return `session/${sessionId}/genome/events`;
}

export function sessionEvents(sessionId: string): string {
	return `session/${sessionId}/events`;
}

// --- Parser ---

const AGENT_RE = /^session\/([^/]+)\/agent\/([^/]+)\/(inbox|events|ready|result)$/;
const GENOME_RE = /^session\/([^/]+)\/(genome\/(?:mutations|events))$/;
const SESSION_RE = /^session\/([^/]+)\/(commands|events)$/;

export function parseTopic(topic: string): ParsedTopic | null {
	let m = AGENT_RE.exec(topic);
	if (m) {
		return { session_id: m[1]!, handle_id: m[2]!, channel: m[3]! };
	}
	m = GENOME_RE.exec(topic);
	if (m) {
		return { session_id: m[1]!, channel: m[2]! };
	}
	m = SESSION_RE.exec(topic);
	if (m) {
		return { session_id: m[1]!, channel: m[2]! };
	}
	return null;
}

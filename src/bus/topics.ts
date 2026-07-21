// Bus topic builders for the agent messaging system.
// Topics follow "session/{session_id}/..." namespace conventions.

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

export function agentMessageAck(sessionId: string, messageId: string): string {
	return `session/${sessionId}/agent-message-ack/${messageId}`;
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

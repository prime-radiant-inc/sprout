export type SessionLifecycleStatus = "running" | "idle" | "interrupted";

export interface SessionMetadataWriter {
	setStatus(status: SessionLifecycleStatus): void;
	updateTurn(turn: number, contextTokens: number, contextWindowSize: number): void;
	save(): Promise<void>;
}

export interface PersistPlanEndMetadataUpdateInput {
	metadata: SessionMetadataWriter;
	turn: number;
	contextTokens: number;
	contextWindowSize: number;
	emitContextUpdate(data: { context_tokens: number; context_window_size: number }): void;
}

/** Persist status transition to running for a new agent run. */
export async function persistRunningMetadata(metadata: SessionMetadataWriter): Promise<void> {
	metadata.setStatus("running");
	await metadata.save();
}

/** Persist final status after a run based on whether it was interrupted. */
export async function persistTerminalMetadata(
	metadata: SessionMetadataWriter,
	interrupted: boolean,
): Promise<void> {
	metadata.setStatus(interrupted ? "interrupted" : "idle");
	await metadata.save();
}

/**
 * Persist turn/context usage from a plan_end event and emit the corresponding
 * context_update event for UIs.
 */
export async function persistPlanEndMetadataUpdate(
	input: PersistPlanEndMetadataUpdateInput,
): Promise<void> {
	input.metadata.updateTurn(input.turn, input.contextTokens, input.contextWindowSize);
	await input.metadata.save();
	input.emitContextUpdate({
		context_tokens: input.contextTokens,
		context_window_size: input.contextWindowSize,
	});
}

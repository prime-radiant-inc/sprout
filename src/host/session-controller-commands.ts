import type { Command, CommandKind } from "../kernel/types.ts";

export interface SessionCommandActions {
	submitGoal(goal: string): void;
	steer(text: string): void;
	interrupt(): void;
	compact(): void;
	clear(): void;
	switchModel(model: string | undefined): void;
	quit(): void;
}

export type SessionCommandHandlers = Record<CommandKind, (data: Record<string, unknown>) => void>;

export function createSessionCommandHandlers(
	actions: SessionCommandActions,
): SessionCommandHandlers {
	return {
		submit_goal: (data) => {
			actions.submitGoal(data.goal as string);
		},
		steer: (data) => {
			actions.steer(data.text as string);
		},
		interrupt: () => {
			actions.interrupt();
		},
		compact: () => {
			actions.compact();
		},
		clear: () => {
			actions.clear();
		},
		switch_model: (data) => {
			actions.switchModel(data.model as string | undefined);
		},
		quit: () => {
			actions.quit();
		},
	};
}

export function dispatchSessionCommand(cmd: Command, actions: SessionCommandActions): void {
	const handlers = createSessionCommandHandlers(actions);
	const handler = (handlers as Record<string, (data: Record<string, unknown>) => void>)[cmd.kind];
	if (!handler) {
		throw new Error(`Unknown command kind: ${String((cmd as { kind: unknown }).kind)}`);
	}
	handler(cmd.data);
}

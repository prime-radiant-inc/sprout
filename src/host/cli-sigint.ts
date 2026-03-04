export interface InteractiveSigintDeps {
	bus: {
		emitCommand(cmd: { kind: string; data: Record<string, unknown> }): void;
		emitEvent(kind: string, agentId: string, depth: number, data: Record<string, unknown>): void;
		onEvent(listener: (event: { kind: string; data: Record<string, unknown> }) => void): void;
	};
	controller: { isRunning: boolean };
	onExitNow: () => void;
	sigintWindowMs?: number;
	setTimer?: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	processRef?: {
		on(event: "SIGINT", listener: () => void): void;
		removeListener(event: "SIGINT", listener: () => void): void;
	};
	registerProcessListener?: boolean;
}

export interface InteractiveSigintRegistration {
	onSignal: () => void;
	clearPending: () => void;
	dispose: () => void;
}

export function registerInteractiveSigint(
	deps: InteractiveSigintDeps,
): InteractiveSigintRegistration {
	const sigintWindowMs = deps.sigintWindowMs ?? 5000;
	const setTimer = deps.setTimer ?? ((handler: () => void, delayMs: number) => setTimeout(handler, delayMs));
	const clearTimer = deps.clearTimer ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
	const processRef = deps.processRef ?? process;
	const registerProcessListener = deps.registerProcessListener ?? true;

	let pendingSigintExit = false;
	let pendingSigintTimer: ReturnType<typeof setTimeout> | null = null;

	const clearPending = () => {
		if (pendingSigintTimer) {
			clearTimer(pendingSigintTimer);
			pendingSigintTimer = null;
		}
		pendingSigintExit = false;
	};

	const onSignal = () => {
		if (pendingSigintExit) {
			clearPending();
			deps.bus.emitCommand({ kind: "quit", data: {} });
			deps.onExitNow();
			return;
		}

		pendingSigintExit = true;
		pendingSigintTimer = setTimer(() => {
			clearPending();
			deps.bus.emitEvent("exit_hint", "cli", 0, { visible: false });
		}, sigintWindowMs);

		if (deps.controller.isRunning) {
			deps.bus.emitCommand({ kind: "interrupt", data: {} });
		} else {
			deps.bus.emitEvent("exit_hint", "cli", 0, { visible: true });
		}
	};

	deps.bus.onEvent((event) => {
		if (event.kind === "perceive") clearPending();
		if (event.kind === "exit_hint" && event.data.visible === false) clearPending();
	});

	if (registerProcessListener) {
		processRef.on("SIGINT", onSignal);
	}

	return {
		onSignal,
		clearPending,
		dispose: () => {
			clearPending();
			if (registerProcessListener) {
				processRef.removeListener("SIGINT", onSignal);
			}
		},
	};
}

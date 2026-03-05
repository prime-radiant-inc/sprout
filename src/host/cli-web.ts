export function buildWebOpenUrl(port: number, webToken?: string, host = "localhost"): string {
	return webToken
		? `http://${host}:${port}/?token=${encodeURIComponent(webToken)}`
		: `http://${host}:${port}`;
}

export async function runWebOnlyMode(opts: {
	bus: {
		onCommand(listener: (cmd: { kind: string; data: Record<string, unknown> }) => void): void;
		emitCommand(cmd: { kind: string; data: Record<string, unknown> }): void;
	};
	stopWebServer: () => Promise<void>;
	cleanupInfra: () => Promise<void>;
	onResumeHint: (sessionId: string) => void;
	sessionId: string;
	processRef?: {
		on(event: "SIGINT", listener: () => void): void;
		removeListener(event: "SIGINT", listener: () => void): void;
	};
}): Promise<void> {
	const processRef = opts.processRef ?? process;
	const webOnlySigintHandler = () => {
		opts.bus.emitCommand({ kind: "quit", data: {} });
	};

	const quitPromise = new Promise<void>((resolve) => {
		opts.bus.onCommand((cmd) => {
			if (cmd.kind === "quit") resolve();
		});
		processRef.on("SIGINT", webOnlySigintHandler);
	});

	await quitPromise;
	processRef.removeListener("SIGINT", webOnlySigintHandler);
	await opts.stopWebServer();
	await opts.cleanupInfra();
	opts.onResumeHint(opts.sessionId);
}

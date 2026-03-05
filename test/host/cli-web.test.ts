import { describe, expect, test } from "bun:test";
import { buildWebOpenUrl, runWebOnlyMode } from "../../src/host/cli-web.ts";

class FakeCommandBus {
	private listeners: Array<(cmd: { kind: string; data: Record<string, unknown> }) => void> = [];
	readonly emitted: Array<{ kind: string; data: Record<string, unknown> }> = [];

	onCommand(listener: (cmd: { kind: string; data: Record<string, unknown> }) => void) {
		this.listeners.push(listener);
	}

	emitCommand(cmd: { kind: string; data: Record<string, unknown> }) {
		this.emitted.push(cmd);
		for (const listener of this.listeners) listener(cmd);
	}
}

describe("buildWebOpenUrl", () => {
	test("builds localhost URL without token", () => {
		expect(buildWebOpenUrl(7777)).toBe("http://localhost:7777");
	});

	test("builds URL with encoded token", () => {
		expect(buildWebOpenUrl(7777, "a b+c")).toBe("http://localhost:7777/?token=a%20b%2Bc");
	});

	test("builds URL for custom host with encoded token", () => {
		expect(buildWebOpenUrl(7777, "nonce token", "0.0.0.0")).toBe(
			"http://0.0.0.0:7777/?token=nonce%20token",
		);
	});
});

describe("runWebOnlyMode", () => {
	test("waits for quit command, then stops web server and cleanup", async () => {
		const bus = new FakeCommandBus();
		const calls: string[] = [];
		const processRef = {
			on: (_event: "SIGINT", _listener: () => void) => {},
			removeListener: (_event: "SIGINT", _listener: () => void) => {},
		};

		const modePromise = runWebOnlyMode({
			bus: bus as any,
			stopWebServer: async () => {
				calls.push("stop");
			},
			cleanupInfra: async () => {
				calls.push("cleanup");
			},
			onResumeHint: (sessionId) => {
				calls.push(`resume:${sessionId}`);
			},
			sessionId: "01TEST",
			processRef,
		});

		bus.emitCommand({ kind: "quit", data: {} });
		await modePromise;

		expect(calls).toEqual(["stop", "cleanup", "resume:01TEST"]);
	});

	test("SIGINT listener emits quit command", async () => {
		const bus = new FakeCommandBus();
		let sigintHandler: (() => void) | undefined;

		const processRef = {
			on: (_event: "SIGINT", listener: () => void) => {
				sigintHandler = listener;
			},
			removeListener: (_event: "SIGINT", _listener: () => void) => {},
		};

		const modePromise = runWebOnlyMode({
			bus: bus as any,
			stopWebServer: async () => {},
			cleanupInfra: async () => {},
			onResumeHint: () => {},
			sessionId: "01TEST",
			processRef,
		});

		sigintHandler?.();
		await modePromise;

		expect(bus.emitted.map((cmd) => cmd.kind)).toContain("quit");
	});
});

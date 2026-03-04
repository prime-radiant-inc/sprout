import { describe, expect, test } from "bun:test";
import { runOneshotMode } from "../../src/host/cli-oneshot.ts";

class FakeEventBus {
	private listeners: Array<(event: unknown) => void> = [];
	readonly commands: Array<{ kind: string; data: Record<string, unknown> }> = [];

	onEvent(listener: (event: unknown) => void) {
		this.listeners.push(listener);
	}

	emit(event: unknown) {
		for (const listener of this.listeners) listener(event);
	}
}

describe("runOneshotMode", () => {
	test("submits goal, renders events, prints resume hint, and cleans up infra", async () => {
		const bus = new FakeEventBus();
		const lines: string[] = [];
		const hints: string[] = [];
		let cleanupCount = 0;
		const submitted: string[] = [];

		await runOneshotMode(
			{
				goal: "fix tests",
				genomePath: "/tmp/genome",
				projectDataDir: "/tmp/project",
				rootDir: "/tmp/root",
				startBusInfrastructure: async () => ({
					spawner: { id: "spawner" } as any,
					genome: { id: "genome" } as any,
					cleanup: async () => {
						cleanupCount++;
					},
				}),
				onResumeHint: (sessionId) => {
					hints.push(sessionId);
				},
			},
			{
				createSessionId: () => "01ONE",
				createBus: () => bus,
				createLogger: () => ({ id: "logger" }),
				createClient: async () => ({ id: "client" }),
				createController: () => ({
					sessionId: "01ONE",
					submitGoal: async (goal: string) => {
						submitted.push(goal);
						bus.emit({
							kind: "warning",
							agent_id: "root",
							depth: 0,
							timestamp: Date.now(),
							data: { message: "line" },
						});
					},
				}),
				subscribeBusEvents: (incomingBus, listener) => {
					(incomingBus as FakeEventBus).onEvent(listener);
				},
				renderEventLine: () => "rendered line",
				writeLine: (line) => {
					lines.push(line);
				},
			},
		);

		expect(submitted).toEqual(["fix tests"]);
		expect(lines).toEqual(["rendered line"]);
		expect(hints).toEqual(["01ONE"]);
		expect(cleanupCount).toBe(1);
	});

	test("cleans up infra and rethrows when submitGoal fails", async () => {
		let cleanupCount = 0;
		let hinted = false;

		await expect(
			runOneshotMode(
				{
					goal: "boom",
					genomePath: "/tmp/genome",
					projectDataDir: "/tmp/project",
					rootDir: "/tmp/root",
					startBusInfrastructure: async () => ({
						spawner: { id: "spawner" } as any,
						genome: { id: "genome" } as any,
						cleanup: async () => {
							cleanupCount++;
						},
					}),
					onResumeHint: () => {
						hinted = true;
					},
				},
				{
					createSessionId: () => "01FAIL",
					createBus: () => ({ onEvent: () => {} }),
					createLogger: () => ({ id: "logger" }),
					createClient: async () => ({ id: "client" }),
					createController: () => ({
						sessionId: "01FAIL",
						submitGoal: async () => {
							throw new Error("submit failed");
						},
					}),
					subscribeBusEvents: () => {},
					renderEventLine: () => null,
					writeLine: () => {},
				},
			),
		).rejects.toThrow("submit failed");

		expect(cleanupCount).toBe(1);
		expect(hinted).toBe(false);
	});
});

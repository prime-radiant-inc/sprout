import { afterEach, describe, expect, jest, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import { EventBus } from "../../src/host/event-bus.ts";
import { App } from "../../src/tui/app.tsx";
import { makeSelectionSnapshot, makeSettingsSnapshot } from "../helpers/provider-settings.ts";
import { sleep, waitFor } from "../helpers/wait-for.ts";

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

function setup(overrides?: Partial<Parameters<typeof App>[0]>) {
	const bus = new EventBus();
	const result = render(
		<App
			bus={bus}
			sessionId="01ABCDEF12345678ABCDEF1234"
			onSubmit={() => {}}
			onSlashCommand={() => {}}
			onExit={() => {}}
			{...overrides}
		/>,
	);
	return { bus, ...result };
}

function createSettingsControlPlane() {
	const snapshot = makeSettingsSnapshot();
	return {
		execute: async (command: { kind: string }) =>
			command.kind === "get_settings"
				? { ok: true as const, snapshot }
				: { ok: true as const, snapshot },
	};
}

/** Wait for React to flush state updates. */
async function flush() {
	await sleep(15);
}

describe("App", () => {
	afterEach(() => {
		currentInstance?.unmount();
		currentInstance = undefined;
	});

	test("renders StatusBar with initial zero values", () => {
		const { lastFrame } = setup();
		const frame = lastFrame();
		expect(frame).toContain("ctx:");
		expect(frame).toContain("0 turns");
		expect(frame).toContain("01ABCDEF12345678ABCDEF1234");
	});

	test("updates StatusBar on plan_end event with usage data", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("plan_end", "root", 0, {
			turn: 3,
			usage: { input_tokens: 5000, output_tokens: 1200, total_tokens: 6200 },
		});

		await flush();
		const frame = lastFrame();
		expect(frame).toContain("3 turns");
	});

	test("updates StatusBar context info on context_update event", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("context_update", "root", 0, {
			context_tokens: 50000,
			context_window_size: 200000,
		});

		await flush();
		const frame = lastFrame();
		expect(frame).toContain("50.0k");
		expect(frame).toContain("200.0k");
		expect(frame).toContain("25%");
	});

	test("updates model from session_start event", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, {
			goal: "test",
			model: "gpt-4o",
		});

		await flush();
		const frame = lastFrame();
		expect(frame).toContain("gpt-4o");
	});

	test("sets status to running on session_start and idle on session_end", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		bus.emitEvent("plan_end", "root", 0, {
			turn: 1,
			usage: { input_tokens: 2000, output_tokens: 500, total_tokens: 2500 },
		});

		await flush();
		let frame = lastFrame();
		// When running, should show token arrows
		expect(frame).toContain("\u2191");
		expect(frame).toContain("\u2193");

		bus.emitEvent("session_end", "root", 0, { turns: 1, stumbles: 0 });
		await flush();
		frame = lastFrame();
		// When idle, should NOT show token arrows
		expect(frame).not.toContain("\u2191");
	});

	test("renders InputArea with prompt", () => {
		const { lastFrame } = setup();
		const frame = lastFrame();
		expect(frame).toContain(">");
	});

	test("InputArea receives typed input and submits via onSubmit", async () => {
		let submitted = "";
		const { stdin } = setup({
			onSubmit: (text) => {
				submitted = text;
			},
		});

		stdin.write("hello world");
		await flush();
		stdin.write("\r");
		await flush();

		expect(submitted).toBe("hello world");
	});

	test("InputArea passes slash commands to onSlashCommand", async () => {
		let slashCmd: any = null;
		const { stdin } = setup({
			onSlashCommand: (cmd) => {
				slashCmd = cmd;
			},
		});

		stdin.write("/compact");
		await flush();
		stdin.write("\r");
		await flush();

		expect(slashCmd).toBeDefined();
		expect(slashCmd.kind).toBe("compact");
	});

	test("async onSlashCommand rejection is caught and emitted as warning", async () => {
		const events: any[] = [];
		const bus = new EventBus();
		bus.onEvent((e) => events.push(e));

		const { stdin } = render(
			<App
				bus={bus}
				sessionId="01ABCDEF12345678ABCDEF1234"
				onSubmit={() => {}}
				onSlashCommand={async () => {
					throw new Error("terminal setup failed");
				}}
				onExit={() => {}}
			/>,
		);

		stdin.write("/compact");
		await flush();
		stdin.write("\r");
		await waitFor(() =>
			events.some(
				(e) => e.kind === "warning" && (e.data.message as string).includes("terminal setup failed"),
			),
		);

		const warning = events.find(
			(e) => e.kind === "warning" && (e.data.message as string).includes("terminal setup failed"),
		);
		expect(warning).toBeDefined();
	});

	test("InputArea shows running prompt during session", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		await flush();

		expect(lastFrame()).toContain("...");
	});

	test("emits steer command instead of submit_goal when running", async () => {
		const commands: any[] = [];
		const { bus, stdin } = setup();
		bus.onCommand((cmd) => commands.push(cmd));

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		await flush();

		stdin.write("try something else");
		await flush();
		stdin.write("\r");
		await flush();

		const steerCmd = commands.find((c) => c.kind === "steer");
		const submitCmd = commands.find((c) => c.kind === "submit_goal");
		expect(steerCmd).toBeDefined();
		expect(steerCmd!.data.text).toBe("try something else");
		expect(submitCmd).toBeUndefined();
	});

	test("accumulates token usage across multiple plan_end events", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		bus.emitEvent("plan_end", "root", 0, {
			turn: 1,
			usage: { input_tokens: 3000, output_tokens: 1000, total_tokens: 4000 },
		});
		await flush();

		let frame = lastFrame();
		expect(frame).toContain("↑3.0k");
		expect(frame).toContain("↓1.0k");

		bus.emitEvent("plan_end", "root", 0, {
			turn: 2,
			usage: { input_tokens: 2000, output_tokens: 500, total_tokens: 2500 },
		});
		await flush();

		frame = lastFrame();
		// Should be cumulative: 3000+2000=5000, 1000+500=1500
		expect(frame).toContain("↑5.0k");
		expect(frame).toContain("↓1.5k");
	});

	test("resets token usage on session_end", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		bus.emitEvent("plan_end", "root", 0, {
			turn: 1,
			usage: { input_tokens: 3000, output_tokens: 1000, total_tokens: 4000 },
		});
		await flush();

		bus.emitEvent("session_end", "root", 0, { turns: 1, stumbles: 0 });
		await flush();

		// After session_end, tokens should be reset to 0
		// Start a new session to see the token display
		bus.emitEvent("session_start", "root", 0, { goal: "test2" });
		bus.emitEvent("plan_end", "root", 0, {
			turn: 1,
			usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
		});
		await flush();

		const frame = lastFrame();
		// Should show only the new session's tokens, not accumulated from previous
		expect(frame).toContain("↑1.0k");
		expect(frame).toContain("↓500");
	});

	test("renders conversation lines from events", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("warning", "root", 0, { message: "test warning" });
		await flush();

		expect(lastFrame()).toContain("test warning");
	});

	test("renders all conversation lines (Static handles scrollback)", async () => {
		const { bus, lastFrame } = setup();

		for (let i = 0; i < 10; i++) {
			bus.emitEvent("warning", "root", 0, { message: `warn-${i}` });
		}
		await flush();

		const frame = lastFrame();
		// Static renders all lines — no viewport slicing
		expect(frame).toContain("warn-0");
		expect(frame).toContain("warn-9");
	});

	test("Ctrl+C while running emits interrupt command on bus", async () => {
		const commands: any[] = [];
		const { bus, stdin } = setup();
		bus.onCommand((cmd) => commands.push(cmd));

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		await flush();

		stdin.write("\x03");
		await flush();

		const interruptCmd = commands.find((c) => c.kind === "interrupt");
		expect(interruptCmd).toBeDefined();
	});

	test("Ctrl+C while idle requires two presses to exit", async () => {
		let exited = false;
		const { stdin } = setup({
			onExit: () => {
				exited = true;
			},
		});

		// First Ctrl+C — warns, does not exit
		stdin.write("\x03");
		await flush();
		expect(exited).toBe(false);

		// Second Ctrl+C — exits
		stdin.write("\x03");
		await flush();
		expect(exited).toBe(true);
	});

	test("calls onSteer callback when steer message submitted while running", async () => {
		let steered = "";
		const { bus, stdin } = setup({
			onSteer: (text: string) => {
				steered = text;
			},
		});

		bus.emitEvent("session_start", "root", 0, { model: "test-model" });
		await flush();

		stdin.write("focus on the edge case");
		await flush();
		stdin.write("\r");
		await waitFor(() => steered === "focus on the edge case");

		expect(steered).toBe("focus on the edge case");
	});

	test("interrupted event sets status to not running", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		bus.emitEvent("plan_end", "root", 0, {
			turn: 1,
			usage: { input_tokens: 2000, output_tokens: 500 },
		});
		await flush();
		expect(lastFrame()).toContain("\u2191"); // Running arrows visible

		bus.emitEvent("interrupted", "root", 0, { message: "user interrupt" });
		await flush();

		expect(lastFrame()).not.toContain("\u2191"); // Arrows gone
		expect(lastFrame()).toContain(">"); // Idle prompt
	});

	test("/model without arg shows ModelPicker", async () => {
		const { lastFrame, stdin } = setup({
			knownModels: ["best", "claude-sonnet-4-6", "qwen2.5-coder"],
			settingsControlPlane: createSettingsControlPlane(),
			initialSelection: makeSelectionSnapshot(),
		});
		await flush();

		// Type /model and submit
		stdin.write("/model");
		await flush();
		stdin.write("\r");
		await flush();

		// Model picker should be visible
		const frame = lastFrame()!;
		expect(frame).toContain("Anthropic");
		expect(frame).toContain("LM Studio");
		expect(frame).toContain("Best");
		expect(frame).toContain("Select model");
	});

	test("selecting model from picker emits a canonical model selection and hides picker", async () => {
		const commands: any[] = [];
		const bus = new EventBus();
		bus.onCommand((cmd) => commands.push(cmd));

		const { lastFrame, stdin } = render(
			<App
				bus={bus}
				sessionId="01ABCDEF12345678ABCDEF1234"
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				onExit={() => {}}
				knownModels={["best", "claude-sonnet-4-6", "qwen2.5-coder"]}
				settingsControlPlane={createSettingsControlPlane() as any}
				initialSelection={makeSelectionSnapshot()}
			/>,
		);
		await flush();

		// Open model picker
		stdin.write("/model");
		await flush();
		stdin.write("\r");
		await flush();

		expect(lastFrame()).toContain("Select model");

		// Move to the explicit Anthropic model and select it
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\r");
		await flush();

		// switch_model command should have been emitted
		const switchCmd = commands.find((c) => c.kind === "switch_model");
		expect(switchCmd).toBeDefined();
		expect(switchCmd!.data.selection).toEqual({
			kind: "model",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		});

		// Picker should be hidden, input area should be back
		expect(lastFrame()).not.toContain("Select model");
		expect(lastFrame()).toContain(">");
	});

	test("/settings opens the provider settings mode", async () => {
		const { lastFrame, stdin } = setup({
			settingsControlPlane: createSettingsControlPlane(),
			initialSelection: makeSelectionSnapshot(),
		});
		await flush();

		stdin.write("/settings");
		await flush();
		stdin.write("\r");
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("Provider settings");
		expect(frame).toContain("Anthropic");
		expect(frame).toContain("settings>");
	});

	test("Escape cancels model picker", async () => {
		const { lastFrame, stdin } = setup({
			knownModels: ["model-a"],
		});

		// Open model picker
		stdin.write("/model");
		await flush();
		stdin.write("\r");
		await flush();
		expect(lastFrame()).toContain("Select model");

		// Press Escape to cancel
		stdin.write("\x1B");
		await flush();

		// Picker should be hidden
		expect(lastFrame()).not.toContain("Select model");
		expect(lastFrame()).toContain(">");
	});

	test("renders initialEvents in conversation view on resume", async () => {
		const initialEvents = [
			{
				kind: "perceive" as const,
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { goal: "resumed goal" },
			},
			{
				kind: "plan_end" as const,
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { text: "Prior assistant response." },
			},
		];

		const { lastFrame } = setup({ initialEvents } as any);
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("resumed goal");
		expect(frame).toContain("Prior assistant response.");
	});

	test("exit hint auto-hides after 5 seconds", () => {
		// Ink's reconciler doesn't use setTimeout for re-renders, so we can't
		// check frame content with fake timers. Instead, verify the auto-hide
		// fires by checking that a `exit_hint { visible: false }` event is
		// emitted on the bus after 5 seconds.
		const events: any[] = [];
		const { bus, stdin } = setup();
		bus.onEvent((e) => events.push(e));

		const setTimeoutSpy = jest.spyOn(globalThis, "setTimeout");
		setTimeoutSpy.mockImplementation(((handler: Parameters<typeof setTimeout>[0]) => {
			if (typeof handler === "function") {
				handler();
			}
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);
		try {
			stdin.write("\x03"); // idle Ctrl+C → onIdleCtrlC → shows hint, starts 5s timer
			expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
			const hideEvent = events.find((e) => e.kind === "exit_hint" && e.data.visible === false);
			expect(hideEvent).toBeDefined();
		} finally {
			setTimeoutSpy.mockRestore();
		}
	});

	test("exit_hint event shows exit warning overlay", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("exit_hint", "cli", 0, { visible: true });
		await flush();

		expect(lastFrame()).toContain("Press Ctrl+C again to exit");
	});

	test("exit_hint with visible:false hides the warning overlay", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("exit_hint", "cli", 0, { visible: true });
		await flush();
		expect(lastFrame()).toContain("Press Ctrl+C again to exit");

		bus.emitEvent("exit_hint", "cli", 0, { visible: false });
		await flush();
		expect(lastFrame()).not.toContain("Press Ctrl+C again to exit");
	});

	test("exit_hint warning is not added to conversation log", async () => {
		const { bus, lastFrame } = setup();

		// Show and then hide the hint
		bus.emitEvent("exit_hint", "cli", 0, { visible: true });
		await flush();
		bus.emitEvent("exit_hint", "cli", 0, { visible: false });
		await flush();

		// The warning should be gone (it was never in the conversation log)
		expect(lastFrame()).not.toContain("Press Ctrl+C again to exit");
	});

	test("Ctrl+C while idle shows hint and second Ctrl+C exits", async () => {
		let exited = false;
		const { stdin, lastFrame } = setup({
			onExit: () => {
				exited = true;
			},
		});

		// First Ctrl+C — should show hint
		stdin.write("\x03");
		await flush();
		expect(lastFrame()).toContain("Press Ctrl+C again to exit");
		expect(exited).toBe(false);

		// Second Ctrl+C — exits
		stdin.write("\x03");
		await flush();
		expect(exited).toBe(true);
	});

	test("/collapse-tools toggles tool visibility and emits warning", async () => {
		const events: any[] = [];
		const { bus, stdin, lastFrame } = setup();
		bus.onEvent((e) => events.push(e));

		// Emit a tool end event first — should be visible
		bus.emitEvent("primitive_end", "root", 0, {
			name: "exec",
			args: { command: "ls" },
			success: true,
		});
		await flush();
		expect(lastFrame()).toContain("Run");

		// Type /collapse-tools and submit
		stdin.write("/collapse-tools");
		await flush();
		stdin.write("\r");
		await waitFor(() =>
			events.some((e) => e.kind === "warning" && e.data.message === "Tool details hidden"),
		);

		// Should emit a warning event about hiding
		const hideWarning = events.find(
			(e) => e.kind === "warning" && e.data.message === "Tool details hidden",
		);
		expect(hideWarning).toBeDefined();

		// Now emit another tool event — it should be hidden
		bus.emitEvent("primitive_end", "root", 0, {
			name: "grep",
			args: { pattern: "foo" },
			success: true,
		});
		await flush();
		expect(lastFrame()).not.toContain("grep");

		// Toggle again to show
		stdin.write("/collapse-tools");
		await flush();
		stdin.write("\r");
		await flush();

		const showWarning = events.find(
			(e) => e.kind === "warning" && e.data.message === "Tool details visible",
		);
		expect(showWarning).toBeDefined();
	});

	test("session_clear updates sessionId in status bar", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(
			<App
				bus={bus}
				sessionId="OLDSESS_1234567890123456"
				onSubmit={() => {}}
				onSlashCommand={() => {}}
				onExit={() => {}}
			/>,
		);

		expect(lastFrame()).toContain("OLDSESS_");

		bus.emitEvent("session_clear", "session", 0, { new_session_id: "NEWSESS_5678901234567890" });
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("NEWSESS_");
		expect(frame).not.toContain("OLDSESS_");
	});
});

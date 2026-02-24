import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { EventBus } from "../../src/host/event-bus.ts";
import { App } from "../../src/tui/app.tsx";

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

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("App", () => {
	test("renders StatusBar with initial zero values", () => {
		const { lastFrame } = setup();
		const frame = lastFrame();
		expect(frame).toContain("ctx:");
		expect(frame).toContain("turn 0");
		expect(frame).toContain("01ABCDEF...");
	});

	test("updates StatusBar on plan_end event with usage data", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("plan_end", "root", 0, {
			turn: 3,
			usage: { input_tokens: 5000, output_tokens: 1200, total_tokens: 6200 },
		});

		await flush();
		const frame = lastFrame();
		expect(frame).toContain("turn 3");
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

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		await flush();

		expect(lastFrame()).toContain("Starting session...");
	});

	test("caps visible conversation lines via maxHeight", async () => {
		const { bus, lastFrame } = setup();

		for (let i = 0; i < 100; i++) {
			bus.emitEvent("warning", "root", 0, { message: `warn-${i}` });
		}
		await flush();

		const frame = lastFrame();
		// The earliest warnings should be scrolled off
		expect(frame).not.toContain("warn-0");
		// The latest warnings should still be visible
		expect(frame).toContain("warn-99");
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

	test("Ctrl+C while idle calls onExit", async () => {
		let exited = false;
		const { stdin } = setup({
			onExit: () => {
				exited = true;
			},
		});

		stdin.write("\x03");
		await flush();

		expect(exited).toBe(true);
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
});

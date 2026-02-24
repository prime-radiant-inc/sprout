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

	test("renders conversation lines from events", async () => {
		const { bus, lastFrame } = setup();

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		await flush();

		expect(lastFrame()).toContain("Starting session...");
	});
});

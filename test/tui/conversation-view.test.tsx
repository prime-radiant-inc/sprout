import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { EventBus } from "../../src/host/event-bus.ts";
import { ConversationView } from "../../src/tui/conversation-view.tsx";

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ConversationView", () => {
	test("renders events as formatted lines", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("warning", "cli", 0, { message: "hello world" });
		await flush();

		expect(lastFrame()).toContain("hello world");
	});

	test("renders multiple events in order", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("perceive", "root", 0, { goal: "do something" });
		bus.emitEvent("warning", "cli", 0, { message: "heads up" });
		await flush();

		const frame = lastFrame()!;
		const goalIdx = frame.indexOf("do something");
		const warnIdx = frame.indexOf("heads up");
		expect(goalIdx).toBeGreaterThanOrEqual(0);
		expect(warnIdx).toBeGreaterThan(goalIdx);
	});

	test("nests subagent events with left border", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("warning", "root", 0, { message: "root-msg" });
		bus.emitEvent("warning", "sub-1", 1, { message: "sub-msg" });
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("root-msg");
		expect(frame).toContain("sub-msg");
		// Depth-1 events get a left box border character
		expect(frame).toContain("│");
	});

	test("caps visible lines to maxHeight", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} maxHeight={3} />);

		for (let i = 0; i < 10; i++) {
			bus.emitEvent("warning", "cli", 0, { message: `line-${i}` });
		}
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("line-7");
		expect(frame).toContain("line-8");
		expect(frame).toContain("line-9");
		expect(frame).not.toContain("line-0");
	});

	test("PgUp enters scroll mode preventing auto-scroll", async () => {
		const bus = new EventBus();
		const { lastFrame, stdin } = render(<ConversationView bus={bus} maxHeight={3} />);

		for (let i = 0; i < 6; i++) {
			bus.emitEvent("warning", "cli", 0, { message: `line-${i}` });
		}
		await flush();

		expect(lastFrame()).toContain("line-5");

		stdin.write("\x1B[5~"); // PgUp
		await flush();

		expect(lastFrame()).toContain("line-0");
	});

	test("PgDown returns to auto-scroll after PgUp", async () => {
		const bus = new EventBus();
		const { lastFrame, stdin } = render(<ConversationView bus={bus} maxHeight={3} />);

		for (let i = 0; i < 6; i++) {
			bus.emitEvent("warning", "cli", 0, { message: `line-${i}` });
		}
		await flush();
		expect(lastFrame()).toContain("line-5");

		stdin.write("\x1B[5~"); // PgUp
		await flush();
		expect(lastFrame()).toContain("line-0");

		stdin.write("\x1B[6~"); // PgDown
		await flush();
		expect(lastFrame()).toContain("line-5");
	});

	test("renders events with appropriate content", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("error", "root", 0, { error: "something broke" });
		bus.emitEvent("warning", "cli", 0, { message: "heads up" });
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("something broke");
		expect(frame).toContain("heads up");
	});

	test("Tab toggles tool call detail visibility", async () => {
		const bus = new EventBus();
		const { lastFrame, stdin } = render(<ConversationView bus={bus} />);

		bus.emitEvent("perceive", "root", 0, { goal: "test goal" });
		bus.emitEvent("primitive_start", "root", 0, { name: "exec", args: { command: "ls" } });
		bus.emitEvent("primitive_end", "root", 0, { name: "exec", success: true, result: "ok" });
		await flush();

		expect(lastFrame()).toContain("exec");

		stdin.write("\t");
		await flush();

		// Tool events hidden, user message remains
		expect(lastFrame()).not.toContain("exec");
		expect(lastFrame()).toContain("test goal");

		stdin.write("\t");
		await flush();
		expect(lastFrame()).toContain("exec");
	});

	test("tool collapse hides act_start and act_end events", async () => {
		const bus = new EventBus();
		const { lastFrame, stdin } = render(<ConversationView bus={bus} />);

		bus.emitEvent("perceive", "root", 0, { goal: "test" });
		bus.emitEvent("act_start", "root", 0, { agent_name: "helper", goal: "do stuff" });
		bus.emitEvent("act_end", "root", 0, { agent_name: "helper", success: true, turns: 3 });
		await flush();

		expect(lastFrame()).toContain("helper");

		stdin.write("\t");
		await flush();

		expect(lastFrame()).not.toContain("helper");
		expect(lastFrame()).toContain("test");
	});

	test("session_clear event clears all lines", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("warning", "agent", 0, { message: "old content" });
		await flush();
		expect(lastFrame()).toContain("old content");

		bus.emitEvent("session_clear", "session", 0, { new_session_id: "abc" });
		await flush();
		expect(lastFrame()).not.toContain("old content");
	});

	test("shows scroll indicator when scrolled up", async () => {
		const bus = new EventBus();
		const { lastFrame, stdin } = render(<ConversationView bus={bus} maxHeight={3} />);

		for (let i = 0; i < 10; i++) {
			bus.emitEvent("warning", "agent", 0, { message: `Line ${i}` });
		}
		await flush();
		expect(lastFrame()).not.toContain("SCROLL");

		stdin.write("\x1B[5~");
		await flush();
		expect(lastFrame()).toContain("SCROLL");
	});

	test("scroll indicator disappears when returning to auto-scroll", async () => {
		const bus = new EventBus();
		const { lastFrame, stdin } = render(<ConversationView bus={bus} maxHeight={3} />);

		for (let i = 0; i < 10; i++) {
			bus.emitEvent("warning", "agent", 0, { message: `Line ${i}` });
		}
		await flush();

		stdin.write("\x1B[5~");
		await flush();
		expect(lastFrame()).toContain("SCROLL");

		// PgDown past end to resume
		for (let j = 0; j < 5; j++) {
			stdin.write("\x1B[6~");
			await flush();
		}

		expect(lastFrame()).not.toContain("SCROLL");
	});

	test("renders initialEvents on mount", async () => {
		const bus = new EventBus();
		const initialEvents = [
			{
				kind: "perceive" as const,
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { goal: "prior goal" },
			},
			{
				kind: "plan_end" as const,
				timestamp: Date.now(),
				agent_id: "root",
				depth: 0,
				data: { text: "Here is my response from before." },
			},
		];

		const { lastFrame } = render(<ConversationView bus={bus} initialEvents={initialEvents} />);
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("prior goal");
		expect(frame).toContain("Here is my response from before.");
	});

	test("initialEvents appear before new events", async () => {
		const bus = new EventBus();
		const initialEvents = [
			{
				kind: "warning" as const,
				timestamp: Date.now(),
				agent_id: "cli",
				depth: 0,
				data: { message: "old-event" },
			},
		];

		const { lastFrame } = render(<ConversationView bus={bus} initialEvents={initialEvents} />);
		await flush();

		bus.emitEvent("warning", "cli", 0, { message: "new-event" });
		await flush();

		const frame = lastFrame()!;
		const oldIdx = frame.indexOf("old-event");
		const newIdx = frame.indexOf("new-event");
		expect(oldIdx).toBeGreaterThanOrEqual(0);
		expect(newIdx).toBeGreaterThan(oldIdx);
	});

	test("skips events that renderEventComponent returns null for", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		// session_start and plan_end with no text should both return null
		bus.emitEvent("session_start", "root", 0, {});
		bus.emitEvent("plan_end", "root", 0, { turn: 1 });
		await flush();

		const frame = lastFrame()!;
		expect(frame.trim()).toBe("");
	});

	test("computes duration between start and end events", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("primitive_start", "root", 0, { name: "exec", args: { command: "ls" } });
		bus.emitEvent("primitive_end", "root", 0, { name: "exec", success: true });
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("s");
		expect(frame).toContain("\u2713");
	});
});

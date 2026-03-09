import { afterEach, describe, expect, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import { EventBus } from "../../src/host/event-bus.ts";
import { TUI_INITIAL_EVENT_CAP } from "../../src/kernel/constants.ts";
import { ConversationView } from "../../src/tui/conversation-view.tsx";

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

describe("ConversationView", () => {
	afterEach(() => {
		currentInstance?.unmount();
		currentInstance = undefined;
	});

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
		expect(frame).toContain("\u2502");
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

	test("hides tool events when toolsCollapsed prop is true", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} toolsCollapsed={true} />);

		bus.emitEvent("perceive", "root", 0, { goal: "test goal" });
		bus.emitEvent("primitive_start", "root", 0, { name: "exec", args: { command: "ls" } });
		bus.emitEvent("primitive_end", "root", 0, { name: "exec", success: true, result: "ok" });
		await flush();

		// Tool events should be hidden, user message visible
		expect(lastFrame()).not.toContain("exec");
		expect(lastFrame()).toContain("test goal");
	});

	test("shows tool events when toolsCollapsed is false or omitted", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("perceive", "root", 0, { goal: "test goal" });
		bus.emitEvent("primitive_start", "root", 0, { name: "exec", args: { command: "ls" } });
		bus.emitEvent("primitive_end", "root", 0, { name: "exec", success: true, result: "ok" });
		await flush();

		// All events should be visible
		expect(lastFrame()).toContain("Run");
		expect(lastFrame()).toContain("test goal");
	});

	test("session_clear adds separator but previous Static items remain", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("warning", "agent", 0, { message: "old content" });
		await flush();
		expect(lastFrame()).toContain("old content");

		bus.emitEvent("session_clear", "session", 0, { new_session_id: "abc" });
		await flush();
		// Static items can't be removed — old content persists alongside separator
		expect(lastFrame()).toContain("old content");
		expect(lastFrame()).toContain("New session");
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

	test("retains only the most recent live lines", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		for (let index = 1; index <= TUI_INITIAL_EVENT_CAP + 3; index++) {
			bus.emitEvent("warning", "cli", 0, { message: `event-${index}` });
		}
		await flush();

		const frame = lastFrame()!;
		expect(frame.startsWith("\u26a0 event-4")).toBe(true);
		expect(frame).toContain(`event-${TUI_INITIAL_EVENT_CAP + 3}`);
	});
});

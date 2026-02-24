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

		bus.emitEvent("session_start", "root", 0, { goal: "test goal" });
		await flush();

		expect(lastFrame()).toContain("Starting session...");
	});

	test("renders multiple events in order", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		bus.emitEvent("warning", "cli", 0, { message: "Commands: /help" });
		await flush();

		const frame = lastFrame()!;
		const startIdx = frame.indexOf("Starting session...");
		const warnIdx = frame.indexOf("Commands: /help");
		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(warnIdx).toBeGreaterThan(startIdx);
	});

	test("indents subagent events based on depth", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("session_start", "root", 0, { goal: "test" });
		bus.emitEvent("session_start", "sub-1", 1, { goal: "subtask" });
		await flush();

		const frame = lastFrame()!;
		const lines = frame.split("\n");
		// Find lines by agent id
		const rootLine = lines.find((l) => l.includes("[root]"));
		const subLine = lines.find((l) => l.includes("[sub-1]"));
		expect(rootLine).toBeDefined();
		expect(subLine).toBeDefined();
		// Subagent line should have more leading whitespace
		const subIndent = subLine!.length - subLine!.trimStart().length;
		const rootIndent = rootLine!.length - rootLine!.trimStart().length;
		expect(subIndent).toBeGreaterThan(rootIndent);
	});

	test("skips events that render-event returns null for", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		// plan_end with no text should return null from renderEvent
		bus.emitEvent("plan_end", "root", 0, { turn: 1 });
		await flush();

		// Frame should be empty (no visible lines)
		const frame = lastFrame()!;
		expect(frame.trim()).toBe("");
	});
});

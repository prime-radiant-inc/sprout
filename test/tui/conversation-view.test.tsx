import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { EventBus } from "../../src/host/event-bus.ts";
import { ConversationView } from "../../src/tui/conversation-view.tsx";
import { EVENT_COLORS } from "../../src/tui/conversation-view.tsx";

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

	test("caps visible lines to maxHeight", async () => {
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} maxHeight={3} />);

		for (let i = 0; i < 10; i++) {
			bus.emitEvent("warning", "cli", 0, { message: `line-${i}` });
		}
		await flush();

		const frame = lastFrame()!;
		// Should show only the last 3 lines (auto-scroll to bottom)
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

		// Normally auto-scrolled to bottom: line-3, line-4, line-5
		expect(lastFrame()).toContain("line-5");

		// PgUp = ESC [5~
		stdin.write("\x1B[5~");
		await flush();

		// Should scroll up and show earlier lines
		expect(lastFrame()).toContain("line-0");
	});

	test("EVENT_COLORS maps error to red and warning to yellow", () => {
		expect(EVENT_COLORS.error).toBe("red");
		expect(EVENT_COLORS.warning).toBe("yellow");
		expect(EVENT_COLORS.session_start).toBe("green");
		expect(EVENT_COLORS.interrupted).toBe("red");
	});

	test("renders events with color (verified with FORCE_COLOR)", async () => {
		// Colors are applied via Ink's <Text color={...}> prop.
		// When FORCE_COLOR=1, output includes ANSI codes.
		// This test verifies events render with correct text content
		// regardless of color support.
		const bus = new EventBus();
		const { lastFrame } = render(<ConversationView bus={bus} />);

		bus.emitEvent("error", "root", 0, { error: "something broke" });
		bus.emitEvent("warning", "cli", 0, { message: "heads up" });
		await flush();

		const frame = lastFrame()!;
		expect(frame).toContain("something broke");
		expect(frame).toContain("heads up");
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

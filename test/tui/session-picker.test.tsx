import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { SessionMetadataSnapshot } from "../../src/host/session-metadata.ts";
import { SessionPicker } from "../../src/tui/session-picker.tsx";

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

const sessions: SessionMetadataSnapshot[] = [
	{
		sessionId: "01AAAA00000000000000000001",
		agentSpec: "root",
		model: "gpt-4o",
		status: "idle",
		turns: 3,
		contextTokens: 10000,
		contextWindowSize: 200000,
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:01:00.000Z",
	},
	{
		sessionId: "01BBBB00000000000000000002",
		agentSpec: "root",
		model: "claude-sonnet",
		status: "running",
		turns: 7,
		contextTokens: 50000,
		contextWindowSize: 200000,
		createdAt: "2025-01-02T00:00:00.000Z",
		updatedAt: "2025-01-02T00:05:00.000Z",
	},
];

describe("SessionPicker", () => {
	test("renders session list", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("01AAAA00000000000000000001");
		expect(frame).toContain("01BBBB00000000000000000002");
	});

	test("highlights first session by default", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		// The selected item should have a marker
		expect(frame).toContain(">");
	});

	test("Down arrow moves selection", async () => {
		const { lastFrame, stdin } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);

		stdin.write("\x1B[B"); // Down arrow
		await flush();

		const frame = lastFrame()!;
		const lines = frame.split("\n");
		// Second session line should be selected
		const selectedLine = lines.find((l) => l.includes(">") && l.includes("01BBBB00"));
		expect(selectedLine).toBeDefined();
	});

	test("Enter selects session and calls onSelect", async () => {
		let selected = "";
		const { stdin } = render(
			<SessionPicker
				sessions={sessions}
				onSelect={(id) => {
					selected = id;
				}}
				onCancel={() => {}}
			/>,
		);

		stdin.write("\r");
		await flush();

		expect(selected).toBe("01AAAA00000000000000000001");
	});

	test("Escape calls onCancel", async () => {
		let cancelled = false;
		const { stdin } = render(
			<SessionPicker
				sessions={sessions}
				onSelect={() => {}}
				onCancel={() => {
					cancelled = true;
				}}
			/>,
		);

		stdin.write("\x1B"); // Escape
		await flush();

		expect(cancelled).toBe(true);
	});

	test("Up arrow moves selection back", async () => {
		const { lastFrame, stdin } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);

		stdin.write("\x1B[B"); // Down
		await flush();
		let lines = lastFrame()!.split("\n");
		expect(lines.find((l) => l.includes(">") && l.includes("01BBBB00"))).toBeDefined();

		stdin.write("\x1B[A"); // Up
		await flush();
		lines = lastFrame()!.split("\n");
		expect(lines.find((l) => l.includes(">") && l.includes("01AAAA00"))).toBeDefined();
	});

	test("renders session details (status, turns, model)", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("idle");
		expect(frame).toContain("3 turns");
		expect(frame).toContain("gpt-4o");
		expect(frame).toContain("running");
		expect(frame).toContain("7 turns");
		expect(frame).toContain("claude-sonnet");
	});

	test("renders updatedAt instead of createdAt, and includes agentSpec", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		// Should show updatedAt, not createdAt
		expect(frame).toContain("2025-01-01T00:01:00");
		expect(frame).not.toContain("2025-01-01T00:00:00");
		// Should include agentSpec
		expect(frame).toContain("root");
	});

	test("shows 'No sessions' when empty", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={[]} onSelect={() => {}} onCancel={() => {}} />,
		);
		expect(lastFrame()).toContain("No sessions");
	});
});

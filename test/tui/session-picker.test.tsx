import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { SessionListEntry } from "../../src/host/session-metadata.ts";
import { SessionPicker } from "../../src/tui/session-picker.tsx";

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

const sessions: SessionListEntry[] = [
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
		firstPrompt: "Fix the login bug in auth middleware",
		lastMessage: "I fixed the bug by adding a null check in auth.ts",
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
		firstPrompt: "Refactor the database layer",
		lastMessage: "I've completed the DB refactoring with tests passing",
	},
];

describe("SessionPicker", () => {
	test("renders session list", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Fix the login bug in auth middleware");
		expect(frame).toContain("Refactor the database layer");
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
		const selectedLine = lines.find((l) => l.includes(">") && l.includes("Refactor the database layer"));
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
		expect(lines.find((l) => l.includes(">") && l.includes("Refactor the database layer"))).toBeDefined();

		stdin.write("\x1B[A"); // Up
		await flush();
		lines = lastFrame()!.split("\n");
		expect(lines.find((l) => l.includes(">") && l.includes("Fix the login bug"))).toBeDefined();
	});

	test("renders turn count for each session", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("3 turns");
		expect(frame).toContain("7 turns");
	});

	test("uses singular 'turn' when turns is 1", () => {
		const one: SessionListEntry[] = [
			{
				sessionId: "01ONE000000000000000000001",
				agentSpec: "root",
				model: "gpt-4o",
				status: "idle",
				turns: 1,
				contextTokens: 0,
				contextWindowSize: 0,
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:01:00.000Z",
				firstPrompt: "Do one thing",
			},
		];
		const { lastFrame } = render(
			<SessionPicker sessions={one} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("1 turn");
		expect(frame).not.toContain("1 turns");
	});

	test("shows 'No sessions' when empty", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={[]} onSelect={() => {}} onCancel={() => {}} />,
		);
		expect(lastFrame()).toContain("No sessions");
	});

	test("renders firstPrompt for each session", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Fix the login bug in auth middleware");
		expect(frame).toContain("Refactor the database layer");
	});

	test("renders lastMessage for each session", () => {
		const { lastFrame } = render(
			<SessionPicker sessions={sessions} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("I fixed the bug by adding a null check");
		expect(frame).toContain("I've completed the DB refactoring");
	});

	test("caps lastMessage display at 3 lines", () => {
		const long: SessionListEntry[] = [
			{
				sessionId: "01DDDD00000000000000000004",
				agentSpec: "root",
				model: "gpt-4o",
				status: "idle",
				turns: 1,
				contextTokens: 0,
				contextWindowSize: 0,
				createdAt: "2025-01-04T00:00:00.000Z",
				updatedAt: "2025-01-04T00:00:00.000Z",
				lastMessage: "Line one\nLine two\nLine three\nLine four\nLine five",
			},
		];
		const { lastFrame } = render(
			<SessionPicker sessions={long} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Line one");
		expect(frame).toContain("Line two");
		expect(frame).toContain("Line three");
		expect(frame).not.toContain("Line four");
		expect(frame).not.toContain("Line five");
	});

	test("strips markdown code blocks from lastMessage", () => {
		const withCode: SessionListEntry[] = [
			{
				sessionId: "01EEEE00000000000000000005",
				agentSpec: "root",
				model: "gpt-4o",
				status: "idle",
				turns: 1,
				contextTokens: 0,
				contextWindowSize: 0,
				createdAt: "2025-01-05T00:00:00.000Z",
				updatedAt: "2025-01-05T00:00:00.000Z",
				lastMessage:
					"I fixed the bug:\n```typescript\nconst x = 1;\nconst y = 2;\n```\nAll tests pass.",
			},
		];
		const { lastFrame } = render(
			<SessionPicker sessions={withCode} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("I fixed the bug");
		expect(frame).toContain("All tests pass");
		expect(frame).not.toContain("const x = 1");
	});

	test("strips markdown formatting (bold, italic, headers, inline code) from lastMessage", () => {
		const withMarkdown: SessionListEntry[] = [
			{
				sessionId: "01FFFF00000000000000000006",
				agentSpec: "root",
				model: "gpt-4o",
				status: "idle",
				turns: 1,
				contextTokens: 0,
				contextWindowSize: 0,
				createdAt: "2025-01-06T00:00:00.000Z",
				updatedAt: "2025-01-06T00:00:00.000Z",
				lastMessage: "## Summary\n**Fixed** the `bug` in _auth.ts_",
			},
		];
		const { lastFrame } = render(
			<SessionPicker sessions={withMarkdown} onSelect={() => {}} onCancel={() => {}} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Summary");
		expect(frame).toContain("Fixed the bug in auth.ts");
		expect(frame).not.toContain("**");
		expect(frame).not.toContain("##");
		expect(frame).not.toContain("`");
		expect(frame).not.toContain("_auth");
	});

	test("renders sessions without firstPrompt or lastMessage gracefully", () => {
		const bare: SessionListEntry[] = [
			{
				sessionId: "01CCCC00000000000000000003",
				agentSpec: "root",
				model: "gpt-4o",
				status: "idle",
				turns: 0,
				contextTokens: 0,
				contextWindowSize: 0,
				createdAt: "2025-01-03T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
		];
		const { lastFrame } = render(
			<SessionPicker sessions={bare} onSelect={() => {}} onCancel={() => {}} />,
		);
		// Should render without crashing and show the fallback prompt text
		expect(lastFrame()).toContain("(new session)");
	});
});

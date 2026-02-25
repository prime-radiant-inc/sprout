import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { formatTokens, StatusBar } from "../../src/tui/status-bar.tsx";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

describe("formatTokens", () => {
	test("returns plain number below 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(42)).toBe("42");
	});

	test("returns M format at 1_000_000 and above", () => {
		expect(formatTokens(1_500_000)).toBe("1.5M");
		expect(formatTokens(2_000_000)).toBe("2.0M");
		expect(formatTokens(1_000_000)).toBe("1.0M");
	});

	test("returns k format at 1000 and above", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(12345)).toBe("12.3k");
		expect(formatTokens(100000)).toBe("100.0k");
	});
});

describe("StatusBar", () => {
	test("renders context pressure percentage", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={50000}
				contextWindowSize={200000}
				turns={3}
				inputTokens={0}
				outputTokens={0}
				model="claude-sonnet-4-20250514"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		const frame = lastFrame();
		expect(frame).toContain("25%");
		expect(frame).toContain("50.0k");
		expect(frame).toContain("200.0k");
	});

	test("renders turn count", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={0}
				contextWindowSize={200000}
				turns={7}
				inputTokens={0}
				outputTokens={0}
				model="claude-sonnet-4-20250514"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		expect(lastFrame()).toContain("7 turns");
	});

	test("renders token usage when running", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={10000}
				contextWindowSize={200000}
				turns={2}
				inputTokens={5000}
				outputTokens={1200}
				model="claude-sonnet-4-20250514"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="running"
			/>,
		);
		const frame = lastFrame();
		expect(frame).toContain("5.0k");
		expect(frame).toContain("1.2k");
	});

	test("hides token usage when idle", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={10000}
				contextWindowSize={200000}
				turns={2}
				inputTokens={5000}
				outputTokens={1200}
				model="claude-sonnet-4-20250514"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		const frame = lastFrame();
		// Should NOT contain the arrow tokens when idle
		expect(frame).not.toContain("\u2191");
		expect(frame).not.toContain("\u2193");
	});

	test("renders model name", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={0}
				contextWindowSize={200000}
				turns={0}
				inputTokens={0}
				outputTokens={0}
				model="gpt-4o"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		expect(lastFrame()).toContain("gpt-4o");
	});

	test("renders full session ID", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={0}
				contextWindowSize={200000}
				turns={0}
				inputTokens={0}
				outputTokens={0}
				model="claude-sonnet-4-20250514"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		expect(lastFrame()).toContain("01ABCDEF12345678ABCDEF1234");
	});

	test("renders compact distance", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={100000}
				contextWindowSize={200000}
				turns={5}
				inputTokens={0}
				outputTokens={0}
				model="test-model"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		// 80% of 200k = 160k, 160k - 100k = 60k
		expect(lastFrame()).toContain("60.0k to compact");
	});

	test("compact distance clamps to zero when past threshold", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={180000}
				contextWindowSize={200000}
				turns={5}
				inputTokens={0}
				outputTokens={0}
				model="test-model"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		// 80% of 200k = 160k, 160k - 180k = -20k → clamped to 0
		expect(lastFrame()).toContain("0 to compact");
	});

	test("handles zero context window size gracefully", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={0}
				contextWindowSize={0}
				turns={0}
				inputTokens={0}
				outputTokens={0}
				model="test-model"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		const frame = lastFrame();
		expect(frame).toContain("0%");
		// At 0% context, "to compact" is hidden (below 50% threshold)
	});

	test("hides token usage when interrupted", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={10000}
				contextWindowSize={200000}
				turns={2}
				inputTokens={5000}
				outputTokens={1200}
				model="claude-sonnet-4-20250514"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="interrupted"
			/>,
		);
		const frame = lastFrame();
		expect(frame).not.toContain("\u2191");
		expect(frame).not.toContain("\u2193");
	});

	test("uses colored background with no border or padding", () => {
		const { lastFrame } = render(
			<StatusBar
				contextTokens={10000}
				contextWindowSize={200000}
				turns={2}
				inputTokens={0}
				outputTokens={0}
				model="test-model"
				sessionId="01ABCDEF12345678ABCDEF1234"
				status="idle"
			/>,
		);
		const frame = lastFrame()!;
		// No box-drawing characters
		expect(frame).not.toContain("─");
		expect(frame).not.toContain("│");
		// Content starts at column 0, no leading padding
		const stripped = stripAnsi(frame);
		expect(stripped).toMatch(/^ctx:/);
	});
});

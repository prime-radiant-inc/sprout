import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStatus } from "../../hooks/useEvents.ts";
import { InputArea } from "../InputArea.tsx";
import { StatusBar } from "../StatusBar.tsx";
import { formatTokens, shortModelName } from "../format.ts";

// --- Helpers ---

const noop = () => {};

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
	return {
		status: "idle",
		model: "claude-sonnet-4-20250514",
		turns: 3,
		inputTokens: 12500,
		outputTokens: 4800,
		contextTokens: 45000,
		contextWindowSize: 200000,
		sessionId: "abc-123-def",
		availableModels: [],
		sessionStartedAt: null,
		...overrides,
	};
}

// --- formatTokens ---

describe("formatTokens", () => {
	test("formats numbers under 1000 as-is", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(999)).toBe("999");
	});

	test("formats thousands with k suffix", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(45000)).toBe("45.0k");
		expect(formatTokens(999999)).toBe("1000.0k");
	});

	test("formats millions with M suffix", () => {
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});
});

// --- shortModelName ---

describe("shortModelName", () => {
	test("strips date suffix from model name", () => {
		expect(shortModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4");
	});

	test("leaves model name without date suffix unchanged", () => {
		expect(shortModelName("gpt-4o")).toBe("gpt-4o");
	});

	test("handles empty string", () => {
		expect(shortModelName("")).toBe("");
	});
});

// --- StatusBar ---

describe("StatusBar", () => {
	test("renders context tokens and pressure text", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		// "42k/200k 23%" style context pressure display
		expect(html).toContain("45.0k");
		expect(html).toContain("200.0k");
		expect(html).toContain("23%");
	});

	test("renders context pressure percentage", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ contextTokens: 100000, contextWindowSize: 200000 })}
				connected={true}
			/>,
		);
		expect(html).toContain("50%");
	});

	test("renders context pressure bar element", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).toContain('data-testid="context-pressure-bar"');
	});

	test("renders turn count", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus({ turns: 7 })} connected={true} />,
		);
		expect(html).toContain("7");
		expect(html).toContain("Turns");
	});

	test("renders turn count of 1", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus({ turns: 1 })} connected={true} />,
		);
		expect(html).toContain(">1<");
		expect(html).toContain("Turns");
	});

	test("does not render hardcoded cost", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).not.toContain("$0.00");
	});

	test("renders model name (shortened)", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).toContain("claude-sonnet-4");
		// Date suffix should be stripped
		expect(html).not.toContain("20250514");
	});

	test("renders session ID (truncated to 8 chars)", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		// Session ID "abc-123-def" truncated to first 8 chars: "abc-123-"
		expect(html).toContain("abc-123-");
		expect(html).toContain('data-action="copy-session-id"');
	});

	test("renders I/O tokens when running", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "running", inputTokens: 12500, outputTokens: 4800 })}
				connected={true}
			/>,
		);
		expect(html).toContain("12.5k");
		expect(html).toContain("4.8k");
	});

	test("does not render I/O tokens when idle", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "idle", inputTokens: 12500, outputTokens: 4800 })}
				connected={true}
			/>,
		);
		// Context tokens 45.0k will be present, but I/O specific display should not
		// We check for the I/O label markers
		expect(html).not.toContain("\u2191");
		expect(html).not.toContain("\u2193");
	});

	test("shows green connection dot when connected", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).toContain('data-connected="true"');
	});

	test("shows red connection dot when disconnected", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={false} />,
		);
		expect(html).toContain('data-connected="false"');
	});

	test("renders nonce auth error when disconnected due to bad token", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus()}
				connected={false}
				connectionError="Invalid or missing web nonce. Add ?token=<nonce> to the URL."
			/>,
		);
		expect(html).toContain('data-testid="connection-error"');
		expect(html).toContain("Invalid or missing web nonce");
	});

	test("session ID has data-action=copy for click-to-copy", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).toContain('data-action="copy-session-id"');
	});

	test("session ID is rendered as a button for keyboard accessibility", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} onInterrupt={() => {}} />,
		);
		expect(html).toContain('data-action="copy-session-id"');
		const match = html.match(/(<\w+)[^>]*data-action="copy-session-id"/);
		expect(match?.[1]).toBe("<button");
	});

	test("renders Stop button when running", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "running" })}
				connected={true}
				onInterrupt={() => {}}
			/>,
		);
		// Should have "Stop" text button
		expect(html).toContain("Stop");
		expect(html).toContain('title="Interrupt (Esc)"');
	});

	test("does not render interrupt button when idle", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "idle" })}
				connected={true}
				onInterrupt={() => {}}
			/>,
		);
		expect(html).not.toContain('title="Interrupt (Esc)"');
	});

	test("renders session duration when sessionStartedAt is set", () => {
		const now = Date.now();
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ sessionStartedAt: now - 65000 })}
				connected={true}
			/>,
		);
		// 65 seconds = "1:05"
		expect(html).toContain("1:05");
	});

	test("renders theme toggle button", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} onToggleTheme={() => {}} theme="dark" />,
		);
		expect(html).toContain('data-action="toggle-theme"');
	});
});

// --- InputArea ---

describe("InputArea", () => {
	test("renders a textarea", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={false}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain("<textarea");
	});

	test("renders submit button", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={false}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain("<button");
	});

	test("renders Send button when idle", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={false}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain("Send");
	});

	test("renders Stop button when running", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={true}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain("Stop");
	});

	test("shows idle placeholder when not running", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={false}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain("What should I work on?");
	});

	test("shows steering placeholder when running", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={true}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain("Steer the agent...");
	});

	test("renders data-running attribute for styling", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={true}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain('data-running="true"');
	});

	test("renders data-running false when idle", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={false}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		expect(html).toContain('data-running="false"');
	});

	test("does not render terminal prompt character", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={false}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
			/>,
		);
		// No terminal-style > prompt should exist
		expect(html).not.toContain("&gt;");
	});

	test("accepts onInterrupt prop and renders Stop button when running", () => {
		const html = renderToStaticMarkup(
			<InputArea
				isRunning={true}
				onSubmit={noop}
				onSlashCommand={noop}
				onSteer={noop}
				onInterrupt={noop}
			/>,
		);
		expect(html).toContain("Stop");
	});
});

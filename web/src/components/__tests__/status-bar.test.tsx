import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStatus } from "../../hooks/useEvents.ts";
import { StatusBar } from "../StatusBar.tsx";

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
	return {
		status: "idle",
		model: "claude-sonnet-4-6",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		contextWindowSize: 200000,
		sessionId: "test-session",
		availableModels: [],
		currentSelection: {
			selection: { kind: "inherit" },
			source: "runtime-fallback",
		},
		sessionStartedAt: null,
		pricingTable: null,
		...overrides,
	};
}

describe("StatusBar", () => {
	test("renders model name when no available models", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		// Should show model as plain text, not a select
		expect(html).toContain("sonnet");
		expect(html).not.toContain("<select");
	});

	test("renders model selector when available models provided", () => {
		const status = makeStatus({
			availableModels: ["best", "balanced", "fast", "claude-opus-4-6", "claude-sonnet-4-6"],
			model: "claude-sonnet-4-6",
		});
		const html = renderToStaticMarkup(
			<StatusBar status={status} connected={true} onSwitchModel={() => {}} />,
		);
		expect(html).toContain("<select");
		expect(html).toContain("claude-opus-4-6");
		expect(html).toContain("claude-sonnet-4-6");
	});

	test("model selector has current model selected", () => {
		const status = makeStatus({
			availableModels: ["claude-opus-4-6", "claude-sonnet-4-6"],
			model: "claude-sonnet-4-6",
		});
		const html = renderToStaticMarkup(
			<StatusBar status={status} connected={true} onSwitchModel={() => {}} />,
		);
		// The selected option should have selected attribute
		expect(html).toContain('selected=""');
	});
});

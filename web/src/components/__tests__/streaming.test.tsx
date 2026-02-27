import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TypingIndicator } from "../TypingIndicator.tsx";
import { StreamingBanner } from "../StreamingBanner.tsx";

describe("TypingIndicator", () => {
	test("renders three dots", () => {
		const html = renderToStaticMarkup(<TypingIndicator />);
		// Count dot elements - should have 3
		const dotCount = (html.match(/data-testid="dot"/g) || []).length;
		expect(dotCount).toBe(3);
	});

	test("renders with data-testid for testing", () => {
		const html = renderToStaticMarkup(<TypingIndicator />);
		expect(html).toContain('data-testid="typing-indicator"');
	});
});

describe("StreamingBanner", () => {
	test("renders agent name", () => {
		const html = renderToStaticMarkup(<StreamingBanner agentName="planner" />);
		expect(html).toContain("planner");
	});

	test("renders 'is responding' text", () => {
		const html = renderToStaticMarkup(<StreamingBanner agentName="test" />);
		expect(html).toContain("is responding");
	});

	test("renders typing indicator inside banner", () => {
		const html = renderToStaticMarkup(<StreamingBanner agentName="test" />);
		expect(html).toContain('data-testid="typing-indicator"');
	});

	test("renders with default agent name when not provided", () => {
		const html = renderToStaticMarkup(<StreamingBanner />);
		expect(html).toContain("Assistant");
		expect(html).toContain("is responding");
	});
});

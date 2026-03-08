import { afterEach, describe, expect, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import { TextRenderer } from "../../src/tui/text-renderer.tsx";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

afterEach(() => {
	currentInstance?.unmount();
	currentInstance = undefined;
});

describe("TextRenderer", () => {
	describe("basic rendering", () => {
		test("renders text content", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["Hello world"]} cursorLine={0} cursorColumn={0} isFocused={true} />,
			);
			expect(stripAnsi(lastFrame()!)).toContain("Hello world");
		});

		test("renders without crashing with default props", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["test"]} cursorLine={0} cursorColumn={0} isFocused={false} />,
			);
			expect(lastFrame()).toBeDefined();
		});

		test("handles empty lines array gracefully", () => {
			const { lastFrame } = render(
				<TextRenderer lines={[]} cursorLine={0} cursorColumn={0} isFocused={false} />,
			);
			expect(lastFrame()).toBeDefined();
		});
	});

	describe("focus handling", () => {
		test("renders full text content when focused", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["Hello"]} cursorLine={0} cursorColumn={2} isFocused={true} />,
			);
			const frame = lastFrame()!;
			// Cursor splits the line: "He" | cursor("l") | "lo"
			// All characters should be present in the output
			expect(frame).toContain("He");
			expect(frame).toContain("lo");
		});

		test("content visible when unfocused", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["Hello world"]} cursorLine={0} cursorColumn={0} isFocused={false} />,
			);
			expect(lastFrame()).toContain("Hello world");
		});

		test("unfocused renders text without splitting at cursor position", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["Hello"]} cursorLine={0} cursorColumn={0} isFocused={false} />,
			);
			// Unfocused: full text rendered as one piece, no cursor splitting
			expect(lastFrame()).toContain("Hello");
		});
	});

	describe("multi-line content", () => {
		test("displays all lines", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={["First line", "Second line", "Third line"]}
					cursorLine={1}
					cursorColumn={3}
					isFocused={true}
				/>,
			);
			const clean = stripAnsi(lastFrame()!);
			expect(clean).toContain("First line");
			expect(clean).toContain("Second line");
			expect(clean).toContain("Third line");
		});

		test("handles empty lines between content", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={["Line 1", "", "Line 3"]}
					cursorLine={0}
					cursorColumn={0}
					isFocused={true}
				/>,
			);
			const clean = stripAnsi(lastFrame()!);
			expect(clean).toContain("Line 1");
			expect(clean).toContain("Line 3");
		});

		test("cursor line text is split around cursor position", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={["First", "Second"]}
					cursorLine={1}
					cursorColumn={3}
					isFocused={true}
				/>,
			);
			const frame = lastFrame()!;
			// Non-cursor line renders as plain text
			expect(frame).toContain("First");
			// Cursor line "Second" with cursor at col 3 splits: "Sec" | "o" | "nd"
			expect(frame).toContain("Sec");
			expect(frame).toContain("nd");
		});
	});

	describe("placeholder", () => {
		test("shows placeholder when empty and unfocused", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={[""]}
					cursorLine={0}
					cursorColumn={0}
					isFocused={false}
					placeholder="Enter your message..."
				/>,
			);
			expect(lastFrame()).toContain("Enter your message...");
		});

		test("shows default placeholder when none provided", () => {
			const { lastFrame } = render(
				<TextRenderer lines={[""]} cursorLine={0} cursorColumn={0} isFocused={false} />,
			);
			expect(lastFrame()).toContain("Type your message...");
		});

		test("hides placeholder when focused even if empty", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={[""]}
					cursorLine={0}
					cursorColumn={0}
					isFocused={true}
					placeholder="Should not see this"
				/>,
			);
			expect(lastFrame()).not.toContain("Should not see this");
		});

		test("hides placeholder when content exists", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={["Some content"]}
					cursorLine={0}
					cursorColumn={0}
					isFocused={false}
					placeholder="Should not see this"
				/>,
			);
			expect(lastFrame()).toContain("Some content");
			expect(lastFrame()).not.toContain("Should not see this");
		});

		test("custom placeholder text", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={[""]}
					cursorLine={0}
					cursorColumn={0}
					isFocused={false}
					placeholder="Start typing your code..."
				/>,
			);
			expect(lastFrame()).toContain("Start typing your code...");
		});
	});

	describe("edge cases", () => {
		test("cursor line beyond content bounds is clamped", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["Short"]} cursorLine={5} cursorColumn={10} isFocused={true} />,
			);
			// Should not crash, should render content
			expect(stripAnsi(lastFrame()!)).toContain("Short");
		});

		test("negative cursor positions are clamped to zero", () => {
			const { lastFrame } = render(
				<TextRenderer
					lines={["Test content"]}
					cursorLine={-1}
					cursorColumn={-5}
					isFocused={true}
				/>,
			);
			expect(lastFrame()).toBeDefined();
			expect(stripAnsi(lastFrame()!)).toContain("Test content");
		});

		test("empty lines array renders without crashing when focused", () => {
			const { lastFrame } = render(
				<TextRenderer lines={[]} cursorLine={0} cursorColumn={0} isFocused={true} />,
			);
			// Should not crash — empty array becomes [""], renders cursor block
			expect(lastFrame()).toBeDefined();
		});

		test("cursor at end of line renders without crashing", () => {
			const { lastFrame } = render(
				<TextRenderer lines={["Hello"]} cursorLine={0} cursorColumn={5} isFocused={true} />,
			);
			// Cursor at end: "Hello" then cursor block (space)
			// Content should still be present
			expect(lastFrame()).toContain("Hello");
		});

		test("re-renders when props change", () => {
			const { lastFrame, rerender } = render(
				<TextRenderer lines={["Hello"]} cursorLine={0} cursorColumn={0} isFocused={true} />,
			);
			expect(stripAnsi(lastFrame()!)).toContain("Hello");

			rerender(
				<TextRenderer lines={["Updated"]} cursorLine={0} cursorColumn={0} isFocused={true} />,
			);
			expect(stripAnsi(lastFrame()!)).toContain("Updated");
		});
	});
});

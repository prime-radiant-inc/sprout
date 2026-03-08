import { afterEach, describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render as inkRender } from "ink-testing-library";
import { useWindowSize } from "../../src/tui/use-window-size.ts";

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

afterEach(() => {
	currentInstance?.unmount();
	currentInstance = undefined;
});

function SizeDisplay() {
	const { columns, rows } = useWindowSize();
	return (
		<Text>
			{columns}x{rows}
		</Text>
	);
}

describe("useWindowSize", () => {
	test("returns stdout dimensions", () => {
		const { lastFrame } = render(<SizeDisplay />);
		const frame = lastFrame()!;
		// ink-testing-library uses a default size; just verify format
		expect(frame).toMatch(/\d+x\d+/);
	});
});

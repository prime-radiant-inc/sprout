import { describe, expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useWindowSize } from "../../src/tui/use-window-size.ts";

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

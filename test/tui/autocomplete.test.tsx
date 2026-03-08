import { afterEach, describe, expect, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import { Autocomplete } from "../../src/tui/autocomplete.tsx";

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

describe("Autocomplete", () => {
	afterEach(() => {
		currentInstance?.unmount();
		currentInstance = undefined;
	});

	test("renders nothing when not visible", () => {
		const { lastFrame } = render(
			<Autocomplete items={["foo", "bar"]} selectedIndex={0} visible={false} />,
		);
		expect(lastFrame()).toBe("");
	});

	test("renders nothing when items is empty", () => {
		const { lastFrame } = render(<Autocomplete items={[]} selectedIndex={0} visible={true} />);
		expect(lastFrame()).toBe("");
	});

	test("renders items with selected highlight", () => {
		const { lastFrame } = render(
			<Autocomplete items={["alpha", "beta", "gamma"]} selectedIndex={1} visible={true} />,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("> beta");
		expect(frame).toContain("  alpha");
		expect(frame).toContain("  gamma");
	});

	test("Enter calls onSelect with selected item", async () => {
		let selected = "";
		const { stdin } = render(
			<Autocomplete
				items={["foo", "bar", "baz"]}
				selectedIndex={1}
				visible={true}
				onSelect={(item) => {
					selected = item;
				}}
			/>,
		);

		stdin.write("\r");
		await flush();

		expect(selected).toBe("bar");
	});

	test("Escape calls onCancel", async () => {
		let cancelled = false;
		const { stdin } = render(
			<Autocomplete
				items={["foo", "bar"]}
				selectedIndex={0}
				visible={true}
				onCancel={() => {
					cancelled = true;
				}}
			/>,
		);

		stdin.write("\x1B");
		await flush();

		expect(cancelled).toBe(true);
	});

	test("Tab calls onSelect with selected item", async () => {
		let selected = "";
		const { stdin } = render(
			<Autocomplete
				items={["foo", "bar", "baz"]}
				selectedIndex={2}
				visible={true}
				onSelect={(item) => {
					selected = item;
				}}
			/>,
		);

		stdin.write("\t");
		await flush();

		expect(selected).toBe("baz");
	});

	test("down arrow calls onNavigate('down')", async () => {
		let direction = "";
		const { stdin } = render(
			<Autocomplete
				items={["foo", "bar"]}
				selectedIndex={0}
				visible={true}
				onNavigate={(dir) => {
					direction = dir;
				}}
			/>,
		);

		stdin.write("\x1B[B");
		await flush();

		expect(direction).toBe("down");
	});

	test("up arrow calls onNavigate('up')", async () => {
		let direction = "";
		const { stdin } = render(
			<Autocomplete
				items={["foo", "bar"]}
				selectedIndex={1}
				visible={true}
				onNavigate={(dir) => {
					direction = dir;
				}}
			/>,
		);

		stdin.write("\x1B[A");
		await flush();

		expect(direction).toBe("up");
	});

	test("caps visible items to maxItems", () => {
		const items = ["a", "b", "c", "d", "e", "f", "g"];
		const { lastFrame } = render(
			<Autocomplete items={items} selectedIndex={0} visible={true} maxItems={3} />,
		);
		const frame = lastFrame()!;
		const lines = frame.split("\n").filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(3);
	});

	test("scrolls window to keep selected visible", () => {
		const items = ["a", "b", "c", "d", "e", "f", "g"];
		const { lastFrame } = render(
			<Autocomplete items={items} selectedIndex={5} visible={true} maxItems={3} />,
		);
		const frame = lastFrame()!;
		// startIndex = Math.max(0, Math.min(5, 7-3)) = 4, so window shows e, f, g
		expect(frame).toContain("> f");
		expect(frame).toContain("  e");
		expect(frame).toContain("  g");
		expect(frame).not.toContain("  a");
		expect(frame).not.toContain("  d");
	});
});

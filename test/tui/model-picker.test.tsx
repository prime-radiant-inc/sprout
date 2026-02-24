import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ModelPicker } from "../../src/tui/model-picker.tsx";

/** Wait for React to flush state updates. */
async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

const MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "gpt-4o"];

describe("ModelPicker", () => {
	test("renders model list", () => {
		const { lastFrame } = render(
			<ModelPicker models={MODELS} onSelect={() => {}} onCancel={() => {}} />,
		);
		expect(lastFrame()).toContain("claude-sonnet");
		expect(lastFrame()).toContain("gpt-4o");
	});

	test("Enter selects model", async () => {
		let selected = "";
		const { stdin } = render(
			<ModelPicker
				models={MODELS}
				onSelect={(m) => {
					selected = m;
				}}
				onCancel={() => {}}
			/>,
		);
		stdin.write("\r");
		await flush();
		expect(selected).toBe("claude-sonnet-4-6");
	});

	test("Escape cancels", async () => {
		let cancelled = false;
		const { stdin } = render(
			<ModelPicker
				models={MODELS}
				onSelect={() => {}}
				onCancel={() => {
					cancelled = true;
				}}
			/>,
		);
		stdin.write("\x1B");
		await flush();
		expect(cancelled).toBe(true);
	});

	test("Down arrow moves selection", async () => {
		let selected = "";
		const { stdin } = render(
			<ModelPicker
				models={MODELS}
				onSelect={(m) => {
					selected = m;
				}}
				onCancel={() => {}}
			/>,
		);
		stdin.write("\x1B[B"); // Down
		await flush();
		stdin.write("\r");
		await flush();
		expect(selected).toBe("claude-opus-4-6");
	});

	test("Up arrow moves selection back", async () => {
		let selected = "";
		const { stdin } = render(
			<ModelPicker
				models={MODELS}
				onSelect={(m) => {
					selected = m;
				}}
				onCancel={() => {}}
			/>,
		);
		stdin.write("\x1B[B"); // Down
		await flush();
		stdin.write("\x1B[B"); // Down again
		await flush();
		stdin.write("\x1B[A"); // Up
		await flush();
		stdin.write("\r");
		await flush();
		expect(selected).toBe("claude-opus-4-6");
	});

	test("shows empty state", () => {
		const { lastFrame } = render(
			<ModelPicker models={[]} onSelect={() => {}} onCancel={() => {}} />,
		);
		expect(lastFrame()).toContain("No models");
	});
});

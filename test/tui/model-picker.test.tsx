import { afterEach, describe, expect, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import { buildModelPickerOptions, ModelPicker } from "../../src/tui/model-picker.tsx";
import { makeSelectionSnapshot, makeSettingsSnapshot } from "../helpers/provider-settings.ts";
import { sleep, waitFor } from "../helpers/wait-for.ts";

async function flush() {
	await sleep(10);
}

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

describe("ModelPicker", () => {
	afterEach(() => {
		currentInstance?.unmount();
		currentInstance = undefined;
	});

	test("builds provider-aware picker options", () => {
		const options = buildModelPickerOptions({
			availableModels: ["best", "balanced", "fast", "claude-sonnet-4-6", "qwen2.5-coder"],
			settings: makeSettingsSnapshot(),
			currentSelection: makeSelectionSnapshot(),
			currentModel: "claude-sonnet-4-6",
		});

		expect(options.map((option) => option.label)).toEqual([
			"Default · claude-sonnet-4-6",
			"Best",
			"Balanced",
			"Fast",
			"Anthropic · Claude Sonnet 4.6",
			"LM Studio · Qwen 2.5 Coder",
		]);
	});

	test("renders provider-aware option labels", () => {
		const { lastFrame } = render(
			<ModelPicker
				options={buildModelPickerOptions({
					availableModels: ["best", "claude-sonnet-4-6"],
					settings: makeSettingsSnapshot(),
					currentSelection: makeSelectionSnapshot(),
					currentModel: "claude-sonnet-4-6",
				})}
				onSelect={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("Anthropic");
		expect(lastFrame()).toContain("Best");
	});

	test("Enter selects the highlighted canonical selection", async () => {
		let selected:
			| {
					kind: "inherit";
			  }
			| {
					kind: "tier";
					tier: "best" | "balanced" | "fast";
			  }
			| {
					kind: "model";
					model: { providerId: string; modelId: string };
			  }
			| undefined;
		const { stdin } = render(
			<ModelPicker
				options={buildModelPickerOptions({
					availableModels: ["best", "claude-sonnet-4-6"],
					settings: makeSettingsSnapshot(),
					currentSelection: makeSelectionSnapshot(),
					currentModel: "claude-sonnet-4-6",
				})}
				onSelect={(selection) => {
					selected = selection;
				}}
				onCancel={() => {}}
			/>,
		);
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\r");
		await waitFor(() => selected?.kind === "model");
		expect(selected).toEqual({
			kind: "model",
			model: {
				providerId: "anthropic-main",
				modelId: "claude-sonnet-4-6",
			},
		});
	});

	test("Escape cancels", async () => {
		let cancelled = false;
		const { stdin } = render(
			<ModelPicker
				options={[]}
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

	test("shows empty state", () => {
		const { lastFrame } = render(
			<ModelPicker options={[]} onSelect={() => {}} onCancel={() => {}} />,
		);
		expect(lastFrame()).toContain("No models");
	});
});

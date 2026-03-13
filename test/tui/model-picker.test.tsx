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

	test("builds default-model options plus exact models grouped by provider", () => {
		const options = buildModelPickerOptions({
			availableModels: [
				"best",
				"balanced",
				"fast",
				"anthropic-main:claude-sonnet-4-6",
				"lmstudio:qwen2.5-coder",
			],
			settings: makeSettingsSnapshot(),
			currentSelection: makeSelectionSnapshot(),
			currentModel: "claude-sonnet-4-6",
		});

		expect(options.map((option) => option.label)).toEqual([
			"Use agent default · claude-sonnet-4-6",
			"Best · Anthropic · claude-opus-4-6",
			"Balanced · Anthropic · Claude Sonnet 4.6",
			"Fast · LM Studio · Qwen 2.5 Coder",
			"Anthropic · Claude Sonnet 4.6",
			"LM Studio · Qwen 2.5 Coder",
		]);
	});

	test("includes exact models from every enabled provider when no filter is applied", () => {
		const options = buildModelPickerOptions({
			availableModels: [],
			settings: makeSettingsSnapshot(),
			currentSelection: makeSelectionSnapshot(),
			currentModel: "claude-sonnet-4-6",
		});

		expect(options.map((option) => option.label)).toEqual([
			"Use agent default · claude-sonnet-4-6",
			"Best · Anthropic · claude-opus-4-6",
			"Balanced · Anthropic · Claude Sonnet 4.6",
			"Fast · LM Studio · Qwen 2.5 Coder",
			"Anthropic · Claude Sonnet 4.6",
			"LM Studio · Qwen 2.5 Coder",
		]);
	});

	test("renders default-model labels alongside provider-grouped exact models", () => {
		const { lastFrame } = render(
			<ModelPicker
				availableModels={[
					"best",
					"balanced",
					"fast",
					"anthropic-main:claude-sonnet-4-6",
					"lmstudio:qwen2.5-coder",
				]}
				settings={makeSettingsSnapshot()}
				currentSelection={makeSelectionSnapshot()}
				currentModel="claude-sonnet-4-6"
				onSelect={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("Use agent default");
		expect(lastFrame()).toContain("Default models");
		expect(lastFrame()).toContain("Balanced · Anthropic");
		expect(lastFrame()).toContain("Anthropic");
		expect(lastFrame()).toContain("LM Studio");
		expect(lastFrame()).toContain("Claude Sonnet 4.6");
		expect(lastFrame()).toContain("Qwen 2.5 Coder");
	});

	test("Enter selects the highlighted canonical exact-model selection", async () => {
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
				availableModels={["best", "anthropic-main:claude-sonnet-4-6", "lmstudio:qwen2.5-coder"]}
				settings={makeSettingsSnapshot()}
				currentSelection={makeSelectionSnapshot()}
				currentModel="claude-sonnet-4-6"
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
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\x1B[B");
		await flush();
		stdin.write("\r");
		await waitFor(() => selected?.kind === "model");
		expect(selected).toEqual({
			kind: "model",
			model: {
				providerId: "lmstudio",
				modelId: "qwen2.5-coder",
			},
		});
	});

	test("Escape cancels", async () => {
		let cancelled = false;
		const { stdin } = render(
			<ModelPicker
				availableModels={[]}
				currentSelection={makeSelectionSnapshot()}
				currentModel=""
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

	test("falls back to the current selection when settings are unavailable", () => {
		const { lastFrame } = render(
			<ModelPicker
				availableModels={[]}
				currentSelection={makeSelectionSnapshot()}
				currentModel=""
				onSelect={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("Use agent default");
		expect(lastFrame()).toContain("anthropic-main · claude-sonnet-4-6");
	});
});

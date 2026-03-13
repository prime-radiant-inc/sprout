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

	test("builds global tier options plus exact models for the current provider", () => {
		const options = buildModelPickerOptions({
			availableModels: ["best", "balanced", "fast", "claude-sonnet-4-6", "qwen2.5-coder"],
			settings: makeSettingsSnapshot(),
			currentSelection: makeSelectionSnapshot(),
			currentModel: "claude-sonnet-4-6",
		});

		expect(options.map((option) => option.label)).toEqual([
			"Default · Anthropic",
			"Provider · Anthropic (selected)",
			"Provider · LM Studio",
			"Best · Anthropic",
			"Balanced · Anthropic",
			"Fast · LM Studio",
			"Anthropic · Claude Sonnet 4.6",
		]);
	});

	test("builds exact-model options for an explicitly selected provider while keeping global tiers", () => {
		const options = buildModelPickerOptions({
			availableModels: [],
			settings: makeSettingsSnapshot(),
			currentSelection: makeSelectionSnapshot(),
			currentModel: "claude-sonnet-4-6",
			selectedProviderId: "lmstudio",
		});

		expect(options.map((option) => option.label)).toEqual([
			"Default · Anthropic",
			"Provider · Anthropic",
			"Provider · LM Studio (selected)",
			"Best · Anthropic",
			"Balanced · Anthropic",
			"Fast · LM Studio",
			"LM Studio · Qwen 2.5 Coder",
			"Anthropic · Claude Sonnet 4.6",
		]);
	});

	test("renders global tier labels alongside provider-scoped exact models", () => {
		const { lastFrame } = render(
			<ModelPicker
				availableModels={["best", "claude-sonnet-4-6"]}
				settings={makeSettingsSnapshot()}
				currentSelection={makeSelectionSnapshot()}
				currentModel="claude-sonnet-4-6"
				onSelect={() => {}}
				onCancel={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("Provider · LM Studio");
		expect(lastFrame()).toContain("Balanced · Anthropic");
		expect(lastFrame()).toContain("Fast · LM Studio");
	});

	test("Enter selects the highlighted canonical selection after switching providers", async () => {
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
		const { stdin, lastFrame } = render(
			<ModelPicker
				availableModels={["best", "claude-sonnet-4-6", "qwen2.5-coder"]}
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
		stdin.write("\r");
		await waitFor(() => (lastFrame() ?? "").includes("Provider · LM Studio (selected)"));
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
		expect(lastFrame()).toContain("Default");
		expect(lastFrame()).toContain("anthropic-main · claude-sonnet-4-6");
	});
});

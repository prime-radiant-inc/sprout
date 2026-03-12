import { afterEach, describe, expect, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import {
	applyProviderEditorCommand,
	createProviderEditorDraft,
	ProviderSettingsEditor,
} from "../../src/tui/provider-settings-editor.tsx";
import { makeSettingsErrorResult, makeSettingsSnapshot } from "../helpers/provider-settings.ts";

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

describe("ProviderSettingsEditor", () => {
	afterEach(() => {
		currentInstance?.unmount();
		currentInstance = undefined;
	});

	test("renders provider health, discovered models, and the last error", () => {
		const settings = makeSettingsSnapshot();
		const { lastFrame } = render(
			<ProviderSettingsEditor
				mode="edit"
				draft={createProviderEditorDraft(settings.settings.providers[0])}
				provider={settings.settings.providers[0]}
				status={settings.providers[0]}
				catalogEntry={settings.catalog[0]}
				lastResult={makeSettingsErrorResult("Latest command failed")}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Anthropic");
		expect(frame).toContain("Unsupported secret backend");
		expect(frame).toContain("Auth failed");
		expect(frame).toContain("Refresh required");
		expect(frame).toContain("Claude Sonnet 4.6");
		expect(frame).toContain("Latest command failed");
	});

	test("renders field-level feedback, manual models, custom headers, and visible actions", () => {
		const settings = makeSettingsSnapshot();
		settings.settings.providers[1]!.nonSecretHeaders = {
			"X-Client": "sprout",
		};
		const { lastFrame } = render(
			<ProviderSettingsEditor
				mode="edit"
				draft={createProviderEditorDraft(settings.settings.providers[1])}
				provider={settings.settings.providers[1]}
				status={settings.providers[1]}
				catalogEntry={settings.catalog[1]}
				lastResult={{
					ok: false,
					code: "validation_failed",
					message: "Validation failed",
					fieldErrors: {
						baseUrl: "Base URL must be a valid http or https URL",
						manualModels: "Manual models must use unique ids",
						nonSecretHeaders: "Header names must be unique",
					},
				}}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Manual models");
		expect(frame).toContain("Qwen 2.5 Coder");
		expect(frame).toContain("Custom headers");
		expect(frame).toContain("X-Client");
		expect(frame).toContain("Actions");
		expect(frame).toContain("Add manual model");
		expect(frame).toContain("Add header");
		expect(frame).toContain("Base URL must be a valid http or https URL");
		expect(frame).toContain("Manual models must use unique ids");
		expect(frame).toContain("Header names must be unique");
	});

	test("builds create and edit provider commands from editor shortcuts", () => {
		const created = applyProviderEditorCommand(
			"save",
			createProviderEditorDraft(undefined),
			"create",
		);
		expect(created.error).toMatch(/label/i);

		const labeled = applyProviderEditorCommand(
			"label OpenRouter",
			createProviderEditorDraft(undefined),
			"create",
		);
		expect(labeled.draft.label).toBe("OpenRouter");

		const kind = applyProviderEditorCommand("kind openrouter", labeled.draft, "create");
		expect(kind.draft.kind).toBe("openrouter");

		const withModel = applyProviderEditorCommand("add-model", kind.draft, "create");
		const modelId = applyProviderEditorCommand(
			"model-id 1 openrouter/manual-fast",
			withModel.draft,
			"create",
		);
		const modelLabel = applyProviderEditorCommand(
			"model-label 1 Manual Fast",
			modelId.draft,
			"create",
		);
		const modelTier = applyProviderEditorCommand("model-tier 1 fast", modelLabel.draft, "create");
		const modelRank = applyProviderEditorCommand("model-rank 1 3", modelTier.draft, "create");
		const withHeader = applyProviderEditorCommand("add-header", modelRank.draft, "create");
		const headerKey = applyProviderEditorCommand(
			"header-key 1 HTTP-Referer",
			withHeader.draft,
			"create",
		);
		const headerValue = applyProviderEditorCommand(
			"header-value 1 https://sprout.local",
			headerKey.draft,
			"create",
		);

		const saveCreate = applyProviderEditorCommand("save", headerValue.draft, "create");
		expect(saveCreate.command).toEqual({
			kind: "create_provider",
			data: {
				kind: "openrouter",
				label: "OpenRouter",
				discoveryStrategy: "remote-with-manual",
				manualModels: [
					{
						id: "openrouter/manual-fast",
						label: "Manual Fast",
						tierHint: "fast",
						rank: 3,
					},
				],
				nonSecretHeaders: {
					"HTTP-Referer": "https://sprout.local",
				},
			},
		});

		const settings = makeSettingsSnapshot();
		settings.settings.providers[1]!.nonSecretHeaders = {
			"X-Client": "sprout",
		};
		const saveEdit = applyProviderEditorCommand(
			"save",
			createProviderEditorDraft(settings.settings.providers[1]),
			"edit",
			"lmstudio",
		);
		expect(saveEdit.command).toEqual({
			kind: "update_provider",
			data: {
				providerId: "lmstudio",
				patch: {
					label: "LM Studio",
					baseUrl: "http://127.0.0.1:1234/v1",
					discoveryStrategy: "manual-only",
					manualModels: [
						{
							id: "qwen2.5-coder",
							label: "Qwen 2.5 Coder",
							tierHint: "fast",
							rank: 5,
						},
					],
					nonSecretHeaders: {
						"X-Client": "sprout",
					},
				},
			},
		});

		const clearedEdit = applyProviderEditorCommand(
			"remove-model 1",
			createProviderEditorDraft(settings.settings.providers[1]),
			"edit",
			"lmstudio",
		);
		expect(
			applyProviderEditorCommand("save", clearedEdit.draft, "edit", "lmstudio").command,
		).toEqual({
			kind: "update_provider",
			data: {
				providerId: "lmstudio",
				patch: {
					label: "LM Studio",
					baseUrl: "http://127.0.0.1:1234/v1",
					discoveryStrategy: "manual-only",
					manualModels: [],
					nonSecretHeaders: {
						"X-Client": "sprout",
					},
				},
			},
		});
	});

	test("builds provider action commands in edit mode", () => {
		const draft = createProviderEditorDraft(makeSettingsSnapshot().settings.providers[1]);

		expect(applyProviderEditorCommand("disable", draft, "edit", "lmstudio").command).toEqual({
			kind: "set_provider_enabled",
			data: { providerId: "lmstudio", enabled: false },
		});
		expect(applyProviderEditorCommand("enable", draft, "edit", "lmstudio").command).toEqual({
			kind: "set_provider_enabled",
			data: { providerId: "lmstudio", enabled: true },
		});
		expect(applyProviderEditorCommand("test", draft, "edit", "lmstudio").command).toEqual({
			kind: "test_provider_connection",
			data: { providerId: "lmstudio" },
		});
		expect(applyProviderEditorCommand("refresh", draft, "edit", "lmstudio").command).toEqual({
			kind: "refresh_provider_models",
			data: { providerId: "lmstudio" },
		});
		expect(applyProviderEditorCommand("secret sk-test", draft, "edit", "lmstudio").command).toEqual(
			{
				kind: "set_provider_secret",
				data: { providerId: "lmstudio", secret: "sk-test" },
			},
		);
		expect(applyProviderEditorCommand("remove-secret", draft, "edit", "lmstudio").command).toEqual({
			kind: "delete_provider_secret",
			data: { providerId: "lmstudio" },
		});
		expect(applyProviderEditorCommand("delete", draft, "edit", "lmstudio").command).toEqual({
			kind: "delete_provider",
			data: { providerId: "lmstudio" },
		});
	});
});

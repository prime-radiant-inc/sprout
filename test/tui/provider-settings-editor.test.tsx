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

	test("builds create and edit provider commands from editor commands", () => {
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

		const saveCreate = applyProviderEditorCommand("save", kind.draft, "create");
		expect(saveCreate.command).toEqual({
			kind: "create_provider",
			data: {
				kind: "openrouter",
				label: "OpenRouter",
				discoveryStrategy: "remote-with-manual",
			},
		});

		const saveEdit = applyProviderEditorCommand(
			"save",
			createProviderEditorDraft(makeSettingsSnapshot().settings.providers[1]),
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

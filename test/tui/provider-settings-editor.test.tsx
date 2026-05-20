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

	test("renders field-level feedback, custom headers, and visible actions", () => {
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
						nonSecretHeaders: "Header names must be unique",
					},
				}}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Custom headers");
		expect(frame).toContain("X-Client");
		expect(frame).toContain("Actions");
		expect(frame).toContain("Add header");
		expect(frame).toContain("Base URL must be a valid http or https URL");
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

		const codexKind = applyProviderEditorCommand("kind openai-codex", labeled.draft, "create");
		expect(codexKind.draft.kind).toBe("openai-codex");

		const withHeader = applyProviderEditorCommand("add-header", kind.draft, "create");
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
					nonSecretHeaders: {
						"X-Client": "sprout",
					},
				},
			},
		});

		expect(applyProviderEditorCommand("discovery remote-only", kind.draft, "create").error).toBe(
			"Unknown provider command: discovery",
		);
		expect(applyProviderEditorCommand("add-model", kind.draft, "create").error).toBe(
			"Unknown provider command: add-model",
		);
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

	test("does not expose generic secret shortcuts for OAuth-only providers", () => {
		const draft = createProviderEditorDraft({
			id: "openai-codex",
			kind: "openai-codex",
			label: "OpenAI Codex",
			enabled: true,
			createdAt: "2026-03-11T12:00:00.000Z",
			updatedAt: "2026-03-11T12:00:00.000Z",
		});

		expect(applyProviderEditorCommand("secret sk-test", draft, "edit", "openai-codex")).toEqual({
			draft,
			error: "OpenAI Codex uses ChatGPT OAuth. Generic provider secret commands are not supported.",
		});
		expect(applyProviderEditorCommand("remove-secret", draft, "edit", "openai-codex")).toEqual({
			draft,
			error: "OpenAI Codex uses ChatGPT OAuth. Generic provider secret commands are not supported.",
		});

		const { lastFrame } = render(
			<ProviderSettingsEditor
				mode="edit"
				draft={draft}
				provider={{
					id: "openai-codex",
					kind: "openai-codex",
					label: "OpenAI Codex",
					enabled: true,
					createdAt: "2026-03-11T12:00:00.000Z",
					updatedAt: "2026-03-11T12:00:00.000Z",
				}}
			/>,
		);
		const frame = lastFrame()!;
		expect(frame).toContain("Enable/disable · test · refresh · delete");
		expect(frame).not.toContain("secret <token>");
		expect(frame).not.toContain("remove-secret");
		expect(frame).not.toContain("base-url <url>");
	});

	test("renders OpenAI Codex OAuth status and shortcuts", () => {
		const provider = {
			id: "openai-codex",
			kind: "openai-codex" as const,
			label: "OpenAI Codex",
			enabled: true,
			createdAt: "2026-03-11T12:00:00.000Z",
			updatedAt: "2026-03-11T12:00:00.000Z",
		};
		const { lastFrame, unmount } = render(
			<ProviderSettingsEditor
				mode="edit"
				draft={createProviderEditorDraft(provider)}
				provider={provider}
				status={{
					providerId: "openai-codex",
					hasSecret: true,
					credentialStatus: {
						kind: "oauth",
						signedIn: true,
						email: "jesse@example.com",
					},
					validationErrors: [],
					connectionStatus: "ok",
					catalogStatus: "current",
				}}
			/>,
		);
		const signedInFrame = lastFrame()!;
		expect(signedInFrame).toContain("OpenAI Codex");
		expect(signedInFrame).toContain("Signed in as jesse@example.com");
		expect(signedInFrame).toContain("Logout: logout");
		expect(signedInFrame).not.toContain("API key");
		unmount();

		const signedOut = render(
			<ProviderSettingsEditor
				mode="edit"
				draft={createProviderEditorDraft(provider)}
				provider={provider}
				status={{
					providerId: "openai-codex",
					hasSecret: false,
					credentialStatus: { kind: "oauth", signedIn: false },
					validationErrors: [],
					connectionStatus: "unknown",
					catalogStatus: "never-loaded",
				}}
			/>,
		);
		expect(signedOut.lastFrame()!).toContain("Login with ChatGPT: login");
	});

	test("renders cleanup-failed OpenAI Codex recovery shortcuts", () => {
		const provider = {
			id: "openai-codex",
			kind: "openai-codex" as const,
			label: "OpenAI Codex",
			enabled: false,
			disabledReason: "credential-cleanup-failed" as const,
			createdAt: "2026-03-11T12:00:00.000Z",
			updatedAt: "2026-03-11T12:00:00.000Z",
		};

		const { lastFrame } = render(
			<ProviderSettingsEditor
				mode="edit"
				draft={createProviderEditorDraft(provider)}
				provider={provider}
				status={{
					providerId: "openai-codex",
					hasSecret: false,
					credentialStatus: { kind: "oauth", signedIn: false },
					validationErrors: [],
					connectionStatus: "unknown",
					catalogStatus: "never-loaded",
				}}
			/>,
		);

		const frame = lastFrame()!;
		expect(frame).toContain("Retry delete: retry-delete");
		expect(frame).toContain("Sign in again: sign-in-again");
	});
});

describe("applyProviderEditorCommand OAuth commands", () => {
	test("builds OpenAI Codex OAuth action commands", () => {
		const draft = createProviderEditorDraft({
			id: "openai-codex",
			kind: "openai-codex",
			label: "OpenAI Codex",
			enabled: true,
			createdAt: "2026-03-11T12:00:00.000Z",
			updatedAt: "2026-03-11T12:00:00.000Z",
		});

		expect(applyProviderEditorCommand("login", draft, "edit", "openai-codex").command).toEqual({
			kind: "login_provider_oauth",
			data: { providerId: "openai-codex" },
		});
		expect(
			applyProviderEditorCommand("sign-in-again", draft, "edit", "openai-codex").command,
		).toEqual({
			kind: "login_provider_oauth",
			data: { providerId: "openai-codex" },
		});
		expect(applyProviderEditorCommand("logout", draft, "edit", "openai-codex").command).toEqual({
			kind: "logout_provider_oauth",
			data: { providerId: "openai-codex" },
		});
		expect(
			applyProviderEditorCommand("retry-delete", draft, "edit", "openai-codex").command,
		).toEqual({
			kind: "retry_provider_delete",
			data: { providerId: "openai-codex" },
		});
	});
});

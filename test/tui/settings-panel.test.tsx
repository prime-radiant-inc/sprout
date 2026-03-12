import { afterEach, describe, expect, test } from "bun:test";
import { render as inkRender } from "ink-testing-library";
import { SettingsPanel } from "../../src/tui/settings-panel.tsx";
import { makeSettingsErrorResult, makeSettingsSnapshot } from "../helpers/provider-settings.ts";
import { sleep, waitFor } from "../helpers/wait-for.ts";

let currentInstance: ReturnType<typeof inkRender> | undefined;

function render(...args: Parameters<typeof inkRender>): ReturnType<typeof inkRender> {
	currentInstance = inkRender(...args);
	return currentInstance;
}

async function flush() {
	await sleep(10);
}

async function submitCommand(
	stdin: ReturnType<typeof inkRender>["stdin"],
	command: string,
	assertReady?: () => boolean,
) {
	stdin.write(command);
	await flush();
	stdin.write("\r");
	if (assertReady) {
		await waitFor(assertReady);
		return;
	}
	await flush();
}

describe("SettingsPanel", () => {
	afterEach(() => {
		currentInstance?.unmount();
		currentInstance = undefined;
	});

	test("renders loading and empty states", () => {
		const loading = render(
			<SettingsPanel settings={null} lastResult={null} onCommand={() => {}} onClose={() => {}} />,
		);
		expect(loading.lastFrame()).toContain("Loading provider settings");
		loading.unmount();

		currentInstance = undefined;
		const empty = render(
			<SettingsPanel
				settings={{
					runtime: {
						secretBackend: {
							backend: "memory",
							available: true,
						},
						warnings: [],
					},
					settings: {
						version: 1,
						providers: [],
						defaults: { selection: { kind: "none" } },
						routing: { providerPriority: [], tierOverrides: {} },
					},
					providers: [],
					catalog: [],
				}}
				lastResult={null}
				onCommand={() => {}}
				onClose={() => {}}
			/>,
		);
		expect(empty.lastFrame()).toContain("No providers configured");
	});

	test("navigates between views and issues create, defaults, and edit commands", async () => {
		const commands: unknown[] = [];
		const { stdin, lastFrame } = render(
			<SettingsPanel
				settings={makeSettingsSnapshot()}
				lastResult={makeSettingsErrorResult("Latest command failed")}
				onCommand={(command) => {
					commands.push(command);
				}}
				onClose={() => {}}
			/>,
		);

		expect(lastFrame()).toContain("Anthropic");
		expect(lastFrame()).toContain("Latest command failed");

		await submitCommand(stdin, "create", () => (lastFrame() ?? "").includes("Create provider"));
		expect(lastFrame()).toContain("Create provider");

		await submitCommand(stdin, "label OpenRouter", () =>
			!(lastFrame() ?? "").includes("label OpenRouter"),
		);
		await submitCommand(stdin, "kind openrouter", () =>
			!(lastFrame() ?? "").includes("kind openrouter"),
		);
		await submitCommand(stdin, "save", () => commands.length === 1);

		await submitCommand(stdin, "defaults", () =>
			(lastFrame() ?? "").includes("Defaults and routing"),
		);
		expect(lastFrame()).toContain("Defaults and routing");

		await submitCommand(stdin, "default tier fast", () => commands.length === 2);

		await submitCommand(stdin, "open lmstudio", () => (lastFrame() ?? "").includes("LM Studio"));
		expect(lastFrame()).toContain("LM Studio");

		await submitCommand(stdin, "disable", () => commands.length === 3);

		expect(commands).toEqual([
			{
				kind: "create_provider",
				data: {
					kind: "openrouter",
					label: "OpenRouter",
					discoveryStrategy: "remote-with-manual",
				},
			},
			{
				kind: "set_default_selection",
				data: { selection: { kind: "tier", tier: "fast" } },
			},
			{
				kind: "set_provider_enabled",
				data: { providerId: "lmstudio", enabled: false },
			},
		]);
	});

	test("esc closes the panel", async () => {
		let closed = false;
		const { stdin } = render(
			<SettingsPanel
				settings={makeSettingsSnapshot()}
				lastResult={null}
				onCommand={() => {}}
				onClose={() => {
					closed = true;
				}}
			/>,
		);

		stdin.write("\x1B");
		await flush();
		expect(closed).toBe(true);
	});
});

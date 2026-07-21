import { describe, expect, test } from "bun:test";
import type { SettingsSnapshot } from "@kernel/types.ts";
import type { ActiveAgentWork } from "@shared/agent-display.ts";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStatus } from "../../hooks/useEvents.ts";
import {
	buildSessionSelectionOptions,
	formatSessionSelectionLabel,
	StatusBar,
} from "../StatusBar.tsx";

function makeStatus(overrides: Partial<SessionStatus> = {}): SessionStatus {
	return {
		status: "idle",
		model: "claude-sonnet-4-6",
		turns: 0,
		inputTokens: 0,
		outputTokens: 0,
		contextTokens: 0,
		contextWindowSize: 200000,
		sessionId: "test-session",
		availableModels: [],
		currentSelection: {
			selection: { kind: "inherit" },
			source: "runtime-fallback",
		},
		sessionStartedAt: null,
		pricingTable: null,
		...overrides,
	};
}

function makeSettings(): SettingsSnapshot {
	return {
		runtime: {
			secretBackend: {
				backend: "memory",
				available: true,
			},
			warnings: [],
				modelOverrides: {
					defaults: {},
					memoryModels: {},
					agentModelOverrides: {},
				},
		},
		settings: {
			version: 4,
			providers: [
				{
					id: "anthropic-main",
					kind: "anthropic",
					label: "Anthropic",
					enabled: true,
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
				{
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
					enabled: true,
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
			],
			defaults: {
				best: {
					providerId: "openrouter-main",
					modelId: "gpt-4.1",
				},
				balanced: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
				},
				memoryModels: {},
				agentModelOverrides: {},
			},
		providers: [
			{
				providerId: "anthropic-main",
				hasSecret: true,
				credentialStatus: { kind: "api-key", present: true },
				validationErrors: [],
				connectionStatus: "ok",
				catalogStatus: "current",
			},
			{
				providerId: "openrouter-main",
				hasSecret: true,
				credentialStatus: { kind: "api-key", present: true },
				validationErrors: [],
				connectionStatus: "ok",
				catalogStatus: "current",
			},
		],
		catalog: [
			{
				providerId: "anthropic-main",
				models: [
					{
						id: "claude-sonnet-4-6",
						label: "Claude Sonnet 4.6",
						source: "remote",
					},
				],
			},
			{
				providerId: "openrouter-main",
				models: [
					{
						id: "gpt-4.1",
						label: "GPT-4.1",
						source: "remote",
					},
				],
			},
		],
		agentModels: [],
	};
}

describe("StatusBar", () => {
	test("renders active subagent work while running", () => {
		const activeWork: ActiveAgentWork = {
			kind: "agent",
			agent: {
				agentName: "architect",
				mnemonicName: "Brunelleschi",
			},
		};

		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "running" })}
				connected={true}
				activeWork={activeWork}
			/>,
		);

		expect(html).toContain("Waiting on Brunelleschi · architect");
	});

	test("renders memory saving work while running", () => {
		const activeWork: ActiveAgentWork = { kind: "memory" };

		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus({ status: "running" })}
				connected={true}
				activeWork={activeWork}
			/>,
		);

		expect(html).toContain("Saving memory");
	});

	test("renders inherit selection label when no switchable options exist", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).toContain("Use agent default");
		expect(html).toContain("claude-sonnet-4-6");
		expect(html).not.toContain("<select");
	});

	test("builds global default-model options and exact-model groups", () => {
		const options = buildSessionSelectionOptions(
			makeStatus({
				model: "claude-sonnet-4-6",
				availableModels: [
					"best",
					"balanced",
					"anthropic-main:claude-sonnet-4-6",
					"openrouter-main:gpt-4.1",
				],
			}),
			makeSettings(),
		);
		expect(options).toEqual([
			{
				selection: { kind: "inherit" },
				value: "inherit",
				label: "Use agent default · claude-sonnet-4-6",
			},
			{
				selection: { kind: "tier", tier: "best" },
				value: "best",
				label: "Best · OpenRouter · GPT-4.1",
				group: "Default models",
			},
			{
				selection: { kind: "tier", tier: "balanced" },
				value: "balanced",
				label: "Balanced · Anthropic · Claude Sonnet 4.6",
				group: "Default models",
			},
			{
				selection: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
				value: "anthropic-main:claude-sonnet-4-6",
				label: "Claude Sonnet 4.6",
				group: "Anthropic",
			},
			{
				selection: {
					kind: "model",
					model: {
						providerId: "openrouter-main",
						modelId: "gpt-4.1",
					},
				},
				value: "openrouter-main:gpt-4.1",
				label: "GPT-4.1",
				group: "OpenRouter",
			},
		]);
	});

	test("builds tier options from env-only default overrides", () => {
		const settings = makeSettings();
		delete settings.settings.defaults.best;
		settings.runtime.modelOverrides.defaults.best = {
			source: "env",
			envVar: "SPROUT_DEFAULT_BEST_MODEL",
			model: {
				providerId: "openrouter-main",
				modelId: "gpt-4.1",
			},
			catalogStatus: "matched",
			displayLabel: "GPT-4.1",
		};

		const options = buildSessionSelectionOptions(
			makeStatus({
				availableModels: ["best"],
				currentSelection: {
					selection: { kind: "tier", tier: "best" },
					source: "session",
				},
			}),
			settings,
		);

		expect(options.find((option) => option.value === "best")).toEqual({
			selection: { kind: "tier", tier: "best" },
			value: "best",
			label: "Best · OpenRouter · GPT-4.1",
			group: "Default models",
		});
		expect(
			formatSessionSelectionLabel(
				{
					selection: { kind: "tier", tier: "best" },
					source: "session",
				},
				"gpt-4.1",
				settings,
			),
		).toBe("Best · OpenRouter · GPT-4.1");
	});

	test("renders grouped default-model and exact-model selector", () => {
		const status = makeStatus({
			availableModels: [
				"best",
				"balanced",
				"anthropic-main:claude-sonnet-4-6",
				"openrouter-main:gpt-4.1",
			],
			model: "claude-sonnet-4-6",
			currentSelection: {
				selection: {
					kind: "model",
					model: {
						providerId: "anthropic-main",
						modelId: "claude-sonnet-4-6",
					},
				},
				resolved: {
					providerId: "anthropic-main",
					modelId: "claude-sonnet-4-6",
				},
				source: "session",
			},
		});
		const html = renderToStaticMarkup(
			<StatusBar
				status={status}
				settings={makeSettings()}
				connected={true}
				onSwitchModel={() => {}}
			/>,
		);
		expect(html).toContain("<select");
		expect(html).toContain('label="Default models"');
		expect(html).toContain('label="Anthropic"');
		expect(html).toContain('label="OpenRouter"');
		expect(html).toContain("Claude Sonnet 4.6");
		expect(html).toContain('selected=""');
	});

	test("formats provider-aware labels for explicit selections", () => {
		expect(
			formatSessionSelectionLabel(
				{
					selection: {
						kind: "model",
						model: {
							providerId: "openrouter-main",
							modelId: "gpt-4.1",
						},
					},
					source: "session",
				},
				"gpt-4.1",
				makeSettings(),
			),
		).toBe("OpenRouter · GPT-4.1");
	});

	test("renders settings launcher when settings callback is provided", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus()}
				connected={true}
				onOpenSettings={() => {}}
			/>,
		);
		expect(html).toContain('data-action="open-settings"');
		expect(html).toContain("Settings");
	});

	test("renders sidebar toggle when the callback is provided", () => {
		const html = renderToStaticMarkup(
			<StatusBar
				status={makeStatus()}
				connected={true}
				onToggleSidebar={() => {}}
			/>,
		);
		expect(html).toContain('data-action="toggle-sidebar"');
	});

	test("omits sidebar toggle when no callback is provided", () => {
		const html = renderToStaticMarkup(
			<StatusBar status={makeStatus()} connected={true} />,
		);
		expect(html).not.toContain('data-action="toggle-sidebar"');
	});
});

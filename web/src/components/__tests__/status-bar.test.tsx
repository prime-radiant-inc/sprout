import { describe, expect, test } from "bun:test";
import type { SettingsSnapshot } from "@kernel/types.ts";
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
		},
		settings: {
			version: 2,
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
		},
		providers: [
			{
				providerId: "anthropic-main",
				hasSecret: true,
				validationErrors: [],
				connectionStatus: "ok",
				catalogStatus: "current",
			},
			{
				providerId: "openrouter-main",
				hasSecret: true,
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
	};
}

describe("StatusBar", () => {
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
});

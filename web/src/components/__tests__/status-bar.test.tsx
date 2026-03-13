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
			version: 1,
			providers: [
				{
					id: "anthropic-main",
					kind: "anthropic",
					label: "Anthropic",
					enabled: true,
					discoveryStrategy: "remote-with-manual",
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
				{
					id: "openrouter-main",
					kind: "openrouter",
					label: "OpenRouter",
					enabled: true,
					discoveryStrategy: "remote-with-manual",
					createdAt: "2026-03-11T00:00:00.000Z",
					updatedAt: "2026-03-11T00:00:00.000Z",
				},
			],
			defaults: {
				defaultProviderId: "anthropic-main",
				tierDefaults: {
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
		expect(html).toContain("Default");
		expect(html).toContain("claude-sonnet-4-6");
		expect(html).not.toContain("<select");
	});

	test("builds global tier options and provider-scoped exact model options", () => {
		const options = buildSessionSelectionOptions(
			makeStatus({
				model: "claude-sonnet-4-6",
				availableModels: ["best", "balanced", "fast", "claude-sonnet-4-6", "gpt-4.1"],
			}),
			makeSettings(),
			"anthropic-main",
		);
		expect(options).toEqual([
			{
				selection: { kind: "inherit" },
				value: "inherit",
				label: "Default · claude-sonnet-4-6",
			},
			{
				selection: { kind: "tier", tier: "best" },
				value: "best",
				label: "Best · OpenRouter",
			},
			{
				selection: { kind: "tier", tier: "balanced" },
				value: "balanced",
				label: "Balanced · Anthropic",
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
				label: "Anthropic · Claude Sonnet 4.6",
			},
		]);
	});

	test("builds exact-model options from the selected provider while keeping global tiers", () => {
		const options = buildSessionSelectionOptions(
			makeStatus({
				model: "claude-sonnet-4-6",
				availableModels: [],
			}),
			makeSettings(),
			"openrouter-main",
		);
		expect(options.map((option) => option.label)).toEqual([
			"Default · claude-sonnet-4-6",
			"Best · OpenRouter",
			"Balanced · Anthropic",
			"OpenRouter · GPT-4.1",
		]);
	});

	test("renders provider-aware selector when settings provide explicit models", () => {
		const status = makeStatus({
			availableModels: ["best", "balanced", "fast", "claude-sonnet-4-6", "gpt-4.1"],
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
		expect(html).toContain("Anthropic · Claude Sonnet 4.6");
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

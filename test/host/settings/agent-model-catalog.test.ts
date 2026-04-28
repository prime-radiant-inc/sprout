import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAgentModelCatalog,
	describeAgentModels,
} from "../../../src/host/settings/agent-model-catalog.ts";
import { createEmptyModelConfigOverrides } from "../../../src/host/settings/model-overrides.ts";
import { createEmptySettings } from "../../../src/host/settings/types.ts";

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) {
		await rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("agent model catalog", () => {
	test("discovers root and tree agent model keys", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-agent-model-catalog-"));
		await writeAgentRoot(tempDir);

		const catalog = await buildAgentModelCatalog({ rootDir: tempDir });

		expect(catalog.map((entry) => entry.key)).toEqual(["metacognitive", "root", "utility/reader"]);
		expect(catalog.find((entry) => entry.key === "root")).toMatchObject({
			name: "root",
			source: "root",
			defaultModel: "best",
		});
		expect(catalog.find((entry) => entry.key === "utility/reader")).toMatchObject({
			name: "reader",
			source: "tree",
			defaultModel: "fast",
		});
	});

	test("describes effective stored and env agent overrides without fallback", async () => {
		const settings = {
			...createEmptySettings(),
			providers: [
				{
					id: "anthropic",
					kind: "anthropic" as const,
					label: "Anthropic",
					enabled: true,
					createdAt: "2026-04-28T00:00:00.000Z",
					updatedAt: "2026-04-28T00:00:00.000Z",
				},
			],
			defaults: {
				balanced: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
				},
			},
			agentModelOverrides: {
				metacognitive: {
					kind: "tier" as const,
					tier: "balanced" as const,
				},
			},
		};
		const modelOverrides = createEmptyModelConfigOverrides();
		modelOverrides.agentModelOverrides["utility/reader"] = {
			source: "env",
			envVar: "SPROUT_AGENT_MODEL_OVERRIDES",
			selection: {
				kind: "model",
				model: {
					providerId: "anthropic",
					modelId: "claude-haiku-4-5",
				},
			},
		};

		const described = describeAgentModels({
			catalog: [
				{
					key: "metacognitive",
					name: "metacognitive",
					source: "tree",
					path: "metacognitive",
					defaultModel: "fast",
				},
				{
					key: "utility/reader",
					name: "reader",
					source: "tree",
					path: "utility/reader",
					defaultModel: "fast",
				},
			],
			settings,
			modelOverrides,
			resolverSettings: {
				providers: [{ id: "anthropic", enabled: true }],
				defaults: settings.defaults,
				memoryModels: settings.memoryModels,
				agentModelOverrides: {
					...settings.agentModelOverrides,
					"utility/reader": modelOverrides.agentModelOverrides["utility/reader"]!.selection,
				},
			},
			providerCatalog: [
				{
					providerId: "anthropic",
					models: [
						{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "remote" },
						{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", source: "remote" },
					],
				},
			],
		});

		expect(described.find((entry) => entry.key === "metacognitive")).toMatchObject({
			storedOverride: { kind: "tier", tier: "balanced" },
			effective: {
				selection: "tier",
				label: "balanced",
				model: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
			},
		});
		expect(described.find((entry) => entry.key === "utility/reader")).toMatchObject({
			runtimeOverride: {
				envVar: "SPROUT_AGENT_MODEL_OVERRIDES",
				selection: {
					kind: "model",
					model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
				},
			},
			effective: {
				selection: "model",
				label: "anthropic:claude-haiku-4-5",
				model: { providerId: "anthropic", modelId: "claude-haiku-4-5" },
			},
		});
	});
});

async function writeAgentRoot(rootDir: string): Promise<void> {
	await mkdir(join(rootDir, "agents", "utility", "agents"), { recursive: true });
	await writeFile(
		join(rootDir, "root.md"),
		frontmatter({
			name: "root",
			description: "Root agent",
			model: "best",
		}),
	);
	await writeFile(
		join(rootDir, "agents", "metacognitive.md"),
		frontmatter({
			name: "metacognitive",
			description: "Observer",
			model: "balanced",
		}),
	);
	await writeFile(
		join(rootDir, "agents", "utility", "agents", "reader.md"),
		frontmatter({
			name: "reader",
			description: "Reader",
			model: "fast",
		}),
	);
}

function frontmatter(input: { name: string; description: string; model: string }): string {
	return `---
name: ${input.name}
description: ${input.description}
model: ${input.model}
tools: []
agents: []
constraints:
  max_turns: 1
  timeout_ms: 1000
  can_spawn: false
  can_learn: false
tags: []
version: 1
---
Prompt.
`;
}

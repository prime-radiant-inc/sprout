import { describe, expect, test } from "bun:test";
import { buildAtifMetrics } from "../../../src/host/atif/costs.ts";
import type { PricingSnapshot } from "../../../src/host/pricing-cache.ts";

describe("buildAtifMetrics", () => {
	test("calculates prompt, cached, and completion cost from a pricing snapshot", () => {
		const snapshot: PricingSnapshot = {
			source: "live",
			fetchedAt: "2026-03-14T12:00:00.000Z",
			upstreams: ["llm-prices"],
			table: [["gpt-4o", { input: 2.5, output: 10, cached_input: 1.25 }]],
		};

		const metrics = buildAtifMetrics({
			providerId: "openai",
			modelId: "gpt-4o",
			usage: {
				input_tokens: 1200,
				output_tokens: 300,
				total_tokens: 1500,
				cache_read_tokens: 200,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.prompt_tokens).toBe(1200);
		expect(metrics?.completion_tokens).toBe(300);
		expect(metrics?.cached_tokens).toBe(200);
		expect(metrics?.cost_usd).toBeCloseTo(0.00575, 8);
		expect(metrics?.extra?.pricing_snapshot).toEqual({
			source: "live",
			fetched_at: "2026-03-14T12:00:00.000Z",
			upstreams: ["llm-prices"],
		});
	});

	test("matches openrouter pricing against stripped and full model ids", () => {
		const snapshot: PricingSnapshot = {
			source: "live",
			fetchedAt: "2026-03-14T12:00:00.000Z",
			upstreams: ["openrouter"],
			table: [["claude-sonnet-4-6", { input: 3, output: 15 }]],
		};

		const metrics = buildAtifMetrics({
			providerId: "openrouter",
			modelId: "anthropic/claude-sonnet-4-6",
			usage: {
				input_tokens: 1_000,
				output_tokens: 500,
				total_tokens: 1_500,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.cost_usd).toBeCloseTo(0.0105, 8);
	});

	test("preserves provider-specific usage dimensions in metrics.extra", () => {
		const snapshot: PricingSnapshot = {
			source: "cache",
			fetchedAt: "2026-03-14T12:00:00.000Z",
			upstreams: ["openrouter", "llm-prices"],
			table: [["claude-sonnet-4-6", { input: 3, output: 15 }]],
		};

		const metrics = buildAtifMetrics({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
			usage: {
				input_tokens: 600,
				output_tokens: 150,
				total_tokens: 750,
				cache_read_tokens: 100,
				cache_write_tokens: 250,
				reasoning_tokens: 75,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.extra?.reasoning_tokens).toBe(75);
		expect(metrics?.extra?.cache_write_tokens).toBe(250);
	});
});

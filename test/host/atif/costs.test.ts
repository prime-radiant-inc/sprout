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
				input_tokens: 1000,
				output_tokens: 300,
				total_tokens: 1500,
				cache_read_tokens: 200,
				total_input_tokens: 1200,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.prompt_tokens).toBe(1000);
		expect(metrics?.completion_tokens).toBe(300);
		expect(metrics?.cached_tokens).toBe(200);
		expect(metrics?.total_input_tokens).toBe(1200);
		expect(metrics?.cost_usd).toBeCloseTo(0.00575, 8);
		expect(metrics?.extra?.cost_breakdown_usd).toEqual({
			regular_input_cost_usd: 0.0025,
			cache_read_cost_usd: 0.00025,
			cache_write_5m_cost_usd: 0,
			cache_write_1h_cost_usd: 0,
			output_cost_usd: 0.003,
		});
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
				total_tokens: 1000,
				cache_read_tokens: 100,
				cache_write_tokens: 250,
				cache_write_5m_tokens: 200,
				cache_write_1h_tokens: 50,
				total_input_tokens: 850,
				reasoning_tokens: 75,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.cost_usd).toBeCloseTo(0.00513, 8);
		expect(metrics?.cache_write_tokens).toBe(250);
		expect(metrics?.total_input_tokens).toBe(850);
		expect(metrics?.extra?.reasoning_tokens).toBe(75);
		const breakdown = metrics?.extra?.cost_breakdown_usd as Record<string, number>;
		expect(breakdown.regular_input_cost_usd).toBeCloseTo(0.0018, 8);
		expect(breakdown.cache_read_cost_usd).toBeCloseTo(0.00003, 8);
		expect(breakdown.cache_write_5m_cost_usd).toBeCloseTo(0.00075, 8);
		expect(breakdown.cache_write_1h_cost_usd).toBeCloseTo(0.0003, 8);
		expect(breakdown.output_cost_usd).toBeCloseTo(0.00225, 8);
	});

	test("marks cost partial when cache write tokens have no TTL bucket", () => {
		const snapshot: PricingSnapshot = {
			source: "cache",
			fetchedAt: "2026-03-14T12:00:00.000Z",
			upstreams: ["llm-prices"],
			table: [["custom-model", { input: 2, output: 4 }]],
		};

		const metrics = buildAtifMetrics({
			providerId: "custom",
			modelId: "custom-model",
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				total_tokens: 20,
				cache_write_tokens: 5,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.cache_write_tokens).toBe(5);
		expect(metrics?.cost_usd).toBeCloseTo(0.00004, 8);
		expect(metrics?.extra?.cost_partial).toBe(true);
		expect(metrics?.extra?.cost_partial_reasons).toEqual(["cache_write_tokens_missing_ttl_bucket"]);
	});

	test("does not apply public pricing snapshots to local openai-compatible providers", () => {
		const snapshot: PricingSnapshot = {
			source: "live",
			fetchedAt: "2026-05-01T12:00:00.000Z",
			upstreams: ["llm-prices"],
			table: [["qwen3.6-35b-a3b", { input: 3, output: 6 }]],
		};

		const metrics = buildAtifMetrics({
			providerId: "llamacpp",
			modelId: "qwen3.6-35b-a3b",
			usage: {
				input_tokens: 10_000,
				output_tokens: 2_000,
				total_tokens: 12_000,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.prompt_tokens).toBe(10_000);
		expect(metrics?.completion_tokens).toBe(2_000);
		expect(metrics?.cost_usd).toBeUndefined();
		expect(metrics?.extra?.cost_pricing_source).toBeUndefined();
		expect(metrics?.extra?.cost_breakdown_usd).toBeUndefined();
	});

	test("falls back to built-in pricing when a live snapshot lacks the model alias", () => {
		const snapshot: PricingSnapshot = {
			source: "live",
			fetchedAt: "2026-03-14T12:00:00.000Z",
			upstreams: ["openrouter", "llm-prices"],
			table: [["unrelated-model", { input: 9, output: 9 }]],
		};

		const metrics = buildAtifMetrics({
			providerId: "anthropic",
			modelId: "claude-haiku-4-5-20251001",
			usage: {
				input_tokens: 1_000,
				output_tokens: 500,
				total_tokens: 1_600,
				cache_write_tokens: 100,
				cache_write_5m_tokens: 100,
				total_input_tokens: 1_100,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.cost_usd).toBeCloseTo(0.003625, 8);
		expect(metrics?.extra?.cost_pricing_source).toBe("fallback");
	});

	test("uses dotted Opus semantic pricing for hyphenated model ids", () => {
		const snapshot: PricingSnapshot = {
			source: "live",
			fetchedAt: "2026-05-01T18:18:44.325Z",
			upstreams: ["openrouter", "llm-prices"],
			table: [
				[
					"claude-opus-4.7",
					{
						input: 5,
						output: 25,
						cached_input: 0.5,
						cache_write_5m: 6.25,
						cache_write_1h: 10,
					},
				],
				[
					"claude-opus-4",
					{
						input: 15,
						output: 75,
						cached_input: 1.5,
						cache_write_5m: 18.75,
						cache_write_1h: 30,
					},
				],
			],
		};

		const metrics = buildAtifMetrics({
			providerId: "anthropic",
			modelId: "claude-opus-4-7",
			usage: {
				input_tokens: 711,
				output_tokens: 1_373,
				total_tokens: 9_490,
				cache_write_tokens: 7_406,
				cache_write_5m_tokens: 7_406,
				total_input_tokens: 8_117,
			},
			pricingSnapshot: snapshot,
		});

		expect(metrics?.cost_usd).toBeCloseTo(0.0841675, 8);
		expect(metrics?.extra?.cost_pricing_source).toBe("snapshot");
	});

	test("falls back to the litellm-generated table for a model the hand-curated table lacks", () => {
		// claude-opus-4-8 is not in the hand-curated FALLBACK_PRICING_TABLE (see
		// pricing.test.ts), so pricing this with no live snapshot proves the
		// litellm-generated table is actually wired into the fallback path.
		const metrics = buildAtifMetrics({
			providerId: "anthropic",
			modelId: "claude-opus-4-8",
			usage: {
				input_tokens: 1_000,
				output_tokens: 500,
				total_tokens: 1_500,
			},
			pricingSnapshot: null,
		});

		expect(metrics?.extra?.cost_pricing_source).toBe("fallback");
		expect(metrics?.cost_usd).toBeGreaterThan(0);
	});
});

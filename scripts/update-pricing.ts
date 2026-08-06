// Regenerates src/generated/litellm-pricing.ts from LiteLLM's published pricing
// database. Run this periodically to pick up new/renamed models.
//
// Usage: bun scripts/update-pricing.ts

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LiteLLMEntry } from "../src/kernel/pricing.ts";
import { transformLiteLLMPrices } from "../src/kernel/pricing.ts";

const LITELLM_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const repoRoot = join(import.meta.dir, "..");

async function main(): Promise<void> {
	console.log(`Fetching ${LITELLM_URL} ...`);
	const resp = await fetch(LITELLM_URL);
	if (!resp.ok) {
		throw new Error(`Failed to fetch LiteLLM pricing data: HTTP ${resp.status}`);
	}
	const raw = (await resp.json()) as Record<string, LiteLLMEntry>;

	const table = transformLiteLLMPrices(raw).sort(([a], [b]) => a.localeCompare(b));
	console.log(`Transformed ${table.length} pricing entries.`);

	const outputPath = join(repoRoot, "src", "generated", "litellm-pricing.ts");
	const lines = [
		"// Generated file — do not edit by hand.",
		`// Source: ${LITELLM_URL}`,
		"// Regenerate via: bun scripts/update-pricing.ts",
		"//",
		"// Kept self-contained (no imports from src/kernel) so this file can't form an",
		"// import cycle with kernel/pricing.ts, which imports LITELLM_PRICING_TABLE from here.",
		"interface LiteLLMPricingEntry {",
		"\tinput: number;",
		"\toutput: number;",
		"\tcached_input?: number;",
		"\tcache_write_5m?: number;",
		"\tcache_write_1h?: number;",
		"}",
		"",
		"export const LITELLM_PRICING_TABLE: [string, LiteLLMPricingEntry][] = [",
		...table.map(([id, pricing]) => `\t${JSON.stringify([id, pricing])},`),
		"];",
		"",
	];

	await mkdir(join(repoRoot, "src", "generated"), { recursive: true });
	await writeFile(outputPath, lines.join("\n"));
	await run([join(repoRoot, "node_modules", ".bin", "biome"), "format", "--write", outputPath]);
	console.log(`Wrote ${outputPath}`);
}

async function run(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
	}
}

await main();

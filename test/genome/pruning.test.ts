import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome, git } from "../../src/genome/genome.ts";
import type { RoutingRule } from "../../src/kernel/types.ts";

function makeRule(overrides: Partial<RoutingRule> = {}): RoutingRule {
	return {
		id: overrides.id ?? `rule-${Date.now()}`,
		condition: overrides.condition ?? "typescript error",
		preference: overrides.preference ?? "code-editor",
		strength: overrides.strength ?? 0.8,
		source: overrides.source ?? "test",
	};
}

describe("Genome pruning", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-pruning-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	describe("pruneUnusedRoutingRules", () => {
		test("removes rules not in the used set", async () => {
			const root = join(tempDir, "prune-rules");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(makeRule({ id: "used-rule", condition: "typescript" }));
			await genome.addRoutingRule(makeRule({ id: "unused-rule", condition: "python" }));
			await genome.addRoutingRule(makeRule({ id: "also-used", condition: "rust" }));

			const usedIds = new Set(["used-rule", "also-used"]);
			const removed = await genome.pruneUnusedRoutingRules(usedIds);

			expect(removed).toEqual(["unused-rule"]);
			const remaining = genome.allRoutingRules();
			expect(remaining).toHaveLength(2);
			expect(remaining.map((r) => r.id)).toContain("used-rule");
			expect(remaining.map((r) => r.id)).toContain("also-used");
		});

		test("commits when rules are pruned", async () => {
			const root = join(tempDir, "prune-rules-commit");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(makeRule({ id: "dead-rule", condition: "cobol" }));

			const removed = await genome.pruneUnusedRoutingRules(new Set());
			expect(removed).toEqual(["dead-rule"]);

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: prune 1 unused routing rules");

			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
		});

		test("returns empty array and does not commit when all rules are used", async () => {
			const root = join(tempDir, "prune-rules-none");
			const genome = new Genome(root);
			await genome.init();

			await genome.addRoutingRule(makeRule({ id: "active-1", condition: "go" }));
			await genome.addRoutingRule(makeRule({ id: "active-2", condition: "java" }));

			const commitCountBefore = (await git(root, "log", "--oneline")).split("\n").length;

			const removed = await genome.pruneUnusedRoutingRules(new Set(["active-1", "active-2"]));
			expect(removed).toEqual([]);

			const commitCountAfter = (await git(root, "log", "--oneline")).split("\n").length;
			expect(commitCountAfter).toBe(commitCountBefore);
		});
	});
});

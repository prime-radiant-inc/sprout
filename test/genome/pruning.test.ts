import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Genome, git } from "../../src/genome/genome.ts";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import { MemoryIndex } from "../../src/genome/memory-index.ts";
import type { Memory, RoutingRule } from "../../src/kernel/types.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: overrides.id ?? `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		content: overrides.content ?? "default memory content",
		tags: overrides.tags ?? ["default"],
		source: overrides.source ?? "test",
		created: overrides.created ?? Date.now(),
		last_used: overrides.last_used ?? Date.now(),
		use_count: overrides.use_count ?? 0,
		confidence: overrides.confidence ?? 1.0,
	};
}

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

	describe("pruneMemories", () => {
		test("removes memories below effective confidence threshold", async () => {
			const root = join(tempDir, "prune-confidence");
			const genome = createTestGenome(root);
			await genome.init();

			const ninetyDaysAgo = Date.now() - 90 * 86400000;
			await genome.addMemory(
				makeMemory({
					id: "old-mem",
					content: "stale fact",
					last_used: ninetyDaysAgo,
					created: ninetyDaysAgo,
					use_count: 1,
					confidence: 0.8, // effective: 0.8 * 0.5^(90/30) = 0.8 * 0.125 = 0.1
				}),
			);

			await genome.addMemory(
				makeMemory({
					id: "fresh-mem",
					content: "fresh fact",
					use_count: 1,
					confidence: 0.8, // effective: ~0.8 (just created)
				}),
			);

			const pruned = await genome.pruneMemories(0.2);
			expect(pruned).toContain("old-mem");
			expect(pruned).not.toContain("fresh-mem");

			// Verify the old memory is actually gone from the store
			expect(genome.memories.getById("old-mem")).toBeUndefined();
			expect(genome.memories.getById("fresh-mem")).toBeDefined();
		});

		test("commits when memories are pruned", async () => {
			const root = join(tempDir, "prune-commit");
			const genome = createTestGenome(root);
			await genome.init();

			const ninetyDaysAgo = Date.now() - 90 * 86400000;
			await genome.addMemory(
				makeMemory({
					id: "stale-1",
					content: "old info",
					last_used: ninetyDaysAgo,
					created: ninetyDaysAgo,
					use_count: 1,
					confidence: 0.5, // effective: 0.5 * 0.125 = 0.0625
				}),
			);

			await genome.pruneMemories(0.2);

			const log = await git(root, "log", "--oneline");
			expect(log).toContain("genome: prune 1 low-confidence memories");

			// Git status should be clean
			const status = await git(root, "status", "--porcelain");
			expect(status).toBe("");
		}, 15_000);

		test("removes surviving links that reference pruned memories", async () => {
			const root = join(tempDir, "prune-linked-memory");
			const genome = createTestGenome(root);
			await genome.init();
			const ninetyDaysAgo = Date.now() - 90 * 86400000;
			await genome.addMemory({
				...makeMemory({
					id: "stale-superseding-memory",
					content: "Stale replacement fact",
					last_used: ninetyDaysAgo,
					created: ninetyDaysAgo,
					use_count: 1,
					confidence: 0.5,
				}),
				outbound_links: [
					{
						uuid: "surviving-memory",
						type: "supersedes",
						reasoning: "old replacement",
						created_at: 1,
					},
				],
			});
			await genome.addMemory({
				...makeMemory({ id: "surviving-memory", content: "Recoverable target fact" }),
				superseded_by: "stale-superseding-memory",
				inbound_links: [
					{
						uuid: "stale-superseding-memory",
						type: "supersedes",
						reasoning: "old replacement",
						created_at: 1,
					},
				],
			});

			const pruned = await genome.pruneMemories(0.2);

			expect(pruned).toEqual(["stale-superseding-memory"]);
			expect(genome.memories.getById("surviving-memory")?.superseded_by).toBeUndefined();
			expect(genome.memories.getById("surviving-memory")?.inbound_links).toEqual([]);
			expect(
				(await genome.searchMemories("Recoverable target", 1)).map((memory) => memory.id),
			).toEqual(["surviving-memory"]);
		}, 15_000);

		test("restores JSONL and index when prune commit fails after rebuild", async () => {
			const root = join(tempDir, "prune-commit-fails");
			const genome = createTestGenome(root);
			await genome.init();

			const ninetyDaysAgo = Date.now() - 90 * 86400000;
			await genome.addMemory(
				makeMemory({
					id: "stale-commit-fail",
					content: "old info",
					last_used: ninetyDaysAgo,
					created: ninetyDaysAgo,
					use_count: 1,
					confidence: 0.5,
				}),
			);
			await genome.addMemory(makeMemory({ id: "fresh-commit-fail", content: "fresh info" }));
			const before = await readFile(join(root, "memories", "memories.jsonl"), "utf-8");
			const hookPath = join(root, ".git", "hooks", "pre-commit");
			await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
			await chmod(hookPath, 0o755);

			await expect(genome.pruneMemories(0.2)).rejects.toThrow("git commit");

			expect(genome.memories.getById("stale-commit-fail")).toBeDefined();
			expect(await readFile(join(root, "memories", "memories.jsonl"), "utf-8")).toBe(before);
			expect(await git(root, "status", "--porcelain")).toBe("");
			const index = MemoryIndex.open(memoryIndexPath(root));
			try {
				expect(index.stats().memoryCount).toBe(2);
			} finally {
				index.close();
			}
		}, 15_000);

		test("returns empty array and does not commit when nothing to prune", async () => {
			const root = join(tempDir, "prune-nothing");
			const genome = createTestGenome(root);
			await genome.init();

			await genome.addMemory(
				makeMemory({
					id: "keeper",
					content: "important fact",
					confidence: 0.9,
				}),
			);

			const commitCountBefore = (await git(root, "log", "--oneline")).split("\n").length;

			const pruned = await genome.pruneMemories(0.2);
			expect(pruned).toEqual([]);

			const commitCountAfter = (await git(root, "log", "--oneline")).split("\n").length;
			expect(commitCountAfter).toBe(commitCountBefore);
		});

		test("uses default threshold of 0.2 when no argument provided", async () => {
			const root = join(tempDir, "prune-default");
			const genome = createTestGenome(root);
			await genome.init();

			const ninetyDaysAgo = Date.now() - 90 * 86400000;
			await genome.addMemory(
				makeMemory({
					id: "barely-stale",
					content: "borderline info",
					last_used: ninetyDaysAgo,
					created: ninetyDaysAgo,
					use_count: 1,
					confidence: 0.8, // effective: 0.1, below default 0.2
				}),
			);

			const pruned = await genome.pruneMemories();
			expect(pruned).toContain("barely-stale");
		});
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

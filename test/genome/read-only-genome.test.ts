import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Genome } from "../../src/genome/genome.ts";
import { memoryIndexPath } from "../../src/genome/index-builder.ts";
import { createReadOnlyGenome } from "../../src/genome/read-only-genome.ts";
import type { MemorySegment } from "../../src/genome/segments.ts";
import { createTestGenome } from "../helpers/test-genome.ts";

describe("createReadOnlyGenome", () => {
	let tempDir: string;
	let genome: Genome;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-read-only-genome-"));
		genome = createTestGenome(tempDir);
		await genome.init();
		await genome.addAgent({
			name: "reader",
			description: "Read files",
			system_prompt: "Read files.",
			model: "fast",
			tools: ["read_file"],
			agents: [],
			constraints: {
				max_turns: 5,
				timeout_ms: 30_000,
				can_spawn: false,
				can_learn: false,
			},
			tags: ["test"],
			version: 1,
		});
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("preserves read access", () => {
		const readOnlyGenome = createReadOnlyGenome(genome);
		expect(readOnlyGenome.getAgent("reader")?.description).toBe("Read files");
	});

	test("rejects mutation methods", async () => {
		const readOnlyGenome = createReadOnlyGenome(genome);

		await expect(
			readOnlyGenome.updateAgent({
				name: "reader",
				description: "Mutated",
				system_prompt: "Read files.",
				model: "fast",
				tools: ["read_file"],
				agents: [],
				constraints: {
					max_turns: 5,
					timeout_ms: 30_000,
					can_spawn: false,
					can_learn: false,
				},
				tags: ["test"],
				version: 1,
			}),
		).rejects.toThrow("read-only genome");
	});

	test("rejects memory and segment mutation methods", async () => {
		const readOnlyGenome = createReadOnlyGenome(genome);
		const memory = {
			id: "memory-read-only",
			content: "readonly",
			tags: [],
			source: "test",
			created: 1,
			last_used: 1,
			use_count: 0,
			confidence: 1,
		};
		const segment: MemorySegment = {
			id: "segment-read-only",
			session_id: "session-read-only",
			summary: "readonly segment",
			title: "Read-only",
			started_at: 1,
			ended_at: 1,
			created_at: 1,
			message_count: 1,
			project_id: "sprout",
			project_confidence: 1,
			complexity: 1,
			source: "session-collapse",
		};

		await expect(readOnlyGenome.addMemory(memory)).rejects.toThrow("read-only genome");
		await expect(readOnlyGenome.addMemories([memory], "blocked")).rejects.toThrow(
			"read-only genome",
		);
		await expect(readOnlyGenome.stageMemoryForMutation(memory)).rejects.toThrow("read-only genome");
		await expect(readOnlyGenome.saveMemoryMutation("blocked")).rejects.toThrow("read-only genome");
		await expect(readOnlyGenome.addSegment(segment)).rejects.toThrow("read-only genome");
		await expect(readOnlyGenome.addSegmentWithMemories(segment, [memory])).rejects.toThrow(
			"read-only genome",
		);
		await expect(
			readOnlyGenome.addExtractedMemoriesWithRelationships({
				segment,
				memories: [memory],
				classifyRelationships: async () => [],
			}),
		).rejects.toThrow("read-only genome");
		expect(() => readOnlyGenome.memories.stage(memory)).toThrow("read-only genome");
		expect(() => readOnlyGenome.memories.mergeLatestFromDisk()).toThrow("read-only genome");
		expect(() => readOnlyGenome.segments.add(segment)).toThrow("read-only genome");
		expect(() => readOnlyGenome.segments.stage(segment)).toThrow("read-only genome");
	});

	test("rejects project and operational memory mutations", async () => {
		const readOnlyGenome = createReadOnlyGenome(genome);
		const project = { id: "sprout", name: "Sprout", confidence: 1, source: "explicit" as const };

		await expect(readOnlyGenome.recordProjectActivity(project)).rejects.toThrow("read-only genome");
		await expect(readOnlyGenome.saveProjectActivityMutation("blocked")).rejects.toThrow(
			"read-only genome",
		);
		await expect(readOnlyGenome.recomputeMemoryScores()).rejects.toThrow("read-only genome");
		await expect(readOnlyGenome.recordMemoryMentions(["mem_abc1234"])).rejects.toThrow(
			"read-only genome",
		);
		expect(() => readOnlyGenome.projects.recordActiveDay(project, new Date())).toThrow(
			"read-only genome",
		);
		expect(() => readOnlyGenome.projects.markConsolidated("sprout")).toThrow("read-only genome");
		expect(() => readOnlyGenome.projects.markEntityGc("sprout")).toThrow("read-only genome");
		expect(() => readOnlyGenome.projects.mergeLatestFromDisk()).toThrow("read-only genome");
		expect(() =>
			readOnlyGenome.projects.upsertMaintenanceRecord({
				id: "sprout",
				name: "Sprout",
				cumulative_active_days: 1,
			}),
		).toThrow("read-only genome");
	});

	test("searchMemories does not rebuild a missing derived index", async () => {
		const now = Date.now();
		await genome.addMemory({
			id: "memory-readonly-search",
			content: "Read-only search should not rebuild the memory index.",
			tags: ["memory"],
			source: "test",
			created: now,
			last_used: now,
			use_count: 0,
			confidence: 1,
		});
		const indexPath = memoryIndexPath(tempDir);
		await rm(indexPath, { force: true });
		await rm(`${indexPath}-shm`, { force: true });
		await rm(`${indexPath}-wal`, { force: true });
		const readOnlyGenome = createReadOnlyGenome(genome);

		await expect(readOnlyGenome.searchMemories("memory index")).rejects.toThrow("not fresh");

		expect(existsSync(indexPath)).toBe(false);
	});
});

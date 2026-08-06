import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadMemoryConsolidationPrompt,
	loadMemoryEntityGcPrompt,
	loadMemoryExtractionPrompts,
	MEMORY_CONSOLIDATION_PROMPT,
	MEMORY_ENTITY_GC_PROMPT,
	MEMORY_EXTRACTION_SYSTEM_PROMPT,
	MEMORY_EXTRACTION_USER_PROMPT,
	SEGMENT_SUMMARY_USER_PROMPT,
} from "../../src/genome/prompts.ts";

describe("genome prompt loading", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-prompts-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("uses deterministic defaults when prompt files are missing", async () => {
		const prompts = await loadMemoryExtractionPrompts(join(tempDir, "genome"));

		expect(prompts.system).toBe(MEMORY_EXTRACTION_SYSTEM_PROMPT);
		expect(prompts.user).toContain("{formatted_messages}");
	});

	test("default extraction prompt allows root-agent evidence without unsupported speculation", () => {
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("root-agent session evidence");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("tool outcomes");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("delegation outcomes");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("Segment summary context");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("source for new facts");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("Do not store unsupported speculation");
		expect(MEMORY_EXTRACTION_USER_PROMPT).toContain("{segment_summary}");
		expect(SEGMENT_SUMMARY_USER_PROMPT).toContain("{previous_summaries}");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).not.toContain(
			"Extract only from user-authored content",
		);
	});

	test("default extraction prompt tells the model to be compact and selective", () => {
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain(
			"Extract fewer, higher-signal memories rather than exhaustive inventories.",
		);
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("one compact factual sentence");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("one concrete detail");
		expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain("Do not summarize the transcript");
	});

	test("maintenance decision prompts load with defaults and honor overrides", async () => {
		const genomeRoot = join(tempDir, "genome");

		expect(await loadMemoryConsolidationPrompt(genomeRoot)).toBe(MEMORY_CONSOLIDATION_PROMPT);
		expect(await loadMemoryEntityGcPrompt(genomeRoot)).toBe(MEMORY_ENTITY_GC_PROMPT);

		await mkdir(join(genomeRoot, "prompts"), { recursive: true });
		await writeFile(
			join(genomeRoot, "prompts", "memory_consolidation.txt"),
			"genome consolidation",
		);
		await writeFile(join(genomeRoot, "prompts", "memory_entity_gc.txt"), "genome entity gc");

		expect(await loadMemoryConsolidationPrompt(genomeRoot)).toBe("genome consolidation");
		expect(await loadMemoryEntityGcPrompt(genomeRoot)).toBe("genome entity gc");
	});

	test("default entity GC prompt is conservative and pins the output contract", () => {
		expect(MEMORY_ENTITY_GC_PROMPT).toContain("When unsure, reject");
		expect(MEMORY_ENTITY_GC_PROMPT).toContain('"action": "merge"');
		expect(MEMORY_ENTITY_GC_PROMPT).toContain('"action": "reject"');
		expect(MEMORY_ENTITY_GC_PROMPT).toContain('"canonical"');
		expect(MEMORY_ENTITY_GC_PROMPT).toContain('"aliases"');
		expect(MEMORY_ENTITY_GC_PROMPT).toContain("Never invent or rename");
		expect(MEMORY_ENTITY_GC_PROMPT).toContain("only valid JSON");
	});

	test("prefers genome prompt files over root prompt files", async () => {
		const genomeRoot = join(tempDir, "genome");
		const rootDir = join(tempDir, "root");
		await mkdir(join(genomeRoot, "prompts"), { recursive: true });
		await mkdir(join(rootDir, "prompts"), { recursive: true });
		await writeFile(join(rootDir, "prompts", "memory_extraction_system.txt"), "root system");
		await writeFile(join(genomeRoot, "prompts", "memory_extraction_system.txt"), "genome system");

		const prompts = await loadMemoryExtractionPrompts(genomeRoot, rootDir);

		expect(prompts.system).toBe("genome system");
	});

	test("uses root prompt files when genome prompt files are missing", async () => {
		const genomeRoot = join(tempDir, "genome");
		const rootDir = join(tempDir, "root");
		await mkdir(join(rootDir, "prompts"), { recursive: true });
		await writeFile(join(rootDir, "prompts", "memory_extraction_user.txt"), "root user");

		const prompts = await loadMemoryExtractionPrompts(genomeRoot, rootDir);

		expect(prompts.user).toBe("root user");
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadMemoryExtractionPrompts,
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

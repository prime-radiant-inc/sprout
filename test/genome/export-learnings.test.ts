import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { exportLearnings, stageLearnings } from "../../src/genome/export-learnings.ts";
import { Genome, serializeAgentSpec } from "../../src/genome/genome.ts";
import { makeSpec } from "../helpers/make-spec.ts";

describe("exportLearnings", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-export-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("identifies agents that evolved beyond their bootstrap version", async () => {
		const genomeDir = join(tempDir, "export-evolved");
		const rootDir = join(tempDir, "export-evolved-boot");
		await mkdir(rootDir, { recursive: true });

		await writeFile(
			join(rootDir, "reader.yaml"),
			serializeAgentSpec(makeSpec({ name: "reader", system_prompt: "basic reader" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromRoot(rootDir);
		await genome.updateAgent(
			makeSpec({ name: "reader", system_prompt: "improved reader with batching" }),
		);

		const result = await exportLearnings(genomeDir, rootDir);

		expect(result.evolved).toHaveLength(1);
		expect(result.evolved[0]!.name).toBe("reader");
		expect(result.evolved[0]!.genomeVersion).toBe(2);
		expect(result.evolved[0]!.rootVersion).toBe(1);
	});

	test("identifies agents that exist only in genome", async () => {
		const genomeDir = join(tempDir, "export-learned");
		const rootDir = join(tempDir, "export-learned-boot");
		await mkdir(rootDir, { recursive: true });

		await writeFile(join(rootDir, "root.yaml"), serializeAgentSpec(makeSpec({ name: "root" })));

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromRoot(rootDir);
		await genome.addAgent(makeSpec({ name: "specialist", description: "learned specialist" }));

		const result = await exportLearnings(genomeDir, rootDir);

		expect(result.genomeOnly).toHaveLength(1);
		expect(result.genomeOnly[0]!.name).toBe("specialist");
	});

	test("does not report agents still at bootstrap version", async () => {
		const genomeDir = join(tempDir, "export-unchanged");
		const rootDir = join(tempDir, "export-unchanged-boot");
		await mkdir(rootDir, { recursive: true });

		await writeFile(join(rootDir, "stable.yaml"), serializeAgentSpec(makeSpec({ name: "stable" })));

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromRoot(rootDir);

		const result = await exportLearnings(genomeDir, rootDir);

		expect(result.evolved).toHaveLength(0);
		expect(result.genomeOnly).toHaveLength(0);
	});

	test("throws when genome path does not exist", async () => {
		const nonexistent = join(tempDir, "no-such-genome");
		const rootDir = join(tempDir, "noexist-boot");
		await mkdir(rootDir, { recursive: true });
		await writeFile(join(rootDir, "root.yaml"), serializeAgentSpec(makeSpec({ name: "root" })));

		await expect(exportLearnings(nonexistent, rootDir)).rejects.toThrow(/does not exist/);
	});
});

describe("stageLearnings", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-stage-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("writes evolved agent markdown to staging directory", async () => {
		const genomeDir = join(tempDir, "stage-evolved");
		const rootDir = join(tempDir, "stage-evolved-boot");
		await mkdir(rootDir, { recursive: true });

		await writeFile(
			join(rootDir, "reader.yaml"),
			serializeAgentSpec(makeSpec({ name: "reader", system_prompt: "basic reader" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromRoot(rootDir);
		await genome.updateAgent(
			makeSpec({ name: "reader", system_prompt: "improved reader with batching" }),
		);

		const result = await exportLearnings(genomeDir, rootDir);
		const stagingDir = join(tempDir, "staging-evolved");
		await stageLearnings(result, stagingDir);

		const content = await readFile(join(stagingDir, "reader.md"), "utf-8");
		const parsed = parseAgentMarkdown(content, "reader.md");
		expect(parsed.name).toBe("reader");
		expect(parsed.system_prompt).toBe("improved reader with batching");
		expect(parsed.version).toBe(2);
	});

	test("writes genome-only agent markdown to staging directory", async () => {
		const genomeDir = join(tempDir, "stage-learned");
		const rootDir = join(tempDir, "stage-learned-boot");
		await mkdir(rootDir, { recursive: true });

		await writeFile(join(rootDir, "root.yaml"), serializeAgentSpec(makeSpec({ name: "root" })));

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromRoot(rootDir);
		await genome.addAgent(
			makeSpec({
				name: "specialist",
				description: "learned specialist",
				system_prompt: "I specialize",
			}),
		);

		const result = await exportLearnings(genomeDir, rootDir);
		const stagingDir = join(tempDir, "staging-learned");
		await stageLearnings(result, stagingDir);

		const content = await readFile(join(stagingDir, "specialist.md"), "utf-8");
		const parsed = parseAgentMarkdown(content, "specialist.md");
		expect(parsed.name).toBe("specialist");
		expect(parsed.description).toBe("learned specialist");
	});

	test("creates staging directory if it does not exist", async () => {
		const genomeDir = join(tempDir, "stage-mkdir");
		const rootDir = join(tempDir, "stage-mkdir-boot");
		await mkdir(rootDir, { recursive: true });

		await writeFile(join(rootDir, "root.yaml"), serializeAgentSpec(makeSpec({ name: "root" })));

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromRoot(rootDir);
		await genome.updateAgent(makeSpec({ name: "root", system_prompt: "evolved root" }));

		const result = await exportLearnings(genomeDir, rootDir);
		const stagingDir = join(tempDir, "deep", "nested", "staging");
		await stageLearnings(result, stagingDir);

		const content = await readFile(join(stagingDir, "root.md"), "utf-8");
		expect(content).toContain("evolved root");
	});
});

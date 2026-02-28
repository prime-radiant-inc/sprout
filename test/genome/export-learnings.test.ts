import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { exportLearnings, stageLearnings } from "../../src/genome/export-learnings.ts";
import { Genome, serializeAgentSpec } from "../../src/genome/genome.ts";
import type { AgentSpec } from "../../src/kernel/types.ts";
import { DEFAULT_CONSTRAINTS } from "../../src/kernel/types.ts";

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		name: overrides.name ?? "test-agent",
		description: overrides.description ?? "A test agent",
		system_prompt: overrides.system_prompt ?? "You are a test agent.",
		model: overrides.model ?? "fast",
		capabilities: overrides.capabilities ?? ["read_file"],
		constraints: overrides.constraints ?? { ...DEFAULT_CONSTRAINTS },
		tags: overrides.tags ?? ["test"],
		version: overrides.version ?? 1,
	};
}

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
		const bootstrapDir = join(tempDir, "export-evolved-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "reader.yaml"),
			serializeAgentSpec(makeSpec({ name: "reader", system_prompt: "basic reader" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);
		await genome.updateAgent(
			makeSpec({ name: "reader", system_prompt: "improved reader with batching" }),
		);

		const result = await exportLearnings(genomeDir, bootstrapDir);

		expect(result.evolved).toHaveLength(1);
		expect(result.evolved[0]!.name).toBe("reader");
		expect(result.evolved[0]!.genomeVersion).toBe(2);
		expect(result.evolved[0]!.bootstrapVersion).toBe(1);
	});

	test("identifies agents that exist only in genome", async () => {
		const genomeDir = join(tempDir, "export-learned");
		const bootstrapDir = join(tempDir, "export-learned-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "root.yaml"),
			serializeAgentSpec(makeSpec({ name: "root" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);
		await genome.addAgent(makeSpec({ name: "specialist", description: "learned specialist" }));

		const result = await exportLearnings(genomeDir, bootstrapDir);

		expect(result.genomeOnly).toHaveLength(1);
		expect(result.genomeOnly[0]!.name).toBe("specialist");
	});

	test("does not report agents still at bootstrap version", async () => {
		const genomeDir = join(tempDir, "export-unchanged");
		const bootstrapDir = join(tempDir, "export-unchanged-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "stable.yaml"),
			serializeAgentSpec(makeSpec({ name: "stable" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);

		const result = await exportLearnings(genomeDir, bootstrapDir);

		expect(result.evolved).toHaveLength(0);
		expect(result.genomeOnly).toHaveLength(0);
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

	test("writes evolved agent YAML to staging directory", async () => {
		const genomeDir = join(tempDir, "stage-evolved");
		const bootstrapDir = join(tempDir, "stage-evolved-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "reader.yaml"),
			serializeAgentSpec(makeSpec({ name: "reader", system_prompt: "basic reader" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);
		await genome.updateAgent(
			makeSpec({ name: "reader", system_prompt: "improved reader with batching" }),
		);

		const result = await exportLearnings(genomeDir, bootstrapDir);
		const stagingDir = join(tempDir, "staging-evolved");
		await stageLearnings(genomeDir, result, stagingDir);

		const content = await readFile(join(stagingDir, "reader.yaml"), "utf-8");
		const parsed = parse(content) as { name: string; system_prompt: string; version: number };
		expect(parsed.name).toBe("reader");
		expect(parsed.system_prompt).toBe("improved reader with batching");
		expect(parsed.version).toBe(2);
	});

	test("writes genome-only agent YAML to staging directory", async () => {
		const genomeDir = join(tempDir, "stage-learned");
		const bootstrapDir = join(tempDir, "stage-learned-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "root.yaml"),
			serializeAgentSpec(makeSpec({ name: "root" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);
		await genome.addAgent(
			makeSpec({ name: "specialist", description: "learned specialist", system_prompt: "I specialize" }),
		);

		const result = await exportLearnings(genomeDir, bootstrapDir);
		const stagingDir = join(tempDir, "staging-learned");
		await stageLearnings(genomeDir, result, stagingDir);

		const content = await readFile(join(stagingDir, "specialist.yaml"), "utf-8");
		const parsed = parse(content) as { name: string; description: string };
		expect(parsed.name).toBe("specialist");
		expect(parsed.description).toBe("learned specialist");
	});

	test("creates staging directory if it does not exist", async () => {
		const genomeDir = join(tempDir, "stage-mkdir");
		const bootstrapDir = join(tempDir, "stage-mkdir-boot");
		await mkdir(bootstrapDir, { recursive: true });

		await writeFile(
			join(bootstrapDir, "root.yaml"),
			serializeAgentSpec(makeSpec({ name: "root" })),
		);

		const genome = new Genome(genomeDir);
		await genome.init();
		await genome.initFromBootstrap(bootstrapDir);
		await genome.updateAgent(makeSpec({ name: "root", system_prompt: "evolved root" }));

		const result = await exportLearnings(genomeDir, bootstrapDir);
		const stagingDir = join(tempDir, "deep", "nested", "staging");
		await stageLearnings(genomeDir, result, stagingDir);

		const content = await readFile(join(stagingDir, "root.yaml"), "utf-8");
		expect(content).toContain("evolved root");
	});
});

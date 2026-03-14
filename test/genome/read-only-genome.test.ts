import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyGenome } from "../../src/genome/read-only-genome.ts";
import { Genome } from "../../src/genome/genome.ts";

describe("createReadOnlyGenome", () => {
	let tempDir: string;
	let genome: Genome;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-read-only-genome-"));
		genome = new Genome(tempDir);
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
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgentMarkdown } from "../../src/agents/markdown-loader.ts";
import { Genome } from "../../src/genome/genome.ts";

function makeSpec(
	name: string,
	overrides: Partial<{ act: "tools" | "code"; tools: string[]; can_spawn: boolean }> = {},
) {
	return {
		name,
		description: `${name} agent`,
		system_prompt: "You are a test agent.",
		model: "test-provider:test-model",
		...(overrides.act ? { act: overrides.act } : {}),
		constraints: {
			max_turns: 10,
			timeout_ms: 0,
			can_spawn: overrides.can_spawn ?? false,
			can_learn: false,
		},
		tags: [],
		version: 1,
		tools: overrides.tools ?? ["read_file"],
		agents: [],
	};
}

const VALID_PROGRAM = `---
name: summarize
description: Summarize a log
params:
  - name: log
    type: string
    description: the log value name
spawns:
  - reader
version: 1
---
return bind("summary", args.log);`;

const IMPORT_PROGRAM = `---
name: evil
description: sneaky
---
await import("node:child_process");`;

describe("Genome programs", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "genome-programs-"));
		await mkdir(join(dir, "agents"), { recursive: true });
		await mkdir(join(dir, "memories"), { recursive: true });
		await mkdir(join(dir, "programs"), { recursive: true });
		await writeFile(join(dir, "agents", "keep.md"), serializeAgentMarkdown(makeSpec("keep")));
		Bun.spawnSync(["git", "init"], { cwd: dir });
		Bun.spawnSync(["git", "add", "."], { cwd: dir });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: dir });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("loads a valid program", async () => {
		await writeFile(join(dir, "programs", "summarize.md"), VALID_PROGRAM);
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		const program = genome.getProgram("summarize");
		expect(program?.name).toBe("summarize");
		expect(program?.spawns).toEqual(["reader"]);
		expect(genome.allPrograms().map((p) => p.name)).toEqual(["summarize"]);
	});

	test("bumps generation on load", async () => {
		await writeFile(join(dir, "programs", "summarize.md"), VALID_PROGRAM);
		const genome = new Genome(dir);
		const before = genome.generation;
		await genome.loadFromDisk();
		expect(genome.generation).toBeGreaterThan(before);
	});

	test("rejects a program whose body contains import (not loaded as runnable)", async () => {
		await writeFile(join(dir, "programs", "evil.md"), IMPORT_PROGRAM);
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		expect(genome.getProgram("evil")).toBeUndefined();
		expect(genome.allPrograms().map((p) => p.name)).not.toContain("evil");
	});

	test("addProgram writes, commits, and loads the program into the library", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		await genome.addProgram({
			name: "greet",
			description: "greet",
			params: [],
			spawns: [],
			version: 1,
			body: 'return bind("out", "hi");',
		});
		expect(genome.getProgram("greet")?.name).toBe("greet");
		// Persisted: a fresh genome loads it from disk.
		const reloaded = new Genome(dir);
		await reloaded.loadFromDisk();
		expect(reloaded.getProgram("greet")?.name).toBe("greet");
		const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir });
		expect(log.stdout.toString()).toContain("add program 'greet'");
	});

	test("addProgram rejects a program whose body carries an import", async () => {
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		await expect(
			genome.addProgram({
				name: "evil",
				description: "sneaky",
				params: [],
				spawns: [],
				version: 1,
				body: 'await import("node:child_process");',
			}),
		).rejects.toThrow();
		expect(genome.getProgram("evil")).toBeUndefined();
	});

	test("removeProgram deletes the program file and drops it from the library", async () => {
		await writeFile(join(dir, "programs", "summarize.md"), VALID_PROGRAM);
		Bun.spawnSync(["git", "add", "."], { cwd: dir });
		Bun.spawnSync(["git", "commit", "-m", "add summarize"], { cwd: dir });
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		expect(genome.getProgram("summarize")).toBeDefined();
		await genome.removeProgram("summarize");
		expect(genome.getProgram("summarize")).toBeUndefined();
		const reloaded = new Genome(dir);
		await reloaded.loadFromDisk();
		expect(reloaded.getProgram("summarize")).toBeUndefined();
	});

	test("catches an on-disk code-mode agent spec granting exec at load", async () => {
		// A hand-committed hybrid: act: code but with a real primitive tool grant.
		await writeFile(
			join(dir, "agents", "hybrid.md"),
			serializeAgentMarkdown(
				makeSpec("hybrid", { act: "code", tools: ["cell", "run_command"], can_spawn: true }),
			),
		);
		const genome = new Genome(dir);
		await genome.loadFromDisk();
		expect(genome.getAgent("hybrid")).toBeUndefined();
		// The valid sibling still loads.
		expect(genome.getAgent("keep")).toBeDefined();
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EmbeddedRootBundle, extractEmbeddedRoot } from "../../src/host/embedded-root.ts";

function createBundle(hash: string, rootContent = "# Root\n"): EmbeddedRootBundle {
	return {
		version: "test-version",
		hash,
		files: [
			{
				path: "root.md",
				content: rootContent,
			},
			{
				path: "agents/reader.md",
				content: "# Reader\n",
			},
		],
	};
}

describe("extractEmbeddedRoot", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("writes the embedded files to the cache directory", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "sprout-embedded-root-"));
		tempDirs.push(cacheDir);

		const rootDir = await extractEmbeddedRoot({
			cacheDir,
			bundle: createBundle("hash-a"),
		});

		expect(await readFile(join(rootDir, "root.md"), "utf-8")).toBe("# Root\n");
		expect(await readFile(join(rootDir, "agents", "reader.md"), "utf-8")).toBe("# Reader\n");
	});

	test("reuses an existing extracted bundle when the version and hash match", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "sprout-embedded-root-"));
		tempDirs.push(cacheDir);

		const rootDir = await extractEmbeddedRoot({
			cacheDir,
			bundle: createBundle("hash-a"),
		});
		await writeFile(join(rootDir, "sentinel.txt"), "keep");

		const reusedRootDir = await extractEmbeddedRoot({
			cacheDir,
			bundle: createBundle("hash-a"),
		});

		expect(reusedRootDir).toBe(rootDir);
		expect(await readFile(join(reusedRootDir, "sentinel.txt"), "utf-8")).toBe("keep");
	});

	test("refreshes the extracted files when the embedded hash changes", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "sprout-embedded-root-"));
		tempDirs.push(cacheDir);

		const oldRootDir = await extractEmbeddedRoot({
			cacheDir,
			bundle: createBundle("hash-a", "# Old Root\n"),
		});
		await writeFile(join(oldRootDir, "sentinel.txt"), "remove me");

		const newRootDir = await extractEmbeddedRoot({
			cacheDir,
			bundle: createBundle("hash-b", "# New Root\n"),
		});

		expect(newRootDir).not.toBe(oldRootDir);
		expect(await readFile(join(newRootDir, "root.md"), "utf-8")).toBe("# New Root\n");
		expect(await Bun.file(join(newRootDir, "sentinel.txt")).exists()).toBe(false);
	});

	test("embeds concise execution reporting guidance for delegated workers", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "sprout-embedded-root-"));
		tempDirs.push(cacheDir);

		const rootDir = await extractEmbeddedRoot({ cacheDir });
		const root = await readFile(join(rootDir, "root.md"), "utf-8");
		const workerPreamble = await readFile(join(rootDir, "preambles", "worker.md"), "utf-8");
		const commandRunner = await readFile(
			join(rootDir, "agents", "utility", "agents", "command-runner.md"),
			"utf-8",
		);
		const taskManager = await readFile(
			join(rootDir, "agents", "utility", "agents", "task-manager.md"),
			"utf-8",
		);
		const techLead = await readFile(join(rootDir, "agents", "tech-lead.md"), "utf-8");
		const engineer = await readFile(
			join(rootDir, "agents", "tech-lead", "agents", "engineer.md"),
			"utf-8",
		);

		expect(root).toContain("exact literals like file contents");
		expect(root).toContain('exact content "Welcome to the benchmark webserver"');
		expect(root).toContain("Never move trailing punctuation inside");
		expect(techLead).toContain("operational or system-execution task");
		expect(techLead).toContain("do not force spec-review");
		expect(techLead).toContain("quality-review ceremony");
		expect(techLead).toContain("Do not ask for exact command lists");
		expect(techLead).toContain("exact literals like file contents");
		expect(techLead).toContain('exact content "Welcome to the benchmark webserver"');
		expect(techLead).toContain("Never move trailing punctuation inside");
		expect(workerPreamble).toContain("default to concise findings");
		expect(workerPreamble).toContain("only when the caller explicitly asks for raw output");
		expect(commandRunner).toContain("Do not dump raw command transcripts by default");
		expect(commandRunner).toContain("Group routine environment detection into concise findings");
		expect(commandRunner).toContain("batch related inspection commands");
		expect(commandRunner).toContain("stop probing beneath");
		expect(commandRunner).toContain("dense quoting/escaping");
		expect(commandRunner).toContain("runtime semantics are still wrong");
		expect(commandRunner).toContain("quiet or noninteractive flags");
		expect(commandRunner).toContain("Do not add sudo speculatively");
		expect(commandRunner).toContain("established facts unless");
		expect(commandRunner).toContain("Do not spend turns re-checking");
		expect(commandRunner).toContain("Do not append offers of further help");
		expect(taskManager).toContain("Do not ask the caller what to do next");
		expect(taskManager).toContain("Do not make a follow-up list or get call");
		expect(engineer).toContain("operational or system-execution task");
		expect(engineer).toContain("do not force a TDD or commit workflow");
		expect(engineer).toContain("Do not ask for redundant child-path checks");
		expect(engineer).toContain("first establish decisive prerequisites");
		expect(engineer).toContain("carry those findings forward");
		expect(engineer).toContain("instead of asking another agent to rediscover them");
		expect(engineer).toContain("tell the command-runner explicitly");
		expect(engineer).toContain("exact command names");
		expect(engineer).toContain("generic labels like");
		expect(engineer).toContain("Only ask for exact file contents");
		expect(engineer).toContain("Do not launch dependent config inspection");
		expect(engineer).toContain("shortest exact proof lines");
		expect(engineer).toContain("Do not ask command-runners to enumerate exact commands");
		expect(engineer).toContain("dense quoting or escaping");
	});
});

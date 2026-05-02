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

function normalizeEmbeddedText(content: string): string {
	return content.replaceAll(/\s+/g, " ").trim();
}

function expectContainsAll(content: string, fragments: string[]) {
	for (const fragment of fragments) {
		expect(content).toContain(fragment);
	}
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

	test("embeds stable execution and delegation semantics", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "sprout-embedded-root-"));
		tempDirs.push(cacheDir);

		const rootDir = await extractEmbeddedRoot({ cacheDir });
		const root = normalizeEmbeddedText(await readFile(join(rootDir, "root.md"), "utf-8"));
		const workerPreamble = normalizeEmbeddedText(
			await readFile(join(rootDir, "preambles", "worker.md"), "utf-8"),
		);
		const commandRunner = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "utility", "agents", "command-runner.md"), "utf-8"),
		);
		const verifier = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "verifier.md"), "utf-8"),
		);
		const debuggerPrompt = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "debugger.md"), "utf-8"),
		);
		const taskManager = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "utility", "agents", "task-manager.md"), "utf-8"),
		);
		const editor = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "utility", "agents", "editor.md"), "utf-8"),
		);
		const reader = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "utility", "agents", "reader.md"), "utf-8"),
		);
		const techLead = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "tech-lead.md"), "utf-8"),
		);
		const engineer = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "tech-lead", "agents", "engineer.md"), "utf-8"),
		);

		expectContainsAll(root, [
			"Route work to the right owner",
			"Give tech-lead the user's request as the contract plus the working directory",
			"Do not summarize it into a project packet",
			"derive file lists",
			"Use architect only for consequential design questions",
			"Use verifier only after implementation evidence exists",
			"Do not become the implementer",
		]);

		expectContainsAll(techLead, [
			"operational or system-execution task",
			"do not force spec-review",
			"quality-review ceremony",
			"The engineer is deliberately not the best-model planner",
			"compact guidance",
			"Do not solve that by writing the implementation for them",
			"produce or repair artifacts from named external inputs",
			"unresolved semantic ambiguity",
			"caller explicitly asks for independent review",
			"engineer is executing the requested task directly",
			"report completion directly to your caller instead of invoking reviewer stages",
			"Do not generate a file-by-file plan",
		]);

		expectContainsAll(workerPreamble, [
			"default to concise findings",
			"only when the caller explicitly asks for raw output",
		]);

		expectContainsAll(commandRunner, [
			"Do not dump raw command transcripts by default",
			"Choose the simplest intervention that satisfies the contract and preserves",
			"same exact verification path",
			"target environment",
			"Do not simulate success by injecting stubs",
			"build-time prerequisites are missing for an isolated build",
			"distinguish pinned runtime dependencies from auxiliary build",
			"treat that as the direct safe repair in the named environment",
		]);

		expectContainsAll(verifier, [
			"Prefer the smallest decisive checks",
			"only the decisive proof lines or file excerpts",
			"exact output schema or report shape",
			"Do not verify by grepping bare words across whole lines",
		]);

		expectContainsAll(debuggerPrompt, ["required output format", "do not report success yet"]);

		expectContainsAll(editor, [
			"model: fast",
			"JSON object with exact `edit_file` fields",
			"Call `edit_file` with those field values copied verbatim",
			"treat those inputs as authoritative",
			"report the contradiction clearly",
		]);

		expectContainsAll(reader, [
			"opaque binary input such as parquet",
			"do not use read_file on them",
		]);

		expectContainsAll(taskManager, ["Do not ask the caller what to do next"]);

		expectContainsAll(engineer, [
			"model: balanced",
			"deliberately a mid-tier implementer",
			"best-model architecture",
			"prefer intent-rich file briefs over full-file transcription",
			"Do not send the editor a monolithic",
			"You may batch multiple related file writes or edits into one editor",
			"Batch related file writes or edits in one editor turn",
			"operational or system-execution task",
			"do not force a TDD or commit workflow",
			"keep ownership of stateful repair loops at the engineer level",
			"keep one owner on the decisive path",
			"required artifact is still missing",
			"Do not ask helpers to simulate success with stubs",
		]);
	});
});

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
		const architect = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "architect.md"), "utf-8"),
		);
		const engineer = normalizeEmbeddedText(
			await readFile(join(rootDir, "agents", "tech-lead", "agents", "engineer.md"), "utf-8"),
		);

		expectContainsAll(root, [
			"structured literal block",
			"forward it verbatim",
			"exact snippet, command text, or test invocation",
			"external source identity",
			"Wait for implementation evidence before delegating verification",
			"Do not dispatch verifier in parallel",
			"delegate to tech-lead with the workflow that matches the acceptance mode",
			"artifact- or data-production task",
			"authoritative external gate",
			"Do not pre-commit tech-lead to spec review or quality review",
			"output values are grounded by the named input evidence",
			"schema shape guidance, not a hidden value-domain restriction",
		]);

		expectContainsAll(techLead, [
			"operational or system-execution task",
			"do not force spec-review",
			"quality-review ceremony",
			"produce or repair artifacts from named external inputs",
			"decisive correctness evidence",
			"unresolved semantic ambiguity",
			"caller explicitly asks for independent review",
			"supporting reviews must not keep the task open",
			"report completion directly",
			"best-effort recovery",
			"heuristic fill-in",
			"source-grounded proof",
			"do not narrow the allowed value domain from an illustrative example",
		]);

		expectContainsAll(architect, [
			"transient or consumable evidence",
			"preserve the full evidence set",
			"snapshot or copy",
		]);

		expectContainsAll(workerPreamble, [
			"default to concise findings",
			"only when the caller explicitly asks for raw output",
		]);

		expectContainsAll(commandRunner, [
			"Do not dump raw command transcripts by default",
			"Choose the simplest intervention",
			"satisfies the contract",
			"preserves invariants",
			"same exact verification path",
			"supporting evidence only",
			"target environment",
			"Do not simulate success by injecting stubs",
			"read-only analysis loop",
			"do not switch to weaker adjacency or nearby-byte heuristics",
			"do not fill one field by taking the raw bytes immediately before or after another recovered field",
			"Treat key-local or token-local byte adjacency as supporting evidence only",
			"treat those type requirements as part of the exact schema",
			"keep the task open instead of counting that row as recovered",
			"not a hidden value-domain restriction",
		]);

		expectContainsAll(verifier, [
			"Prefer the smallest decisive checks",
			"only the decisive proof lines or file excerpts",
			"exact output schema or report shape",
			"Do not verify by grepping bare words across whole lines",
		]);

		expectContainsAll(debuggerPrompt, [
			"required output format",
			"near-match",
			"extra byte",
			"do not report success yet",
		]);

		expectContainsAll(editor, [
			"treat those inputs as authoritative",
			"then patch directly",
			"prefer edit_file",
			"report the contradiction clearly",
		]);

		expectContainsAll(reader, [
			"opaque binary input such as parquet",
			"do not use read_file on them",
			"Stop once you have the decisive",
		]);

		expectContainsAll(taskManager, [
			"Do not ask the caller what to do next",
			"Do not make a follow-up list or get call",
		]);

		expectContainsAll(engineer, [
			"operational or system-execution task",
			"do not force a TDD or commit workflow",
			"keep ownership of stateful repair loops",
			"same exact verification path",
			"component-level proofs as supporting evidence only",
			"keep the rebuild/install frontier active",
			"Do not ask helpers to simulate success with stubs",
		]);
	});
});

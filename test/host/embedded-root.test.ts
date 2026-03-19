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

		expect(root).toContain("exact literals like file contents");
		expect(root).toContain('exact content "Welcome to the benchmark webserver"');
		expect(root).toContain("Never move trailing punctuation inside");
		expect(root).toContain("structured literal block");
		expect(root).toContain("forward it verbatim");
		expect(root).toContain("exact snippet, command text, or test invocation");
		expect(root).toContain("carry that literal content forward verbatim");
		expect(root).toContain("specific code block is part of the acceptance criteria");
		expect(root).toContain("copy that code block itself into the delegated goal");
		expect(root).toContain("Do not replace it with");
		expect(root).toContain("the user's exact snippet");
		expect(root).toContain("external source identity");
		expect(root).toContain("repo URL, package name, branch, tag, commit");
		expect(root).toContain("Do not substitute a different upstream");
		expect(root).toContain("floating default branch");
		expect(root).toContain("Wait for implementation evidence before delegating verification");
		expect(root).toContain("Do not dispatch verifier in parallel");
		expect(root).toContain("explicitly asked for a baseline");
		expect(techLead).toContain("operational or system-execution task");
		expect(techLead).toContain("do not force spec-review");
		expect(techLead).toContain("quality-review ceremony");
		expect(techLead).toContain("artifact- or data-production task");
		expect(techLead).toContain("workspace like `/app`");
		expect(techLead).toContain("benchmark-sensitive execution path");
		expect(techLead).toContain("decisive execution proof");
		expect(techLead).toContain("Do not ask for exact command lists");
		expect(techLead).toContain("do not reframe it as an existing `/app` project");
		expect(techLead).toContain("do not ask the engineer to inspect `/app` scaffolds");
		expect(techLead).toContain(
			'Bad: "This is a code-change task in the /app project; inspect whether /app',
		);
		expect(techLead).toContain(
			'Good: "This task is driven by the named input files; inspect the exact inputs',
		);
		expect(techLead).toContain("structured literal block");
		expect(techLead).toContain("exact snippet, command text, or test invocation");
		expect(techLead).toContain("carry that literal content forward verbatim");
		expect(techLead).toContain("specific code block is part of the acceptance criteria");
		expect(techLead).toContain("copy that code block itself into the engineer goal");
		expect(techLead).toContain("Do not replace it with");
		expect(techLead).toContain("the user's exact snippet");
		expect(techLead).toContain("do not replace them with");
		expect(techLead).toContain("do not dispatch helpers to rediscover");
		expect(techLead).toContain("external source identity");
		expect(techLead).toContain("Forward that identity verbatim");
		expect(techLead).toContain("Do not swap in a different upstream");
		expect(techLead).toContain("default branch");
		expect(techLead).toContain("caller-provided schema block is already authoritative context");
		expect(techLead).toContain("Do not ask the engineer to rediscover it from the repo");
		expect(techLead).toContain("do not tell the");
		expect(techLead).toContain("engineer to return NEEDS_CONTEXT");
		expect(techLead).toContain("exact output schema or report shape");
		expect(techLead).toContain("Do not tell the engineer to use a best");
		expect(techLead).toContain("instead of inventing substitute keys");
		expect(techLead).toContain("exact allowed labels or row set");
		expect(techLead).toContain("substitute");
		expect(techLead).toContain("synonyms, collapse ranges, or add extra categories");
		expect(techLead).toContain("before/on/after");
		expect(techLead).toContain("today/last_7_days/last_30_days/month_to_date/total");
		expect(techLead).toContain("DEBUG");
		expect(techLead).toContain("keys like `field`, `values`, and `selected`");
		expect(techLead).toContain("one list entry per conflicting field");
		expect(techLead).toContain("do not collapse multiple field conflicts");
		expect(techLead).toContain("single per-user object");
		expect(techLead).toContain("exact literals like file contents");
		expect(techLead).toContain("exact config token, placeholder, or variable name");
		expect(techLead).toContain("Do not treat a semantically similar token as good enough");
		expect(techLead).toContain("Preserve distinctions.");
		expect(techLead).toContain("Collapse them only when");
		expect(techLead).toContain("task and the evidence");
		expect(techLead).toContain("justify it");
		expect(techLead).toContain("Choose the simplest intervention");
		expect(techLead).toContain("satisfies the contract");
		expect(techLead).toContain("preserves invariants");
		expect(techLead).toContain("existing shared environment");
		expect(techLead).toContain("hard invariants");
		expect(techLead).toContain("do not rewrite that");
		expect(techLead).toContain("environment to fit the plan");
		expect(techLead).toContain("re-check those");
		expect(techLead).toContain("invariants immediately");
		expect(techLead).toContain("any install, build, or packaging step");
		expect(techLead).toContain("If an engineer reports that an exact literal");
		expect(techLead).toContain("do not report DONE");
		expect(techLead).toContain("low-confidence fragments or placeholder values");
		expect(techLead).toContain("count as recovered rows");
		expect(techLead).toContain('exact content "Welcome to the benchmark webserver"');
		expect(techLead).toContain("Never move trailing punctuation inside");
		expect(techLead).toContain("produce or repair artifacts from named external inputs");
		expect(techLead).toContain("do not dispatch spec-reviewer or quality-reviewer");
		expect(techLead).toContain("reopen scope with hermetic tests");
		expect(techLead).toContain("general hardening");
		expect(techLead).toContain("decisive correctness evidence");
		expect(techLead).toContain("unresolved semantic ambiguity");
		expect(techLead).toContain("shape-correct artifact is not enough");
		expect(workerPreamble).toContain("default to concise findings");
		expect(workerPreamble).toContain("only when the caller explicitly asks for raw output");
		expect(commandRunner).toContain("Do not dump raw command transcripts by default");
		expect(commandRunner).toContain("required output format");
		expect(commandRunner).toContain("near-match");
		expect(commandRunner).toContain("exact config token, placeholder, or variable name");
		expect(commandRunner).toContain("Do not replace it with a semantically similar");
		expect(commandRunner).toContain("Choose the simplest intervention");
		expect(commandRunner).toContain("satisfies the contract");
		expect(commandRunner).toContain("preserves invariants");
		expect(commandRunner).toContain("extra leading or trailing byte");
		expect(commandRunner).toContain("tracing the offset, delimiter, or decoding step");
		expect(commandRunner).toContain("structured records from a corrupted binary");
		expect(commandRunner).toContain("Do not stop at raw string scraping");
		expect(commandRunner).toContain("mostly empty, punctuation-only,");
		expect(commandRunner).toContain("ambiguous fragments");
		expect(commandRunner).toContain("infer the local record structure");
		expect(commandRunner).toContain("validate candidate");
		expect(commandRunner).toContain("across multiple examples");
		expect(commandRunner).toContain("IEEE floating-point layouts");
		expect(commandRunner).toContain("deriving structured output from existing data");
		expect(commandRunner).toContain("begin with a bounded");
		expect(commandRunner).toContain("reconnaissance pass");
		expect(commandRunner).toContain("inspect a few concrete examples");
		expect(commandRunner).toContain("requested output contract");
		expect(commandRunner).toContain("competing interpretations");
		expect(commandRunner).toContain("first full script");
		expect(commandRunner).toContain("partial valid subset");
		expect(commandRunner).toContain("first turn reconnaissance-only");
		expect(commandRunner).toContain("do not write the main script");
		expect(commandRunner).toContain("final artifact");
		expect(commandRunner).toContain("or output");
		expect(commandRunner).toContain("file.");
		expect(commandRunner).toContain("standard parser or validator");
		expect(commandRunner).toContain("matches a known");
		expect(commandRunner).toContain("format's internal structure");
		expect(commandRunner).toContain("low-fidelity content heuristics");
		expect(commandRunner).toContain("structure-aware methods");
		expect(commandRunner).toContain("Group routine environment detection into concise findings");
		expect(commandRunner).toContain("batch related inspection commands");
		expect(commandRunner).toContain("stop probing beneath");
		expect(commandRunner).toContain("dense quoting/escaping");
		expect(commandRunner).toContain("shell-variable loops or `sh -c` wrappers");
		expect(commandRunner).toContain("`exec` already runs in bash");
		expect(commandRunner).toContain("Do not wrap a multi-line command in another `bash -lc`");
		expect(commandRunner).toContain("pass the script directly as the command body");
		expect(commandRunner).toContain("Prefer simple explicit per-file checks");
		expect(commandRunner).toContain("large match set such as many files under one directory");
		expect(commandRunner).toContain("Summarize the decisive facts instead");
		expect(commandRunner).toContain("total match count");
		expect(commandRunner).toContain("first and last relevant matches");
		expect(commandRunner).toContain("Treat caller-supplied input files and datasets as read-only");
		expect(commandRunner).toContain("Do not rewrite, overwrite, seed, normalize,");
		expect(commandRunner).toContain("or simplify those inputs");
		expect(commandRunner).toContain("Never modify benchmark or task inputs");
		expect(commandRunner).toContain("if the current outputs are wrong, write");
		expect(commandRunner).toContain("the fix to the implementation or outputs instead");
		expect(commandRunner).toContain("treat an empty");
		expect(commandRunner).toContain("or sharply reduced result as partial");
		expect(commandRunner).toContain("concrete candidate items");
		expect(commandRunner).toContain("decisively ruled out");
		expect(commandRunner).toContain("do not write the final artifact as complete output");
		expect(commandRunner).toContain("stronger structural anchors");
		expect(commandRunner).toContain("exact");
		expect(commandRunner).toContain("offsets, record boundaries");
		expect(commandRunner).toContain("parsed field positions");
		expect(commandRunner).toContain("use those");
		expect(commandRunner).toContain("anchors directly");
		expect(commandRunner).toContain("weaker local substrings");
		expect(commandRunner).toContain("lower-bound subset");
		expect(commandRunner).toContain("stay inside that model");
		expect(commandRunner).toContain("smallest");
		expect(commandRunner).toContain("discriminating check");
		expect(commandRunner).toContain("remaining cases");
		expect(commandRunner).toContain("most faithful representation the evidence supports");
		expect(commandRunner).toContain("does not require a narrower subtype");
		expect(commandRunner).toContain("Preserve the strongest validated constraints");
		expect(commandRunner).toContain("broaden only the unresolved dimension");
		expect(commandRunner).toContain("Use the strongest current model as a filter");
		expect(commandRunner).toContain("Preserve distinctions.");
		expect(commandRunner).toContain("Collapse them only when");
		expect(commandRunner).toContain("task and the evidence");
		expect(commandRunner).toContain("justify it");
		expect(commandRunner).toContain("existing shared environment");
		expect(commandRunner).toContain("hard invariants");
		expect(commandRunner).toContain("Do not upgrade, downgrade");
		expect(commandRunner).toContain("rewrite that environment in place");
		expect(commandRunner).toContain("fixed version as an invariant");
		expect(commandRunner).toContain("satisfy other missing declared prerequisites");
		expect(commandRunner).toContain("that do not conflict with it");
		expect(commandRunner).toContain("Do not bypass dependency evaluation wholesale");
		expect(commandRunner).toContain("just because one package version is pinned");
		expect(commandRunner).toContain("candidate install, reinstall, or packaging command");
		expect(commandRunner).toContain("would uninstall, upgrade, downgrade");
		expect(commandRunner).toContain("or otherwise replace a fixed invariant dependency");
		expect(commandRunner).toContain("do not run it");
		expect(commandRunner).toContain("build or reinstall a local source tree");
		expect(commandRunner).toContain("existing constrained environment");
		expect(commandRunner).toContain("full dependency re-resolution");
		expect(commandRunner).toContain("task explicitly calls for changing");
		expect(commandRunner).toContain("preserve the fixed invariant dependencies");
		expect(commandRunner).toContain("Choose a build/install path that preserves");
		expect(commandRunner).toContain("reuses the already-satisfied environment");
		expect(commandRunner).toContain("re-check the stated invariant");
		expect(commandRunner).toContain("before you report success");
		expect(commandRunner).toContain("expected source change is present");
		expect(commandRunner).toContain("treat that confirmation as a hard gate");
		expect(commandRunner).toContain("live file state still shows the old lines");
		expect(commandRunner).toContain("Do not continue into build, install, package, or test");
		expect(commandRunner).toContain("report the mismatch immediately");
		expect(commandRunner).toContain("live runtime traceback or failing check");
		expect(commandRunner).toContain("exact file, line, or symbol");
		expect(commandRunner).toContain("smallest local action");
		expect(commandRunner).toContain("rerun that same failing check");
		expect(commandRunner).toContain("repo-wide compatibility census");
		expect(commandRunner).toContain("missing module, package,");
		expect(commandRunner).toContain("test runner, CLI tool");
		expect(commandRunner).toContain("named prerequisite or import frontier");
		expect(commandRunner).toContain("same exact verification path");
		expect(commandRunner).toContain("exact required command, snippet, import path, or test path");
		expect(commandRunner).toContain("remains the gate after each repair step");
		expect(commandRunner).toContain("Do not substitute a convenience probe");
		expect(commandRunner).toContain("sibling import, or narrower related check");
		expect(commandRunner).toContain("If the caller says an exact snippet or command is required");
		expect(commandRunner).toContain("but the literal text is not present in the current goal");
		expect(commandRunner).toContain("Do not invent or guess a proxy");
		expect(commandRunner).toContain("same compatibility class");
		expect(commandRunner).toContain("one bounded repair pass");
		expect(commandRunner).toContain("before the next expensive rebuild");
		expect(commandRunner).toContain("Keep that sweep bounded");
		expect(commandRunner).toContain("patch the named site first");
		expect(commandRunner).toContain("before you scan for same-class siblings");
		expect(commandRunner).toContain("exact failing file");
		expect(commandRunner).toContain("directly implicated import chain");
		expect(commandRunner).toContain("Do not broaden into other same-class files");
		expect(commandRunner).toContain("until rerunning that same exact gate");
		expect(commandRunner).toContain("Do not turn it into a repo-wide audit");
		expect(commandRunner).toContain("continue with the next bounded local fix");
		expect(commandRunner).toContain("same loop");
		expect(commandRunner).toContain("Do not stop for a new reconnaissance pass");
		expect(commandRunner).toContain("optional dependency block the requested path");
		expect(commandRunner).toContain("working hypothesis");
		expect(commandRunner).toContain("If more than one interpretation still fits the");
		expect(commandRunner).toContain("evidence, do not write the");
		expect(commandRunner).toContain("final artifact yet");
		expect(commandRunner).toContain("discriminating check resolves");
		expect(commandRunner).toContain("Keep source evidence and output values distinct");
		expect(commandRunner).toContain("unexplained extra");
		expect(commandRunner).toContain("characters, corruption markers");
		expect(commandRunner).toContain("supports each field before");
		expect(commandRunner).toContain("Keep field roles separate");
		expect(commandRunner).toContain("Track evidence provenance per output field");
		expect(commandRunner).toContain("Cleanup, suffixes, offsets, adjacency");
		expect(commandRunner).toContain("different field's contents");
		expect(commandRunner).toContain("neighboring raw byte");
		expect(commandRunner).toContain("Preserve semantic consistency within each output field");
		expect(commandRunner).toContain("incompatible kinds or meanings across rows");
		expect(commandRunner).toContain("mixes inconsistent domains");
		expect(commandRunner).toContain("broadest well-supported form");
		expect(commandRunner).toContain("Do not coerce recovered or inferred values");
		expect(commandRunner).toContain("produces contradictory facts");
		expect(commandRunner).toContain("Rerun a simpler explicit check");
		expect(commandRunner).toContain("runtime semantics are still wrong");
		expect(commandRunner).toContain("If a command exits successfully but explicitly says");
		expect(commandRunner).toContain("required capability, artifact, or optimized path was skipped");
		expect(commandRunner).toContain("treat that message as the current failure frontier");
		expect(commandRunner).toContain("not as success");
		expect(commandRunner).toContain("names the direct remediation");
		expect(commandRunner).toContain("missing prerequisite");
		expect(commandRunner).toContain("same-step rerun needed to reach the required capability");
		expect(commandRunner).toContain("take that remediation and rerun");
		expect(commandRunner).toContain("before widening into source analysis");
		expect(commandRunner).toContain(
			"requires named native, compiled, generated, or optimized outputs",
		);
		expect(commandRunner).toContain("successful install, package, or editable step");
		expect(commandRunner).toContain("still leaves those named outputs absent");
		expect(commandRunner).toContain("pure-Python or metadata-only result");
		expect(commandRunner).toContain("direct step that produces or proves");
		expect(commandRunner).toContain(
			"build metadata or command output names the missing prerequisite",
		);
		expect(commandRunner).toContain("restore that prerequisite");
		expect(commandRunner).toContain("rerun the direct output-producing step");
		expect(commandRunner).toContain("structured log/event tokens");
		expect(commandRunner).toContain("actual token boundary from a sample line");
		expect(commandRunner).toContain("Do not grep bare severity words across whole lines");
		expect(commandRunner).toContain("helper script for structured-token counting");
		expect(commandRunner).toContain("observed field or delimiter shape");
		expect(commandRunner).toContain("escaped");
		expect(commandRunner).toContain("regex from memory");
		expect(commandRunner).toContain("bracketed severity field");
		expect(commandRunner).toContain("exact bracketed field shape");
		expect(commandRunner).toContain("Do not count `ERROR`, `WARNING`, or `INFO`");
		expect(commandRunner).toContain("grep -w");
		expect(commandRunner).toContain("count `[ERROR]`, `[WARNING]`, and `[INFO]`");
		expect(commandRunner).toContain("first counting pass");
		expect(commandRunner).toContain("sample one or two real");
		expect(commandRunner).toContain("Do not jump straight from filename enumeration");
		expect(commandRunner).toContain("whole-word");
		expect(commandRunner).toContain("bulk counting script");
		expect(commandRunner).toContain("If the caller asks you to count structured log");
		expect(commandRunner).toContain("has not already supplied the observed field shape");
		expect(commandRunner).toContain("sample one or two real lines yourself first");
		expect(commandRunner).toContain("before any aggregate count or output write");
		expect(commandRunner).toContain("enumerates the exact allowed labels");
		expect(commandRunner).toContain("preserve that set exactly");
		expect(commandRunner).toContain("verify a snippet, import path, command, test run,");
		expect(commandRunner).toContain("run that exact verification path in the real runtime");
		expect(commandRunner).toContain("proving something is installed into an existing environment");
		expect(commandRunner).toContain("clean working directory outside the source tree");
		expect(commandRunner).toContain("Do not replace an exact snippet or import path");
		expect(commandRunner).toContain("sibling module probe");
		expect(commandRunner).toContain("Component-level proofs are supporting evidence only");
		expect(commandRunner).toContain(
			"Do not return success until the end-to-end exact check passes",
		);
		expect(commandRunner).toContain("If the caller requires installed-location proof");
		expect(commandRunner).toContain("source tree or build tree as failure");
		expect(commandRunner).toContain("exact modules, files, artifacts, or outputs");
		expect(commandRunner).toContain("private implementation modules");
		expect(commandRunner).toContain("public target");
		expect(commandRunner).toContain("Do not simulate success by injecting stubs");
		expect(commandRunner).toContain("constructing an alternate execution context");
		expect(commandRunner).toContain("keep it clearly labeled as");
		expect(commandRunner).toContain("diagnosis and do not replace");
		expect(commandRunner).toContain("exact ignored paths, excluded files");
		expect(commandRunner).toContain("Do not replace them with semantic approximations");
		expect(commandRunner).toContain("such as `-k` filters");
		expect(commandRunner).toContain("Do not rename, collapse, reorder");
		expect(commandRunner).toContain("add");
		expect(commandRunner).toContain("categories unless the caller explicitly asked");
		expect(commandRunner).toContain("before/on/after");
		expect(commandRunner).toContain("today/last_7_days/last_30_days/month_to_date/total");
		expect(commandRunner).toContain("DEBUG");
		expect(commandRunner).toContain("quiet or noninteractive flags");
		expect(commandRunner).toContain("Do not add sudo speculatively");
		expect(commandRunner).toContain("absolute path");
		expect(commandRunner).toContain("Do not rewrite it under the working directory");
		expect(commandRunner).toContain("relative paths from a project tree");
		expect(commandRunner).toContain("directory those paths are");
		expect(commandRunner).toContain("absolute path to the entrypoint is not a substitute");
		expect(commandRunner).toContain("set `cwd` to that directory");
		expect(commandRunner).toContain("established facts unless");
		expect(commandRunner).toContain("Do not spend turns re-checking");
		expect(commandRunner).toContain("Do not repeat the literal command text or exit code");
		expect(commandRunner).toContain("one short step summary");
		expect(commandRunner).toContain("If the caller already named the decisive");
		expect(commandRunner).toContain("files and failure cause");
		expect(commandRunner).toContain("make the smallest safe change directly");
		expect(commandRunner).toContain("instead of starting a long");
		expect(commandRunner).toContain("read-only analysis loop");
		expect(commandRunner).toContain("stop after the first decisive available command");
		expect(commandRunner).toContain('Do not add a "commands used" appendix');
		expect(commandRunner).toContain("Do not append offers of further help");
		expect(verifier).toContain("Prefer the smallest decisive checks");
		expect(verifier).toContain("Do not require exact command lists or exit codes by default");
		expect(verifier).toContain("only the decisive proof lines or file excerpts");
		expect(verifier).toContain("Prefer targeted checks per requirement");
		expect(verifier).toContain("source-specific field mappings");
		expect(verifier).toContain("carry those exact");
		expect(verifier).toContain("mappings into the verification step");
		expect(verifier).toContain("instead of assuming heterogeneous raw");
		expect(verifier).toContain("inputs already use the canonical field names");
		expect(verifier).toContain("the canonical field names");
		expect(verifier).toContain("exact output schema or report shape");
		expect(verifier).toContain("required keys, nesting, and field names");
		expect(verifier).toContain("instead of accepting a near match");
		expect(verifier).toContain("required record cardinality");
		expect(verifier).toContain("requires one conflict");
		expect(verifier).toContain("single per-user object with nested");
		expect(verifier).toContain("structured log lines or records");
		expect(verifier).toContain("identify the real");
		expect(verifier).toContain("token boundary from sample lines first");
		expect(verifier).toContain("Do not verify by grepping bare words across whole lines");
		expect(verifier).toContain("output values are inferred");
		expect(verifier).toContain("verify the");
		expect(verifier).toContain("inferred values themselves");
		expect(verifier).toContain("representative results against the evidence");
		expect(verifier).toContain("multiple examples");
		expect(verifier).toContain("malformed identifiers");
		expect(verifier).toContain("implausible");
		expect(verifier).toContain("outliers");
		expect(debuggerPrompt).toContain("required output format");
		expect(debuggerPrompt).toContain("near-match");
		expect(debuggerPrompt).toContain("extra byte");
		expect(debuggerPrompt).toContain("do not report success yet");
		expect(debuggerPrompt).toContain("structured logs or records");
		expect(debuggerPrompt).toContain("real field or token");
		expect(debuggerPrompt).toContain("boundary from sample lines");
		expect(debuggerPrompt).toContain("bare word matches across whole lines");
		expect(editor).toContain("treat those inputs as authoritative");
		expect(editor).toContain("do not re-read unrelated files just");
		expect(editor).toContain("do not use read_file on opaque binary inputs");
		expect(editor).toContain("already provides the exact file paths");
		expect(editor).toContain("failure mode, and replacement direction");
		expect(editor).toContain("make the smallest confirming read");
		expect(editor).toContain("then patch directly");
		expect(editor).toContain("exact existing-file edit");
		expect(editor).toContain("prefer edit_file");
		expect(editor).toContain("Do not rewrite the whole file with write_file");
		expect(editor).toContain("targeted edit on an existing file");
		expect(editor).toContain("verification read appears contradictory");
		expect(editor).toContain("re-read the exact changed lines");
		expect(editor).toContain("simpler local check");
		expect(editor).toContain("Do not loop on the same contradictory");
		expect(editor).toContain("Switch to the other local file-check primitive");
		expect(editor).toContain("retry one bounded edit");
		expect(editor).toContain("report the contradiction clearly");
		expect(editor).toContain("Do not escalate into a whole-file rewrite");
		expect(editor).toContain("Do not spend turns on extra read-only");
		expect(editor).toContain("analysis or design prose");
		expect(editor).toContain(
			'Bad: "glob /data, read the JSON and CSV, then read the Parquet file bytes',
		);
		expect(editor).toContain('Good: "use the caller-provided paths, mappings, and schema summary');
		expect(reader).toContain("opaque binary input such as parquet");
		expect(reader).toContain("do not use read_file on them");
		expect(reader).toContain("explicitly asked for raw bytes");
		expect(reader).toContain("Say so clearly");
		expect(reader).toContain("broad glob or grep would return a long directory listing");
		expect(reader).toContain("do not feed that raw list back into the conversation");
		expect(reader).toContain("they need an exec-capable tool for");
		expect(reader).toContain("bulk aggregation");
		expect(reader).toContain("named files and exact failure pattern");
		expect(reader).toContain("Stop once you have the decisive");
		expect(reader).toContain("file lines, failure cause, and");
		expect(reader).toContain("minimal fix direction");
		expect(reader).toContain("Do not keep searching for exhaustive");
		expect(reader).toContain("supporting examples after that point");
		expect(taskManager).toContain("Do not ask the caller what to do next");
		expect(taskManager).toContain("Do not make a follow-up list or get call");
		expect(engineer).toContain("operational or system-execution task");
		expect(engineer).toContain("do not force a TDD or commit workflow");
		expect(engineer).toContain("keep ownership of stateful repair loops");
		expect(engineer).toContain("keep the same helper on that direct repair loop");
		expect(engineer).toContain("Do not dispatch a fresh helper");
		expect(engineer).toContain("restate the next exact local site");
		expect(engineer).toContain("continue through patch, rebuild");
		expect(engineer).toContain("and rerunning that same exact gate");
		expect(engineer).toContain("use command-runner only for the next bounded");
		expect(engineer).toContain("do not hand command-runner the whole remaining");
		expect(engineer).toContain("mixed repair/install/test loop");
		expect(engineer).toContain("later source fixes may still be needed");
		expect(engineer).toContain("next concrete failing step");
		expect(engineer).toContain("next edit or rerun");
		expect(engineer).toContain("Do not ask for redundant child-path checks");
		expect(engineer).toContain("first establish decisive prerequisites");
		expect(engineer).toContain("carry those findings forward");
		expect(engineer).toContain("instead of asking another agent to rediscover them");
		expect(engineer).toContain("driven by named external inputs");
		expect(engineer).toContain("first prerequisite helper turn should not ask about `/app` at all");
		expect(engineer).toContain("`/app` repo state, git status");
		expect(engineer).toContain("tell the command-runner explicitly");
		expect(engineer).toContain("exact command names");
		expect(engineer).toContain("generic labels like");
		expect(engineer).toContain("Only ask for exact file contents");
		expect(engineer).toContain("Do not launch dependent config inspection");
		expect(engineer).toContain("shortest exact proof lines");
		expect(engineer).toContain("Do not ask command-runners to enumerate exact commands");
		expect(engineer).toContain("may match many files");
		expect(engineer).toContain("match list by default");
		expect(engineer).toContain("total match count");
		expect(engineer).toContain("boundary proof lines");
		expect(engineer).toContain("dense quoting or escaping");
		expect(engineer).toContain("counting structured tokens from logs or events");
		expect(engineer).toContain("sample line first");
		expect(engineer).toContain("word-boundary escapes from");
		expect(engineer).toContain("memory");
		expect(engineer).toContain("bracketed severity field");
		expect(engineer).toContain("exact bracketed field shape");
		expect(engineer).toContain("Do not ask helpers to count bare severity words");
		expect(engineer).toContain("grep -w");
		expect(engineer).toContain("count `[ERROR]`, `[WARNING]`, and `[INFO]`");
		expect(engineer).toContain("repo-local build, test, install, or packaging command");
		expect(engineer).toContain("exact project root and tell the helper to run");
		expect(engineer).toContain("from that directory");
		expect(engineer).toContain("absolute script path from another directory");
		expect(engineer).toContain("first ask for one or two real");
		expect(engineer).toContain("observed severity field shape");
		expect(engineer).toContain("Do not send a counting helper straight from filename discovery");
		expect(engineer).toContain("whole-word");
		expect(engineer).toContain("two-step helper flow");
		expect(engineer).toContain("first helper turn samples representative lines");
		expect(engineer).toContain("second helper turn may count only after");
		expect(engineer).toContain("reference the observed field shape explicitly");
		expect(engineer).toContain("opaque binary inputs like parquet");
		expect(engineer).toContain("do not send a reader to raw-read them");
		expect(engineer).toContain("Use a command-runner with an");
		expect(engineer).toContain("caller-supplied input paths or datasets");
		expect(engineer).toContain("read-only inputs unless the");
		expect(engineer).toContain("task explicitly says to modify them");
		expect(engineer).toContain("Do not ask a helper to rewrite an input file");
		expect(engineer).toContain("Repair");
		expect(engineer).toContain("the implementation or outputs instead");
		expect(engineer).toContain("current result is empty or sharply reduced");
		expect(engineer).toContain("concrete");
		expect(engineer).toContain("candidate items");
		expect(engineer).toContain("were decisively");
		expect(engineer).toContain("ruled out");
		expect(engineer).toContain("fresh runtime or test failure");
		expect(engineer).toContain("already identifies the exact file");
		expect(engineer).toContain("smallest local fix");
		expect(engineer).toContain("rerun that same failing check");
		expect(engineer).toContain("local replacement direction is already clear");
		expect(engineer).toContain("Do not split off a separate reconnaissance pass");
		expect(engineer).toContain("ask the editing helper for the bounded patch first");
		expect(engineer).toContain("Only widen after that direct patch");
		expect(engineer).toContain("Do not ask for a focused code-reading pass before editing");
		expect(engineer).toContain("removed import, API, or symbol");
		expect(engineer).toContain("Use the editor as the first bounded helper");
		expect(engineer).toContain("confirming read inside that edit branch");
		expect(engineer).toContain("Do not broaden into a hotspot search");
		expect(engineer).toContain("compatibility census");
		expect(engineer).toContain("do not report DONE");
		expect(engineer).toContain("recovery quality");
		expect(engineer).toContain("low-confidence fragments or placeholder values");
		expect(engineer).toContain("real recovered field values");
		expect(engineer).toContain("unresolved semantic ambiguity");
		expect(engineer).toContain("fallback interpretation");
		expect(engineer).toContain("do not report");
		expect(engineer).toContain("DONE or DONE_WITH_CONCERNS");
		expect(engineer).toContain("infer the local record structure");
		expect(engineer).toContain("validate");
		expect(engineer).toContain("across multiple examples");
		expect(engineer).toContain("IEEE floating-point layouts");
		expect(engineer).toContain("deriving structured output from existing data");
		expect(engineer).toContain("ask for a short reconnaissance");
		expect(engineer).toContain("pass before the main implementation helper");
		expect(engineer).toContain("few concrete source examples");
		expect(engineer).toContain("report any competing");
		expect(engineer).toContain("interpretations that still fit the evidence");
		expect(engineer).toContain("Only after that reconnaissance result");
		expect(engineer).toContain("first implementation helper");
		expect(engineer).toContain("unverified interpretation");
		expect(engineer).toContain("first helper turn reconnaissance-only");
		expect(engineer).toContain("must not write the main script");
		expect(engineer).toContain("final artifact");
		expect(engineer).toContain("or");
		expect(engineer).toContain("output file");
		expect(engineer).toContain("standard parser or top-level validator");
		expect(engineer).toContain("matches a known");
		expect(engineer).toContain("format's internal structure");
		expect(engineer).toContain("low-fidelity content heuristics");
		expect(engineer).toContain("structure-aware path");
		expect(engineer).toContain("stronger structural anchors");
		expect(engineer).toContain("exact offsets");
		expect(engineer).toContain("record boundaries");
		expect(engineer).toContain("row counts, or parsed field positions");
		expect(engineer).toContain("carry those");
		expect(engineer).toContain("anchors forward");
		expect(engineer).toContain("weaker local patterns");
		expect(engineer).toContain("lower-bound subset");
		expect(engineer).toContain("do not delegate final artifact writing yet");
		expect(engineer).toContain("smallest discriminating check");
		expect(engineer).toContain("remaining cases within that same model");
		expect(engineer).toContain("most faithful representation the evidence supports");
		expect(engineer).toContain("does not require a narrower subtype");
		expect(engineer).toContain("strongest validated constraints");
		expect(engineer).toContain("broaden only the unresolved dimension");
		expect(engineer).toContain("strongest current model as a filter");
		expect(engineer).toContain("Preserve distinctions.");
		expect(engineer).toContain("Collapse them only when");
		expect(engineer).toContain("task and the evidence");
		expect(engineer).toContain("justify it");
		expect(engineer).toContain("Choose the simplest intervention");
		expect(engineer).toContain("satisfies the contract");
		expect(engineer).toContain("preserves invariants");
		expect(engineer).toContain("existing shared environment");
		expect(engineer).toContain("hard invariants");
		expect(engineer).toContain("Do not ask a helper to rewrite that environment");
		expect(engineer).toContain("keep that fixed version unchanged");
		expect(engineer).toContain("satisfy any other missing");
		expect(engineer).toContain("declared prerequisites");
		expect(engineer).toContain("that do not conflict");
		expect(engineer).toContain("fresh failure is a missing standard prerequisite");
		expect(engineer).toContain("restore that prerequisite in the named environment");
		expect(engineer).toContain("rerun the same failing build, import, or test step");
		expect(engineer).toContain("Do not widen into source analysis");
		expect(engineer).toContain("reader-only investigation");
		expect(engineer).toContain("If a successful command output still says the required capability");
		expect(engineer).toContain("artifact, or performance path was skipped, disabled, or replaced");
		expect(engineer).toContain("treat that as the current frontier");
		expect(engineer).toContain("not as success");
		expect(engineer).toContain("names the direct remediation");
		expect(engineer).toContain("missing prerequisite");
		expect(engineer).toContain("same-step rerun");
		expect(engineer).toContain("ask for that remediation and rerun before");
		expect(engineer).toContain("reader-only investigation");
		expect(engineer).toContain("requires named native, compiled, generated, or optimized outputs");
		expect(engineer).toContain("successful install, package, or editable step");
		expect(engineer).toContain("still leaves those named outputs absent");
		expect(engineer).toContain("pure-Python or metadata-only result");
		expect(engineer).toContain("treat that as the current frontier");
		expect(engineer).toContain("direct step that produces or proves");
		expect(engineer).toContain("build metadata or command output names the missing prerequisite");
		expect(engineer).toContain("restore that prerequisite");
		expect(engineer).toContain("rerun the direct output-producing step");
		expect(engineer).toContain("fresh runtime or test failure already identifies");
		expect(engineer).toContain("exact file, line, or symbol");
		expect(engineer).toContain("smallest local fix");
		expect(engineer).toContain("rerun that same failing check");
		expect(engineer).toContain("missing module,");
		expect(engineer).toContain("package, test runner, CLI tool");
		expect(engineer).toContain("next concrete blocker");
		expect(engineer).toContain("same exact verification path");
		expect(engineer).toContain("exact required command, snippet, import path, or test path");
		expect(engineer).toContain("remains the gate after each repair step");
		expect(engineer).toContain("Do not ask a helper to substitute a convenience probe");
		expect(engineer).toContain("sibling import, or narrower related check");
		expect(engineer).toContain(
			"carry the literal snippet, command text, or test invocation forward verbatim",
		);
		expect(engineer).toContain("specific code block is part of the acceptance criteria");
		expect(engineer).toContain("carry that code block itself into helper goals");
		expect(engineer).toContain("Do not refer to it only as");
		expect(engineer).toContain("the exact required snippet");
		expect(engineer).toContain("same compatibility class");
		expect(engineer).toContain("one bounded repair pass");
		expect(engineer).toContain("before the next reinstall");
		expect(engineer).toContain("Keep that sweep bounded");
		expect(engineer).toContain("patch the named site first");
		expect(engineer).toContain("before asking for same-class siblings");
		expect(engineer).toContain("exact failing file");
		expect(engineer).toContain("directly implicated import chain");
		expect(engineer).toContain("Do not broaden into other same-class files");
		expect(engineer).toContain("until rerunning that same exact gate");
		expect(engineer).toContain("Do not turn it into a repo-wide audit");
		expect(engineer).toContain("do not dispatch a separate");
		expect(engineer).toContain("reader pass just to restate that chain");
		expect(engineer).toContain("prove installation into an existing environment");
		expect(engineer).toContain("clean context outside the source tree");
		expect(engineer).toContain("Do not ask helpers to substitute sibling");
		expect(engineer).toContain("import probes for an exact snippet");
		expect(engineer).toContain("component-level proofs as supporting evidence only");
		expect(engineer).toContain("Do not accept them as completion");
		expect(engineer).toContain("installed-location proof");
		expect(engineer).toContain("exact modules, files, artifacts, or outputs");
		expect(engineer).toContain("private implementation modules");
		expect(engineer).toContain("public target");
		expect(engineer).toContain("repo-wide audit");
		expect(engineer).toContain("Do not ask a helper to bypass dependency evaluation wholesale");
		expect(engineer).toContain("unless the caller explicitly required it");
		expect(engineer).toContain("or you already proved the prerequisites are present");
		expect(engineer).toContain("install, reinstall, or packaging strategy");
		expect(engineer).toContain("would replace a fixed invariant dependency");
		expect(engineer).toContain("do not ask the helper to run it");
		expect(engineer).toContain("build or reinstall a local source tree");
		expect(engineer).toContain("existing constrained environment");
		expect(engineer).toContain("full dependency re-resolution");
		expect(engineer).toContain("task explicitly calls for");
		expect(engineer).toContain("broader resolution");
		expect(engineer).toContain("preserve the fixed invariant dependencies");
		expect(engineer).toContain("preserves the invariant");
		expect(engineer).toContain("reuses the already-satisfied");
		expect(engineer).toContain("After any install, build, or packaging step");
		expect(engineer).toContain("re-check those invariants immediately");
		expect(engineer).toContain("the branch is not DONE");
		expect(engineer).toContain("working hypothesis");
		expect(engineer).toContain("If more than one interpretation still fits the");
		expect(engineer).toContain("evidence, do not write the");
		expect(engineer).toContain("final artifact yet");
		expect(engineer).toContain("discriminating check resolves");
		expect(engineer).toContain("Keep source evidence and output values distinct");
		expect(engineer).toContain("unexplained extra");
		expect(engineer).toContain("characters, corruption markers");
		expect(engineer).toContain("supports each field before");
		expect(engineer).toContain("Keep field roles separate");
		expect(engineer).toContain("Track evidence provenance per output field");
		expect(engineer).toContain("Cleanup, suffixes, offsets, adjacency");
		expect(engineer).toContain("different field's contents");
		expect(engineer).toContain("neighboring raw byte");
		expect(engineer).toContain("Preserve semantic consistency within each output field");
		expect(engineer).toContain("incompatible kinds or meanings across rows");
		expect(engineer).toContain("mixes inconsistent domains");
		expect(engineer).toContain("broadest well-supported form");
		expect(engineer).toContain("Do not ask a helper to coerce");
		expect(engineer).toContain("delegating a verification step");
		expect(engineer).toContain("exact requested execution");
		expect(engineer).toContain("real snippet, import path, command, test run");
		expect(engineer).toContain("Do not ask helpers to simulate success with stubs");
		expect(engineer).toContain("synthetic import contexts");
		expect(engineer).toContain("If the exact requested verification fails");
		expect(engineer).toContain("Do not accept a helper's alternate proof");
		expect(engineer).toContain("Do not replace exact ignored paths");
		expect(engineer).toContain("semantic approximations such as `-k` filters");
		expect(engineer).toContain("exact structured format, schema block, or");
		expect(engineer).toContain("example payload");
		expect(engineer).toContain("that task text is already authoritative context");
		expect(engineer).toContain("Do not send a helper to rediscover whether");
		expect(engineer).toContain("Do not return NEEDS_CONTEXT just because");
		expect(engineer).toContain("exact output schema or report shape");
		expect(engineer).toContain("implement it with the exact required keys");
		expect(engineer).toContain("exact labels, periods, severities");
		expect(engineer).toContain("carry");
		expect(engineer).toContain("those exact labels forward");
		expect(engineer).toContain("Do not substitute");
		expect(engineer).toContain("collapse date ranges, or add extra categories");
		expect(engineer).toContain("before/on/after");
		expect(engineer).toContain("today/last_7_days/last_30_days/month_to_date/total");
		expect(engineer).toContain("DEBUG");
		expect(engineer).toContain("Do not invent substitute keys");
		expect(engineer).toContain("chosen_value");
		expect(engineer).toContain("chosen_source");
		expect(engineer).toContain("values_by_source");
		expect(engineer).toContain("required record cardinality");
		expect(engineer).toContain("one list entry per conflicting field");
		expect(engineer).toContain("single per-user object");
		expect(engineer).toContain("absolute paths or structured formats");
		expect(engineer).toContain("exact config token, placeholder, or variable name");
		expect(engineer).toContain("Do not substitute a semantically similar token");
		expect(engineer).toContain("rediscover them from the repo");
		expect(engineer).toContain("exact literals like file contents");
		expect(engineer).toContain("external source identity");
		expect(engineer).toContain("repo URL, package name, branch, tag, commit");
		expect(engineer).toContain("same source identity");
		expect(engineer).toContain("Do not swap in a fork");
		expect(engineer).toContain('exact content "Welcome to the benchmark webserver"');
		expect(engineer).toContain("Never move trailing punctuation inside");
		expect(engineer).toContain("field or schema mapping table");
		expect(engineer).toContain("source-to-target direction");
		expect(engineer).toContain('phrases like "map fields into the unified schema"');
		expect(engineer).toContain("repeat those exact paths");
		expect(engineer).toContain("do not replace them with generic references");
		expect(engineer).toContain('Bad: "inspect the three input data files"');
		expect(engineer).toContain("Good: \"inspect '/data/source_a/users.json'");
		expect(engineer).toContain(
			'Bad: "inspect the input files, available runtime, and whether /app already',
		);
		expect(engineer).toContain('Good: "inspect the exact input files and available runtime first"');
		expect(engineer).toContain("When helper findings reveal concrete source schemas");
		expect(engineer).toContain("explicit per-source mapping list");
		expect(engineer).toContain("source_a: id -> user_id");
		expect(engineer).toContain("source_b: user_id -> user_id");
		expect(engineer).toContain('Do not just say "the given field mappings"');
		expect(engineer).toContain("an empty or incidental");
		expect(engineer).toContain("workspace as decisive context");
		expect(engineer).toContain("Do not return NEEDS_CONTEXT");
		expect(engineer).toContain("Do not ask helpers to ask which language");
		expect(engineer).toContain("do not spend another helper turn");
		expect(engineer).toContain("whether `/app` is a git repo");
		expect(engineer).toContain("choose the smallest reasonable implementation approach");
		expect(engineer).toContain("When a helper reports a targeted source patch");
		expect(engineer).toContain("do not trust the diff summary alone");
		expect(engineer).toContain("confirm the live file state");
		expect(engineer).toContain("same workspace the next build");
		expect(engineer).toContain("restate the expected post-patch lines");
		expect(engineer).toContain('Bad: "The workspace is empty; tell me which language');
		expect(engineer).toContain('Good: "The workspace is empty and the task authorizes');
		expect(engineer).toContain('Bad: "Before implementing, inspect whether `/app` is a git repo');
		expect(engineer).toContain("I already know the input files and runtime support");
	});
});

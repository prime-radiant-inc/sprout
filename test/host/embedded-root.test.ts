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
		const verifier = await readFile(join(rootDir, "agents", "verifier.md"), "utf-8");
		const debuggerPrompt = await readFile(join(rootDir, "agents", "debugger.md"), "utf-8");
		const taskManager = await readFile(
			join(rootDir, "agents", "utility", "agents", "task-manager.md"),
			"utf-8",
		);
		const editor = await readFile(
			join(rootDir, "agents", "utility", "agents", "editor.md"),
			"utf-8",
		);
		const reader = await readFile(
			join(rootDir, "agents", "utility", "agents", "reader.md"),
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
		expect(root).toContain("structured literal block");
		expect(root).toContain("forward it verbatim");
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
		expect(techLead).toContain("do not replace them with");
		expect(techLead).toContain("do not dispatch helpers to rediscover");
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
		expect(commandRunner).toContain("broadest well-supported form");
		expect(commandRunner).toContain("Do not coerce recovered or inferred values");
		expect(commandRunner).toContain("produces contradictory facts");
		expect(commandRunner).toContain("Rerun a simpler explicit check");
		expect(commandRunner).toContain("runtime semantics are still wrong");
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
		expect(commandRunner).toContain("established facts unless");
		expect(commandRunner).toContain("Do not spend turns re-checking");
		expect(commandRunner).toContain("Do not repeat the literal command text or exit code");
		expect(commandRunner).toContain("one short step summary");
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
		expect(taskManager).toContain("Do not ask the caller what to do next");
		expect(taskManager).toContain("Do not make a follow-up list or get call");
		expect(engineer).toContain("operational or system-execution task");
		expect(engineer).toContain("do not force a TDD or commit workflow");
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
		expect(engineer).toContain("broadest well-supported form");
		expect(engineer).toContain("Do not ask a helper to coerce");
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
		expect(engineer).toContain('Bad: "The workspace is empty; tell me which language');
		expect(engineer).toContain('Good: "The workspace is empty and the task authorizes');
		expect(engineer).toContain('Bad: "Before implementing, inspect whether `/app` is a git repo');
		expect(engineer).toContain("I already know the input files and runtime support");
	});
});

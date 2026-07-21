import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Genome } from "../genome/genome.ts";
import { buildReadMemoryPrimitives, buildWriteMemoryPrimitives } from "../genome/memory-tools.ts";
import type { MemoryWriteAuthorization } from "../genome/memory-write-authorization.ts";
import { getToolDisplayName } from "../shared/tool-display.ts";
import type { StoreAccess } from "../store/store-access.ts";
import { type ExecResult, type ExecutionEnvironment, renderReadFile } from "./execution-env.ts";
import { redactSensitiveTranscriptContent } from "./redaction.ts";
import {
	captureMarker,
	DEFAULT_PREVIEW_BUDGETS,
	resolvePreviewBudgets,
	truncateAtBudgetDetailed,
	truncateToolOutput,
	truncateToolOutputDetailed,
} from "./truncation.ts";
import {
	type AgentSpec,
	normalizeAgentConstraints,
	normalizeAgentOutputConfig,
	normalizeAgentPromptCacheConfig,
	normalizeAgentSamplingConfig,
	normalizeAgentTaskPayloadConfig,
	normalizeAgentThinkingConfig,
	type PrimitiveResult,
	validateAgentName,
} from "./types.ts";

const READ_FILE_LINE_PREFIX_NOTE =
	'read_file prefixes each line as "<line_number>\\t<line_text>"; remove everything through the first tab on each line before reusing text in edit_file or apply_patch.';

export interface GenomeContext {
	genome: Genome;
	agentName: string;
	sessionId: string;
	writeAuthorization?: MemoryWriteAuthorization;
}

export interface Primitive {
	name: string;
	displayName?: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		args: Record<string, unknown>,
		env: ExecutionEnvironment,
		signal?: AbortSignal,
	): Promise<PrimitiveResult>;
}

export interface PrimitiveRegistry {
	names(): string[];
	get(name: string): Primitive | undefined;
	register(prim: Primitive): void;
	/** Enable auto-capture of lossily-truncated output into this store. */
	setCaptureStore?(store: StoreAccess): void;
	execute(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<PrimitiveResult>;
}

export interface PrimitiveRegistryOptions {
	evalMode?: boolean;
	/**
	 * When false, the `exec` primitive is NOT provisioned — the agent has no
	 * shell/exec capability at all. A tree-wide capability strip: threaded to
	 * every agent in a session (root + delegated subprocesses) so a restricted
	 * run cannot reach exec by delegating to an exec-capable agent. Defaults to
	 * true (exec available). Enforced by the code-mode-cannot-exec canary.
	 */
	allowExec?: boolean;
	/** Preview budgets override (evals/tests); defaults resolve from the env. */
	previewBudgets?: Record<string, number>;
}

export function createPrimitiveRegistry(
	env: ExecutionEnvironment,
	genomeContext?: GenomeContext,
	options?: PrimitiveRegistryOptions,
): PrimitiveRegistry {
	const primitives = new Map<string, Primitive>();
	let captureStore: StoreAccess | undefined;
	const previewBudgets = options?.previewBudgets ?? resolvePreviewBudgets(process.env);

	for (const prim of buildPrimitives(options?.allowExec !== false)) {
		primitives.set(prim.name, prim);
	}

	if (genomeContext) {
		const workspacePrimitives = options?.evalMode
			? buildReadMemoryPrimitives(genomeContext)
			: buildWorkspacePrimitives(genomeContext);
		for (const prim of workspacePrimitives) {
			primitives.set(prim.name, prim);
		}
	}

	return {
		names: () => [...primitives.keys()],
		get: (name) => primitives.get(name),
		register: (prim) => primitives.set(prim.name, prim),
		setCaptureStore: (store) => {
			captureStore = store;
		},
		execute: async (name, args, signal?) => {
			const prim = primitives.get(name);
			if (!prim) {
				return { output: "", success: false, error: `Unknown primitive: ${name}` };
			}
			const result = await prim.execute(args, env, signal);
			// Value reads bypass the registry gate wholesale (sap spec §2): a
			// value read is a precision instrument whose own budgets ARE the
			// truncation policy, and it redacts output and errors at source.
			if (name.startsWith("value_")) {
				return result;
			}
			// captureSource stays inside the gate: it carries the raw, unredacted
			// content, and every path below spreads `redacted` — strip it once here.
			const { captureSource: source, ...passthrough } = result;
			const output = redactSensitiveTranscriptContent(passthrough.output);
			const redacted: PrimitiveResult = { ...passthrough, output };
			if (passthrough.error !== undefined) {
				redacted.error = redactSensitiveTranscriptContent(passthrough.error);
			}
			// The predicate (capture-all spec v10): the svelte/capture path
			// engages only when the result carries its source AND a capture store
			// exists — a svelte cut without a ref to compensate would destroy
			// information, so everything else keeps today's truncation limits.
			if (source === undefined || captureStore === undefined) {
				return { ...redacted, output: truncateToolOutput(output, name) };
			}
			const budget = previewBudgets[name] ?? previewBudgets.default ?? DEFAULT_PREVIEW_BUDGETS.default;
			// Chars-only trigger: below budget renders whole (no line shaping —
			// a sub-budget many-line output costs less to show than to capture).
			if (output.length <= budget) {
				return redacted;
			}
			const noun = name === "fetch" ? "body" : "content";
			const gauge = truncateAtBudgetDetailed(output, name, budget);
			const dropped = `${gauge.droppedChars} chars`;
			// An explicit bind already stored the source — never store it twice.
			// The marker points at the explicitly bound value instead.
			if (result.boundValues !== undefined && result.boundValues.length > 0) {
				const marker = captureMarker(dropped, ` — full ${noun}: ⟦${result.boundValues[0]!.name}⟧`);
				return {
					...redacted,
					output: truncateAtBudgetDetailed(output, name, budget, marker).text,
				};
			}
			try {
				const metadata = await captureStore.bind({
					name: `${name}_output`,
					content: source.content,
					type: source.type,
					// The channel forces agentHandleId to the connection's verified
					// identity; a direct-scope holder is the scope's owner.
					provenance: { agentHandleId: "", origin: { kind: "primitive", name } },
					explicit: false,
				});
				const boundValues = [{ name: metadata.name, ulid: metadata.ulid, size: metadata.size }];
				// Stderr the preview dropped binds as its own value. Containment
				// runs in REDACTED space: raw stderr can never match a redacted
				// preview, so a raw comparison would bind spurious companions.
				const redactedStderr =
					source.stderr === undefined || source.stderr === ""
						? undefined
						: redactSensitiveTranscriptContent(source.stderr);
				let tail = ` — full ${noun}: ⟦${metadata.name}⟧`;
				if (redactedStderr !== undefined && !gauge.text.includes(redactedStderr)) {
					// The companion bind fails ALONE: the main value is already
					// stored, so its marker must stand — a blanket failure banner
					// here would falsely claim nothing was captured.
					try {
						const stderrMetadata = await captureStore.bind({
							name: `${name}_output_stderr`,
							content: source.stderr as string,
							type: "text",
							provenance: { agentHandleId: "", origin: { kind: "primitive", name } },
							explicit: false,
						});
						boundValues.push({
							name: stderrMetadata.name,
							ulid: stderrMetadata.ulid,
							size: stderrMetadata.size,
						});
						tail = ` — full ${noun}: ⟦${metadata.name}⟧, stderr: ⟦${stderrMetadata.name}⟧`;
					} catch {
						// Stderr mention simply stays absent; the capture is honest.
					}
				}
				const marker = captureMarker(dropped, tail);
				return {
					...redacted,
					output: truncateAtBudgetDetailed(output, name, budget, marker).text,
					boundValues,
				};
			} catch (err) {
				// Capture failed → today's limits (principle 1: no svelte cut
				// without a ref). Under today's limit the output rides whole,
				// honestly unmarked; over it, lossy-but-honest — never a marker
				// naming a value that does not exist.
				const legacy = truncateToolOutputDetailed(output, name);
				if (!legacy.truncated) {
					return redacted;
				}
				const reason = err instanceof Error ? err.message : String(err);
				const legacyDropped =
					legacy.droppedLines > 0 ? `${legacy.droppedLines} lines` : `${legacy.droppedChars} chars`;
				const marker = captureMarker(
					legacyDropped,
					reason.includes("store full")
						? "; store full — content not captured"
						: "; capture failed — content not captured",
				);
				return {
					...redacted,
					output: truncateToolOutputDetailed(output, name, undefined, marker).text,
				};
			}
		},
	};
}

function buildPrimitives(allowExec = true): Primitive[] {
	return [
		readFilePrimitive(),
		writeFilePrimitive(),
		editFilePrimitive(),
		applyPatchPrimitive(),
		...(allowExec ? [execPrimitive()] : []),
		grepPrimitive(),
		globPrimitive(),
		fetchPrimitive(),
	];
}

function buildWorkspacePrimitives(ctx: GenomeContext): Primitive[] {
	return [
		saveToolPrimitive(ctx),
		saveFilePrimitive(ctx),
		saveAgentPrimitive(ctx),
		...buildReadMemoryPrimitives(ctx),
		...(ctx.agentName === "archivist" ? buildWriteMemoryPrimitives(ctx) : []),
	];
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

function readFilePrimitive(): Primitive {
	return {
		name: "read_file",
		displayName: getToolDisplayName("read_file"),
		description: `Read a file from the filesystem. Returns line-numbered content. ${READ_FILE_LINE_PREFIX_NOTE}`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file" },
				offset: { type: "integer", description: "1-based line number to start from" },
				limit: { type: "integer", description: "Max lines to read" },
			},
			required: ["path"],
		},
		async execute(args, env) {
			try {
				const options = {
					offset: args.offset as number | undefined,
					limit: args.limit as number | undefined,
				};
				// Prefer the raw surface: one read yields both the rendering and
				// the SOURCE bytes capture stores (sap spec §2).
				if (env.read_file_raw !== undefined) {
					const raw = await env.read_file_raw(args.path as string, options);
					return {
						output: renderReadFile(raw, options.offset ?? 1),
						success: true,
						captureSource: { content: raw, type: "text" as const },
					};
				}
				const content = await env.read_file(args.path as string, options);
				return { output: content, success: true };
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

function writeFilePrimitive(): Primitive {
	return {
		name: "write_file",
		displayName: getToolDisplayName("write_file"),
		description: "Write content to a file. Creates the file and parent directories if needed.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file" },
				content: { type: "string", description: "The full file content" },
			},
			required: ["path", "content"],
		},
		async execute(args, env) {
			try {
				const content = args.content as string;
				await env.write_file(args.path as string, content);
				return {
					output: `Wrote ${content.length} bytes to ${args.path}`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// edit_file (Anthropic/Gemini native format)
// ---------------------------------------------------------------------------

function editFilePrimitive(): Primitive {
	return {
		name: "edit_file",
		displayName: getToolDisplayName("edit_file"),
		description: `Replace an exact string occurrence in a file. old_string must match the raw file text exactly and must not include read_file line prefixes. ${READ_FILE_LINE_PREFIX_NOTE}`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to the file" },
				old_string: { type: "string", description: "Exact text to find" },
				new_string: { type: "string", description: "Replacement text" },
				replace_all: {
					type: "boolean",
					description: "Replace all occurrences (default: false)",
				},
			},
			required: ["path", "old_string", "new_string"],
		},
		async execute(args, env) {
			const path = args.path as string;
			const oldStr = args.old_string as string;
			const newStr = args.new_string as string;
			const replaceAll = (args.replace_all as boolean) ?? false;

			try {
				// Read raw content (not line-numbered)
				const fullPath = path.startsWith("/") ? path : join(env.working_directory(), path);
				const content = await readFile(fullPath, "utf-8");

				if (!content.includes(oldStr)) {
					return {
						output: "",
						success: false,
						error:
							`String not found in ${path}: "${oldStr.slice(0, 100)}". ` +
							READ_FILE_LINE_PREFIX_NOTE,
					};
				}

				if (!replaceAll) {
					// Check for ambiguous match
					const firstIdx = content.indexOf(oldStr);
					const secondIdx = content.indexOf(oldStr, firstIdx + 1);
					if (secondIdx !== -1) {
						return {
							output: "",
							success: false,
							error:
								`Ambiguous match: "${oldStr.slice(0, 100)}" appears multiple times in ${path}. ` +
								`Use replace_all=true or provide more context to make the match unique.`,
						};
					}
				}

				const updated = replaceAll
					? content.replaceAll(oldStr, newStr)
					: content.replace(oldStr, newStr);
				await env.write_file(path, updated);

				const count = replaceAll ? content.split(oldStr).length - 1 : 1;

				return {
					output: `Replaced ${count} occurrence(s) in ${path}`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// apply_patch (OpenAI v4a format)
// ---------------------------------------------------------------------------

function applyPatchPrimitive(): Primitive {
	return {
		name: "apply_patch",
		displayName: getToolDisplayName("apply_patch"),
		description:
			"Apply code changes using the v4a patch format. Supports creating, deleting, updating, and renaming files.",
		parameters: {
			type: "object",
			properties: {
				patch: { type: "string", description: "Patch content in v4a format" },
			},
			required: ["patch"],
		},
		async execute(args, env) {
			const patch = args.patch as string;
			try {
				const results = await applyV4aPatch(patch, env);
				return {
					output: results.join("\n"),
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

interface PatchOperation {
	type: "add" | "delete" | "update";
	path: string;
	moveTo?: string;
	content?: string; // for add
	hunks?: PatchHunk[]; // for update
}

interface PatchHunk {
	contextHint: string;
	lines: HunkLine[];
}

interface HunkLine {
	type: "context" | "delete" | "add";
	content: string;
}

function parseV4aPatch(patch: string): PatchOperation[] {
	const lines = patch.split("\n");
	const ops: PatchOperation[] = [];

	let i = 0;

	// Skip to "*** Begin Patch"
	while (i < lines.length && lines[i]?.trim() !== "*** Begin Patch") i++;
	if (i >= lines.length) throw new Error("Invalid patch: missing '*** Begin Patch'");
	i++;

	while (i < lines.length) {
		const line = lines[i]!;

		if (line.trim() === "*** End Patch") break;

		if (line.startsWith("*** Add File: ")) {
			const path = line.slice("*** Add File: ".length).trim();
			i++;
			const contentLines: string[] = [];
			while (i < lines.length && !lines[i]!.startsWith("***")) {
				const l = lines[i]!;
				if (l.startsWith("+")) {
					contentLines.push(l.slice(1));
				}
				i++;
			}
			ops.push({ type: "add", path, content: contentLines.join("\n") });
		} else if (line.startsWith("*** Delete File: ")) {
			const path = line.slice("*** Delete File: ".length).trim();
			ops.push({ type: "delete", path });
			i++;
		} else if (line.startsWith("*** Update File: ")) {
			const path = line.slice("*** Update File: ".length).trim();
			i++;

			let moveTo: string | undefined;
			if (i < lines.length && lines[i]!.startsWith("*** Move to: ")) {
				moveTo = lines[i]!.slice("*** Move to: ".length).trim();
				i++;
			}

			const hunks: PatchHunk[] = [];
			while (i < lines.length && !lines[i]!.startsWith("***")) {
				const hunkLine = lines[i]!;
				if (hunkLine.startsWith("@@ ")) {
					const contextHint = hunkLine.slice(3).trim();
					i++;
					const hunkLines: HunkLine[] = [];
					while (i < lines.length && !lines[i]!.startsWith("@@ ") && !lines[i]!.startsWith("***")) {
						const hl = lines[i]!;
						if (hl.startsWith(" ")) {
							hunkLines.push({ type: "context", content: hl.slice(1) });
						} else if (hl.startsWith("-")) {
							hunkLines.push({ type: "delete", content: hl.slice(1) });
						} else if (hl.startsWith("+")) {
							hunkLines.push({ type: "add", content: hl.slice(1) });
						}
						i++;
					}
					hunks.push({ contextHint, lines: hunkLines });
				} else {
					i++;
				}
			}
			ops.push({ type: "update", path, moveTo, hunks });
		} else {
			i++;
		}
	}

	if (ops.length === 0) {
		throw new Error("Invalid patch: no operations found");
	}

	return ops;
}

async function applyV4aPatch(patch: string, env: ExecutionEnvironment): Promise<string[]> {
	const ops = parseV4aPatch(patch);
	const results: string[] = [];

	for (const op of ops) {
		if (op.type === "add") {
			await env.write_file(op.path, op.content ?? "");
			results.push(`Created ${op.path}`);
		} else if (op.type === "delete") {
			const fullPath = op.path.startsWith("/") ? op.path : join(env.working_directory(), op.path);
			await unlink(fullPath);
			results.push(`Deleted ${op.path}`);
		} else if (op.type === "update") {
			const fullPath = op.path.startsWith("/") ? op.path : join(env.working_directory(), op.path);
			let content = await readFile(fullPath, "utf-8");

			for (const hunk of op.hunks ?? []) {
				content = applyHunk(content, hunk);
			}

			const targetPath = op.moveTo ?? op.path;
			await env.write_file(targetPath, content);

			if (op.moveTo && op.moveTo !== op.path) {
				await unlink(fullPath);
				results.push(`Updated and renamed ${op.path} -> ${op.moveTo}`);
			} else {
				results.push(`Updated ${op.path}`);
			}
		}
	}

	return results;
}

function applyHunk(content: string, hunk: PatchHunk): string {
	const fileLines = content.split("\n");

	// Build the search pattern from context + delete lines
	const searchLines: string[] = [];
	for (const line of hunk.lines) {
		if (line.type === "context" || line.type === "delete") {
			searchLines.push(line.content);
		}
	}

	// Find the match position
	const matchIdx = findMatchPosition(fileLines, searchLines);
	if (matchIdx === -1) {
		throw new Error(`Patch hunk failed: could not find matching context for "${hunk.contextHint}"`);
	}

	// Build replacement lines
	const replacementLines: string[] = [];
	for (const line of hunk.lines) {
		if (line.type === "context" || line.type === "add") {
			replacementLines.push(line.content);
		}
		// delete lines are omitted
	}

	// Splice
	fileLines.splice(matchIdx, searchLines.length, ...replacementLines);
	return fileLines.join("\n");
}

function findMatchPosition(fileLines: string[], searchLines: string[]): number {
	if (searchLines.length === 0) return -1;

	for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
		let match = true;
		for (let j = 0; j < searchLines.length; j++) {
			if (fileLines[i + j]?.trimEnd() !== searchLines[j]?.trimEnd()) {
				match = false;
				break;
			}
		}
		if (match) return i;
	}
	return -1;
}

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

/** Render an ExecResult as exec's tool output. */
function renderExecResult(result: ExecResult): string {
	return [
		result.stdout,
		result.stderr ? `[stderr]\n${result.stderr}` : "",
		`exit_code: ${result.exit_code}`,
		`duration_ms: ${result.duration_ms}`,
		result.timed_out ? "[TIMED OUT]" : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Success/error judgment for an ExecResult. */
function execResultStatus(result: ExecResult): { success: boolean; error?: string } {
	return {
		success: result.exit_code === 0 && !result.timed_out,
		error:
			result.exit_code !== 0
				? `Command exited with code ${result.exit_code}`
				: result.timed_out
					? "Command timed out"
					: undefined,
	};
}

function execPrimitive(): Primitive {
	return {
		name: "exec",
		displayName: getToolDisplayName("exec"),
		description: "Execute a bash command. Returns stdout, stderr, and exit code.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The command to run" },
				cwd: { type: "string", description: "Working directory for the command" },
				working_dir: { type: "string", description: "Working directory for the command" },
				timeout_ms: { type: "integer", description: "Override default timeout" },
			},
			required: ["command"],
		},
		async execute(args, env, signal?) {
			try {
				const result = await env.exec_command(args.command as string, {
					working_dir: (args.cwd as string | undefined) ?? (args.working_dir as string | undefined),
					timeout_ms: args.timeout_ms as number | undefined,
					signal,
				});

				return {
					output: renderExecResult(result),
					...execResultStatus(result),
					// Capture stores SOURCE bytes: raw stdout, raw stderr separately.
					captureSource: {
						content: result.stdout,
						type: "text" as const,
						...(result.stderr !== "" ? { stderr: result.stderr } : {}),
					},
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

function grepPrimitive(): Primitive {
	return {
		name: "grep",
		displayName: getToolDisplayName("grep"),
		description: "Search file contents using literal text.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Literal text to search for" },
				path: { type: "string", description: "Directory or file to search" },
				glob_filter: { type: "string", description: "File pattern filter (e.g., '*.py')" },
				max_results: { type: "integer", description: "Max results (default: 100)" },
			},
			required: ["pattern"],
		},
		async execute(args, env) {
			try {
				const options = {
					glob_filter: args.glob_filter as string | undefined,
					max_results: (args.max_results as number) ?? 100,
				};
				// Prefer the structured surface: one search yields both the
				// rendering and the structured matches capture stores as JSON.
				if (env.grep_structured !== undefined) {
					const matches = await env.grep_structured(
						args.pattern as string,
						args.path as string | undefined,
						options,
					);
					return {
						output: matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n"),
						success: true,
						captureSource: { content: JSON.stringify(matches), type: "json" as const },
					};
				}
				const result = await env.grep(
					args.pattern as string,
					args.path as string | undefined,
					options,
				);
				return { output: result, success: true };
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

function globPrimitive(): Primitive {
	return {
		name: "glob",
		displayName: getToolDisplayName("glob"),
		description: "Find files matching a glob pattern.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Glob pattern (e.g., '**/*.ts')" },
				path: { type: "string", description: "Base directory" },
			},
			required: ["pattern"],
		},
		async execute(args, env) {
			try {
				const files = await env.glob(args.pattern as string, args.path as string | undefined);
				const listing = files.join("\n");
				return {
					output: listing,
					success: true,
					captureSource: { content: listing, type: "text" as const },
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/** One fetch's structured outcome; the raw body feeds captureSource. */
interface FetchOutcome {
	status: number;
	statusText: string;
	ok: boolean;
	headers: Record<string, string>;
	body: string;
}

/** Perform the fetch primitive's request once, structurally. */
async function performFetch(args: Record<string, unknown>): Promise<FetchOutcome> {
	const response = await fetch(args.url as string, {
		method: (args.method as string) ?? "GET",
		headers: args.headers as Record<string, string> | undefined,
		body: args.body as string | undefined,
	});
	return {
		status: response.status,
		statusText: response.statusText,
		ok: response.ok,
		headers: Object.fromEntries(response.headers.entries()),
		body: await response.text(),
	};
}

/** Render a FetchOutcome as fetch's tool output. */
function renderFetchResponse(outcome: FetchOutcome): string {
	return [
		`status: ${outcome.status}`,
		`headers: ${JSON.stringify(outcome.headers)}`,
		"",
		outcome.body,
	].join("\n");
}

function fetchPrimitive(): Primitive {
	return {
		name: "fetch",
		displayName: getToolDisplayName("fetch"),
		description: "Make an HTTP request.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "URL to fetch" },
				method: { type: "string", description: "HTTP method (default: GET)" },
				headers: {
					type: "object",
					description: "HTTP headers",
					additionalProperties: { type: "string" },
				},
				body: { type: "string", description: "Request body" },
			},
			required: ["url"],
		},
		async execute(args, _env) {
			try {
				const outcome = await performFetch(args);
				return {
					output: renderFetchResponse(outcome),
					success: outcome.ok,
					error: outcome.ok ? undefined : `HTTP ${outcome.status}: ${outcome.statusText}`,
					// Capture stores the raw body, never the status/header rendering.
					captureSource: { content: outcome.body, type: "text" as const },
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// save_tool (workspace)
// ---------------------------------------------------------------------------

function saveToolPrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_tool",
		displayName: getToolDisplayName("save_tool"),
		description:
			"Save an executable script to your workspace. The tool persists across sessions and becomes part of your capabilities.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Tool name (used as filename, e.g. 'run-tests')" },
				description: { type: "string", description: "What this tool does" },
				script: { type: "string", description: "The script content (bash, python, node, etc.)" },
				interpreter: {
					type: "string",
					description: "Script interpreter (e.g. 'bash', 'python3', 'node'). Default: 'bash'",
				},
			},
			required: ["name", "description", "script"],
		},
		async execute(args) {
			const name = args.name as string;
			const description = args.description as string;
			const script = args.script as string | undefined;
			const interpreter = args.interpreter as string | undefined;

			if (!name || !description) {
				return {
					output: "",
					success: false,
					error: "Missing required parameters: name, description",
				};
			}
			if (!script) {
				return { output: "", success: false, error: "Missing required parameter: script" };
			}

			try {
				await ctx.genome.saveAgentTool(ctx.agentName, {
					name,
					description,
					script,
					interpreter,
				});
				return {
					output: `Saved tool '${name}' to workspace. It will be available in future sessions.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// save_file (workspace)
// ---------------------------------------------------------------------------

function saveFilePrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_file",
		displayName: getToolDisplayName("save_file"),
		description:
			"Save a reference file to your workspace. Files persist across sessions and can be read with read_file.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Filename (e.g. 'style-guide.md')" },
				content: { type: "string", description: "File content" },
			},
			required: ["name", "content"],
		},
		async execute(args) {
			const name = args.name as string;
			const content = args.content as string | undefined;

			if (!name) {
				return { output: "", success: false, error: "Missing required parameter: name" };
			}
			if (content === undefined || content === null) {
				return { output: "", success: false, error: "Missing required parameter: content" };
			}

			try {
				await ctx.genome.saveAgentFile(ctx.agentName, { name, content: content as string });
				return {
					output: `Saved file '${name}' to workspace.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

function saveAgentPrimitive(ctx: GenomeContext): Primitive {
	return {
		name: "save_agent",
		displayName: getToolDisplayName("save_agent"),
		description:
			"Save a new agent definition to the genome. The agent becomes available for delegation immediately and persists across sessions.",
		parameters: {
			type: "object",
			properties: {
				spec: {
					type: "string",
					description:
						"Complete agent definition as YAML. Must include: name, description, model, system_prompt. Optional: tools, agents, constraints, sampling, output, task_payload, tags, version.",
				},
			},
			required: ["spec"],
		},
		async execute(args) {
			const spec = args.spec as string;
			if (!spec) {
				return { output: "", success: false, error: "Missing required parameter: spec" };
			}

			try {
				const raw = parseYaml(spec);

				for (const field of ["name", "description", "system_prompt", "model"]) {
					if (!raw[field] || typeof raw[field] !== "string") {
						return {
							output: "",
							success: false,
							error: `Invalid agent spec: missing or invalid '${field}'`,
						};
					}
				}

				validateAgentName(raw.name as string);

				if (raw.capabilities !== undefined) {
					return {
						output: "",
						success: false,
						error:
							"Invalid agent spec: 'capabilities' was removed; use explicit 'tools' and 'agents' fields",
					};
				}
				if (raw.requires_tool_use !== undefined) {
					return {
						output: "",
						success: false,
						error:
							"Invalid agent spec: 'requires_tool_use' belongs under 'constraints.requires_tool_use'",
					};
				}

				const tools: string[] = raw.tools ?? [];
				const agents: string[] = raw.agents ?? [];
				const source = `save_agent spec for '${raw.name as string}'`;
				const agentSpec: AgentSpec = {
					name: raw.name as string,
					description: raw.description as string,
					system_prompt: raw.system_prompt as string,
					model: raw.model as string,
					tools,
					agents,
					constraints: normalizeAgentConstraints(raw.constraints, source),
					tags: (raw.tags as string[]) ?? [],
					version: (raw.version as number) ?? 1,
				};
				if (raw.thinking !== undefined) {
					agentSpec.thinking = normalizeAgentThinkingConfig(raw.thinking, source);
				}
				if (raw.sampling !== undefined) {
					agentSpec.sampling = normalizeAgentSamplingConfig(raw.sampling, source);
				}
				if (raw.output !== undefined) {
					agentSpec.output = normalizeAgentOutputConfig(raw.output, source);
				}
				if (raw.task_payload !== undefined) {
					agentSpec.task_payload = normalizeAgentTaskPayloadConfig(raw.task_payload, source);
				}
				if (raw.prompt_cache !== undefined) {
					agentSpec.prompt_cache = normalizeAgentPromptCacheConfig(raw.prompt_cache, source);
				}

				await ctx.genome.addAgent(agentSpec);
				return {
					output: `Agent '${agentSpec.name}' saved and registered. It is available for delegation immediately.`,
					success: true,
				};
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

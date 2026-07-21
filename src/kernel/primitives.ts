import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getToolDisplayName } from "../shared/tool-display.ts";
import type { StoreAccess } from "../store/store-access.ts";
import { applyPatchPrimitive } from "./apply-patch.ts";
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
import type { PrimitiveResult } from "./types.ts";
import { buildGenomePrimitives, type GenomeContext } from "./workspace-primitives.ts";

const READ_FILE_LINE_PREFIX_NOTE =
	'read_file prefixes each line as "<line_number>\\t<line_text>"; remove everything through the first tab on each line before reusing text in edit_file or apply_patch.';

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
		for (const prim of buildGenomePrimitives(genomeContext, options?.evalMode === true)) {
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
			const budget =
				previewBudgets[name] ?? previewBudgets.default ?? DEFAULT_PREVIEW_BUDGETS.default;
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

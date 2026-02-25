import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Genome } from "../genome/genome.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";
import { truncateToolOutput } from "./truncation.ts";
import type { PrimitiveResult } from "./types.ts";

export interface GenomeContext {
	genome: Genome;
	agentName: string;
}

export interface Primitive {
	name: string;
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
	execute(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<PrimitiveResult>;
}

export function createPrimitiveRegistry(
	env: ExecutionEnvironment,
	genomeContext?: GenomeContext,
): PrimitiveRegistry {
	const primitives = new Map<string, Primitive>();

	for (const prim of buildPrimitives(env)) {
		primitives.set(prim.name, prim);
	}

	if (genomeContext) {
		for (const prim of buildWorkspacePrimitives(genomeContext)) {
			primitives.set(prim.name, prim);
		}
	}

	return {
		names: () => [...primitives.keys()],
		get: (name) => primitives.get(name),
		register: (prim) => primitives.set(prim.name, prim),
		execute: async (name, args, signal?) => {
			const prim = primitives.get(name);
			if (!prim) {
				return { output: "", success: false, error: `Unknown primitive: ${name}` };
			}
			const result = await prim.execute(args, env, signal);
			// Truncate output for LLM consumption
			return {
				...result,
				output: truncateToolOutput(result.output, name),
			};
		},
	};
}

function buildPrimitives(_env: ExecutionEnvironment): Primitive[] {
	return [
		readFilePrimitive(),
		writeFilePrimitive(),
		editFilePrimitive(),
		applyPatchPrimitive(),
		execPrimitive(),
		grepPrimitive(),
		globPrimitive(),
		fetchPrimitive(),
	];
}

export function buildWorkspacePrimitives(ctx: GenomeContext): Primitive[] {
	return [saveToolPrimitive(ctx), saveFilePrimitive(ctx)];
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

function readFilePrimitive(): Primitive {
	return {
		name: "read_file",
		description: "Read a file from the filesystem. Returns line-numbered content.",
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
				const content = await env.read_file(args.path as string, {
					offset: args.offset as number | undefined,
					limit: args.limit as number | undefined,
				});
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
		description: "Replace an exact string occurrence in a file.",
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
						error: `String not found in ${path}: "${oldStr.slice(0, 100)}"`,
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

function execPrimitive(): Primitive {
	return {
		name: "exec",
		description: "Execute a shell command. Returns stdout, stderr, and exit code.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The command to run" },
				timeout_ms: { type: "integer", description: "Override default timeout" },
			},
			required: ["command"],
		},
		async execute(args, env, signal?) {
			try {
				const result = await env.exec_command(args.command as string, {
					timeout_ms: args.timeout_ms as number | undefined,
					signal,
				});

				const output = [
					result.stdout,
					result.stderr ? `[stderr]\n${result.stderr}` : "",
					`exit_code: ${result.exit_code}`,
					`duration_ms: ${result.duration_ms}`,
					result.timed_out ? "[TIMED OUT]" : "",
				]
					.filter(Boolean)
					.join("\n");

				return {
					output,
					success: result.exit_code === 0 && !result.timed_out,
					error:
						result.exit_code !== 0
							? `Command exited with code ${result.exit_code}`
							: result.timed_out
								? "Command timed out"
								: undefined,
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
		description: "Search file contents using regex patterns.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regex pattern" },
				path: { type: "string", description: "Directory or file to search" },
				glob_filter: { type: "string", description: "File pattern filter (e.g., '*.py')" },
				max_results: { type: "integer", description: "Max results (default: 100)" },
			},
			required: ["pattern"],
		},
		async execute(args, env) {
			try {
				const result = await env.grep(args.pattern as string, args.path as string | undefined, {
					glob_filter: args.glob_filter as string | undefined,
					max_results: (args.max_results as number) ?? 100,
				});
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
				return { output: files.join("\n"), success: true };
			} catch (err) {
				return { output: "", success: false, error: String(err) };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

function fetchPrimitive(): Primitive {
	return {
		name: "fetch",
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
				const response = await fetch(args.url as string, {
					method: (args.method as string) ?? "GET",
					headers: args.headers as Record<string, string> | undefined,
					body: args.body as string | undefined,
				});
				const body = await response.text();
				const output = [
					`status: ${response.status}`,
					`headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`,
					"",
					body,
				].join("\n");

				return {
					output,
					success: response.ok,
					error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
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

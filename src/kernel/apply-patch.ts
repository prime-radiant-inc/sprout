/**
 * The apply_patch primitive: parser and applier for the OpenAI v4a patch
 * format (Add/Delete/Update File operations with @@-context hunks).
 */
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getToolDisplayName } from "../shared/tool-display.ts";
import type { ExecutionEnvironment } from "./execution-env.ts";
import type { Primitive } from "./primitives.ts";

export function applyPatchPrimitive(): Primitive {
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

/** Patch paths resolve against the env's working directory when relative. */
function resolveAgainstWorkdir(env: ExecutionEnvironment, path: string): string {
	return path.startsWith("/") ? path : join(env.working_directory(), path);
}

async function applyV4aPatch(patch: string, env: ExecutionEnvironment): Promise<string[]> {
	const ops = parseV4aPatch(patch);
	const results: string[] = [];

	for (const op of ops) {
		if (op.type === "add") {
			await env.write_file(op.path, op.content ?? "");
			results.push(`Created ${op.path}`);
		} else if (op.type === "delete") {
			await unlink(resolveAgainstWorkdir(env, op.path));
			results.push(`Deleted ${op.path}`);
		} else if (op.type === "update") {
			const fullPath = resolveAgainstWorkdir(env, op.path);
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

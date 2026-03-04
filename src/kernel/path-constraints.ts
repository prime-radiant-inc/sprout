import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConstraints } from "./types.js";

/** Primitives that write to file paths */
const WRITE_PRIMITIVES = new Set(["write_file", "edit_file", "apply_patch"]);

/**
 * Resolve a path the same way ExecutionEnvironment does:
 * - Absolute paths returned as-is
 * - ~ expanded to homedir
 * - Relative paths resolved against workDir
 */
export function resolvePath(path: string, workDir: string): string {
	if (path.startsWith("/")) return path;
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	if (path === "~") return homedir();
	return resolve(workDir, path);
}

/**
 * Check if a primitive call is allowed given the agent's path constraints.
 * Returns null if allowed, or an error message string if denied.
 *
 * Paths are resolved before matching so that ~, relative, and absolute paths
 * all compare correctly against the constraint patterns.
 */
export function checkPathConstraint(
	primitiveName: string,
	args: Record<string, unknown>,
	constraints: AgentConstraints,
	workDir: string,
): string | null {
	if (!constraints.allowed_write_paths) return null;
	if (!WRITE_PRIMITIVES.has(primitiveName)) return null;

	// Resolve constraint patterns too, so ~/... in constraints matches correctly
	const resolvedPatterns = constraints.allowed_write_paths.map((p) => resolvePath(p, workDir));

	if (primitiveName === "apply_patch") {
		const rawPatch = args.patch;
		if (typeof rawPatch !== "string") return null;

		for (const rawPath of extractPatchWritePaths(rawPatch)) {
			const resolved = resolvePath(rawPath, workDir);
			if (!matchesAny(resolved, resolvedPatterns)) {
				return `Write access denied: "${rawPath}" (resolved: ${resolved}) is not in allowed_write_paths`;
			}
		}
		return null;
	}

	const rawPath = args.path as string | undefined;
	if (!rawPath) return null;
	const resolved = resolvePath(rawPath, workDir);
	if (!matchesAny(resolved, resolvedPatterns)) {
		return `Write access denied: "${rawPath}" (resolved: ${resolved}) is not in allowed_write_paths`;
	}

	return null;
}

function matchesAny(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

/**
 * Extract every file path touched by an apply_patch payload.
 * Includes add/delete/update paths plus rename targets (`*** Move to`).
 */
function extractPatchWritePaths(patch: string): string[] {
	const paths = new Set<string>();
	const lines = patch.split("\n");

	for (const line of lines) {
		if (line.startsWith("*** Add File: ")) {
			paths.add(line.slice("*** Add File: ".length).trim());
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			paths.add(line.slice("*** Delete File: ".length).trim());
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			paths.add(line.slice("*** Update File: ".length).trim());
			continue;
		}
		if (line.startsWith("*** Move to: ")) {
			paths.add(line.slice("*** Move to: ".length).trim());
		}
	}

	return [...paths].filter((p) => p.length > 0);
}

/**
 * Validate that an agent's constraints are compatible with its tools.
 * Throws if allowed_write_paths is set but the agent has exec (which can bypass it).
 */
export function validateConstraints(
	agentName: string,
	tools: string[],
	constraints: AgentConstraints,
): void {
	if (constraints.allowed_write_paths && tools.includes("exec")) {
		throw new Error(
			`Agent "${agentName}" has allowed_write_paths but also has exec capability. ` +
				`exec can bypass write restrictions. Remove exec or remove allowed_write_paths.`,
		);
	}
}

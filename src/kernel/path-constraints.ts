import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConstraints } from "./types.js";

/** Primitives that write to file paths */
const WRITE_PRIMITIVES = new Set(["write_file", "edit_file"]);

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

	const rawPath = args.path as string | undefined;
	if (!rawPath) return null;

	const resolved = resolvePath(rawPath, workDir);

	// Resolve constraint patterns too, so ~/... in constraints matches correctly
	const resolvedPatterns = constraints.allowed_write_paths.map((p) => resolvePath(p, workDir));

	if (!matchesAny(resolved, resolvedPatterns)) {
		return `Write access denied: "${rawPath}" (resolved: ${resolved}) is not in allowed_write_paths`;
	}

	return null;
}

function matchesAny(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

/**
 * Validate that an agent's constraints are compatible with its capabilities.
 * Throws if allowed_write_paths is set but the agent has exec (which can bypass it).
 */
export function validateConstraints(
	agentName: string,
	capabilities: string[],
	constraints: AgentConstraints,
): void {
	if (constraints.allowed_write_paths && capabilities.includes("exec")) {
		throw new Error(
			`Agent "${agentName}" has allowed_write_paths but also has exec capability. ` +
				`exec can bypass write restrictions. Remove exec or remove allowed_write_paths.`,
		);
	}
}

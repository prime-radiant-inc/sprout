import type { AgentConstraints } from "./types.js";

/** Primitives that read from paths */
const READ_PRIMITIVES = new Set(["read_file", "grep", "glob"]);

/** Primitives that write to paths */
const WRITE_PRIMITIVES = new Set(["write_file", "edit_file"]);

/**
 * Check if a primitive call is allowed given the agent's path constraints.
 * Returns null if allowed, or an error message string if denied.
 */
export function checkPathConstraint(
	primitiveName: string,
	args: Record<string, unknown>,
	constraints: AgentConstraints,
): string | null {
	const path = args.path as string | undefined;
	if (!path) return null; // No path argument — nothing to restrict

	if (READ_PRIMITIVES.has(primitiveName) && constraints.allowed_read_paths) {
		if (!matchesAny(path, constraints.allowed_read_paths)) {
			return `Path access denied: "${path}" is not in allowed_read_paths for this agent`;
		}
	}

	if (WRITE_PRIMITIVES.has(primitiveName) && constraints.allowed_write_paths) {
		if (!matchesAny(path, constraints.allowed_write_paths)) {
			return `Path access denied: "${path}" is not in allowed_write_paths for this agent`;
		}
	}

	return null;
}

function matchesAny(path: string, patterns: string[]): boolean {
	return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

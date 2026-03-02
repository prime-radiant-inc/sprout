import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Convert a directory path into a project slug.
 * Mirrors Claude Code's convention: slashes and spaces become hyphens.
 * e.g. "/Users/jesse/prime-radiant/sprout" → "-Users-jesse-prime-radiant-sprout"
 */
export function slugifyPath(dirPath: string): string {
	return dirPath.replace(/[\s/]/g, "-");
}

/**
 * Resolve the project data directory inside the genome.
 * Layout: $GENOME/projects/$SLUG/  (contains sessions/, logs/, memory/)
 */
export function projectDataDir(genomePath: string, projectDir: string): string {
	return join(genomePath, "projects", slugifyPath(projectDir));
}

/**
 * Ensure the project data directory structure exists.
 * Creates sessions/, logs/, and memory/ subdirectories.
 */
export async function ensureProjectDirs(dataDir: string): Promise<void> {
	await mkdir(join(dataDir, "sessions"), { recursive: true });
	await mkdir(join(dataDir, "logs"), { recursive: true });
	await mkdir(join(dataDir, "memory"), { recursive: true });
}

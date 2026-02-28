import { existsSync } from "node:fs";
import { join } from "node:path";

/** Sentinel marker embedded in dev-mode postscripts for idempotency checks. */
export const DEV_MODE_SENTINEL = "<!-- sprout:dev-mode-postscript -->";

/**
 * Detect whether sprout is running inside its own source tree.
 * True when the working directory contains both bootstrap/ and src/genome/.
 */
export function isDevMode(workDir: string): boolean {
	return existsSync(join(workDir, "bootstrap")) && existsSync(join(workDir, "src", "genome"));
}

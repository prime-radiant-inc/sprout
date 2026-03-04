import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

let loaded = false;

/**
 * Load test env vars from repo-local files only.
 * Order: .env.test.local -> .env.test -> .env
 */
export function loadTestEnv(): void {
	if (loaded) return;
	loaded = true;

	const repoRoot = join(import.meta.dir, "../..");
	const candidates = [
		join(repoRoot, ".env.test.local"),
		join(repoRoot, ".env.test"),
		join(repoRoot, ".env"),
	];

	for (const path of candidates) {
		if (existsSync(path)) {
			config({ path, override: false });
		}
	}
}

loadTestEnv();

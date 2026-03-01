import { access } from "node:fs/promises";
import { join } from "node:path";

/** Sentinel marker embedded in dev-mode postscripts for idempotency checks. */
export const DEV_MODE_SENTINEL = "<!-- sprout:dev-mode-postscript -->";

/** Postscript injected into the quartermaster when running in dev mode. */
export const DEV_MODE_POSTSCRIPT = `${DEV_MODE_SENTINEL}
## Development Mode

You are running inside sprout's own source tree. Changes you make affect
two distinct targets:

1. **Runtime genome** (\`save_agent\` tool) — changes take effect immediately
   for this sprout instance. Use for experimentation and runtime adaptation.

2. **Root source** (files in \`root/\`) — changes here become the
   default for all new sprout genomes. Use when an improvement should ship
   as part of the product.

When the fabricator creates or modifies an agent:
- Default to runtime genome (save_agent) for new experimental agents
- When an improvement is proven (evaluated as helpful), suggest promoting
  it to root via a file write to the appropriate path under root/agents/
- Always note which target was used in your response

The \`--genome export\` command can also harvest runtime improvements into
root for human review.`;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Detect whether sprout is running inside its own source tree.
 * True when the working directory contains both root/ and src/genome/.
 */
export async function isDevMode(workDir: string): Promise<boolean> {
	const [hasRoot, hasGenome] = await Promise.all([
		exists(join(workDir, "root")),
		exists(join(workDir, "src", "genome")),
	]);
	return hasRoot && hasGenome;
}

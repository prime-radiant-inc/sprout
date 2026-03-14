import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const distDir = join(repoRoot, "tools/harbor/dist");
const entrypoint = join(repoRoot, "src", "host", "cli.ts");

async function main(): Promise<void> {
	await run([Bun.which("bun") ?? process.execPath, "run", "scripts/generate-embedded-root.ts"]);

	await rm(distDir, { recursive: true, force: true });
	await mkdir(distDir, { recursive: true });

	await buildBinary("bun-linux-x64", join(distDir, "sprout-linux-x64"));
	await buildBinary("bun-linux-arm64", join(distDir, "sprout-linux-arm64"));
}

async function buildBinary(target: string, outfile: string): Promise<void> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outfile,
		target: "bun",
		format: "esm",
		sourcemap: "none",
		minify: true,
		compile: {
			target,
			outfile,
		},
	});

	if (!result.success) {
		const messages = result.logs.map((log) => log.message).join("\n");
		throw new Error(`Failed to build ${target} binary:\n${messages}`);
	}
}

async function run(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
	}
}

await main();

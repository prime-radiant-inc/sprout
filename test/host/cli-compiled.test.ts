import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

describe("compiled cli entrypoint", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("compiled cli responds to --help promptly", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "sprout-cli-compiled-"));
		tempDirs.push(tempDir);
		const outfile = join(tempDir, "sprout-test");

		const build = Bun.spawn(
			["bun", "build", "src/host/cli.ts", "--compile", "--outfile", outfile],
			{
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const buildExitCode = await build.exited;
		const buildStderr = await new Response(build.stderr).text();

		expect(buildExitCode, buildStderr).toBe(0);

		const proc = Bun.spawn([outfile, "--help"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});

		const timedOut = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				proc.kill();
				resolve(true);
			}, 10_000);
			void proc.exited.then(() => {
				clearTimeout(timer);
				resolve(false);
			});
		});

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		expect(timedOut, stderr).toBe(false);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("Usage: sprout [options]");
	}, 20_000);
});

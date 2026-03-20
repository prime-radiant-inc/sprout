import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "../fixtures/emit-json-and-exit.ts");

async function run(mode?: "stderr") {
	const proc = Bun.spawn(["bun", "run", HELPER, ...(mode ? [mode] : [])], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("bun child exit flush repro", () => {
	// This canary protects the repo harness against Bun's bare-relative test-path
	// bug. It passes when the harness feeds Bun "./test/..." paths.
	test("stdout survives immediate process.exit", async () => {
		const result = await run();

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ ok: true });
		expect(result.stderr).toBe("");
	});

	test("stderr survives immediate process.exit", async () => {
		const result = await run("stderr");

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toEqual({ ok: false });
	});
});

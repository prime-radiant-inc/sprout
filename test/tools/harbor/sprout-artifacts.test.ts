import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

async function expectFile(path: string): Promise<void> {
	await access(path, constants.R_OK);
}

describe("Sprout Harbor artifacts", () => {
	test("build script exists", async () => {
		await expectFile(join(repoRoot, "scripts", "build-sprout-binary.ts"));
	});

	test("harbor adapter directory contains the expected files", async () => {
		await expectFile(join(repoRoot, "tools", "harbor", "sprout_agent.py"));
		await expectFile(join(repoRoot, "tools", "harbor", "install-sprout.sh.j2"));
		await expectFile(join(repoRoot, "tools", "harbor", "README.md"));
	});

	test("build script targets tools/harbor/dist", async () => {
		const script = await readFile(join(repoRoot, "scripts", "build-sprout-binary.ts"), "utf-8");
		expect(script).toContain("tools/harbor/dist");
	});

	test("adapter command includes the headless eval flags", async () => {
		const adapter = await readFile(join(repoRoot, "tools", "harbor", "sprout_agent.py"), "utf-8");
		expect(adapter).toContain("--prompt");
		expect(adapter).toContain("--log-atif /logs/agent/agent-state/trajectory.json");
		expect(adapter).toContain("--eval-mode");
		expect(adapter).toContain("--genome-path /logs/agent/agent-state/genome");
	});

	test("python adapter syntax is valid when python3 is available", async () => {
		if (!Bun.which("python3")) return;
		const proc = Bun.spawn(["python3", "-m", "py_compile", "tools/harbor/sprout_agent.py"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();
		expect(exitCode, stderr).toBe(0);
	});
});

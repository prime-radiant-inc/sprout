import { describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
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
		expect(script).toContain(
			'buildBinary("bun-linux-x64-baseline", join(distDir, "sprout-linux-x64"))',
		);
		expect(script).toContain('buildBinary("bun-linux-arm64", join(distDir, "sprout-linux-arm64"))');
	});

	test("build script stages uploadable binaries in tools/harbor", async () => {
		const script = await readFile(join(repoRoot, "scripts", "build-sprout-binary.ts"), "utf-8");
		expect(script).toContain('const harborDir = join(repoRoot, "tools/harbor")');
		expect(script).toContain("copyFile(join(distDir, name), join(harborDir, name))");
	});

	test("adapter command includes the headless eval flags", async () => {
		const adapter = await readFile(join(repoRoot, "tools", "harbor", "sprout_agent.py"), "utf-8");
		expect(adapter).toContain('_AGENT_DIR.glob("sprout-linux-*")');
		expect(adapter).not.toContain('_AGENT_DIR / "dist"');
		expect(adapter).toContain("--prompt");
		expect(adapter).toContain("--log-atif /logs/agent/agent-state/trajectory.json");
		expect(adapter).toContain("--eval-mode");
		expect(adapter).toContain("--genome-path /logs/agent/agent-state/genome");
	});

	test("embedded tool wrappers use sprout internal commands instead of bun-run source files", async () => {
		const bundle = await readFile(join(repoRoot, "src", "generated", "embedded-root.ts"), "utf-8");
		expect(bundle).toContain("--internal-task-cli");
		expect(bundle).toContain("--internal-mcp-cli");
		expect(bundle).not.toContain('exec bun run "$TOOL_DIR/cli.ts"');
		expect(bundle).not.toContain('exec bun run "$TOOL_DIR/mcp-cli.ts"');
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";

describe("LocalExecutionEnvironment", () => {
	let env: LocalExecutionEnvironment;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-test-"));
		env = new LocalExecutionEnvironment(tempDir);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	// -- Metadata --

	test("working_directory returns the configured dir", () => {
		expect(env.working_directory()).toBe(tempDir);
	});

	test("platform returns a known value", () => {
		expect(["darwin", "linux", "windows"]).toContain(env.platform());
	});

	// -- File operations --

	test("write_file creates a file and read_file reads it back", async () => {
		await env.write_file("hello.txt", "Hello World");
		const content = await env.read_file("hello.txt");
		expect(content).toContain("Hello World");
	});

	test("read_file returns line-numbered output", async () => {
		await env.write_file("numbered.txt", "line one\nline two\nline three");
		const content = await env.read_file("numbered.txt");
		expect(content).toContain("1\t");
		expect(content).toContain("line one");
		expect(content).toContain("2\t");
		expect(content).toContain("line two");
	});

	test("read_file supports offset and limit", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
		await env.write_file("many-lines.txt", lines.join("\n"));

		const content = await env.read_file("many-lines.txt", { offset: 3, limit: 2 });
		expect(content).toContain("line 3");
		expect(content).toContain("line 4");
		expect(content).not.toContain("line 2");
		expect(content).not.toContain("line 5");
	});

	test("read_file errors on nonexistent file", async () => {
		expect(env.read_file("nonexistent.txt")).rejects.toThrow();
	});

	test("write_file creates parent directories", async () => {
		await env.write_file("deep/nested/dir/file.txt", "nested content");
		const content = await env.read_file("deep/nested/dir/file.txt");
		expect(content).toContain("nested content");
	});

	test("file_exists returns true for existing files", async () => {
		await env.write_file("exists.txt", "yes");
		expect(await env.file_exists("exists.txt")).toBe(true);
	});

	test("file_exists returns false for missing files", async () => {
		expect(await env.file_exists("nope.txt")).toBe(false);
	});

	// -- Command execution --

	test("exec_command runs a shell command and captures output", async () => {
		const result = await env.exec_command("echo hello");
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exit_code).toBe(0);
		expect(result.timed_out).toBe(false);
	});

	test("exec_command captures stderr", async () => {
		const result = await env.exec_command("echo error >&2");
		expect(result.stderr.trim()).toBe("error");
	});

	test("exec_command captures exit code", async () => {
		const result = await env.exec_command("exit 42");
		expect(result.exit_code).toBe(42);
	});

	test("exec_command times out and kills the process", async () => {
		const result = await env.exec_command("sleep 30", { timeout_ms: 500 });
		expect(result.timed_out).toBe(true);
		expect(result.duration_ms).toBeLessThan(2000);
	});

	test("exec_command resolves PATH (shell execution)", async () => {
		// This verifies the /bin/sh -c pattern from Appendix D.13
		const result = await env.exec_command("which ls");
		expect(result.exit_code).toBe(0);
		expect(result.stdout.trim()).toContain("ls");
	});

	test("exec_command uses working directory", async () => {
		const result = await env.exec_command("pwd");
		// macOS resolves /var -> /private/var, so use realpath for comparison
		const { realpathSync } = await import("node:fs");
		expect(result.stdout.trim()).toBe(realpathSync(tempDir));
	});

	test("exec_command tracks duration", async () => {
		const result = await env.exec_command("sleep 0.1");
		expect(result.duration_ms).toBeGreaterThan(50);
		expect(result.duration_ms).toBeLessThan(2000);
	});

	test("exec_command filters sensitive env vars by default", async () => {
		const result = await env.exec_command("env", {
			env_vars: { SECRET_API_KEY: "should-not-appear", HOME: process.env.HOME ?? "/tmp" },
		});
		expect(result.stdout).not.toContain("should-not-appear");
		expect(result.stdout).toContain("HOME=");
	});

	// -- Search operations --

	test("grep finds pattern matches in files", async () => {
		await env.write_file("search/a.ts", 'const foo = "bar";\nconst baz = "qux";');
		await env.write_file("search/b.ts", "function foo() {}");
		const results = await env.grep("foo", "search");
		expect(results).toContain("a.ts");
		expect(results).toContain("b.ts");
		expect(results).toContain("foo");
	});

	test("grep supports glob filter", async () => {
		await env.write_file("search/c.py", "foo = 1");
		const results = await env.grep("foo", "search", { glob_filter: "*.ts" });
		expect(results).not.toContain("c.py");
		expect(results).toContain("a.ts");
	});

	test("grep returns empty for no matches", async () => {
		const results = await env.grep("zzzznonexistent", "search");
		expect(results.trim()).toBe("");
	});

	test("glob finds files by pattern", async () => {
		const files = await env.glob("search/**/*.ts");
		expect(files.length).toBeGreaterThanOrEqual(2);
		expect(files.some((f) => f.endsWith("a.ts"))).toBe(true);
		expect(files.some((f) => f.endsWith("b.ts"))).toBe(true);
	});

	test("glob returns empty for no matches", async () => {
		const files = await env.glob("**/*.zzz");
		expect(files).toEqual([]);
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry, type PrimitiveRegistry } from "../../src/kernel/primitives.ts";

describe("primitives", () => {
	let env: LocalExecutionEnvironment;
	let registry: PrimitiveRegistry;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sprout-prim-"));
		env = new LocalExecutionEnvironment(tempDir);
		registry = createPrimitiveRegistry(env);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("registry contains all required primitives", () => {
		const names = registry.names();
		expect(names).toContain("read_file");
		expect(names).toContain("write_file");
		expect(names).toContain("edit_file");
		expect(names).toContain("apply_patch");
		expect(names).toContain("exec");
		expect(names).toContain("grep");
		expect(names).toContain("glob");
		expect(names).toContain("fetch");
	});

	test("each primitive has name, description, and parameters schema", () => {
		for (const name of registry.names()) {
			const prim = registry.get(name);
			expect(prim).toBeDefined();
			expect(prim!.name).toBe(name);
			expect(prim!.description.length).toBeGreaterThan(0);
			expect(prim!.parameters).toBeDefined();
			expect(prim!.parameters.type).toBe("object");
		}
	});

	// -- read_file --

	describe("read_file", () => {
		test("reads a file with line numbers", async () => {
			await env.write_file("test-read.txt", "hello\nworld");
			const result = await registry.execute("read_file", { path: "test-read.txt" });
			expect(result.success).toBe(true);
			expect(result.output).toContain("1\t");
			expect(result.output).toContain("hello");
			expect(result.output).toContain("world");
		});

		test("supports offset and limit", async () => {
			const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
			await env.write_file("test-offset.txt", lines.join("\n"));
			const result = await registry.execute("read_file", {
				path: "test-offset.txt",
				offset: 5,
				limit: 3,
			});
			expect(result.success).toBe(true);
			expect(result.output).toContain("line 5");
			expect(result.output).toContain("line 7");
			expect(result.output).not.toContain("line 4");
			expect(result.output).not.toContain("line 8");
		});

		test("returns error for nonexistent file", async () => {
			const result = await registry.execute("read_file", { path: "no-such-file.txt" });
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	// -- write_file --

	describe("write_file", () => {
		test("creates a new file", async () => {
			const result = await registry.execute("write_file", {
				path: "test-write.txt",
				content: "new content",
			});
			expect(result.success).toBe(true);

			const read = await registry.execute("read_file", { path: "test-write.txt" });
			expect(read.output).toContain("new content");
		});

		test("creates parent directories", async () => {
			const result = await registry.execute("write_file", {
				path: "deep/path/file.txt",
				content: "deep content",
			});
			expect(result.success).toBe(true);
		});
	});

	// -- edit_file --

	describe("edit_file", () => {
		test("replaces exact string match", async () => {
			await env.write_file("test-edit.txt", "hello world\ngoodbye world");
			const result = await registry.execute("edit_file", {
				path: "test-edit.txt",
				old_string: "hello world",
				new_string: "hi earth",
			});
			expect(result.success).toBe(true);

			const read = await registry.execute("read_file", { path: "test-edit.txt" });
			expect(read.output).toContain("hi earth");
			expect(read.output).toContain("goodbye world");
			expect(read.output).not.toContain("hello world");
		});

		test("replace_all replaces multiple occurrences", async () => {
			await env.write_file("test-edit-all.txt", "foo bar foo baz foo");
			const result = await registry.execute("edit_file", {
				path: "test-edit-all.txt",
				old_string: "foo",
				new_string: "qux",
				replace_all: true,
			});
			expect(result.success).toBe(true);

			const read = await registry.execute("read_file", { path: "test-edit-all.txt" });
			expect(read.output).not.toContain("foo");
			expect(read.output).toContain("qux");
		});

		test("errors when old_string not found", async () => {
			await env.write_file("test-edit-miss.txt", "hello world");
			const result = await registry.execute("edit_file", {
				path: "test-edit-miss.txt",
				old_string: "nonexistent string",
				new_string: "replacement",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("not found");
		});

		test("errors when old_string matches multiple times without replace_all", async () => {
			await env.write_file("test-edit-ambig.txt", "foo bar\nfoo baz");
			const result = await registry.execute("edit_file", {
				path: "test-edit-ambig.txt",
				old_string: "foo",
				new_string: "qux",
			});
			expect(result.success).toBe(false);
			expect(result.error?.toLowerCase()).toContain("ambiguous");
		});
	});

	// -- apply_patch --

	describe("apply_patch", () => {
		test("creates a new file", async () => {
			const patch = `*** Begin Patch
*** Add File: new-file.py
+def greet(name):
+    return f"Hello, {name}!"
*** End Patch`;
			const result = await registry.execute("apply_patch", { patch });
			expect(result.success).toBe(true);

			const read = await registry.execute("read_file", { path: "new-file.py" });
			expect(read.output).toContain("def greet");
		});

		test("deletes a file", async () => {
			await env.write_file("to-delete.txt", "bye");
			const patch = `*** Begin Patch
*** Delete File: to-delete.txt
*** End Patch`;
			const result = await registry.execute("apply_patch", { patch });
			expect(result.success).toBe(true);
			expect(await env.file_exists("to-delete.txt")).toBe(false);
		});

		test("updates a file with context hunks", async () => {
			await env.write_file("to-update.py", 'def main():\n    print("Hello")\n    return 0\n');
			const patch = `*** Begin Patch
*** Update File: to-update.py
@@ def main():
     print("Hello")
-    return 0
+    print("World")
+    return 1
*** End Patch`;
			const result = await registry.execute("apply_patch", { patch });
			expect(result.success).toBe(true);

			const read = await registry.execute("read_file", { path: "to-update.py" });
			expect(read.output).toContain("World");
			expect(read.output).toContain("return 1");
			expect(read.output).not.toContain("return 0");
		});

		test("errors on invalid patch format", async () => {
			const result = await registry.execute("apply_patch", { patch: "not a valid patch" });
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	// -- exec --

	describe("exec", () => {
		test("runs a command and returns output", async () => {
			const result = await registry.execute("exec", { command: "echo hello" });
			expect(result.success).toBe(true);
			expect(result.output).toContain("hello");
		});

		test("returns error info on command failure", async () => {
			const result = await registry.execute("exec", { command: "exit 1" });
			expect(result.success).toBe(false);
		});

		test("captures both stdout and stderr in output", async () => {
			const result = await registry.execute("exec", {
				command: "echo out && echo err >&2",
			});
			expect(result.output).toContain("out");
			expect(result.output).toContain("err");
		});

		test("includes exit code and duration in output", async () => {
			const result = await registry.execute("exec", { command: "echo test" });
			expect(result.output).toContain("exit_code: 0");
			expect(result.output).toContain("duration_ms:");
		});
	});

	// -- grep --

	describe("grep", () => {
		test("finds pattern in files", async () => {
			await env.write_file("grep-test/a.txt", "hello world\ngoodbye world");
			await env.write_file("grep-test/b.txt", "hello earth");
			const result = await registry.execute("grep", {
				pattern: "hello",
				path: "grep-test",
			});
			expect(result.success).toBe(true);
			expect(result.output).toContain("hello");
		});

		test("returns empty for no matches", async () => {
			const result = await registry.execute("grep", {
				pattern: "zzzznothere",
				path: "grep-test",
			});
			expect(result.success).toBe(true);
			expect(result.output.trim()).toBe("");
		});
	});

	// -- glob --

	describe("glob", () => {
		test("finds files matching pattern", async () => {
			await env.write_file("glob-test/a.ts", "a");
			await env.write_file("glob-test/b.ts", "b");
			await env.write_file("glob-test/c.py", "c");
			const result = await registry.execute("glob", { pattern: "glob-test/**/*.ts" });
			expect(result.success).toBe(true);
			expect(result.output).toContain("a.ts");
			expect(result.output).toContain("b.ts");
			expect(result.output).not.toContain("c.py");
		});
	});

	// -- fetch --

	describe("fetch", () => {
		test("fetches a URL", async () => {
			// Use httpbin or a reliable test endpoint
			const result = await registry.execute("fetch", {
				url: "https://httpbin.org/get",
			});
			expect(result.success).toBe(true);
			expect(result.output).toContain("httpbin");
		});

		test("returns error for bad URL", async () => {
			const result = await registry.execute("fetch", {
				url: "https://this-domain-does-not-exist-12345.invalid/",
			});
			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	// -- abort signal --

	describe("abort signal", () => {
		test("exec primitive returns failure when signal already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const result = await registry.execute("exec", { command: "sleep 10" }, controller.signal);
			expect(result.success).toBe(false);
		});

		test("exec primitive kills child process when signal fires mid-execution", async () => {
			const controller = new AbortController();

			// Start a long-running command, then abort after a short delay
			const resultPromise = registry.execute(
				"exec",
				{ command: "sleep 30", timeout_ms: 60_000 },
				controller.signal,
			);

			// Abort after 100ms — command should terminate well before 30s
			setTimeout(() => controller.abort(), 100);

			const start = performance.now();
			const result = await resultPromise;
			const elapsed = performance.now() - start;

			expect(result.success).toBe(false);
			expect(elapsed).toBeLessThan(5_000); // Should complete quickly, not wait 30s
		});

		test("signal is threaded through to primitive execute method", async () => {
			const controller = new AbortController();

			// A non-exec primitive should receive the signal without error
			await env.write_file("signal-test.txt", "hello");
			const result = await registry.execute(
				"read_file",
				{ path: "signal-test.txt" },
				controller.signal,
			);
			expect(result.success).toBe(true);
		});
	});
});

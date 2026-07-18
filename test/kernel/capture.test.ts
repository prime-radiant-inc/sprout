import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_PRIMITIVE_NAMES, withCapture } from "../../src/kernel/capture.ts";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry, type Primitive } from "../../src/kernel/primitives.ts";
import { truncateToolOutput } from "../../src/kernel/truncation.ts";
import type { GrepResult, ManifestDelta } from "../../src/store/store.ts";
import type { StoreAccess, StoreBindInput } from "../../src/store/store-access.ts";
import type { ValueMetadata } from "../../src/store/value.ts";

interface BoundEntry extends Omit<StoreBindInput, "content"> {
	content: string;
}

/** Fake StoreAccess: records binds/publishes, optionally fails them. */
class FakeStore implements StoreAccess {
	bound: BoundEntry[] = [];
	published: string[] = [];
	bindError: string | undefined;
	publishError: string | undefined;

	async bind(args: StoreBindInput): Promise<ValueMetadata> {
		if (this.bindError !== undefined) throw new Error(this.bindError);
		const content =
			typeof args.content === "string" ? args.content : new TextDecoder().decode(args.content);
		this.bound.push({ ...args, content });
		return {
			ulid: `ulid_${this.bound.length}`,
			name: args.name,
			scopeId: "scope_test",
			type: args.type,
			size: content.length,
			provenance: args.provenance,
			preview: `${args.type} · ${content.length} bytes`,
			createdAt: 1,
		};
	}

	async publish(ref: string): Promise<void> {
		if (this.publishError !== undefined) throw new Error(this.publishError);
		this.published.push(ref);
	}

	async peek(): Promise<string> {
		throw new Error("not implemented");
	}
	async metadata(): Promise<ValueMetadata> {
		throw new Error("not implemented");
	}
	async get(): Promise<Uint8Array> {
		throw new Error("not implemented");
	}
	async slice(): Promise<string> {
		throw new Error("not implemented");
	}
	async grep(): Promise<GrepResult> {
		throw new Error("not implemented");
	}
	async manifestDelta(): Promise<ManifestDelta> {
		throw new Error("not implemented");
	}
	async names(): Promise<string[]> {
		return this.bound.map((b) => b.name);
	}
}

describe("capture (bind/publish on read_file, exec, grep, fetch)", () => {
	let dir: string;
	let env: LocalExecutionEnvironment;
	let store: FakeStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sprout-capture-"));
		env = new LocalExecutionEnvironment(dir);
		store = new FakeStore();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function wrapped(name: string): Primitive {
		const registry = createPrimitiveRegistry(env);
		const prim = registry.get(name);
		if (!prim) throw new Error(`no primitive: ${name}`);
		return withCapture(prim, store);
	}

	it("names the four capture-capable primitives", () => {
		expect([...CAPTURE_PRIMITIVE_NAMES]).toEqual(["read_file", "exec", "grep", "fetch"]);
	});

	it("adds bind and publish to the parameter schema", () => {
		const prim = wrapped("read_file");
		const props = prim.parameters.properties as Record<string, unknown>;
		expect(props.bind).toBeDefined();
		expect(props.publish).toBeDefined();
		expect(props.path).toBeDefined();
	});

	describe("read_file", () => {
		it("binds raw un-numbered bytes while the rendered output keeps line numbers", async () => {
			await writeFile(join(dir, "a.txt"), "alpha\nbeta\ngamma");
			const result = await wrapped("read_file").execute({ path: "a.txt", bind: "src" }, env);
			expect(result.success).toBe(true);
			expect(result.output).toContain("1\talpha\n2\tbeta\n3\tgamma");
			expect(result.output).toContain("bound: ⟦src⟧ (text · 16 bytes)");
			expect(store.bound).toHaveLength(1);
			expect(store.bound[0]?.content).toBe("alpha\nbeta\ngamma");
			expect(store.bound[0]?.type).toBe("text");
			expect(store.bound[0]?.explicit).toBe(true);
			expect(store.bound[0]?.provenance.origin).toEqual({
				kind: "primitive",
				name: "read_file",
				argsSummary: "a.txt",
			});
			expect(result.boundValues).toEqual([{ name: "src", ulid: "ulid_1", size: 16 }]);
		});

		it("binds exactly the offset/limit slice", async () => {
			await writeFile(join(dir, "a.txt"), "l1\nl2\nl3\nl4");
			const result = await wrapped("read_file").execute(
				{ path: "a.txt", offset: 2, limit: 2, bind: "mid" },
				env,
			);
			expect(result.success).toBe(true);
			expect(result.output).toContain("2\tl2\n3\tl3");
			expect(store.bound[0]?.content).toBe("l2\nl3");
		});

		it("without bind, behaves exactly like the plain primitive", async () => {
			await writeFile(join(dir, "a.txt"), "alpha\nbeta");
			const plain = await createPrimitiveRegistry(env).execute("read_file", { path: "a.txt" });
			const result = await wrapped("read_file").execute({ path: "a.txt" }, env);
			expect(result.output).toBe(plain.output);
			expect(store.bound).toHaveLength(0);
			expect(result.boundValues).toBeUndefined();
		});

		it("a read failure does not bind anything", async () => {
			const result = await wrapped("read_file").execute({ path: "missing.txt", bind: "x" }, env);
			expect(result.success).toBe(false);
			expect(store.bound).toHaveLength(0);
		});
	});

	describe("exec", () => {
		it("binds raw stdout and nonempty stderr as <name>_stderr, trailer names both", async () => {
			const result = await wrapped("exec").execute(
				{ command: "printf 'out line'; printf 'err line' 1>&2", bind: "log" },
				env,
			);
			expect(result.success).toBe(true);
			expect(result.output).toContain("out line");
			expect(result.output).toContain("exit_code: 0");
			expect(result.output).toContain("bound: ⟦log⟧");
			expect(result.output).toContain("bound: ⟦log_stderr⟧");
			expect(store.bound.map((b) => [b.name, b.content])).toEqual([
				["log", "out line"],
				["log_stderr", "err line"],
			]);
			expect(result.boundValues).toEqual([
				{ name: "log", ulid: "ulid_1", size: 8 },
				{ name: "log_stderr", ulid: "ulid_2", size: 8 },
			]);
		});

		it("empty stderr binds only the stdout value", async () => {
			const result = await wrapped("exec").execute({ command: "printf 'only'", bind: "log" }, env);
			expect(store.bound.map((b) => b.name)).toEqual(["log"]);
			expect(result.output).not.toContain("log_stderr");
		});

		it("a failing command still binds its output", async () => {
			const result = await wrapped("exec").execute(
				{ command: "printf 'boom' 1>&2; exit 3", bind: "log" },
				env,
			);
			expect(result.success).toBe(false);
			expect(store.bound.map((b) => b.name)).toEqual(["log", "log_stderr"]);
			expect(store.bound[1]?.content).toBe("boom");
		});
	});

	describe("grep", () => {
		it("binds structured matches as a JSON value, colons in text preserved", async () => {
			await writeFile(join(dir, "data.txt"), "before\nkey: a:b:c\nafter");
			const result = await wrapped("grep").execute(
				{ pattern: "key:", path: dir, bind: "hits" },
				env,
			);
			expect(result.success).toBe(true);
			expect(store.bound).toHaveLength(1);
			expect(store.bound[0]?.type).toBe("json");
			const matches = JSON.parse(store.bound[0]?.content ?? "");
			expect(matches).toHaveLength(1);
			expect(matches[0].path).toContain("data.txt");
			expect(matches[0].line).toBe(2);
			expect(matches[0].text).toBe("key: a:b:c");
			expect(result.output).toContain("bound: ⟦hits⟧");
			expect(result.output).toContain("data.txt:2:key: a:b:c");
		});
	});

	describe("fetch", () => {
		it("binds the raw body while the rendered output keeps status and headers", async () => {
			const server = Bun.serve({
				port: 0,
				fetch: () => new Response("raw body content", { status: 200 }),
			});
			try {
				const result = await wrapped("fetch").execute(
					{ url: `http://localhost:${server.port}/x`, bind: "page" },
					env,
				);
				expect(result.success).toBe(true);
				expect(result.output).toContain("status: 200");
				expect(result.output).toContain("bound: ⟦page⟧");
				expect(store.bound[0]?.content).toBe("raw body content");
				expect(store.bound[0]?.provenance.origin).toEqual({
					kind: "primitive",
					name: "fetch",
					argsSummary: `http://localhost:${server.port}/x`,
				});
			} finally {
				server.stop(true);
			}
		});
	});

	describe("bind failures and validation", () => {
		it("a failed bind keeps the tool result and replaces the trailer honestly", async () => {
			await writeFile(join(dir, "a.txt"), "alpha");
			store.bindError = "store full: scope at value cap";
			const result = await wrapped("read_file").execute({ path: "a.txt", bind: "src" }, env);
			expect(result.success).toBe(true);
			expect(result.output).toContain("1\talpha");
			expect(result.output).toContain("[bind failed: store full: scope at value cap]");
			expect(result.output).not.toContain("⟦src⟧");
			expect(result.boundValues).toBeUndefined();
		});

		it("an invalid bind name is a loud tool error", async () => {
			await writeFile(join(dir, "a.txt"), "alpha");
			const result = await wrapped("read_file").execute({ path: "a.txt", bind: "9bad" }, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("invalid bind name");
			expect(store.bound).toHaveLength(0);
		});

		it("publish without bind is a tool error", async () => {
			const result = await wrapped("exec").execute({ command: "true", publish: true }, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("publish");
		});
	});

	describe("publish", () => {
		it("bind + publish calls store.publish for each bound value", async () => {
			await wrapped("exec").execute(
				{ command: "printf 'o'; printf 'e' 1>&2", bind: "log", publish: true },
				env,
			);
			expect(store.published).toEqual(["log", "log_stderr"]);
		});

		it("a failed publish surfaces in the trailer without failing the call", async () => {
			await writeFile(join(dir, "a.txt"), "alpha");
			store.publishError = "worker restarting";
			const result = await wrapped("read_file").execute(
				{ path: "a.txt", bind: "src", publish: true },
				env,
			);
			expect(result.success).toBe(true);
			expect(result.output).toContain("bound: ⟦src⟧");
			expect(result.output).toContain("[publish failed: worker restarting]");
		});
	});
});

describe("auto-capture on lossy truncation", () => {
	let dir: string;
	let env: LocalExecutionEnvironment;
	let store: FakeStore;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "sprout-autocapture-"));
		env = new LocalExecutionEnvironment(dir);
		store = new FakeStore();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const longOutput = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");

	function fakeExec(output: string): Primitive {
		return {
			name: "exec",
			description: "fake",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { output, success: true };
			},
		};
	}

	it("auto-binds the full output and the marker names the value", async () => {
		const registry = createPrimitiveRegistry(env);
		registry.register(fakeExec(longOutput));
		registry.setCaptureStore?.(store);
		const result = await registry.execute("exec", {});
		expect(result.output).toContain("[... 44 lines truncated — full output: ⟦exec_output⟧]");
		expect(result.output).not.toContain("lines omitted");
		expect(store.bound).toHaveLength(1);
		expect(store.bound[0]?.name).toBe("exec_output");
		expect(store.bound[0]?.content).toBe(longOutput);
		expect(store.bound[0]?.explicit).toBe(false);
		expect(result.boundValues).toEqual([{ name: "exec_output", ulid: "ulid_1", size: 2591 }]);
	});

	it("store-full falls back to an honest marker naming no value", async () => {
		const registry = createPrimitiveRegistry(env);
		registry.register(fakeExec(longOutput));
		registry.setCaptureStore?.(store);
		store.bindError = "store full: disk quota exceeded";
		const result = await registry.execute("exec", {});
		expect(result.output).toContain("[... 44 lines truncated; store full — content not captured]");
		expect(result.output).not.toContain("⟦");
		expect(result.boundValues).toBeUndefined();
	});

	it("without a store, output is byte-identical to today's truncation", async () => {
		const registry = createPrimitiveRegistry(env);
		registry.register(fakeExec(longOutput));
		const result = await registry.execute("exec", {});
		expect(result.output).toBe(truncateToolOutput(longOutput, "exec"));
		expect(result.output).toContain("[... 44 lines omitted ...]");
	});

	it("untruncated output never auto-binds", async () => {
		const registry = createPrimitiveRegistry(env);
		registry.register(fakeExec("short output"));
		registry.setCaptureStore?.(store);
		const result = await registry.execute("exec", {});
		expect(result.output).toBe("short output");
		expect(store.bound).toHaveLength(0);
	});

	it("value_* primitives are never auto-captured", async () => {
		const registry = createPrimitiveRegistry(env);
		registry.register({
			name: "value_get",
			description: "fake",
			parameters: { type: "object", properties: {} },
			async execute() {
				return { output: "x".repeat(40_000), success: true };
			},
		});
		registry.setCaptureStore?.(store);
		const result = await registry.execute("value_get", {});
		expect(store.bound).toHaveLength(0);
		expect(result.output).toBe(truncateToolOutput("x".repeat(40_000), "value_get"));
	});
});

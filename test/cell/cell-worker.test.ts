import { describe, expect, it } from "bun:test";
import {
	type CellWorkerMessage,
	rejectImportRequire,
	runCellWorker,
} from "../../src/cell/cell-worker";

/**
 * In-process worker harness: feed request lines, auto-answer ambient requests
 * via `ambient`, and collect the final result message per cell.
 */
function makeHarness(ambient?: (method: string, args: unknown[]) => Promise<unknown>) {
	let push: (line: string | null) => void = () => {};
	const queue: (string | null)[] = [];
	let wake: (() => void) | undefined;
	push = (line) => {
		queue.push(line);
		wake?.();
	};
	async function* lines(): AsyncGenerator<string> {
		for (;;) {
			while (queue.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = undefined;
			}
			const next = queue.shift();
			if (next === null || next === undefined) return;
			yield next;
		}
	}
	const results = new Map<string, CellWorkerMessage & { op: "result" }>();
	const waiters = new Map<string, (msg: CellWorkerMessage & { op: "result" }) => void>();
	const ambientCalls: { method: string; args: unknown[] }[] = [];
	const done = runCellWorker({
		lines: lines(),
		write: (line) => {
			const msg = JSON.parse(line) as CellWorkerMessage;
			if (msg.op === "ambient") {
				ambientCalls.push({ method: msg.method, args: msg.args });
				const respond = ambient
					? ambient(msg.method, msg.args)
					: Promise.reject(new Error(`no ambient handler for ${msg.method}`));
				respond
					.then((result) => push(`${JSON.stringify({ id: msg.id, ok: true, result })}\n`))
					.catch((err) =>
						push(`${JSON.stringify({ id: msg.id, ok: false, error: (err as Error).message })}\n`),
					);
			} else if (msg.op === "result") {
				const waiter = waiters.get(msg.id);
				if (waiter) {
					waiters.delete(msg.id);
					waiter(msg);
				} else {
					results.set(msg.id, msg);
				}
			}
		},
	});
	let seq = 0;
	return {
		ambientCalls,
		async runCell(
			code: string,
			programs?: { name: string; body: string }[],
		): Promise<CellWorkerMessage & { op: "result" }> {
			const id = `cell-${++seq}`;
			const result = new Promise<CellWorkerMessage & { op: "result" }>((resolve) => {
				const early = results.get(id);
				if (early) resolve(early);
				else waiters.set(id, resolve);
			});
			push(`${JSON.stringify({ id, op: "cell", code, ...(programs ? { programs } : {}) })}\n`);
			return result;
		},
		async close() {
			push(null);
			await done;
		},
	};
}

describe("lexical gate", () => {
	it("rejects static import", () => {
		expect(rejectImportRequire('import fs from "node:fs";')).toContain("import");
	});

	it("rejects dynamic import()", () => {
		expect(rejectImportRequire('await import("node:child_process")')).toContain("import");
	});

	it("rejects require", () => {
		expect(rejectImportRequire('const cp = require("child_process")')).toContain("require");
	});

	it("rejects import/require even inside strings and comments (over-rejection is safe)", () => {
		expect(rejectImportRequire("// no import here\nreturn 1")).not.toBeUndefined();
		expect(rejectImportRequire('const s = "require"')).not.toBeUndefined();
	});

	it("does not reject prefixed identifiers like important or requirements", () => {
		expect(rejectImportRequire("const important = 1; const requirements = 2; return 3")).toBe(
			undefined,
		);
	});

	it("a rejected cell fails loudly through the worker", async () => {
		const h = makeHarness();
		const result = await h.runCell('const x = require("fs"); return x;');
		expect(result.ok).toBe(false);
		expect(result.error).toContain("require");
		await h.close();
	});
});

describe("stripped realm", () => {
	it("shadows runtime globals to undefined", async () => {
		const h = makeHarness();
		const result = await h.runCell(
			"return [typeof Bun, typeof process, typeof fetch, typeof WebSocket, typeof Deno].join(',')",
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("undefined,undefined,undefined,undefined,undefined");
		await h.close();
	});

	it("setTimeout stays available for plain JS timing", async () => {
		const h = makeHarness();
		const result = await h.runCell(
			"await new Promise((r) => setTimeout(r, 5)); return typeof setTimeout",
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("function");
		await h.close();
	});
});

describe("realm containment (vm context)", () => {
	it("no escape reaches the host process/Bun/require/fetch", async () => {
		const h = makeHarness();
		const result = await h.runCell(
			[
				"const probes = {};",
				"probes.directProcess = typeof process;",
				"probes.directBun = typeof Bun;",
				"probes.directFetch = typeof fetch;",
				"probes.directGlobalThis = typeof globalThis.process;",
				'probes.fnProcess = Function("return typeof process")();',
				'probes.evalBun = eval("typeof Bun");',
				'probes.ctorGlobalThisProcess = ({}).constructor.constructor("return typeof globalThis.process")();',
				'try { probes.ctorBun = ({}).constructor.constructor("return typeof Bun")(); } catch (e) { probes.ctorBun = "blocked"; }',
				"return JSON.stringify(probes);",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		const probes = JSON.parse(result.returnValue ?? "{}");
		for (const [key, value] of Object.entries(probes)) {
			expect([key, value]).toEqual([key, expect.stringMatching(/^(undefined|blocked)$/)]);
		}
		await h.close();
	});

	it("Bun.spawnSync is unreachable — no host command execution", async () => {
		const h = makeHarness();
		const result = await h.runCell(
			'try { Bun.spawnSync(["echo", "pwned"]); return "RAN"; } catch (e) { return "blocked"; }',
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("blocked");
		await h.close();
	});

	it("legitimate JS stdlib still works inside the context", async () => {
		const h = makeHarness();
		const result = await h.runCell(
			[
				"class Point { constructor(x) { this.x = x; } double() { return this.x * 2; } }",
				"const parsed = JSON.parse('{\"n\":21}');",
				"const m = Math.max(1, 2, 3);",
				"const all = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);",
				"const clone = structuredClone({ a: [1, { b: 2 }] });",
				"clone.a[1].b = 99;",
				"return JSON.stringify({",
				"  cls: new Point(parsed.n).double(),",
				"  m,",
				"  sum: all[0] + all[1],",
				"  cloneOk: clone.a[1].b,",
				"});",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		const out = JSON.parse(result.returnValue ?? "{}");
		expect(out).toEqual({ cls: 42, m: 3, sum: 3, cloneOk: 99 });
		await h.close();
	});

	it("ambient return values cannot be walked to a host constructor", async () => {
		const h = makeHarness(async (method) => {
			if (method === "grep") return { matches: ["a"], truncated: false };
			return "ok";
		});
		const result = await h.runCell(
			[
				"const g = await grep('notes', 'a');",
				'const viaResult = g.constructor.constructor("return typeof process")();',
				'const viaPromise = grep("notes", "a").constructor.constructor("return typeof Bun")();',
				"return JSON.stringify({ viaResult, viaPromise });",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		expect(JSON.parse(result.returnValue ?? "{}")).toEqual({
			viaResult: "undefined",
			viaPromise: "undefined",
		});
		await h.close();
	});
});

describe("cell execution", () => {
	it("captures console output and surfaces the final return", async () => {
		const h = makeHarness();
		const result = await h.runCell('console.log("hello", {a: 1}); return 40 + 2;');
		expect(result.ok).toBe(true);
		expect(result.output).toBe('hello {"a":1}\n');
		expect(result.returnValue).toBe("42");
		await h.close();
	});

	it("caps the console buffer at 64KB with a truncation note", async () => {
		const h = makeHarness();
		const result = await h.runCell(
			'for (let i = 0; i < 100; i++) console.log("x".repeat(1024)); return "done"',
		);
		expect(result.ok).toBe(true);
		expect(result.output.length).toBeLessThan(66 * 1024);
		expect(result.output).toContain("[console output truncated");
		await h.close();
	});

	it("supports top-level await and returns undefined when nothing is returned", async () => {
		const h = makeHarness();
		const result = await h.runCell("await Promise.resolve(); const x = 1;");
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBeUndefined();
		await h.close();
	});

	it("thrown errors fail the cell with the message and keep console output", async () => {
		const h = makeHarness();
		const result = await h.runCell('console.log("before"); throw new Error("boom");');
		expect(result.ok).toBe(false);
		expect(result.error).toContain("boom");
		expect(result.output).toContain("before");
		await h.close();
	});

	it("plain JS locals die across cells", async () => {
		const h = makeHarness();
		const first = await h.runCell("const secret = 7; return secret;");
		expect(first.ok).toBe(true);
		const second = await h.runCell("return secret;");
		expect(second.ok).toBe(false);
		expect(second.error).toContain("secret");
		await h.close();
	});
});

describe("ambient API", () => {
	it("routes ambient calls to the parent and returns the response", async () => {
		const h = makeHarness(async (method, args) => {
			if (method === "peek") return `peeked:${args[0]}`;
			if (method === "size") return 123;
			throw new Error(`unexpected: ${method}`);
		});
		const result = await h.runCell(
			"const p = await peek('notes'); return p + ':' + (await size('notes'));",
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("peeked:notes:123");
		expect(h.ambientCalls.map((c) => c.method)).toEqual(["peek", "size"]);
		await h.close();
	});

	it("ambient errors reject inside the cell and fail it when uncaught", async () => {
		const h = makeHarness(async () => {
			throw new Error("unknown value: nope in scope test");
		});
		const result = await h.runCell("return await get('nope');");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unknown value");
		await h.close();
	});

	it("exposes the full ambient surface", async () => {
		const h = makeHarness(async (method) => {
			if (method === "grep") return { matches: [], truncated: false };
			if (method === "parse") return { k: 1 };
			return "ok";
		});
		const result = await h.runCell(
			"return [typeof bind, typeof publish, typeof peek, typeof slice, typeof lines, typeof grep, typeof parse, typeof size, typeof get].join(',')",
		);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe(Array(9).fill("function").join(","));
		await h.close();
	});
});

describe("programs namespace", () => {
	it("runs a program body against the ambient API with its args", async () => {
		const binds: { name: string; value: unknown }[] = [];
		const h = makeHarness(async (method, args) => {
			if (method === "bind") {
				binds.push({ name: args[0] as string, value: args[1] });
				return { name: args[0], ulid: "u1", size: 3, preview: "p" };
			}
			return "ok";
		});
		const result = await h.runCell("return await programs.stash({ x: 'hi' });", [
			{ name: "stash", body: 'return await bind("out", args.x);' },
		]);
		expect(result.ok).toBe(true);
		expect(binds).toEqual([{ name: "out", value: "hi" }]);
		await h.close();
	});

	it("only exposes programs present in the request", async () => {
		const h = makeHarness(async () => "ok");
		const result = await h.runCell("return typeof programs.absent;", [
			{ name: "present", body: "return 1;" },
		]);
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("undefined");
		await h.close();
	});

	it("has no programs namespace when none are supplied", async () => {
		const h = makeHarness(async () => "ok");
		const result = await h.runCell("return typeof programs;");
		expect(result.ok).toBe(true);
		expect(result.returnValue).toBe("undefined");
		await h.close();
	});
});

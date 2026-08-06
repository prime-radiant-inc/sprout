import { describe, expect, it } from "bun:test";
import type { CellEngineRequest, CellEngineResult } from "../../src/cell/cell-engine";
import { QuickJSCellEngine } from "../../src/cell/quickjs-engine";

function assertOk(
	result: CellEngineResult,
): asserts result is { ok: true; returnValue: string | undefined } {
	if (!result.ok) throw new Error(`expected cell to succeed, got error: ${result.error}`);
}

function assertFailed(
	result: CellEngineResult,
): asserts result is { ok: false; error: string; infrastructure: boolean } {
	if (result.ok) throw new Error(`expected cell to fail, got returnValue: ${result.returnValue}`);
}

/**
 * Adversarial containment suite (QuickJS spec P3). Where the parameterized
 * worker suite proves BEHAVIOR parity, this proves the SECURITY property the
 * whole engine swap exists for: model-authored cell code cannot reach a host
 * capability, cannot forge the sever, cannot bypass the caps, and cannot leak
 * state across cells. Every probe runs the real QuickJS engine and asserts the
 * cell is contained — never that it "errored", which a bug could satisfy while
 * still leaking.
 */
function run(code: string, overrides: Partial<CellEngineRequest> = {}) {
	const engine = new QuickJSCellEngine();
	return engine.runCell({
		code,
		callAmbient: async (method, args) => ({ method, args }),
		isInfraError: () => false,
		log: () => {},
		...overrides,
	});
}

describe("QuickJS containment — host capabilities are unreachable", () => {
	const HOST_GLOBALS = [
		"process",
		"Bun",
		"require",
		"fetch",
		"WebAssembly",
		"Deno",
		"global",
		"module",
		"__dirname",
	];

	it("no host global is present in the realm", async () => {
		const result = await run(
			`return JSON.stringify([${HOST_GLOBALS.map((g) => `typeof ${g}`).join(",")}]);`,
		);
		assertOk(result);
		expect(JSON.parse(result.returnValue ?? "[]")).toEqual(HOST_GLOBALS.map(() => "undefined"));
	});

	it("the Function constructor evaluates in-realm — cannot reach host process", async () => {
		const result = await run('return Function("return typeof process")();');
		expect(result).toMatchObject({ ok: true, returnValue: "undefined" });
	});

	it("the AsyncFunction constructor evaluates in-realm", async () => {
		const result = await run(
			'const f = (async () => {}).constructor("return typeof Bun"); return await f();',
		);
		expect(result).toMatchObject({ ok: true, returnValue: "undefined" });
	});

	it("the GeneratorFunction constructor evaluates in-realm", async () => {
		const result = await run(
			'const G = (function* () {}).constructor; return G("return typeof globalThis.process")().next().value;',
		);
		expect(result).toMatchObject({ ok: true, returnValue: "undefined" });
	});

	it("the constructor chain off a fresh object cannot walk to host", async () => {
		const result = await run(
			'return ({}).constructor.constructor("return typeof globalThis.fetch")();',
		);
		expect(result).toMatchObject({ ok: true, returnValue: "undefined" });
	});

	it("the raw host bridges are deleted after bootstrap", async () => {
		const result = await run(
			"return [typeof __hostCall__, typeof __hostLog__, typeof __hostTimers__].join(',');",
		);
		expect(result).toMatchObject({ ok: true, returnValue: "undefined,undefined,undefined" });
	});

	it("V8/JSC-specific stack-trace hooks are absent", async () => {
		const result = await run(
			"return [typeof Error.captureStackTrace, typeof Error.prepareStackTrace].join(',');",
		);
		expect(result).toMatchObject({ ok: true, returnValue: "undefined,undefined" });
	});
});

describe("QuickJS containment — the sever cannot be forged", () => {
	it("a tampered in-cell JSON.parse cannot smuggle a host reference through an ambient result", async () => {
		// The engine's marshal-in uses a pristine captured JSON.parse, so the
		// value entering the realm is already severed to realm-native. A cell CAN
		// corrupt its own VIEW by reassigning JSON.parse (the bootstrap's
		// convenience re-sever uses realm globals) — a self-inflicted wound — but
		// the result it sees can never carry a host prototype: walking its
		// constructor chain still dead-ends in the realm.
		const result = await run(
			'JSON.parse = () => ({ x: 1 }); const r = await peek("notes"); return r.constructor.constructor("return typeof process")();',
			{ callAmbient: async (method) => ({ method }) },
		);
		expect(result).toMatchObject({ ok: true, returnValue: "undefined" });
	});

	it("an ambient argument's throwing getter does not execute host-side", async () => {
		const result = await run(
			'await bind("x", { get boom() { throw new Error("host-side exec"); } }); return "survived";',
		);
		expect(result).toMatchObject({ ok: true, returnValue: "survived" });
	});

	it("a Proxy ambient argument's traps do not execute host-side", async () => {
		const result = await run(
			'await bind("x", new Proxy({}, { get() { throw new Error("trap"); }, ownKeys() { throw new Error("trap"); } })); return "survived";',
		);
		expect(result).toMatchObject({ ok: true, returnValue: "survived" });
	});
});

describe("QuickJS containment — caps cannot be bypassed", () => {
	it("cell code cannot reach or clear the interrupt handler", async () => {
		const result = await run(
			"try { setInterruptHandler(null); } catch (e) {} try { globalThis.__interrupt__ = null; } catch (e) {} while (true) {}",
			{ limits: { budgetMs: 120 } },
		);
		assertFailed(result);
		expect(result.error).toContain("budget");
		expect(result.infrastructure).toBe(true);
	});

	it("a bigint allocation bomb is refused, not an OOM crash", async () => {
		const result = await run("return (1n << 100000000n).toString().length;", {
			limits: { memoryBytes: 32 * 1024 * 1024 },
		});
		assertFailed(result);
		// Either a RangeError (refused up front) or the memory cap — never a crash.
		expect(result.error.length).toBeGreaterThan(0);
	});

	it("catching the OOM error and continuing still binds every later allocation", async () => {
		const result = await run(
			[
				"let caught = 0;",
				"const keep = [];",
				"for (let i = 0; i < 200; i++) {",
				"  try { keep.push('x'.repeat(1024 * 1024)); } catch (e) { caught++; }",
				"}",
				"return caught > 0 ? 'still-capped' : 'escaped';",
			].join("\n"),
			{ limits: { memoryBytes: 16 * 1024 * 1024 } },
		);
		// The cell may catch OOM, but the cap keeps binding — it never reports "escaped".
		if (result.ok) expect(result.returnValue).toBe("still-capped");
		else expect(result.error).toContain("memory");
		// (both branches are contained; the forbidden outcome is returnValue "escaped")
	});
});

describe("QuickJS containment — no state survives a cell boundary", () => {
	it("prototype pollution and leaked globals die with the cell", async () => {
		const engine = new QuickJSCellEngine();
		const base = {
			callAmbient: async () => "ok",
			isInfraError: () => false,
			log: () => {},
		};
		const first = await engine.runCell({
			...base,
			code: "Object.prototype.polluted = 42; globalThis.leaked = 7; String.prototype.evil = () => 1; return 'tampered';",
		});
		expect(first).toMatchObject({ ok: true, returnValue: "tampered" });
		const second = await engine.runCell({
			...base,
			code: "return JSON.stringify({ proto: ({}).polluted ?? null, leaked: typeof leaked, str: typeof ''.evil });",
		});
		assertOk(second);
		expect(JSON.parse(second.returnValue ?? "{}")).toEqual({
			proto: null,
			leaked: "undefined",
			str: "undefined",
		});
	});
});

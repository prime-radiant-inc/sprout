import { describe, expect, it } from "bun:test";
import debugVariant from "@jitl/quickjs-singlefile-mjs-debug-sync";
import { newQuickJSWASMModuleFromVariant, TestQuickJSWASMModule } from "quickjs-emscripten-core";
import type { CellEngineRequest } from "../../src/cell/cell-engine";
import { QuickJSCellEngine } from "../../src/cell/quickjs-engine";

/**
 * Handle-lifetime discipline tests (QuickJS spec P1): every cell path must
 * dispose every wasm handle it creates. The DEBUG variant is what gives these
 * teeth — it tracks allocations and aborts loudly on a leaked handle at
 * runtime dispose, where the release build stays silent. Fresh module per
 * test: a debug-build abort poisons the wasm instance it fires in.
 */
async function runLeakChecked(code: string, overrides: Partial<CellEngineRequest> = {}) {
	const testModule = new TestQuickJSWASMModule(await newQuickJSWASMModuleFromVariant(debugVariant));
	const engine = new QuickJSCellEngine({ loadModule: async () => testModule });
	const logs: unknown[][] = [];
	const result = await engine.runCell({
		code,
		callAmbient: async () => "ok",
		isInfraError: () => false,
		log: (args) => logs.push(args),
		...overrides,
	});
	// Not assertNoMemoryAllocated(): upstream 0.32's module.newRuntime drops
	// options.ownedLifetimes, so TestQuickJSWASMModule never unregisters
	// disposed runtimes and would report a leak for every properly-disposed
	// cell. The checks that matter survive: every runtime must be disposed, and
	// the debug build's wasm-level leak sanitizer must see no un-freed memory.
	const assertNoLeaks = () => {
		for (const runtime of testModule.runtimes) {
			expect(runtime.alive).toBe(false);
		}
		expect(testModule.getFFI().QTS_RecoverableLeakCheck()).toBe(0);
	};
	return { result, logs, assertNoLeaks };
}

describe("QuickJSCellEngine handle discipline (debug build)", () => {
	it("a plain cell leaks nothing", async () => {
		const { result, assertNoLeaks } = await runLeakChecked("return { a: [1, 2, { b: 3 }] };");
		expect(result).toEqual({ ok: true, returnValue: '{"a":[1,2,{"b":3}]}' });
		assertNoLeaks();
	});

	it("console logging leaks nothing, including unserializable args", async () => {
		const { result, logs, assertNoLeaks } = await runLeakChecked(
			"console.log('plain', { x: 1 }); const o = {}; o.self = o; console.log(o); return 'ok';",
		);
		expect(result.ok).toBe(true);
		expect(logs[0]).toEqual(["plain", '{"x":1}']);
		assertNoLeaks();
	});

	it("ambient round trips leak nothing", async () => {
		const { result, assertNoLeaks } = await runLeakChecked(
			"const a = await get('x'); const b = await get('y'); return [a, b];",
			{ callAmbient: async (method, args) => ({ method, args }) },
		);
		expect(result.ok).toBe(true);
		assertNoLeaks();
	});

	it("caught and uncaught ambient rejections leak nothing", async () => {
		const infra = Object.assign(new Error("StoreUnavailable"), { __infra__: true });
		const { result, assertNoLeaks } = await runLeakChecked(
			"try { await get('a'); } catch (e) {} return await get('b');",
			{
				callAmbient: async () => {
					throw infra;
				},
				isInfraError: (err) => (err as { __infra__?: boolean }).__infra__ === true,
			},
		);
		expect(result).toEqual({ ok: false, error: "StoreUnavailable", infrastructure: true });
		assertNoLeaks();
	});

	it("fired, cleared, and abandoned timers leak nothing", async () => {
		const { result, assertNoLeaks } = await runLeakChecked(
			[
				"await new Promise((r) => setTimeout(r, 5));", // fires
				"const t = setTimeout(() => {}, 5000); clearTimeout(t);", // cleared
				"setInterval(() => {}, 5);", // abandoned — teardown's job
				"return 'timers';",
			].join("\n"),
		);
		expect(result).toEqual({ ok: true, returnValue: "timers" });
		assertNoLeaks();
	});

	it("program invocation leaks nothing", async () => {
		const { result, assertNoLeaks } = await runLeakChecked(
			"return await programs.echo({ v: 7 });",
			{ programs: [{ name: "echo", body: "return args.v * 6;" }] },
		);
		expect(result).toEqual({ ok: true, returnValue: "42" });
		assertNoLeaks();
	});

	it("thrown errors and syntax errors leak nothing", async () => {
		const thrown = await runLeakChecked("throw new Error('boom');");
		expect(thrown.result.ok).toBe(false);
		thrown.assertNoLeaks();
		const syntax = await runLeakChecked("return } nope {");
		expect(syntax.result.ok).toBe(false);
		syntax.assertNoLeaks();
	});

	it("a deadlocked cell is torn down leak-free", async () => {
		const { result, assertNoLeaks } = await runLeakChecked("await new Promise(() => {});");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("deadlock");
		assertNoLeaks();
	});

	it("a memory-capped OOM cell is torn down leak-free", async () => {
		// Single over-limit allocation: exercises the in-runtime limit's OOM
		// teardown without ballooning the debug build's LeakSanitizer (the
		// cumulative wasm-cap path is covered at the worker level on release).
		const { result, assertNoLeaks } = await runLeakChecked(
			"const s = 'x'.repeat(32 * 1024 * 1024); return s.length;",
			{ limits: { memoryBytes: 8 * 1024 * 1024 } },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("out of memory");
		assertNoLeaks();
	});

	it("a deadline-interrupted cell is torn down leak-free", async () => {
		const { result, assertNoLeaks } = await runLeakChecked("while (true) {}", {
			limits: { budgetMs: 100 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("budget");
		assertNoLeaks();
	});

	it("a late ambient response against a finished cell leaks nothing and does not crash", async () => {
		const { result, assertNoLeaks } = await runLeakChecked("get('x'); return 'early';", {
			callAmbient: async () => {
				await new Promise((r) => setTimeout(r, 20));
				return "late";
			},
		});
		expect(result).toEqual({ ok: true, returnValue: "early" });
		await new Promise((r) => setTimeout(r, 40));
		assertNoLeaks();
	});
});

describe("QuickJSCellEngine host-fault resilience", () => {
	// The wild failure (observed 2026-07-21 under parallel shard load): during
	// deep recursion, the HOST's wasm call stack can exhaust before QuickJS's
	// soft stack limit trips — JSC's wasm frame sizes vary with compilation
	// tier, which varies with CPU load. The foreign RangeError unwinds the C
	// interpreter with no cleanup, leaked GC objects make JS_FreeRuntime abort
	// (list_empty(&rt->gc_obj_list)), and emscripten surfaces that abort as a
	// THROW from disposal. The engine must contain both faces of the fault.
	const baseRequest = {
		callAmbient: async () => "ok",
		isInfraError: () => false,
		log: () => {},
	};

	it("a throw from runtime disposal is contained: the cell's result stands and the module is discarded", async () => {
		let loads = 0;
		const real = await newQuickJSWASMModuleFromVariant(debugVariant);
		let armed = true;
		const engine = new QuickJSCellEngine({
			loadModule: async () => {
				loads++;
				return {
					newRuntime: () => {
						const rt = real.newRuntime();
						if (!armed) return rt;
						const dispose = rt.dispose.bind(rt);
						(rt as any).dispose = () => {
							armed = false;
							dispose();
							throw new Error(
								"Aborted(Assertion failed: list_empty(&rt->gc_obj_list), at: quickjs.c,2036,JS_FreeRuntime)",
							);
						};
						return rt;
					},
				};
			},
		});
		const first = await engine.runCell({ code: "return 'fine';", ...baseRequest });
		expect(first).toEqual({ ok: true, returnValue: "fine" });
		expect(loads).toBe(1);
		// The faulted module was discarded; the next cell rebuilds and works.
		const second = await engine.runCell({ code: "return 'again';", ...baseRequest });
		expect(second).toEqual({ ok: true, returnValue: "again" });
		expect(loads).toBe(2);
	});

	it("a foreign host throw during cell eval becomes a typed stumble and discards the module", async () => {
		let loads = 0;
		const real = await newQuickJSWASMModuleFromVariant(debugVariant);
		const engine = new QuickJSCellEngine({
			loadModule: async () => {
				loads++;
				return {
					newRuntime: () => {
						const rt = real.newRuntime();
						const newContext = rt.newContext.bind(rt);
						(rt as any).newContext = (...args: unknown[]) => {
							const ctx = (newContext as any)(...args);
							const evalCode = ctx.evalCode.bind(ctx);
							ctx.evalCode = (code: string, ...rest: unknown[]) => {
								if (String(code).includes("__HOST_BOOM__")) {
									throw new RangeError("Maximum call stack size exceeded.");
								}
								return evalCode(code, ...rest);
							};
							return ctx;
						};
						return rt;
					},
				};
			},
		});
		const result = await engine.runCell({ code: "__HOST_BOOM__; return 1;", ...baseRequest });
		if (result.ok) throw new Error("expected the foreign throw to fail the cell");
		expect(result.error).toContain("stack");
		expect(result.infrastructure).not.toBe(true);
		expect(loads).toBe(1);
		const next = await engine.runCell({ code: "return 'alive';", ...baseRequest });
		expect(next).toEqual({ ok: true, returnValue: "alive" });
		expect(loads).toBe(2);
	});

	it("a transient module-load failure is not cached — the next cell retries the load", async () => {
		// A rejected load must not wedge the engine for the process lifetime:
		// the parent never respawns a worker for an engine-failure result, so a
		// cached rejection would brick cells for the whole agent process.
		let loads = 0;
		const engine = new QuickJSCellEngine({
			loadModule: async () => {
				loads++;
				if (loads === 1) throw new Error("transient wasm instantiation failure");
				return newQuickJSWASMModuleFromVariant(debugVariant);
			},
		});
		await expect(engine.runCell({ code: "return 1;", ...baseRequest })).rejects.toThrow(
			"transient wasm instantiation failure",
		);
		const second = await engine.runCell({ code: "return 'recovered';", ...baseRequest });
		expect(second).toEqual({ ok: true, returnValue: "recovered" });
		expect(loads).toBe(2);
	});
});

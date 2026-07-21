import { describe, expect, it } from "bun:test";
import type { CellResult } from "../../src/cell/cell-host";
import { buildCellPrimitive } from "../../src/kernel/cell-primitive";
import type { ExecutionEnvironment } from "../../src/kernel/execution-env";

const env = {} as ExecutionEnvironment;

function runner(result: CellResult, calls?: string[]) {
	return {
		async runCell(code: string): Promise<CellResult> {
			calls?.push(code);
			return result;
		},
	};
}

const okResult = (overrides: Partial<CellResult> = {}): CellResult => ({
	ok: true,
	output: "",
	newBindings: [],
	stumbleCount: 0,
	metrics: { computeTimeMs: 12, totalMs: 40 },
	...overrides,
});

describe("cell primitive", () => {
	it("renders output, return value, and bound lines", async () => {
		const prim = buildCellPrimitive(
			runner(
				okResult({
					output: "hello\n",
					returnValue: "42",
					newBindings: [{ name: "notes", ulid: "u1", size: 9, preview: "p" }],
				}),
			),
		);
		const result = await prim.execute({ code: "return 42" }, env);
		expect(result.success).toBe(true);
		expect(result.output).toBe("hello\nreturn: 42\nbound: ⟦notes⟧ (9 bytes)");
		expect(result.boundValues).toEqual([{ name: "notes", ulid: "u1", size: 9 }]);
		expect(result.metrics).toEqual({ computeTimeMs: 12, totalMs: 40 });
	});

	it("renders errors with the names in scope", async () => {
		const prim = buildCellPrimitive(
			runner(
				okResult({
					ok: false,
					error: { message: "unknown value: missing", scopeNames: ["alpha", "beta"] },
				}),
			),
		);
		const result = await prim.execute({ code: "return missing" }, env);
		expect(result.success).toBe(false);
		expect(result.error).toContain("unknown value: missing");
		expect(result.error).toContain("names in scope: alpha, beta");
	});

	it("rejects empty code without touching the host", async () => {
		const calls: string[] = [];
		const prim = buildCellPrimitive(runner(okResult(), calls));
		const result = await prim.execute({ code: "" }, env);
		expect(result.success).toBe(false);
		expect(calls).toEqual([]);
	});

	it("surfaces host-thrown failures (infrastructure) as tool errors", async () => {
		const prim = buildCellPrimitive({
			async runCell() {
				throw new Error("store worker unavailable: op timed out");
			},
		});
		const result = await prim.execute({ code: "return 1" }, env);
		expect(result.success).toBe(false);
		expect(result.error).toContain("store worker unavailable");
	});

	it("lists genome programs with their params and spawns in a <programs> block", () => {
		const prim = buildCellPrimitive(
			runner(okResult()),
			[{ name: "reader", description: "reads" }],
			[
				{
					name: "summarize",
					description: "Summarize a log",
					params: [{ name: "log", type: "string", description: "the log value name" }],
					spawns: ["reader"],
				},
			],
		);
		expect(prim.description).toContain("<programs>");
		expect(prim.description).toContain("summarize");
		expect(prim.description).toContain("Summarize a log");
		expect(prim.description).toContain("log");
		expect(prim.description).toContain("reader");
	});

	it("omits the <programs> block when there are no programs", () => {
		const prim = buildCellPrimitive(runner(okResult()));
		expect(prim.description).not.toContain("<programs>");
	});

	it("steers against reading a moved value back to verify it (keeps content below the line)", () => {
		const prim = buildCellPrimitive(runner(okResult()));
		// The splice is the delivery — a write built from ⟦name⟧ is verbatim, so the
		// description must tell weak models NOT to read the value back to confirm it,
		// and NOT to surface a value's bytes via get/peek/return/console.log.
		expect(prim.description).toContain("the splice IS the delivery");
		expect(prim.description).toMatch(/do NOT read the value back/);
		expect(prim.description).toMatch(/return NAMES, sizes, and counts, never the content/);
	});
});

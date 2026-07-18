import { describe, expect, it } from "bun:test";
import type { ExecutionEnvironment } from "../../src/kernel/execution-env";
import { buildValuePrimitives } from "../../src/kernel/value-primitives";
import type { StoreAccess } from "../../src/store/store-access";
import type { ValueMetadata } from "../../src/store/value";

const env = {} as ExecutionEnvironment;

/** Fake StoreAccess over an in-memory map of text values. */
function fakeStore(values: Record<string, string>): StoreAccess {
	const resolve = (ref: string): string => {
		const body = values[ref];
		if (body === undefined) throw new Error(`unknown value: ${ref} in scope test`);
		return body;
	};
	return {
		async bind() {
			throw new Error("bind is not exercised by value primitives");
		},
		async peek(ref) {
			return `text · ${resolve(ref).length} bytes\n${resolve(ref).slice(0, 80)}`;
		},
		async metadata(ref) {
			return { size: resolve(ref).length } as ValueMetadata;
		},
		async get(ref, options) {
			const body = resolve(ref);
			if (body.length > options.maxBytes) {
				throw new Error(`value exceeds read budget: ${body.length} > ${options.maxBytes} bytes`);
			}
			return new TextEncoder().encode(body);
		},
		async slice(ref, options) {
			const lines = resolve(ref).split("\n");
			const start = Math.max(0, options.startLine - 1);
			return lines.slice(start, start + options.lineCount).join("\n");
		},
		async grep(ref, pattern, options = {}) {
			const regex = new RegExp(pattern);
			const matches = resolve(ref)
				.split("\n")
				.map((text, i) => ({ line: i + 1, text }))
				.filter((m) => regex.test(m.text));
			const max = options.maxResults ?? 100;
			return { matches: matches.slice(0, max), truncated: matches.length > max };
		},
		async manifestDelta() {
			throw new Error("manifestDelta is not exercised by value primitives");
		},
		async names() {
			return Object.keys(values).sort();
		},
		async publish() {
			throw new Error("publish is not exercised by value primitives");
		},
		async registerEnvGrant(): Promise<ValueMetadata> {
			throw new Error("registerEnvGrant is not exercised by value primitives");
		},
		async claimEnvGrant(): Promise<ValueMetadata> {
			throw new Error("claimEnvGrant is not exercised by value primitives");
		},
	};
}

function prims(values: Record<string, string>) {
	const list = buildValuePrimitives(fakeStore(values));
	const byName = new Map(list.map((p) => [p.name, p]));
	return { list, byName };
}

const FAKE_SECRET = `sk-ant-${"a".repeat(30)}`;

describe("value primitives", () => {
	it("exposes exactly the read primitives, no bind", () => {
		const { list } = prims({});
		expect(list.map((p) => p.name).sort()).toEqual([
			"value_get",
			"value_grep",
			"value_peek",
			"value_slice",
		]);
		for (const p of list) {
			expect(p.description.toLowerCase()).toContain("ulid");
		}
	});

	it("value_peek returns the stored preview", async () => {
		const { byName } = prims({ notes: "hello\nworld" });
		const result = await byName.get("value_peek")!.execute({ ref: "notes" }, env);
		expect(result.success).toBe(true);
		expect(result.output).toContain("text · 11 bytes");
	});

	it("value_grep formats matches as <line>:<text>", async () => {
		const { byName } = prims({ notes: "alpha\nbeta\ngamma" });
		const result = await byName
			.get("value_grep")!
			.execute({ ref: "notes", pattern: "ma$|ta$", max_results: 10 }, env);
		expect(result.success).toBe(true);
		expect(result.output).toBe("2:beta\n3:gamma");
	});

	it("value_slice returns the slice text", async () => {
		const { byName } = prims({ notes: "one\ntwo\nthree" });
		const result = await byName
			.get("value_slice")!
			.execute({ ref: "notes", start_line: 2, line_count: 2 }, env);
		expect(result.success).toBe(true);
		expect(result.output).toBe("two\nthree");
	});

	it("value_get returns full content under the budget", async () => {
		const { byName } = prims({ notes: "full body" });
		const result = await byName.get("value_get")!.execute({ ref: "notes" }, env);
		expect(result.success).toBe(true);
		expect(result.output).toBe("full body");
	});

	it("value_get over the 50k budget errors with slice/grep guidance", async () => {
		const { byName } = prims({ big: "x".repeat(60_000) });
		const result = await byName.get("value_get")!.execute({ ref: "big" }, env);
		expect(result.success).toBe(false);
		expect(result.error).toContain("value_slice");
		expect(result.error).toContain("value_grep");
	});

	it("redacts secrets in every output path", async () => {
		const body = `token line\napi_key=${FAKE_SECRET}\ntail`;
		const { byName } = prims({ leaky: body });
		const outputs = [
			await byName.get("value_get")!.execute({ ref: "leaky" }, env),
			await byName.get("value_peek")!.execute({ ref: "leaky" }, env),
			await byName.get("value_slice")!.execute({ ref: "leaky", start_line: 2, line_count: 1 }, env),
			await byName.get("value_grep")!.execute({ ref: "leaky", pattern: "api_key" }, env),
		];
		for (const result of outputs) {
			expect(result.success).toBe(true);
			expect(result.output).not.toContain(FAKE_SECRET);
			expect(result.output).toContain("[REDACTED_API_KEY]");
		}
	});

	it("value_grep appends a truncation note when the result is truncated", async () => {
		const body = Array.from({ length: 5 }, (_, i) => `hit ${i}`).join("\n");
		const { byName } = prims({ many: body });
		const result = await byName
			.get("value_grep")!
			.execute({ ref: "many", pattern: "hit", max_results: 2 }, env);
		expect(result.success).toBe(true);
		expect(result.output).toContain("1:hit 0");
		expect(result.output).toContain("…truncated");
	});

	it("value_slice clamps line_count and surfaces the slice budget error cleanly", async () => {
		const store = fakeStore({ big: "line\n".repeat(10) });
		let requestedLineCount = 0;
		store.slice = async (_ref, options) => {
			requestedLineCount = options.lineCount;
			throw new Error("slice budget exceeded: result is 999 bytes, over the 10-byte budget");
		};
		const [slice] = buildValuePrimitives(store).filter((p) => p.name === "value_slice");
		const result = await slice!.execute(
			{ ref: "big", start_line: 1, line_count: Number.MAX_SAFE_INTEGER },
			env,
		);
		expect(requestedLineCount).toBe(10_000);
		expect(result.success).toBe(false);
		expect(result.error).toContain("slice budget exceeded");
		expect(result.error).toContain("fewer lines");
	});

	it("redacts secrets embedded in store error messages", async () => {
		const store = fakeStore({});
		store.peek = async () => {
			throw new Error(`store exploded while reading api_key=${FAKE_SECRET}`);
		};
		const [peek] = buildValuePrimitives(store).filter((p) => p.name === "value_peek");
		const result = await peek!.execute({ ref: "leaky" }, env);
		expect(result.success).toBe(false);
		expect(result.error).not.toContain(FAKE_SECRET);
		expect(result.error).toContain("[REDACTED_API_KEY]");
	});

	it("store errors surface as success:false, never throws", async () => {
		const { byName } = prims({});
		for (const [name, args] of [
			["value_peek", { ref: "missing" }],
			["value_get", { ref: "missing" }],
			["value_slice", { ref: "missing", start_line: 1, line_count: 1 }],
			["value_grep", { ref: "missing", pattern: "x" }],
		] as const) {
			const result = await byName.get(name)!.execute({ ...args }, env);
			expect(result.success).toBe(false);
			expect(result.error).toContain("unknown value");
		}
	});
});

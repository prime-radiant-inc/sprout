import { beforeEach, describe, expect, it } from "bun:test";
import { LocalExecutionEnvironment } from "../../src/kernel/execution-env.ts";
import { createPrimitiveRegistry, type Primitive } from "../../src/kernel/primitives.ts";
import type { PrimitiveResult } from "../../src/kernel/types.ts";
import type { GrepResult, ManifestDelta } from "../../src/store/store.ts";
import type { StoreAccess, StoreBindInput } from "../../src/store/store-access.ts";
import type { ValueMetadata } from "../../src/store/value.ts";

/**
 * The registry gate predicate (capture-all spec v10): the svelte/capture path
 * engages iff the result carries `captureSource` AND a capture store is set;
 * everything else renders at today's limits. Chars-only trigger on the
 * predicate path; capture failure → today's limits (principle 1); value_*
 * bypasses the gate wholesale; outputs and errors redacted.
 */

interface BoundEntry extends Omit<StoreBindInput, "content"> {
	content: string;
}

class FakeStore implements StoreAccess {
	bound: BoundEntry[] = [];
	published: string[] = [];
	bindError: string | undefined;

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
	async registerEnvGrant(): Promise<ValueMetadata> {
		throw new Error("not implemented");
	}
	async claimEnvGrant(): Promise<ValueMetadata> {
		throw new Error("not implemented");
	}
	async recordCell(): Promise<void> {}
	async names(): Promise<string[]> {
		return this.bound.map((b) => b.name);
	}
}

function stub(name: string, result: PrimitiveResult): Primitive {
	return {
		name,
		description: `stub ${name}`,
		parameters: { type: "object", properties: {} },
		execute: async () => result,
	};
}

describe("registry gate (capture-all v10)", () => {
	let env: LocalExecutionEnvironment;
	let store: FakeStore;

	beforeEach(() => {
		env = new LocalExecutionEnvironment("/tmp");
		store = new FakeStore();
	});

	function registryWith(prim: Primitive, withStore = true) {
		const registry = createPrimitiveRegistry(env);
		registry.register(prim);
		if (withStore) registry.setCaptureStore?.(store);
		return registry;
	}

	it("sub-budget capture-capable output renders fully inline, redacted, unshaped — chars-only trigger", async () => {
		// 300 short lines: over exec's 256-line limit but under the 2,000-char
		// budget. Today this is line-cut AND captured; under v10 it renders whole.
		const lines = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n");
		const output = `token: hunter2secretvalue\n${lines}`;
		const registry = registryWith(
			stub("exec", { output, success: true, captureSource: { content: output, type: "text" } }),
		);
		const result = await registry.execute("exec", {});
		expect(result.output).toContain("l299");
		expect(result.output).not.toContain("truncated");
		expect(result.output).toContain("[REDACTED_SECRET]");
		expect(result.output).not.toContain("hunter2secretvalue");
		expect(store.bound).toHaveLength(0);
	});

	it("over-budget capture-capable output captures the raw source and renders preview + form-1 marker", async () => {
		const source = `SECRET_TOKEN=raw-must-store-verbatim\n${"x".repeat(5_000)}`;
		const registry = registryWith(
			stub("exec", {
				output: source,
				success: true,
				captureSource: { content: source, type: "text" },
			}),
		);
		const result = await registry.execute("exec", {});
		// Stored value is the exact RAW source (splice fidelity).
		expect(store.bound).toHaveLength(1);
		expect(store.bound[0]!.name).toBe("exec_output");
		expect(store.bound[0]!.content).toBe(source);
		// Model-facing render is bounded and marked with the canonical form.
		expect(result.output.length).toBeLessThan(3_000);
		expect(result.output).toMatch(/\[\.\.\. \d+ chars truncated — full content: ⟦exec_output⟧\]/);
		expect(result.output).not.toContain("raw-must-store-verbatim");
	});

	it("fetch markers use the body noun", async () => {
		const body = "z".repeat(5_000);
		const registry = registryWith(
			stub("fetch", {
				output: `status: 200\nheaders: {}\n\n${body}`,
				success: true,
				captureSource: { content: body, type: "text" },
			}),
		);
		const result = await registry.execute("fetch", {});
		expect(result.output).toMatch(/full body: ⟦fetch_output⟧/);
	});

	it("without a capture store, today's limits apply (no svelte cut, no capture)", async () => {
		const output = "y".repeat(40_000);
		const registry = registryWith(
			stub("exec", { output, success: true, captureSource: { content: output, type: "text" } }),
			false,
		);
		const result = await registry.execute("exec", {});
		// exec's DEFAULT_CHAR_LIMITS entry is 30,000 — far above the svelte budget.
		expect(result.output.length).toBeGreaterThan(20_000);
		expect(store.bound).toHaveLength(0);
	});

	it("a source-less tool keeps today's limits even with a store present", async () => {
		const output = "m".repeat(20_000);
		const registry = registryWith(stub("memory_search", { output, success: true }));
		const result = await registry.execute("memory_search", {});
		// Generic fallback is 30,000: renders whole, uncaptured, no marker.
		expect(result.output.length).toBe(20_000);
		expect(store.bound).toHaveLength(0);
	});

	it("value_* results bypass the gate wholesale", async () => {
		const output = "v".repeat(45_000);
		const registry = registryWith(stub("value_get", { output, success: true }));
		const result = await registry.execute("value_get", {});
		expect(result.output).toBe(output);
		expect(store.bound).toHaveLength(0);
	});

	it("capture failure over today's limit degrades to today's rendering with the capture-failed banner", async () => {
		store.bindError = "disk exploded";
		const output = "w".repeat(40_000);
		const registry = registryWith(
			stub("exec", { output, success: true, captureSource: { content: output, type: "text" } }),
		);
		const result = await registry.execute("exec", {});
		expect(result.output.length).toBeGreaterThan(20_000);
		expect(result.output).toContain("capture failed — content not captured");
	});

	it("capture failure under today's limit renders fully inline with no banner", async () => {
		store.bindError = "disk exploded";
		const output = "w".repeat(10_000);
		const registry = registryWith(
			stub("exec", { output, success: true, captureSource: { content: output, type: "text" } }),
		);
		const result = await registry.execute("exec", {});
		expect(result.output).toBe(output);
		expect(result.output).not.toContain("truncated");
	});

	it("store-full failures use the store-full banner", async () => {
		store.bindError = "store full: value cap reached";
		const output = "w".repeat(40_000);
		const registry = registryWith(
			stub("exec", { output, success: true, captureSource: { content: output, type: "text" } }),
		);
		const result = await registry.execute("exec", {});
		expect(result.output).toContain("store full — content not captured");
	});

	it("an explicitly bound result is never stored twice — the marker names the existing value", async () => {
		const source = "e".repeat(5_000);
		const registry = registryWith(
			stub("exec", {
				output: source,
				success: true,
				captureSource: { content: source, type: "text" },
				boundValues: [{ name: "my_explicit", ulid: "u1", size: source.length }],
			}),
		);
		const result = await registry.execute("exec", {});
		expect(store.bound).toHaveLength(0);
		expect(result.output).toMatch(/full content: ⟦my_explicit⟧/);
	});

	it("error strings are redacted", async () => {
		const registry = registryWith(
			stub("exec", {
				output: "",
				success: false,
				error: "command failed: token: hunter2secretvalue",
			}),
		);
		const result = await registry.execute("exec", {});
		expect(result.error).toContain("[REDACTED_SECRET]");
		expect(result.error).not.toContain("hunter2secretvalue");
	});

	it("stderr companion containment runs in redacted space — no spurious companion when redacted stderr is visible", async () => {
		// stderr consists of a redactable secret; its REDACTED form appears in the
		// preview. The old raw-vs-preview check would false-positive and bind a
		// spurious companion value.
		const stderr = "token: hunter2secretvalue";
		const output = `${stderr}\n${"x".repeat(5_000)}`;
		const registry = registryWith(
			stub("exec", {
				output,
				success: true,
				captureSource: { content: output, type: "text", stderr },
			}),
		);
		const result = await registry.execute("exec", {});
		expect(store.bound).toHaveLength(1);
		expect(result.output).not.toContain("stderr: ⟦");
	});
});
